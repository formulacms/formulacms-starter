// Read side of the live model catalog (AI-MODELS-1b, design § 1 and § 4).
// Loads the stored vendor rows and OpenRouter rows, then merges them with the
// committed data through the pure code in `lib/ai/model-catalog.ts`. The merge
// happens at read time so a deploy that changes committed prices or
// capabilities is never hidden behind a stale stored copy.
//
// Settings, saves, prepare queries and admission all read through here, so
// every check uses the same entries (step D).
import { v, type Infer } from "convex/values"
import type { Doc } from "../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import { ANTHROPIC_API_CATALOG } from "../../lib/ai/capabilities/anthropic-api"
import { OPENAI_API_CATALOG } from "../../lib/ai/capabilities/openai-api"
import type {
  ApiModelTuple,
  ApiProvider,
  TaskProfile,
} from "../../lib/ai/execution-contract"
import {
  assistantModelChoices,
  defaultTupleFor,
  taskProfileTuple,
  validateTupleForProfiles,
} from "../../lib/ai/task-profiles"
import {
  BUNDLED_CATALOG_ENTRIES,
  VENDOR_CATALOG_MAX_MODELS,
  buildCatalogModel,
  catalogFromEntries,
  openRouterIdFor,
  refusal,
  type CatalogModel,
  type OpenRouterRow,
  type VendorModel,
} from "../../lib/ai/model-catalog"
import { OPENROUTER_CATALOG_MAX_MODELS } from "../../lib/ai/openrouter-catalog"
import {
  aiPriceQuoteValidator,
  reasoningEffortValidator,
  runtimeApiProviderValidator,
} from "./aiValidators"
import { readSyncState } from "./catalogRefresh"

type Ctx = QueryCtx | MutationCtx
type DirectProvider = "anthropic" | "openai"

const inputModalityValidator = v.union(
  v.literal("text"),
  v.literal("image"),
  v.literal("file"),
  v.literal("audio"),
  v.literal("video")
)

const lifecycleValidator = v.union(
  v.literal("active"),
  v.literal("deprecated"),
  v.literal("retired")
)

/** `CatalogModel` as a Convex validator, for returning entries from queries. */
export const catalogModelEntryValidator = v.object({
  provider: runtimeApiProviderValidator,
  model: v.string(),
  name: v.string(),
  family: v.optional(v.string()),
  releasedAt: v.optional(v.number()),
  capability: v.optional(
    v.object({
      name: v.optional(v.string()),
      inputModalities: v.array(inputModalityValidator),
      outputModalities: v.array(v.literal("text")),
      structuredOutput: v.boolean(),
      reasoning: v.union(
        v.object({
          kind: v.literal("effort"),
          supportedEfforts: v.array(reasoningEffortValidator),
          providerDefault: reasoningEffortValidator,
        }),
        v.object({ kind: v.literal("unsupported") })
      ),
      pricing: v.optional(
        v.object({ inputPerM: v.number(), outputPerM: v.number() })
      ),
    })
  ),
  capabilitySource: v.union(
    v.literal("committed"),
    v.literal("vendor"),
    v.literal("openrouter"),
    v.literal("none")
  ),
  defaultEffort: v.union(reasoningEffortValidator, v.null()),
  lifecycle: lifecycleValidator,
  retiresAt: v.optional(v.number()),
  listed: v.union(v.literal("live"), v.literal("bundled"), v.literal("absent")),
  price: v.optional(aiPriceQuoteValidator),
  priceSource: v.optional(
    v.union(v.literal("committed"), v.literal("openrouter"))
  ),
  maxOutputTokens: v.optional(v.number()),
})

/** `CatalogModel` with mutable arrays: the shape a query may return. */
export type CatalogModelEntry = Infer<typeof catalogModelEntryValidator>

function asEntry(entry: CatalogModel): CatalogModelEntry {
  const { capability, ...rest } = entry
  if (!capability) return rest
  return {
    ...rest,
    capability: {
      ...capability,
      inputModalities: [...capability.inputModalities],
      outputModalities: [...capability.outputModalities],
      reasoning:
        capability.reasoning.kind === "effort"
          ? {
              ...capability.reasoning,
              supportedEfforts: [...capability.reasoning.supportedEfforts],
            }
          : { kind: "unsupported" },
    },
  }
}

function toVendorModel(row: Doc<"aiVendorModels">): VendorModel {
  const { _id, _creationTime, syncedAt, ...rest } = row
  void _id
  void _creationTime
  void syncedAt
  return rest
}

function toOpenRouterRow(row: Doc<"openRouterCatalogModels">): OpenRouterRow {
  const { _id, _creationTime, ...rest } = row
  void _id
  void _creationTime
  return rest
}

async function openRouterRowFor(
  ctx: Ctx,
  modelId: string
): Promise<OpenRouterRow | undefined> {
  const row = await ctx.db
    .query("openRouterCatalogModels")
    .withIndex("by_modelId", (q) => q.eq("modelId", modelId))
    .first()
  return row ? toOpenRouterRow(row) : undefined
}

async function hasLiveList(ctx: Ctx, provider: ApiProvider): Promise<boolean> {
  return (await readSyncState(ctx, provider))?.lastSuccessAt !== undefined
}

function bundledEntry(
  provider: ApiProvider,
  model: string
): CatalogModel | undefined {
  return BUNDLED_CATALOG_ENTRIES.find(
    (entry) => entry.provider === provider && entry.model === model
  )
}

/**
 * Entries for specific models: at most three indexed reads each (the vendor
 * row, the mapped OpenRouter row, the sync row). An unknown model still gets
 * an entry, so a refusal can name its reason.
 */
export async function loadCatalogModels(
  ctx: Ctx,
  keys: readonly { provider: ApiProvider; model: string }[]
): Promise<CatalogModelEntry[]> {
  const live = new Map<ApiProvider, boolean>()
  const liveFor = async (provider: ApiProvider) => {
    if (!live.has(provider)) live.set(provider, await hasLiveList(ctx, provider))
    return live.get(provider)!
  }
  const seen = new Set<string>()
  const entries: CatalogModel[] = []
  for (const { provider, model } of keys) {
    const id = `${provider}:${model}`
    if (seen.has(id)) continue
    seen.add(id)
    const hasLive = await liveFor(provider)
    if (provider === "openrouter") {
      const row = await openRouterRowFor(ctx, model)
      entries.push(
        row || hasLive
          ? buildCatalogModel({
              provider,
              model,
              openRouterRow: row,
              hasLiveList: hasLive,
            })
          : (bundledEntry(provider, model) ??
              buildCatalogModel({ provider, model, hasLiveList: false }))
      )
      continue
    }
    const vendor = await ctx.db
      .query("aiVendorModels")
      .withIndex("by_provider_and_modelId", (q) =>
        q.eq("provider", provider).eq("modelId", model)
      )
      .first()
    const mappedId = openRouterIdFor(provider, model)
    entries.push(
      buildCatalogModel({
        provider,
        model,
        ...(vendor ? { vendorRow: toVendorModel(vendor) } : {}),
        ...(mappedId
          ? { openRouterRow: await openRouterRowFor(ctx, mappedId) }
          : {}),
        hasLiveList: hasLive,
      })
    )
  }
  return entries.map(asEntry)
}

/**
 * Every known entry of one provider (bounded). Without a successful sync the
 * provider's bundled committed list is returned instead. Entries that no menu
 * may offer are included; the caller applies `catalogFromEntries(...).list`.
 */
export async function loadProviderCatalog(
  ctx: Ctx,
  provider: ApiProvider
): Promise<CatalogModel[]> {
  const hasLive = await hasLiveList(ctx, provider)
  if (provider === "openrouter") {
    if (!hasLive) {
      return BUNDLED_CATALOG_ENTRIES.filter(
        (entry) => entry.provider === "openrouter"
      )
    }
    const rows = await ctx.db
      .query("openRouterCatalogModels")
      .take(OPENROUTER_CATALOG_MAX_MODELS)
    return rows.map((row) =>
      buildCatalogModel({
        provider,
        model: row.modelId,
        openRouterRow: toOpenRouterRow(row),
        hasLiveList: true,
      })
    )
  }

  // Listed rows and tombstones are read apart, each within the cap, so old
  // history never pushes a listed model out of the menu.
  const vendorRows = hasLive
    ? [
        ...(await ctx.db
          .query("aiVendorModels")
          .withIndex("by_provider_and_absentSince", (q) =>
            q.eq("provider", provider).eq("absentSince", undefined)
          )
          .take(VENDOR_CATALOG_MAX_MODELS)),
        // Newest tombstones: a saved model that left the list keeps its name.
        ...(await ctx.db
          .query("aiVendorModels")
          .withIndex("by_provider_and_absentSince", (q) =>
            q.eq("provider", provider).gt("absentSince", 0)
          )
          .order("desc")
          .take(VENDOR_CATALOG_MAX_MODELS)),
      ]
    : []
  const committed = Object.keys(
    provider === "anthropic" ? ANTHROPIC_API_CATALOG : OPENAI_API_CATALOG
  )
  const vendorById = new Map(vendorRows.map((row) => [row.modelId, row]))
  const ids = [...new Set([...vendorRows.map((r) => r.modelId), ...committed])]
  const entries: CatalogModel[] = []
  for (const model of ids) {
    const vendor = vendorById.get(model)
    const mappedId = openRouterIdFor(provider as DirectProvider, model)
    entries.push(
      buildCatalogModel({
        provider,
        model,
        ...(vendor ? { vendorRow: toVendorModel(vendor) } : {}),
        ...(mappedId
          ? { openRouterRow: await openRouterRowFor(ctx, mappedId) }
          : {}),
        hasLiveList: hasLive,
      })
    )
  }
  return entries
}

type CandidateTuple = Readonly<ApiModelTuple> | null | undefined
type ProviderTuples = Partial<Record<ApiProvider, CandidateTuple>>

/** Same provider, model and effort (no effort counts as one value). */
function sameTuple(
  a: Readonly<ApiModelTuple> | null,
  b: Readonly<ApiModelTuple>
): boolean {
  const effort = (tuple: Readonly<ApiModelTuple>) =>
    "reasoning" in tuple ? tuple.reasoning?.effort : undefined
  return (
    a !== null &&
    a.provider === b.provider &&
    a.model === b.model &&
    effort(a) === effort(b)
  )
}

/**
 * Entries for every tuple a run of these profiles may resolve to, read in the
 * prepare transaction so the action needs no extra query: the saved tuples
 * (assistant, agent overrides, task and site defaults) and the committed
 * defaults of each profile. Only `providers` are included; an assistant run
 * never switches provider.
 *
 * When a provider does not offer its committed default tuple (model and
 * effort) for the first profile, the default rule (`defaultTupleFor`) picks
 * the first offered choice in Settings' order. The entries for that provider
 * are then its whole bounded catalog (`loadProviderCatalog`), in the order
 * Settings reads it, so a run decides from exactly what Settings shows. At
 * most about 15 entries otherwise; with the whole list, up to 500 listed rows
 * and 500 tombstones plus the committed models for a direct provider, or
 * 1,000 rows for OpenRouter.
 */
export async function loadRuntimeCatalogEntries(
  ctx: Ctx,
  args: {
    providers: readonly ApiProvider[]
    profiles: readonly TaskProfile[]
    tuples?: readonly CandidateTuple[]
    providerDefaults?: ProviderTuples | null
    taskDefaults?: Record<string, CandidateTuple> | null
    modelOverrides?: ProviderTuples | null
    /** Checked against retirement and price end dates; default is the clock. */
    now?: number
  }
): Promise<CatalogModelEntry[]> {
  const candidates: CandidateTuple[] = [
    ...(args.tuples ?? []),
    ...Object.values(args.modelOverrides ?? {}),
    ...Object.values(args.taskDefaults ?? {}),
    ...Object.values(args.providerDefaults ?? {}),
    ...args.providers.flatMap((provider) =>
      args.profiles.map((profile) => taskProfileTuple(provider, profile))
    ),
  ]
  const entries = await loadCatalogModels(
    ctx,
    candidates.flatMap((tuple) =>
      tuple?.mode === "catalog" && args.providers.includes(tuple.provider)
        ? [{ provider: tuple.provider, model: tuple.model }]
        : []
    )
  )
  const profile = args.profiles[0]
  if (!profile) return entries
  // Whether the committed tuple is offered depends on its own entry only, so
  // the candidate entries answer it the same way the whole list would.
  const choices = assistantModelChoices(
    args.profiles,
    catalogFromEntries(entries),
    args.now ?? Date.now()
  )
  const whole: CatalogModelEntry[] = []
  for (const provider of args.providers) {
    const committed = taskProfileTuple(provider, profile)
    if (sameTuple(defaultTupleFor(provider, profile, choices[provider]), committed)) continue
    whole.push(...(await loadProviderCatalog(ctx, provider)).map(asEntry))
  }
  if (whole.length === 0) return entries
  // The whole lists first, in their own order; then the candidates they do
  // not hold (for example a saved model no longer listed, kept for its
  // refusal reason).
  const held = new Set(whole.map((entry) => `${entry.provider}:${entry.model}`))
  return [
    ...whole,
    ...entries.filter((entry) => !held.has(`${entry.provider}:${entry.model}`)),
  ]
}

/**
 * The save check for Settings, task defaults and agent overrides: the same
 * entry a run reads, refused for the same reasons (not offered, not listed,
 * retired, unknown capabilities, no price, wrong effort), then checked
 * against every profile the selection serves.
 */
export async function assertTupleSelectable(
  ctx: Ctx,
  tuple: Readonly<ApiModelTuple>,
  profiles: readonly TaskProfile[],
  now: number
): Promise<void> {
  if (tuple.mode !== "catalog") throw new Error("Only catalog tuples can be saved.")
  const entries = await loadCatalogModels(ctx, [
    { provider: tuple.provider, model: tuple.model },
  ])
  const reason = refusal(entries[0], tuple, now)
  if (reason) throw new Error(`The selected model is not available (${reason}).`)
  validateTupleForProfiles(tuple, profiles, catalogFromEntries(entries))
}
