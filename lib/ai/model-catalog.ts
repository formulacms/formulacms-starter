/**
 * One merged model catalog per provider, built from the vendors' own model
 * lists, the committed capability files, DIRECT_PRICES and the OpenRouter
 * feed (design 1b § 3–4). Pure and framework-free: the Convex loader supplies
 * the stored rows and `now`; nothing here reads the clock.
 */
import { anthropicCapability, ANTHROPIC_API_CATALOG } from "./capabilities/anthropic-api"
import { openAICapability, OPENAI_API_CATALOG } from "./capabilities/openai-api"
import {
  OPENROUTER_GENERATED_AT,
  OPENROUTER_GENERATED_CATALOG,
} from "./capabilities/openrouter-catalog.generated"
import {
  REASONING_EFFORTS,
  type ApiModelCapability,
  type ApiProvider,
  type InputModality,
  type ReasoningEffort,
} from "./execution-contract"
import {
  isOpenRouterAliasOrBatch,
  OPENROUTER_PORTABLE_EFFORTS,
  type OpenRouterFeedModel,
} from "./openrouter-catalog"
import {
  DIRECT_PRICES,
  openRouterPriceQuote,
  type PriceQuote,
} from "./price-quote"

export const VENDOR_CATALOG_MAX_MODELS = 500

/** Owner 2026-11-15 ("romove mode sol-6"): never offered in any list, live or
 * bundled. A saved choice still shows and is refused at run time. One line per
 * later removal, as `<provider>:<model id>`; the local tools use `codex:` and
 * `claude:`. */
export const NOT_OFFERED_MODELS: readonly string[] = [
  "openai:gpt-6-sol",
  "openrouter:openai/gpt-6-sol",
  "codex:gpt-6-sol",
  "openrouter:openai/gpt-6-sol-pro", // owner 2026-11-16 ("yes to all")
]

/** An API provider, or a local tool on the owner's computer. */
export type NotOfferedSource = ApiProvider | "codex" | "claude"

export type ModelLifecycle = "active" | "deprecated" | "retired"

/** One row from a direct vendor's own model list (Anthropic or OpenAI). */
export interface VendorModel {
  readonly provider: "anthropic" | "openai"
  readonly modelId: string
  readonly name?: string
  readonly line?: string
  readonly releasedAt?: number
  readonly inputModalities?: InputModality[]
  readonly structuredOutput?: boolean
  readonly effortControl?: "effort" | "none" | "unknown"
  readonly efforts?: ReasoningEffort[]
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  /** Anthropic only; OpenAI's comes from `retiresAt` (its `shutdown_date`). */
  readonly lifecycle?: ModelLifecycle
  readonly deprecatedAt?: number
  readonly retiresAt?: number
  /** Set by the loader when the model left the vendor's list (tombstone). */
  readonly absentSince?: number
}

export type OpenRouterRow = OpenRouterFeedModel & { readonly syncedAt?: number }

export interface CatalogModel {
  readonly provider: ApiProvider
  readonly model: string
  readonly name: string
  readonly family?: string
  readonly releasedAt?: number
  readonly capability?: ApiModelCapability
  readonly capabilitySource: "committed" | "vendor" | "openrouter" | "none"
  /** Display only: runs always send an explicit effort. */
  readonly defaultEffort: ReasoningEffort | null
  readonly lifecycle: ModelLifecycle
  readonly retiresAt?: number
  readonly listed: "live" | "bundled" | "absent"
  readonly price?: PriceQuote
  readonly priceSource?: "committed" | "openrouter"
  readonly maxOutputTokens?: number
}

export interface ModelCatalog {
  /** Every known entry, including ones never offered, so a saved choice can
   * still show its name and its refusal reason. */
  get(provider: ApiProvider, model: string): CatalogModel | undefined
  /** Only the models a menu may offer at `now`, newest first. */
  list(provider: ApiProvider, now: number): readonly CatalogModel[]
}

export type CatalogRefusal =
  | "unknown-model"
  | "not-offered"
  | "not-listed"
  | "retired"
  | "capabilities-unknown"
  | "no-price"
  | "price-expired"
  | "effort-required"
  | "effort-not-accepted"
  | "effort-unsupported"

// ---------------------------------------------------------------- helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

/** RFC 3339 / ISO date to epoch ms; epoch placeholders become absent. */
function instant(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : NaN
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

function rowsOf(value: unknown, vendor: string): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error(`${vendor} returned an invalid model list.`)
  }
  if (value.data.length > VENDOR_CATALOG_MAX_MODELS) {
    throw new Error(
      `${vendor} returned ${value.data.length} models; expected at most ${VENDOR_CATALOG_MAX_MODELS}.`
    )
  }
  return value.data
}

function supported(value: unknown): boolean | undefined {
  return isRecord(value) && typeof value.supported === "boolean"
    ? value.supported
    : undefined
}

const key = (provider: NotOfferedSource, model: string) => `${provider}:${model}`

export function isNotOffered(provider: NotOfferedSource, model: string): boolean {
  return NOT_OFFERED_MODELS.includes(key(provider, model))
}

// ---------------------------------------------------------------- parsers

/** One page of Anthropic `GET /v1/models`. Unknown or missing values stay
 * absent, which means "capabilities unknown"; malformed rows are skipped. */
export function parseAnthropicModels(value: unknown): VendorModel[] {
  const models = new Map<string, VendorModel>()
  for (const raw of rowsOf(value, "Anthropic")) {
    if (!isRecord(raw)) continue
    const modelId = text(raw.id)
    if (!modelId || models.has(modelId)) continue
    const caps = isRecord(raw.capabilities) ? raw.capabilities : undefined
    const effortCaps = caps?.effort
    const effortSupported = supported(effortCaps)
    const efforts = isRecord(effortCaps)
      ? REASONING_EFFORTS.filter((name) => supported(effortCaps[name]) === true)
      : []
    const effortControl =
      effortSupported === false
        ? "none"
        : effortSupported === true && efforts.length > 0
          ? "effort"
          : "unknown"
    const structuredOutput = supported(caps?.structured_outputs)
    const lifecycle = (["active", "deprecated", "retired"] as const).find(
      (name) => name === raw.lifecycle
    )
    const fields = {
      name: text(raw.display_name),
      line: text(raw.line),
      releasedAt: instant(raw.created_at),
      inputModalities: caps
        ? ([
            "text",
            ...(supported(caps.image_input) ? ["image"] : []),
            ...(supported(caps.pdf_input) ? ["file"] : []),
          ] as InputModality[])
        : undefined,
      structuredOutput,
      efforts: effortControl === "effort" ? efforts : undefined,
      maxInputTokens: positiveInteger(raw.max_input_tokens),
      maxOutputTokens: positiveInteger(raw.max_tokens),
      lifecycle,
      deprecatedAt: instant(raw.deprecated_at),
      retiresAt: instant(raw.retires_at),
    }
    models.set(modelId, {
      provider: "anthropic",
      modelId,
      effortControl,
      ...withoutUndefined(fields),
    })
  }
  return [...models.values()]
}

/** The cursor for the next Anthropic page, when `has_more` is set. */
export function anthropicNextPage(value: unknown): string | undefined {
  return isRecord(value) && value.has_more === true ? text(value.last_id) : undefined
}

const OPENAI_EXCLUDED_WORDS = [
  "audio",
  "realtime",
  "transcribe",
  "tts",
  "image",
  "search",
  "embedding",
  "moderation",
  "instruct",
  "latest",
  "deep-research",
  "computer-use",
]

/** OpenAI lists every model a key can use; keep only chat/reasoning text
 * models (design § 3 filters). Capabilities still decide whether it is offered. */
export function isOpenAiTextModel(id: string, ownedBy: unknown): boolean {
  return (
    (ownedBy === "openai" || ownedBy === "system") &&
    /^(gpt-|o\d)/.test(id) &&
    !id.startsWith("ft:") &&
    !/-pro(-|$)/.test(id) &&
    !OPENAI_EXCLUDED_WORDS.some((word) => id.includes(word))
  )
}

/** OpenAI `GET /v1/models`: only `id`, `created`, `owned_by`, `shutdown_date`. */
export function parseOpenAiModels(value: unknown): VendorModel[] {
  const models = new Map<string, VendorModel>()
  for (const raw of rowsOf(value, "OpenAI")) {
    if (!isRecord(raw)) continue
    const modelId = text(raw.id)
    if (!modelId || models.has(modelId) || !isOpenAiTextModel(modelId, raw.owned_by))
      continue
    const created = positiveInteger(raw.created)
    // Documented as a date; a Unix-seconds number is accepted defensively.
    const seconds = positiveInteger(raw.shutdown_date)
    const shutdown = seconds === undefined ? instant(raw.shutdown_date) : seconds * 1000
    models.set(modelId, {
      provider: "openai",
      modelId,
      ...(created === undefined ? {} : { releasedAt: created * 1000 }),
      ...(shutdown ? { retiresAt: shutdown } : {}),
    })
  }
  return [...models.values()]
}

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as { [K in keyof T]?: Exclude<T[K], undefined> }
}

// ---------------------------------------------------------------- id mapping

/** The exact OpenRouter id for a direct model, or undefined. Never derives a
 * `:batch`, `:free`, `-pro` or `~` id. */
export function openRouterIdFor(
  provider: ApiProvider,
  model: string
): string | undefined {
  if (provider === "openrouter" || /[:~]/.test(model) || /-pro(-|$)/.test(model))
    return undefined
  if (provider === "openai") return `openai/${model}`
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(
    model.replace(/-\d{8}$/, "")
  )
  return match
    ? `anthropic/claude-${match[1]}-${match[2]}${match[3] ? `.${match[3]}` : ""}`
    : undefined
}

/** The mapped OpenRouter row, only when its id matches exactly and (when the
 * vendor's display name is known) its name ends with that display name. */
function mappedRow(
  provider: "anthropic" | "openai",
  model: string,
  displayName: string | undefined,
  row: OpenRouterRow | undefined
): OpenRouterRow | undefined {
  if (!row || row.modelId !== openRouterIdFor(provider, model)) return undefined
  if (provider === "anthropic" && displayName && !row.name.endsWith(displayName))
    return undefined
  return row
}

// ---------------------------------------------------------------- merge

function stripCapability(capability: ApiModelCapability): ApiModelCapability {
  return {
    inputModalities: [...capability.inputModalities],
    outputModalities: ["text"],
    structuredOutput: capability.structuredOutput,
    reasoning:
      capability.reasoning.kind === "effort"
        ? {
            kind: "effort",
            supportedEfforts: [...capability.reasoning.supportedEfforts],
            providerDefault: capability.reasoning.providerDefault,
          }
        : { kind: "unsupported" },
  }
}

function effortCapability(
  inputModalities: readonly InputModality[],
  structuredOutput: boolean,
  efforts: readonly ReasoningEffort[] | null,
  defaultEffort: ReasoningEffort | undefined
): ApiModelCapability {
  return {
    inputModalities: [...inputModalities],
    outputModalities: ["text"],
    structuredOutput,
    reasoning:
      efforts === null
        ? { kind: "unsupported" }
        : {
            kind: "effort",
            supportedEfforts: [...efforts],
            // The type needs a value; `defaultEffort` stays null when unknown.
            providerDefault:
              defaultEffort && efforts.includes(defaultEffort)
                ? defaultEffort
                : efforts.includes("medium")
                  ? "medium"
                  : efforts[0]!,
          },
  }
}

/** Anthropic capability from its own list, or undefined when anything is unknown. */
function vendorCapability(
  row: VendorModel | undefined,
  defaultEffort: ReasoningEffort | undefined
): ApiModelCapability | undefined {
  if (!row?.inputModalities || row.structuredOutput === undefined) return undefined
  if (row.effortControl === "none")
    return effortCapability(row.inputModalities, row.structuredOutput, null, undefined)
  if (row.effortControl !== "effort" || !row.efforts?.length) return undefined
  return effortCapability(row.inputModalities, row.structuredOutput, row.efforts, defaultEffort)
}

/** OpenAI capability filled from the mapped OpenRouter row. No `reasoning`
 * object means no effort control; a row without an effort list is unknown. */
function openRouterFill(row: OpenRouterRow | undefined): ApiModelCapability | undefined {
  if (!row || row.hasReasoning === undefined) return undefined
  if (!row.hasReasoning)
    return effortCapability(row.inputModalities, row.structuredOutput, null, undefined)
  if (!row.vendorEfforts?.length) return undefined
  return effortCapability(row.inputModalities, row.structuredOutput, row.vendorEfforts, row.defaultEffort)
}

/** "GPT-6.1 Sol" → "Sol", "Anthropic: Claude Opus 5.5" → "Opus". */
export function familyFromName(name: string): string | undefined {
  const words = name
    .replace(/^[^:]*:\s*/, "")
    .split(/\s+/)
    .filter((word) => word && !/\d/.test(word))
  if (words[0] === "Claude") words.shift()
  return words.length > 0 ? words.join(" ") : undefined
}

function committedFor(provider: "anthropic" | "openai", model: string) {
  return provider === "anthropic" ? anthropicCapability(model) : openAICapability(model)
}

export interface BuildCatalogModelInput {
  readonly provider: ApiProvider
  readonly model: string
  /** The vendor's own row (Anthropic/OpenAI), possibly a tombstone. */
  readonly vendorRow?: VendorModel
  /** OpenRouter provider: the model's own row. Direct providers: the row at
   * `openRouterIdFor(provider, model)`; any other row is ignored. */
  readonly openRouterRow?: OpenRouterRow
  /** Whether a live list exists for this provider (else the bundle is used). */
  readonly hasLiveList: boolean
}

/** Merge one model (design § 3): committed data first, the vendor's own data
 * next, OpenRouter only for OpenAI capabilities and missing prices. Time-free:
 * `refusal()` applies `now`. */
export function buildCatalogModel(input: BuildCatalogModelInput): CatalogModel {
  const { provider, model, vendorRow, hasLiveList } = input
  if (provider === "openrouter") return openRouterEntry(model, input.openRouterRow, hasLiveList)

  const committed = committedFor(provider, model)
  const displayName = vendorRow?.name ?? committed?.name
  const row = mappedRow(provider, model, displayName, input.openRouterRow)
  const name =
    displayName ?? (row ? row.name.replace(/^[^:]*:\s*/, "") : undefined) ?? model

  let capability: ApiModelCapability | undefined
  let capabilitySource: CatalogModel["capabilitySource"] = "none"
  if (committed) {
    capability = stripCapability(committed)
    capabilitySource = "committed"
  } else if (provider === "anthropic") {
    capability = vendorCapability(vendorRow, row?.defaultEffort)
    if (capability) capabilitySource = "vendor"
  } else {
    capability = openRouterFill(row)
    if (capability) capabilitySource = "openrouter"
  }
  const efforts =
    capability?.reasoning.kind === "effort" ? capability.reasoning.supportedEfforts : []
  const defaultEffort =
    committed?.reasoning.kind === "effort"
      ? committed.reasoning.providerDefault
      : row?.defaultEffort && efforts.includes(row.defaultEffort)
        ? row.defaultEffort
        : null

  const committedPrice = DIRECT_PRICES[key(provider, model)]
  const filledPrice =
    committedPrice || !row || row.syncedAt === undefined
      ? undefined
      : openRouterPriceQuote(
          { ...row, syncedAt: row.syncedAt },
          vendorRow?.maxInputTokens ?? Number.MAX_SAFE_INTEGER
        )
  const price = committedPrice ?? filledPrice
  const retiresAt = vendorRow?.retiresAt
  const lifecycle: ModelLifecycle =
    provider === "anthropic"
      ? (vendorRow?.lifecycle ?? "active")
      : retiresAt !== undefined
        ? "deprecated"
        : "active"
  const releasedAt = vendorRow?.releasedAt ?? row?.releasedAt
  const maxOutputTokens = vendorRow?.maxOutputTokens ?? row?.maxOutputTokens
  const family =
    provider === "anthropic" && vendorRow?.line
      ? vendorRow.line.charAt(0).toUpperCase() + vendorRow.line.slice(1)
      : familyFromName(name)

  return {
    provider,
    model,
    name,
    ...(family ? { family } : {}),
    ...(releasedAt === undefined ? {} : { releasedAt }),
    ...(capability ? { capability } : {}),
    capabilitySource,
    defaultEffort,
    lifecycle,
    ...(retiresAt === undefined ? {} : { retiresAt }),
    listed: vendorRow
      ? vendorRow.absentSince === undefined
        ? "live"
        : "absent"
      : hasLiveList
        ? "absent"
        : "bundled",
    ...(price
      ? { price, priceSource: committedPrice ? ("committed" as const) : ("openrouter" as const) }
      : {}),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}

function openRouterEntry(
  model: string,
  row: OpenRouterRow | undefined,
  hasLiveList: boolean
): CatalogModel {
  if (!row || row.modelId !== model) {
    return {
      provider: "openrouter",
      model,
      name: model,
      capabilitySource: "none",
      defaultEffort: null,
      lifecycle: "active",
      listed: "absent",
    }
  }
  // Portable efforts only (the parser stores no others), so the OpenRouter
  // menus and checks never offer an effort a model may not accept.
  const efforts = row.reasoningEfforts.filter((effort) =>
    (OPENROUTER_PORTABLE_EFFORTS as readonly ReasoningEffort[]).includes(effort)
  )
  const defaultEffort =
    row.defaultEffort && efforts.includes(row.defaultEffort) ? row.defaultEffort : "medium"
  const price =
    row.syncedAt === undefined ? undefined : openRouterPriceQuote({ ...row, syncedAt: row.syncedAt })
  const family = familyFromName(row.name)
  return {
    provider: "openrouter",
    model,
    name: row.name,
    ...(family ? { family } : {}),
    ...(row.releasedAt === undefined ? {} : { releasedAt: row.releasedAt }),
    // Portable efforts, as today, so the OpenRouter menus do not change.
    capability: effortCapability(
      row.inputModalities,
      row.structuredOutput,
      efforts.length > 0 ? efforts : null,
      defaultEffort
    ),
    capabilitySource: "vendor",
    defaultEffort: efforts.length > 0 ? defaultEffort : null,
    lifecycle: row.expiresAt === undefined ? "active" : "deprecated",
    ...(row.expiresAt === undefined ? {} : { retiresAt: row.expiresAt }),
    listed: hasLiveList ? "live" : "bundled",
    ...(price ? { price, priceSource: "openrouter" as const } : {}),
    ...(row.maxOutputTokens === undefined ? {} : { maxOutputTokens: row.maxOutputTokens }),
  }
}

// ---------------------------------------------------------------- refusal

/** Model-level reasons, in a fixed order. */
export function modelRefusal(
  entry: CatalogModel | CatalogModelValue | undefined,
  now: number
): CatalogRefusal | null {
  if (!entry) return "unknown-model"
  if (isNotOffered(entry.provider, entry.model)) return "not-offered"
  // Rows stored before the feed filter existed: refused here as well, so no
  // stored alias or `:batch` row is offered or run before the next refresh.
  if (entry.provider === "openrouter" && isOpenRouterAliasOrBatch(entry.model))
    return "not-offered"
  if (entry.listed === "absent") return "not-listed"
  // Anthropic's `lifecycle` is the retirement signal: a past `retires_at` on a
  // deprecated model means the retirement is overdue, not done. OpenAI and
  // OpenRouter announce a shutdown date only, so that date retires the model.
  if (
    entry.lifecycle === "retired" ||
    (entry.provider !== "anthropic" && entry.retiresAt !== undefined && entry.retiresAt <= now)
  )
    return "retired"
  if (!entry.capability) return "capabilities-unknown"
  if (!entry.price) return "no-price"
  if (entry.price.endsAt !== null && entry.price.endsAt <= now) return "price-expired"
  return null
}

/** Why a run or a save with this tuple must be refused, or null. */
export function refusal(
  entry: CatalogModel | CatalogModelValue | undefined,
  tuple: { readonly reasoning?: { readonly effort: ReasoningEffort } },
  now: number
): CatalogRefusal | null {
  const reason = modelRefusal(entry, now)
  if (reason) return reason
  const reasoning = entry!.capability!.reasoning
  const effort = tuple.reasoning?.effort
  if (reasoning.kind === "unsupported") return effort === undefined ? null : "effort-unsupported"
  if (effort === undefined) return "effort-required"
  return reasoning.supportedEfforts.includes(effort) ? null : "effort-not-accepted"
}

/** Offered in a menu: no refusal, and no announced price end (today's rule). */
function isOffered(entry: CatalogModel, now: number): boolean {
  return modelRefusal(entry, now) === null && entry.price!.endsAt === null
}

// ---------------------------------------------------------------- catalog

/** Newest first by `releasedAt`, then name; undated rows after, in input order. */
export function menuOrder(entries: readonly CatalogModel[]): CatalogModel[] {
  const dated = entries.filter((entry) => entry.releasedAt !== undefined)
  const undated = entries.filter((entry) => entry.releasedAt === undefined)
  dated.sort((a, b) => b.releasedAt! - a.releasedAt! || a.name.localeCompare(b.name))
  return [...dated, ...undated]
}

/** An entry as a Convex query returns it: plain arrays instead of tuples. */
export type CatalogModelValue = Omit<CatalogModel, "capability"> & {
  readonly capability?: Omit<ApiModelCapability, "outputModalities"> & {
    readonly outputModalities: readonly "text"[]
  }
}

export function catalogFromEntries(
  entries: readonly (CatalogModel | CatalogModelValue)[]
): ModelCatalog {
  // Same runtime shape: a query's entry only types its output list as an array.
  const byKey = new Map(
    (entries as readonly CatalogModel[]).map((entry) => [key(entry.provider, entry.model), entry])
  )
  const ordered = menuOrder([...byKey.values()])
  return {
    get: (provider, model) => byKey.get(key(provider, model)),
    list: (provider, now) =>
      ordered.filter((entry) => entry.provider === provider && isOffered(entry, now)),
  }
}

/** The newest offered model of the same family, only when it is newer. */
export function newerModelFor(
  entry: CatalogModel,
  catalog: ModelCatalog,
  now: number
): CatalogModel | undefined {
  if (!entry.family || entry.releasedAt === undefined) return undefined
  const vendor = (model: string) => model.split("/")[0]
  return catalog
    .list(entry.provider, now)
    .find(
      (candidate) =>
        candidate.family === entry.family &&
        candidate.model !== entry.model &&
        (entry.provider !== "openrouter" || vendor(candidate.model) === vendor(entry.model)) &&
        candidate.releasedAt !== undefined &&
        candidate.releasedAt > entry.releasedAt!
    )
}

/** Offline fallback: committed files + DIRECT_PRICES + the generated
 * OpenRouter bundle, whose rows carry the ceiling prices computed when the
 * bundle was generated (`pnpm ai:catalog:openrouter`). */
export const BUNDLED_CATALOG_ENTRIES: readonly CatalogModel[] = [
  ...Object.keys(ANTHROPIC_API_CATALOG).map((model) =>
    buildCatalogModel({ provider: "anthropic", model, hasLiveList: false })
  ),
  ...Object.keys(OPENAI_API_CATALOG).map((model) =>
    buildCatalogModel({ provider: "openai", model, hasLiveList: false })
  ),
  ...Object.entries(OPENROUTER_GENERATED_CATALOG)
    .filter(([model]) => !isOpenRouterAliasOrBatch(model))
    .map(([model, entry]) =>
      buildCatalogModel({
        provider: "openrouter",
        model,
        hasLiveList: false,
        openRouterRow: {
          modelId: model,
          name: entry.name,
          inputModalities: [...entry.inputModalities],
          structuredOutput: entry.structuredOutput,
          reasoningEfforts:
            entry.reasoning.kind === "effort" ? [...entry.reasoning.supportedEfforts] : [],
          // Release and expiration dates from the feed, so the fallback orders
          // newest first and retires a model on its announced date.
          ...(entry.releasedAt === undefined ? {} : { releasedAt: entry.releasedAt }),
          ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
          // Ceiling prices computed when the bundle was generated, so these
          // models are priced before the first synchronized list.
          ...(entry.ceilingInputPerM === undefined || entry.ceilingOutputPerM === undefined
            ? {}
            : {
                ceilingInputPerM: entry.ceilingInputPerM,
                ceilingOutputPerM: entry.ceilingOutputPerM,
                syncedAt: OPENROUTER_GENERATED_AT,
              }),
        },
      })
    ),
]

export const BUNDLED_MODEL_CATALOG: ModelCatalog = catalogFromEntries(BUNDLED_CATALOG_ENTRIES)
