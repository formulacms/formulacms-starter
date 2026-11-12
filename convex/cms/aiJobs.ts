/** AI1 U1b: owner-started durable jobs. No catalog entry is added here. */
import { ConvexError, v, type Infer } from "convex/values"
import type { FunctionReturnType } from "convex/server"
import {
  Workpool,
  vOnCompleteValidator,
  type WorkId,
} from "@convex-dev/workpool"
import { api, components, internal } from "../_generated/api"
import {
  query,
  mutation,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import schema, { aiPageJobStateValidator } from "../schema"
import {
  requireOwnerAndOptionalModule,
  resolveOptionalModuleGuardState,
} from "../lib/modules/state"
import { prependAssistantInstructions } from "../../lib/ai/task-profiles"
import { enforceAiRateLimit } from "../lib/aiRateLimit"
import {
  resolveAssistantRuntimeTuple,
  requireAiTranslationModule,
  readRuntimeProviderConnection,
} from "../lib/ai"
import { readContentGenerationConfig } from "../agents/contentWriter"
import { readTranslationConfig } from "../agents/localizer"
import {
  AGENTS,
  languageName,
  buildTranslationSystemPrompt,
  renderTemplate,
} from "../lib/agents/registry"
import {
  assertSliceType,
  buildPageFillGenerationInput,
} from "../lib/agents/contentWriterContract"
import {
  flattenSliceText,
  pushDescriptorText,
  SIBLING_TEXT_CAP,
} from "../lib/agents/pageContext"
import {
  installedSliceValidator,
  isEditorialTextPrimitive,
  isTranslatableTextPrimitive,
  readSliceDefinition,
  type Primitive,
  type Slice,
} from "../lib/slices"
import { richTextToPlainText } from "../lib/richtext/pmText"
import { readSlice } from "../lib/slices/identity"
import { readFrozenSnapshotProjection } from "../lib/publishing/snapshots"
import { assertSnapshotPageSoftDeleteAllowed } from "./publication"
import { contentTypeDefs } from "../lib/contentTypes"
import { collectTranslatableLeaves } from "../../components/admin/page-editor/lib/descriptor-values"
import {
  parseFieldPath,
  setValueAtFieldPath,
} from "../../components/admin/page-editor/lib/field-path"
import { slugify } from "../lib/contentTypes/routing"
import { readEffectiveSlicePresentationCatalog } from "../lib/slices/presentations"
import { hasExplicitSlicePresentations } from "../lib/slices/presentationMutations"
import { assertOrdinaryLocale } from "../lib/language/state"
import {
  enumerateSegments,
  assembleTranslation,
  TranslationLimitError,
  type PageTranslationContent,
} from "../lib/agents/translationWorkflow"
import {
  currentMonth,
  pricing,
  reservePageJob,
  releasePageJobReservation,
  settleAttempt,
} from "./ai"
import { inputTokenEstimate, moneyInteger } from "../../lib/ai/price-quote"
import { maxOutputTokensFor } from "../../lib/ai/task-profiles"
import type {
  GenerationRequest,
  ApiModelTuple,
} from "../../lib/ai/execution-contract"

export const pageJobPool = new Workpool(components.aiPageJobs, {
  maxParallelism: 6,
  retryActionsByDefault: false,
})
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
// Write jobs keep the two shipped languages. A translation job takes any
// language code; `prepare` checks both are languages of this site.
const localeValidator = v.union(v.literal("en"), v.literal("fr"))
const inputValidator = v.union(
  v.object({
    kind: v.literal("write"),
    brief: v.string(),
    locale: localeValidator,
    meta: v.object({
      title: v.string(),
      slug: v.string(),
      metaTitle: v.optional(v.string()),
      metaDescription: v.optional(v.string()),
    }),
    rows: v.array(v.object({ sliceType: v.string(), purpose: v.string() })),
  }),
  v.object({
    kind: v.literal("translation"),
    pageId: v.id("pages"),
    sourceLocale: v.string(),
    targetLocale: v.string(),
  })
)
type Input = Infer<typeof inputValidator>
type Job = Doc<"aiJobs">
type Unit = Doc<"aiJobUnits">
type UnitWork = Pick<
  Unit,
  "index" | "sliceType" | "purpose" | "input" | "state" | "output"
>
type Ctx = QueryCtx | MutationCtx
const terminalReasons = v.union(
  v.literal("canceled"),
  v.literal("failed"),
  v.literal("capped")
)
const unitStateValidator = v.union(
  v.literal("waiting"),
  v.literal("inProgress"),
  v.literal("saved"),
  v.literal("failed")
)
const monthValidator = v.object({
  spentMicros: v.number(),
  reservedMicros: v.number(),
  capMicros: v.number(),
  status: v.union(
    v.literal("below"),
    v.literal("warn80"),
    v.literal("reached")
  ),
})
const unitsFor = (ctx: Ctx, jobId: Id<"aiJobs">) =>
  ctx.db
    .query("aiJobUnits")
    .withIndex("by_jobId_and_index", (q) => q.eq("jobId", jobId))
    .take(61)
async function unitHasOpenAttempt(ctx: Ctx, unit: Unit): Promise<boolean> {
  for (const key of unit.attemptKeys) {
    const attempt = await ctx.db
      .query("aiSpendingAttempts")
      .withIndex("by_attemptKey", (q) => q.eq("attemptKey", key))
      .unique()
    if (
      !attempt ||
      attempt.state !== "settled" ||
      attempt.chargedMicros === undefined
    )
      return true
  }
  return false
}
async function jobIsStillSettling(
  ctx: Ctx,
  units: readonly Unit[]
): Promise<boolean> {
  for (const unit of units)
    if (
      unit.state === "inProgress" ||
      unit.workId ||
      (await unitHasOpenAttempt(ctx, unit))
    )
      return true
  return false
}
const expired = (job: Job) =>
  Date.now() >= job.expiresAt || job.state === "expired"
const active = (job: Job) =>
  job.state === "running" || job.state === "canceling"

async function taskGate(ctx: Ctx, kind: Job["kind"]): Promise<string> {
  const owner = await requireOwnerAndOptionalModule(ctx, "ai")
  if (kind === "translation") {
    await requireAiTranslationModule(ctx)
  }
  return owner.authId
}
/** Frozen jobs check their own connection, not a later assistant selection. */
async function requireJobProvider(ctx: Ctx, job: Job): Promise<void> {
  const connection = await readRuntimeProviderConnection(
    ctx,
    job.tuple.provider
  )
  if (connection.state === "missing" || connection.state === "refused")
    throw new ConvexError("AI_JOB_PROVIDER_UNAVAILABLE")
}
/** Owner and AI-module checks only: for calls that reach no provider. */
async function ownedJobNoTaskGate(ctx: Ctx, id: Id<"aiJobs">): Promise<Job> {
  const owner = await requireOwnerAndOptionalModule(ctx, "ai")
  const job = await ctx.db.get("aiJobs", id)
  if (!job || job.authId !== owner.authId)
    throw new ConvexError("AI_JOB_NOT_FOUND")
  return job
}
async function ownedJob(ctx: Ctx, id: Id<"aiJobs">): Promise<Job> {
  const job = await ownedJobNoTaskGate(ctx, id)
  await taskGate(ctx, job.kind)
  return job
}
async function monthBlock(ctx: Ctx, job?: Job) {
  const month = await currentMonth(ctx, Date.now())
  const reservation = job?.reservationKey
    ? await ctx.db
        .query("aiSpendingJobReservations")
        .withIndex("by_reservationKey", (q) =>
          q.eq("reservationKey", job.reservationKey!)
        )
        .unique()
    : null
  const row = reservation
    ? await ctx.db.get("aiSpendingMonths", reservation.monthId)
    : month.row
  const spentMicros = row?.spentMicros ?? 0,
    reservedMicros = row?.reservedMicros ?? 0
  const total = BigInt(spentMicros) + BigInt(reservedMicros),
    cap = BigInt(month.capMicros)
  return {
    spentMicros,
    reservedMicros,
    capMicros: month.capMicros,
    status:
      total >= cap
        ? ("reached" as const)
        : total * 5n >= cap * 4n
          ? ("warn80" as const)
          : ("below" as const),
  }
}
function fits(month: Infer<typeof monthValidator>, estimate: number): boolean {
  return (
    BigInt(month.spentMicros) +
      BigInt(month.reservedMicros) +
      BigInt(estimate) <=
    BigInt(month.capMicros)
  )
}

/** Pinned selection and templates: estimates and workers build the same input. */
export function jobGenerationInput(
  job: Pick<
    Job,
    | "kind"
    | "brief"
    | "locale"
    | "title"
    | "systemPrompt"
    | "userPromptTemplate"
    | "brandVoice"
    | "sourceLocale"
    | "targetLocale"
  >,
  unit: Pick<Unit, "index" | "sliceType" | "purpose" | "input">,
  units: readonly UnitWork[],
  estimating = false
) {
  if (job.kind === "translation")
    return {
      instructions: buildTranslationSystemPrompt(
        job.sourceLocale!,
        job.targetLocale!,
        false
      ),
      prompt: renderTemplate(
        job.userPromptTemplate ?? AGENTS.translation.defaultUserPromptTemplate,
        { text: unit.input! }
      ),
    }
  return buildPageFillGenerationInput({
    systemTemplate: job.systemPrompt ?? AGENTS.content.defaultSystemPrompt,
    userTemplate:
      job.userPromptTemplate ?? AGENTS.content.defaultUserPromptTemplate,
    language: languageName(job.locale),
    sliceType: assertSliceType(unit.sliceType!),
    pageBrief: job.brief!,
    purpose: unit.purpose!,
    brandVoice: job.brandVoice,
    context: {
      pageTitle: job.title,
      siblings: units
        .filter((row) => row.index < unit.index)
        .map((row) => ({
          type: row.sliceType!,
          text:
            row.state === "saved" && typeof row.output === "object"
              ? flattenSliceText(row.output)
              : estimating
                ? "é".repeat(SIBLING_TEXT_CAP + 1)
                : "",
        })),
    },
  })
}
async function estimateUnits(
  ctx: Ctx,
  job: Parameters<typeof jobGenerationInput>[0] & {
    tuple: ApiModelTuple
    assistantInstructions?: string
  },
  units: readonly UnitWork[]
): Promise<number> {
  let total = 0
  for (const unit of units) {
    if (unit.state === "saved") continue
    const generation = jobGenerationInput(job, unit, units, true)
    const profile =
      job.kind === "write"
        ? ("editorial-copy" as const)
        : ("brand-translation" as const)
    const phase =
      job.kind === "write" ? ("page-fill" as const) : ("translation" as const)
    const request = {
      target: { lane: "runtime", provider: job.tuple.provider },
      tuple: job.tuple,
      profile,
      phase,
      ...generation,
      instructions: prependAssistantInstructions(
        job.assistantInstructions,
        generation.instructions
      ),
      input: { prompt: generation.prompt },
      requirements: { inputModalities: ["text"], structuredOutput: false },
      output: { kind: "text" },
    } as GenerationRequest<string>
    const priced = await pricing(
      ctx,
      {
        attemptKey: "page-job-estimate",
        provider: job.tuple.provider,
        modelId: job.tuple.model,
        lane: "runtime",
        profile,
        phase,
        inputTokens: inputTokenEstimate(request),
        imageTokens: 0,
        maxOutputTokens: maxOutputTokensFor(request),
      },
      Date.now()
    )
    total = moneyInteger(total + priced.estimateMicros)
  }
  return total
}
/**
 * Whether a language of a page already has content, defined the way the
 * editor's "Not translated" status is (`projectAdminPageLocales`): a language
 * with no state row, or a state row with no published snapshot, no working
 * draft at the current generation and no readable snapshot base, is Not
 * translated. `draftGeneration` is what a save for that language must expect
 * (0 when the language has no state row).
 */
async function targetLocaleStatus(
  ctx: Ctx,
  pageId: Id<"pages">,
  locale: string
): Promise<{ hasContent: boolean; draftGeneration: number }> {
  const states = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", pageId).eq("locale", locale)
    )
    .take(2)
  if (states.length > 1) throw new ConvexError("AI_JOB_SOURCE_UNAVAILABLE")
  const state = states[0]
  if (!state) return { hasContent: false, draftGeneration: 0 }
  const draftGeneration = state.draftGeneration
  if (state.currentSnapshotId !== undefined || state.hasCurrentSnapshot)
    return { hasContent: true, draftGeneration }
  const drafts = await ctx.db
    .query("pageLocaleDrafts")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", pageId).eq("locale", locale)
    )
    .take(2)
  if (drafts.length > 1) throw new ConvexError("AI_JOB_SOURCE_UNAVAILABLE")
  if (drafts[0] && drafts[0].generation === state.draftGeneration)
    return { hasContent: true, draftGeneration }
  if (state.draftBaseSnapshotId) {
    const base = await readFrozenSnapshotProjection(
      ctx,
      state.draftBaseSnapshotId,
      pageId,
      locale
    )
    if (base) return { hasContent: true, draftGeneration }
  }
  return { hasContent: false, draftGeneration }
}
type TypedDraft = NonNullable<NonNullable<Job["sourcePage"]>["draft"]>
/**
 * The source language's draft as the typed save input: only the descriptor's
 * localized fields (absent keys stay absent, empty values stay), plus the
 * slices when the content type has a slice body.
 */
function pinnedSourceDraft(
  pageType: Doc<"pages">["pageType"],
  content: Record<string, unknown>
): TypedDraft {
  const def = contentTypeDefs[pageType]
  const localized: Record<string, unknown> = {}
  for (const key of Object.keys(def.localizedFields))
    if (content[key] !== undefined)
      localized[key] = structuredClone(content[key])
  return {
    pageType,
    localized,
    ...(def.capabilities.sliceBody ? { slices: content.slices ?? [] } : {}),
  } as unknown as TypedDraft
}
/** The pinned draft with the translation applied: nothing is read from the live source. */
export function translatedDraft(
  pinned: TypedDraft,
  translated: NonNullable<Job["suggestion"]>
): TypedDraft {
  let localized = structuredClone(pinned.localized) as Record<string, unknown>
  for (const leaf of translated.translatables)
    localized = setValueAtFieldPath(
      localized,
      parseFieldPath(leaf.path),
      leaf.value
    ) as Record<string, unknown>
  localized.title = translated.title
  // Absent stays absent: assembly returns a meta field only if the source had it.
  if (translated.metaTitle !== undefined)
    localized.metaTitle = translated.metaTitle
  if (translated.metaDescription !== undefined)
    localized.metaDescription = translated.metaDescription
  return {
    pageType: pinned.pageType,
    localized,
    ...("slices" in pinned ? { slices: translated.slices } : {}),
  } as unknown as TypedDraft
}
async function prepare(ctx: Ctx, authId: string, input: Input) {
  if (input.kind === "write") {
    if (
      !input.brief.trim() ||
      input.brief.length > 2000 ||
      !input.meta.title.trim() ||
      input.rows.length < 1 ||
      input.rows.length > 8
    )
      throw new ConvexError("AI_JOB_INPUT_INVALID")
    for (const row of input.rows) {
      assertSliceType(row.sliceType)
      if (!row.purpose.trim() || row.purpose.length > 500)
        throw new ConvexError("AI_JOB_INPUT_INVALID")
    }
  } else {
    if (input.sourceLocale === input.targetLocale)
      throw new ConvexError("AI_JOB_INPUT_INVALID")
    // Both must be languages of this site (LOCALE_NOT_ENABLED otherwise).
    await assertOrdinaryLocale(ctx, input.sourceLocale)
    await assertOrdinaryLocale(ctx, input.targetLocale)
  }
  const contentConfig =
    input.kind === "write"
      ? await readContentGenerationConfig(ctx, authId)
      : undefined
  const cfg = contentConfig ?? (await readTranslationConfig(ctx, authId))
  const profile =
    input.kind === "write" ? "editorial-copy" : "brand-translation"
  const tuple = resolveAssistantRuntimeTuple(cfg.assistant, {
    profile,
    phase: input.kind === "write" ? "page-fill" : "translation",
    legacyModelId: cfg.modelId ?? undefined,
    providerDefaults: cfg.providerDefaults ?? undefined,
    taskDefaults: cfg.taskDefaults ?? undefined,
    modelOverrides: cfg.modelOverrides ?? undefined,
  })
  const common = {
    kind: input.kind,
    tuple,
    assistantInstructions: cfg.assistant.instructions,
    userPromptTemplate: cfg.userPromptTemplate,
    systemPrompt: contentConfig?.systemPrompt,
    brandVoice: contentConfig?.brandVoice ?? undefined,
  }
  if (input.kind === "write")
    return {
      ...common,
      kind: "write" as const,
      title: input.meta.title,
      locale: input.locale,
      brief: input.brief,
      sourceLocale: undefined,
      targetLocale: undefined,
      sourcePage: undefined,
      draftGeneration: 0,
      targetDraftGeneration: undefined,
      units: input.rows.map((row, index) => ({
        ...row,
        index,
        kind: "write" as const,
        state: "waiting" as const,
        reused: false,
        costMicros: 0,
        attemptKeys: [] as string[],
      })),
    }
  // Reuse the editor's source projection and descriptor collector, with no live reads in workers.
  const result: FunctionReturnType<typeof api.cms.pages.getForEdit> =
    await ctx.runQuery(api.cms.pages.getForEdit, { id: input.pageId })
  const page = result?.page
  const state = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", input.pageId).eq("locale", input.sourceLocale)
    )
    .unique()
  const content = page?.content?.[input.sourceLocale] as
    Record<string, unknown> | undefined
  if (!page || !state || !content || typeof content.title !== "string")
    throw new ConvexError("AI_JOB_SOURCE_UNAVAILABLE")
  const sourcePage: PageTranslationContent & {
    slices: Slice[]
    translatables: NonNullable<PageTranslationContent["translatables"]>
  } = {
    title: content.title,
    ...(typeof content.metaTitle === "string"
      ? { metaTitle: content.metaTitle }
      : {}),
    ...(typeof content.metaDescription === "string"
      ? { metaDescription: content.metaDescription }
      : {}),
    slices: (content.slices ?? []) as Slice[],
    translatables: collectTranslatableLeaves(
      contentTypeDefs[page.pageType].localizedFields,
      content
    ),
  }
  // The complete typed draft of this one generation, pinned with the segments.
  const sourceDraft = pinnedSourceDraft(page.pageType, content)
  const target = await targetLocaleStatus(ctx, page._id, input.targetLocale)
  if (target.hasContent) throw new ConvexError("AI_JOB_TARGET_HAS_CONTENT")
  let segments: Awaited<ReturnType<typeof enumerateSegments>>
  try {
    segments = await enumerateSegments(sourcePage)
  } catch (error) {
    // Over the supported size (60 segments, 5,000 characters of plain text,
    // 200,000 of rich text): refused here, before any reservation.
    if (error instanceof TranslationLimitError)
      throw new ConvexError("AI_JOB_SOURCE_TOO_LARGE")
    throw error
  }
  return {
    ...common,
    kind: "translation" as const,
    title: sourcePage.title,
    locale: input.targetLocale,
    brief: undefined,
    sourceLocale: input.sourceLocale,
    targetLocale: input.targetLocale,
    sourcePage: { ...sourcePage, draft: sourceDraft },
    draftGeneration: state.draftGeneration,
    targetDraftGeneration: target.draftGeneration,
    units: segments.map((segment) => ({
      index: segment.index,
      kind: "translation" as const,
      address: segment.address,
      segmentKind: segment.kind,
      input: segment.text,
      state: "waiting" as const,
      reused: false,
      costMicros: 0,
      attemptKeys: [] as string[],
    })),
  }
}

export const estimatePageJob = query({
  args: { input: inputValidator },
  returns: v.object({
    estimateMicros: v.number(),
    month: monthValidator,
    fits: v.boolean(),
  }),
  handler: async (ctx, { input }) => {
    const owner = await taskGate(ctx, input.kind)
    const prepared = await prepare(ctx, owner, input)
    const estimateMicros = await estimateUnits(ctx, prepared, prepared.units)
    const month = await monthBlock(ctx)
    return { estimateMicros, month, fits: fits(month, estimateMicros) }
  },
})
async function noOtherActive(
  ctx: MutationCtx,
  authId: string,
  except?: Id<"aiJobs">
): Promise<void> {
  for (const state of ["running", "canceling"] as const) {
    const rows = await ctx.db
      .query("aiJobs")
      .withIndex("by_authId_and_state", (q) =>
        q.eq("authId", authId).eq("state", state)
      )
      .take(2)
    for (const row of rows) {
      if (row._id === except) continue
      if (expired(row)) await expire(ctx, row)
      else throw new ConvexError("AI_JOB_ALREADY_ACTIVE")
    }
  }
}
async function readStartGenerations(ctx: MutationCtx, pageId: Id<"pages">) {
  const life = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(2)
  const shared = await ctx.db
    .query("pageSharedDrafts")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(2)
  if (life.length !== 1 || shared.length !== 1)
    throw new ConvexError("AI_JOB_SOURCE_UNAVAILABLE")
  return {
    startLifecycleGeneration: life[0]!.lifecycleGeneration,
    startSharedDraftGeneration: shared[0]!.generation,
  }
}
export const startPageJob = mutation({
  args: { input: inputValidator },
  returns: v.id("aiJobs"),
  handler: async (ctx, { input }): Promise<Id<"aiJobs">> => {
    const authId = await taskGate(ctx, input.kind)
    await enforceAiRateLimit(ctx, { pageOp: true })
    await noOtherActive(ctx, authId)
    const prepared = await prepare(ctx, authId, input)
    const estimateMicros = await estimateUnits(ctx, prepared, prepared.units)
    const pageId: Id<"pages"> =
      input.kind === "translation"
        ? input.pageId
        : await ctx.runMutation(api.cms.pages.create, {
            pageType: "page",
            status: "draft",
            slug: input.meta.slug,
            title: input.meta.title,
            defaultLocale: input.locale,
            content: {
              [input.locale]: {
                title: input.meta.title,
                slices: [],
                ...(input.meta.metaTitle !== undefined
                  ? { metaTitle: input.meta.metaTitle }
                  : {}),
                ...(input.meta.metaDescription !== undefined
                  ? { metaDescription: input.meta.metaDescription }
                  : {}),
              },
            },
          })
    const state = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", prepared.locale)
      )
      .unique()
    if (input.kind === "write" && !state)
      throw new ConvexError("AI_JOB_SOURCE_UNAVAILABLE")
    // Dismiss trashes the new page only while these still hold.
    const startGenerations =
      input.kind === "write" ? await readStartGenerations(ctx, pageId) : {}
    const { units, ...fields } = prepared
    const now = Date.now()
    const jobId = await ctx.db.insert("aiJobs", {
      ...fields,
      sourcePage: fields.sourcePage
        ? {
            ...fields.sourcePage,
            translatables: [...fields.sourcePage.translatables],
          }
        : undefined,
      authId,
      pageId,
      draftGeneration:
        input.kind === "write"
          ? state!.draftGeneration
          : prepared.draftGeneration,
      ...startGenerations,
      state: "running",
      estimateMicros,
      costMicros: 0,
      createdAt: now,
      expiresAt: now + SEVEN_DAYS,
    })
    const reservationKey = await reservePageJob(
      ctx,
      authId,
      jobId,
      estimateMicros
    )
    await ctx.db.patch("aiJobs", jobId, { reservationKey })
    for (const unit of units)
      await ctx.db.insert("aiJobUnits", { ...unit, authId, jobId })
    await ctx.scheduler.runAt(now + SEVEN_DAYS, internal.cms.aiJobs.expireJob, {
      jobId,
    })
    await advance(ctx, (await ctx.db.get("aiJobs", jobId))!)
    return jobId
  },
})

async function finish(
  ctx: MutationCtx,
  job: Job,
  state: "done" | "canceled" | "failed" | "capped"
): Promise<void> {
  const units = await unitsFor(ctx, job._id)
  let suggestion: Job["suggestion"]
  if (state === "done" && job.kind === "translation") {
    if (!job.sourcePage) throw new Error("Missing pinned translation source.")
    suggestion = await assembleTranslation(
      job.sourcePage,
      units.map((unit) => {
        if (!unit.address || typeof unit.output !== "string")
          throw new Error("Missing translation unit output.")
        return { address: unit.address, text: unit.output }
      })
    )
    // Before `sourcePage` is cleared below: the complete translated draft.
    if (job.sourcePage.draft)
      suggestion = {
        ...suggestion,
        draft: translatedDraft(job.sourcePage.draft, suggestion),
      }
  }
  await releasePageJobReservation(ctx, job.reservationKey)
  await ctx.db.patch("aiJobs", job._id, {
    state,
    stopReason: undefined,
    ...(state === "done"
      ? {
          brief: undefined,
          sourcePage: undefined,
          systemPrompt: undefined,
          assistantInstructions: undefined,
          userPromptTemplate: undefined,
          brandVoice: undefined,
          suggestion,
        }
      : {}),
  })
  if (state === "done")
    for (const unit of units)
      await ctx.db.patch("aiJobUnits", unit._id, { input: undefined })
}
async function stop(
  ctx: MutationCtx,
  job: Job,
  reason: Infer<typeof terminalReasons>
): Promise<void> {
  await ctx.db.patch("aiJobs", job._id, {
    state: "canceling",
    stopReason: reason,
  })
  for (const unit of await unitsFor(ctx, job._id))
    if (unit.workId) await pageJobPool.cancel(ctx, unit.workId as WorkId)
}
async function advance(ctx: MutationCtx, job: Job): Promise<void> {
  if (expired(job)) return expire(ctx, job)
  if (!active(job)) return
  const units = await unitsFor(ctx, job._id)
  if (
    units.every((unit) => unit.state === "saved") &&
    !units.some((unit) => unit.workId)
  )
    return finish(ctx, job, "done")
  if (job.state === "canceling") {
    if (!units.some((unit) => unit.workId || unit.state === "inProgress"))
      await finish(ctx, job, job.stopReason ?? "canceled")
    return
  }
  const month = await monthBlock(ctx, job)
  if (!fits(month, 0)) {
    await stop(ctx, job, "capped")
    return advance(ctx, { ...job, state: "canceling", stopReason: "capped" })
  }
  const available =
    (job.kind === "write" ? 1 : 6) - units.filter((unit) => unit.workId).length
  for (const unit of units
    .filter((unit) => unit.state === "waiting" && !unit.workId)
    .slice(0, available)) {
    const workId: WorkId = await pageJobPool.enqueueAction(
      ctx,
      internal.agents.pageJobWorker.runUnit,
      { jobId: job._id, unitId: unit._id },
      {
        retry: false,
        onComplete: internal.cms.aiJobs.onComplete,
        context: { jobId: job._id, unitId: unit._id },
      }
    )
    await ctx.db.patch("aiJobUnits", unit._id, { workId })
  }
}
export const cancelPageJob = mutation({
  args: { jobId: v.id("aiJobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }): Promise<null> => {
    const job = await ownedJobNoTaskGate(ctx, jobId)
    if (expired(job)) await expire(ctx, job)
    else if (active(job)) {
      await stop(ctx, job, "canceled")
      await advance(ctx, { ...job, state: "canceling", stopReason: "canceled" })
    }
    return null
  },
})
export const resumePageJob = mutation({
  args: { jobId: v.id("aiJobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }): Promise<null> => {
    const job = await ownedJob(ctx, jobId)
    if (
      job.reviewedAt !== undefined ||
      expired(job) ||
      !["canceled", "failed", "capped"].includes(job.state)
    )
      throw new ConvexError("AI_JOB_NOT_RESUMABLE")
    const units = await unitsFor(ctx, jobId)
    if (await jobIsStillSettling(ctx, units))
      throw new ConvexError("AI_JOB_STILL_SETTLING")
    await noOtherActive(ctx, job.authId, jobId)
    await enforceAiRateLimit(ctx, { pageOp: true })
    await requireJobProvider(ctx, job)
    const estimateMicros = await estimateUnits(ctx, job, units)
    const reservationKey = await reservePageJob(
      ctx,
      job.authId,
      jobId,
      estimateMicros
    )
    for (const unit of units)
      await ctx.db.patch(
        "aiJobUnits",
        unit._id,
        unit.state === "saved"
          ? { reused: true }
          : { state: "waiting", claimToken: undefined }
      )
    await ctx.db.patch("aiJobs", jobId, {
      state: "running",
      stopReason: undefined,
      reservationKey,
      estimateMicros,
    })
    await advance(ctx, {
      ...job,
      state: "running",
      stopReason: undefined,
      reservationKey,
      estimateMicros,
    })
    return null
  },
})

export const claimUnit = internalMutation({
  args: { jobId: v.id("aiJobs"), unitId: v.id("aiJobUnits") },
  returns: v.union(
    v.object({
      job: schema.doc("aiJobs"),
      unit: schema.doc("aiJobUnits"),
      units: v.array(schema.doc("aiJobUnits")),
      claimToken: v.string(),
    }),
    v.null()
  ),
  handler: async (
    ctx,
    { jobId, unitId }
  ): Promise<{
    job: Job
    unit: Unit
    units: Unit[]
    claimToken: string
  } | null> => {
    const job = await ctx.db.get("aiJobs", jobId),
      unit = await ctx.db.get("aiJobUnits", unitId)
    if (!job || !unit || unit.jobId !== jobId) return null
    if (expired(job)) {
      await expire(ctx, job)
      return null
    }
    if (job.state !== "running" || unit.state !== "waiting") return null
    try {
      const guard = await resolveOptionalModuleGuardState(ctx, "ai")
      if (!guard.effective) throw new ConvexError("CMS_MODULE_DISABLED")
      if (guard.readiness !== "ready")
        throw new ConvexError("CMS_MODULE_NOT_READY")
      if (job.kind === "translation") await requireAiTranslationModule(ctx)
      await requireJobProvider(ctx, job)
    } catch (error) {
      if (
        !(error instanceof ConvexError) ||
        ![
          "CMS_MODULE_DISABLED",
          "CMS_MODULE_NOT_READY",
          "AI_JOB_PROVIDER_UNAVAILABLE",
        ].includes(error.data as string)
      )
        throw error
      await stop(ctx, job, "canceled")
      return null
    }
    if (!fits(await monthBlock(ctx, job), 0)) {
      await stop(ctx, job, "capped")
      return null
    }
    const claimToken = crypto.randomUUID()
    await ctx.db.patch("aiJobUnits", unitId, {
      state: "inProgress",
      claimToken,
    })
    return {
      job,
      unit: { ...unit, state: "inProgress", claimToken },
      // Only a write job reads its siblings (earlier sections as context), and
      // it runs one unit at a time. A translation runs up to six workers that
      // each write their own unit row: a range read of all rows here made
      // parallel claims conflict, so a translation claim returns none.
      units: job.kind === "write" ? await unitsFor(ctx, jobId) : [],
      claimToken,
    }
  },
})
export const saveUnit = internalMutation({
  args: {
    jobId: v.id("aiJobs"),
    unitId: v.id("aiJobUnits"),
    claimToken: v.string(),
    output: v.union(installedSliceValidator, v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const job = await ctx.db.get("aiJobs", args.jobId),
      unit = await ctx.db.get("aiJobUnits", args.unitId)
    if (
      !job ||
      !unit ||
      unit.jobId !== job._id ||
      expired(job) ||
      unit.state !== "inProgress" ||
      unit.claimToken !== args.claimToken
    )
      return false
    if (
      (job.kind === "write") !== (typeof args.output === "object") ||
      unit.attemptKeys.length === 0
    )
      return false
    if (await unitHasOpenAttempt(ctx, unit)) return false
    await ctx.db.patch("aiJobUnits", unit._id, {
      state: "saved",
      output: args.output,
    })
    return true
  },
})
export const onComplete = internalMutation({
  args: vOnCompleteValidator(
    v.object({ jobId: v.id("aiJobs"), unitId: v.id("aiJobUnits") })
  ),
  returns: v.null(),
  handler: async (ctx, { context, workId }): Promise<null> => {
    try {
      // A failed callback is not evidence that a successful output was unsaved.
      const unit = await ctx.db.get("aiJobUnits", context.unitId)
      const job = await ctx.db.get("aiJobs", context.jobId)
      if (!unit || !job || unit.jobId !== job._id || unit.workId !== workId)
        return null
      if (expired(job)) {
        await expire(ctx, job)
        return null
      }
      await ctx.db.patch("aiJobUnits", unit._id, {
        workId: undefined,
        ...(unit.state === "saved"
          ? {}
          : {
              state:
                job.state === "canceling" && unit.state === "waiting"
                  ? ("waiting" as const)
                  : ("failed" as const),
            }),
      })
      let next = job
      if (unit.state !== "saved" && job.state === "running") {
        const stopReason = fits(await monthBlock(ctx, job), 0)
          ? "failed"
          : "capped"
        await stop(ctx, job, stopReason)
        next = { ...job, state: "canceling", stopReason }
      }
      await advance(ctx, next)
    } catch {
      console.error("AI_PAGE_JOB_COMPLETION_FAILED")
    }
    return null
  },
})
async function expire(ctx: MutationCtx, job: Job): Promise<void> {
  if (job.state === "expired") return
  for (const unit of await unitsFor(ctx, job._id)) {
    if (unit.workId) await pageJobPool.cancel(ctx, unit.workId as WorkId)
    await ctx.db.patch("aiJobUnits", unit._id, {
      input: undefined,
      output: undefined,
      purpose: undefined,
      workId: undefined,
      claimToken: undefined,
    })
  }
  await releasePageJobReservation(ctx, job.reservationKey)
  await ctx.db.patch("aiJobs", job._id, {
    state: "expired",
    brief: undefined,
    sourcePage: undefined,
    suggestion: undefined,
    systemPrompt: undefined,
    assistantInstructions: undefined,
    userPromptTemplate: undefined,
    brandVoice: undefined,
    stopReason: undefined,
  })
}
export const expireJob = internalMutation({
  args: { jobId: v.id("aiJobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }): Promise<null> => {
    const job = await ctx.db.get("aiJobs", jobId)
    if (job && expired(job)) await expire(ctx, job)
    return null
  },
})
/**
 * The text a reader of the page sees in one field: only editorial `text` and
 * `richText` values, found through `group` and `list` at any depth. Links,
 * images, selects, relations, ids and every other kind add nothing (the same
 * rule as `collectTranslatableLeaves`). A link's own label, if any, is stored
 * as a separate `text` field, so it is read there.
 */
function readableFieldText(
  def: Primitive,
  value: unknown,
  parts: string[],
  sliceType: string,
  path: string,
  translation = false
): void {
  if (def.kind === "text" || def.kind === "richText") {
    if (!isEditorialTextPrimitive(def) || typeof value !== "string") return
    // A translation review shows only text a translation may change.
    if (translation && def.kind === "text" && !isTranslatableTextPrimitive(def))
      return
    if (def.kind === "text") {
      pushDescriptorText(def, value, parts, sliceType, path)
      return
    }
    const plain = richTextToPlainText(value)
    if (plain) parts.push(plain)
    return
  }
  if (def.kind === "group") {
    const fields = def.config.fields as Record<string, Primitive>
    const object =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    for (const [key, child] of Object.entries(fields))
      readableFieldText(
        child,
        object[key],
        parts,
        sliceType,
        `${path}.${key}`,
        translation
      )
    return
  }
  if (def.kind === "list" && Array.isArray(value))
    value.forEach((row, index) =>
      readableFieldText(
        def.config.item as Primitive,
        row,
        parts,
        sliceType,
        `${path}[${index}]`,
        translation
      )
    )
}
/** Readable text of one slice, uncut, as an ordered field list for the review view. */
function sliceTextFields(
  slice: Slice,
  translation = false
): { label: string; text: string }[] {
  const read = readSlice(slice)
  const def = readSliceDefinition(read.type)
  const fields: { label: string; text: string }[] = []
  // A type without a definition shows nothing rather than a dump of its values.
  if (!def) return fields
  const add = (
    label: string,
    primitive: Primitive,
    value: unknown,
    path: string
  ) => {
    const parts: string[] = []
    readableFieldText(primitive, value, parts, read.type, path, translation)
    const text = parts.join("\n").trim()
    if (text) fields.push({ label, text })
  }
  const humanize = (key: string) =>
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/^./, (c) => c.toUpperCase())
  if (def.primary.kind === "group") {
    const group = def.primary.config.fields as Record<string, Primitive>
    const value = (read.primary ?? {}) as Record<string, unknown>
    for (const [key, child] of Object.entries(group))
      add(humanize(key), child, value[key], `primary.${key}`)
  } else add("Content", def.primary, read.primary, "primary")
  if (def.items !== undefined && "items" in read)
    add("Items", def.items, read.items, "items")
  return fields
}
const lifecycleFor = async (ctx: Ctx, pageId: Id<"pages">) => {
  const rows = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(2)
  return rows.length === 1 ? rows[0]! : null
}
const readableFieldValidator = v.object({
  label: v.string(),
  text: v.string(),
})
/** Readable rows of a translated page's own text: title, meta, other text fields. */
function translationPageFields(
  suggestion: NonNullable<Job["suggestion"]>
): { label: string; text: string }[] {
  const rows: { label: string; text: string }[] = [
    { label: "Title", text: suggestion.title },
  ]
  if (suggestion.metaTitle)
    rows.push({ label: "Meta title", text: suggestion.metaTitle })
  if (suggestion.metaDescription)
    rows.push({ label: "Meta description", text: suggestion.metaDescription })
  for (const leaf of suggestion.translatables) {
    const text =
      leaf.kind === "richText" ? richTextToPlainText(leaf.value) : leaf.value
    if (!text.trim()) continue
    const name = leaf.path
      .replace(/\[\d+\]/g, "")
      .split(".")
      .filter(Boolean)
    const last = name[name.length - 1] ?? leaf.path
    rows.push({
      label: last
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/^./, (c) => c.toUpperCase()),
      text: text.trim(),
    })
  }
  return rows
}
export const pageJobResult = query({
  args: { jobId: v.id("aiJobs") },
  returns: v.object({
    jobId: v.id("aiJobs"),
    kind: v.union(v.literal("write"), v.literal("translation")),
    pageId: v.id("pages"),
    title: v.string(),
    locale: v.string(),
    pageAvailable: v.boolean(),
    // Translation jobs only. `pageFields` are the translated page's own text
    // (Title first, then Meta title and Meta description when present);
    // `sections` are its translated sections, in page order.
    sourceLocale: v.optional(v.string()),
    targetLocale: v.optional(v.string()),
    sourceChanged: v.optional(v.boolean()),
    pageFields: v.optional(v.array(readableFieldValidator)),
    sections: v.array(
      v.object({
        index: v.number(),
        sliceType: v.string(),
        purpose: v.string(),
        fields: v.array(readableFieldValidator),
      })
    ),
  }),
  handler: async (ctx, { jobId }) => {
    const job = await ownedJob(ctx, jobId)
    if (
      job.state !== "done" ||
      expired(job) ||
      job.reviewedAt !== undefined ||
      (job.kind === "translation" && !job.suggestion)
    )
      throw new ConvexError("AI_JOB_NOT_REVIEWABLE")
    const pageAvailable =
      (await lifecycleFor(ctx, job.pageId))?.lifecycleState === "active"
    if (job.kind === "translation") {
      const suggestion = job.suggestion!
      const sourceState = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", job.pageId).eq("locale", job.sourceLocale!)
        )
        .take(2)
      return {
        jobId,
        kind: "translation" as const,
        pageId: job.pageId,
        title: job.title,
        locale: job.locale,
        pageAvailable,
        sourceLocale: job.sourceLocale!,
        targetLocale: job.targetLocale!,
        // The source language's draft moved on since Start (or is gone).
        sourceChanged:
          sourceState.length !== 1 ||
          sourceState[0]!.draftGeneration !== job.draftGeneration,
        pageFields: translationPageFields(suggestion),
        sections: suggestion.slices.map((slice, index) => ({
          index,
          sliceType: readSlice(slice).type,
          purpose: "",
          fields: sliceTextFields(slice, true),
        })),
      }
    }
    const rows = await unitsFor(ctx, jobId)
    const sections = rows
      .filter(
        (unit) => unit.state === "saved" && typeof unit.output === "object"
      )
      .sort((a, b) => a.index - b.index)
      .map((unit) => {
        const output = unit.output as Slice
        return {
          index: unit.index,
          sliceType: unit.sliceType ?? readSlice(output).type,
          purpose: unit.purpose ?? "",
          fields: sliceTextFields(output),
        }
      })
    return {
      jobId,
      kind: "write" as const,
      pageId: job.pageId,
      title: job.title,
      locale: job.locale,
      pageAvailable,
      sections,
    }
  },
})
/**
 * The content and address the editor would load for this language: the working
 * draft while its generation is current, otherwise the verified snapshot base
 * (publishing removes the draft row). Same rule as `pages.getForEdit`.
 */
async function currentLocaleSource(
  ctx: Ctx,
  page: Doc<"pages">,
  state: Doc<"pageLocalePublicationStates">
): Promise<{ slug: string; content: Record<string, unknown> }> {
  const drafts = await ctx.db
    .query("pageLocaleDrafts")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", page._id).eq("locale", state.locale)
    )
    .take(2)
  if (drafts.length > 1) throw new ConvexError("AI_JOB_SOURCE_UNAVAILABLE")
  const draft = drafts[0]
  if (draft && draft.generation === state.draftGeneration)
    return {
      slug: draft.slug,
      content: draft.content as unknown as Record<string, unknown>,
    }
  if (state.draftBaseSnapshotId) {
    const base = await readFrozenSnapshotProjection(
      ctx,
      state.draftBaseSnapshotId,
      page._id,
      state.locale
    )
    if (base && base.payload.page.pageType === page.pageType)
      return {
        slug: base.payload.localized.slug,
        content: base.payload.localized.content as unknown as Record<
          string,
          unknown
        >,
      }
  }
  throw new ConvexError("AI_JOB_SOURCE_UNAVAILABLE")
}
/** B3: the temporary copies of a finished job (pinned source, suggestion, unit text). */
async function deleteJobCopies(ctx: MutationCtx, job: Job): Promise<void> {
  for (const unit of await unitsFor(ctx, job._id))
    await ctx.db.patch("aiJobUnits", unit._id, {
      input: undefined,
      output: undefined,
    })
  await ctx.db.patch("aiJobs", job._id, {
    sourcePage: undefined,
    suggestion: undefined,
  })
}
/**
 * Accept a whole-page translation: build the target language's draft from the
 * suggestion and save it through the editor's own draft save (its stale and
 * slice checks apply). The save runs before the copies are deleted, and any
 * refusal rolls the whole mutation back, so a refused job keeps its suggestion.
 * The target must be exactly as it was at Start. Never publishes.
 */
async function acceptTranslation(
  ctx: MutationCtx,
  job: Job,
  chosen: number[]
): Promise<{ pageId: Id<"pages">; saved: number; draftGeneration: number }> {
  // One Accept saves the whole page: the list must be empty, meaning all.
  if (chosen.length > 0) throw new ConvexError("AI_JOB_INPUT_INVALID")
  const suggestion = job.suggestion
  if (job.state !== "done" || !suggestion)
    throw new ConvexError("AI_JOB_NOT_REVIEWABLE")
  const life = await lifecycleFor(ctx, job.pageId)
  const page = await ctx.db.get("pages", job.pageId)
  if (!life || !page) throw new ConvexError("AI_JOB_SOURCE_UNAVAILABLE")
  const targetStates = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", job.pageId).eq("locale", job.locale)
    )
    .take(2)
  if (targetStates.length > 1)
    throw new ConvexError("AI_JOB_SOURCE_UNAVAILABLE")
  const targetGeneration = targetStates[0]?.draftGeneration ?? 0
  if (targetGeneration !== (job.targetDraftGeneration ?? 0))
    throw new ConvexError("AI_JOB_TARGET_CHANGED")
  // The draft pinned at Start with the translation applied. A job made before
  // it existed cannot be accepted (Dismiss still works): the missing baseline
  // is never rebuilt from the live source.
  const pinned = suggestion.draft
  if (!pinned) throw new ConvexError("AI_JOB_NOT_REVIEWABLE")
  const localized = structuredClone(pinned.localized) as Record<string, unknown>
  // The editor gives a translated section its own id in the new language.
  const slices =
    "slices" in pinned
      ? pinned.slices.map((slice) => ({
          ...structuredClone(slice),
          id: crypto.randomUUID(),
        }))
      : undefined
  // Copied sections carry their presentation choice with fresh ids, which are
  // new assignments. Like Duplicate (`pages.ts`), pass the transaction's
  // catalog revision so they are checked for eligibility; an archived or
  // unavailable choice still refuses.
  const saved = await ctx.runMutation(api.cms.publication.saveEditorDraft, {
    pageId: job.pageId,
    expectedLifecycleGeneration: life.lifecycleGeneration,
    ...(hasExplicitSlicePresentations([
      { [job.locale]: { ...localized, ...(slices ? { slices } : {}) } },
    ])
      ? {
          expectedPresentationCatalogRevision: (
            await readEffectiveSlicePresentationCatalog(ctx)
          ).revision,
        }
      : {}),
    localized: {
      locale: job.locale,
      // The editor's first save of an untranslated language: an address made
      // from the translated title, "generated" so a clash gets a free address.
      slug: slugify(suggestion.title),
      addressIntent: "generated",
      draft: {
        pageType: pinned.pageType,
        localized,
        ...(slices ? { slices } : {}),
      } as never,
      expectedGeneration: targetGeneration,
    },
  })
  await deleteJobCopies(ctx, job)
  await ctx.db.patch("aiJobs", job._id, { reviewedAt: Date.now() })
  return {
    pageId: job.pageId,
    saved: slices?.length ?? 0,
    draftGeneration: saved.draftGeneration ?? targetGeneration + 1,
  }
}
/**
 * Save the chosen sections below what the owner already has, through the
 * editor's own draft save (its stale checks and slice rules apply). Never publishes.
 */
export const acceptPageJob = mutation({
  args: { jobId: v.id("aiJobs"), chosen: v.array(v.number()) },
  returns: v.object({
    pageId: v.id("pages"),
    saved: v.number(),
    // The target language's draft generation after the save; absent when
    // nothing was saved (already reviewed).
    draftGeneration: v.optional(v.number()),
  }),
  handler: async (
    ctx,
    { jobId, chosen }
  ): Promise<{
    pageId: Id<"pages">
    saved: number
    draftGeneration?: number
  }> => {
    const job = await ownedJob(ctx, jobId)
    if (job.reviewedAt !== undefined) return { pageId: job.pageId, saved: 0 }
    if (expired(job)) {
      await expire(ctx, job)
      throw new ConvexError("AI_JOB_EXPIRED")
    }
    if (job.kind === "translation") return acceptTranslation(ctx, job, chosen)
    if (job.state !== "done") throw new ConvexError("AI_JOB_NOT_REVIEWABLE")
    const saved = (await unitsFor(ctx, jobId)).filter(
      (unit) => unit.state === "saved" && typeof unit.output === "object"
    )
    const known = new Set(saved.map((unit) => unit.index))
    if (
      chosen.length < 1 ||
      new Set(chosen).size !== chosen.length ||
      chosen.some((index) => !known.has(index))
    )
      throw new ConvexError("AI_JOB_INPUT_INVALID")
    const chosenSlices = saved
      .filter((unit) => chosen.includes(unit.index))
      .sort((a, b) => a.index - b.index)
      .map((unit) => unit.output as Slice)
    const life = await lifecycleFor(ctx, job.pageId)
    const page = await ctx.db.get("pages", job.pageId)
    const stateRows = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", job.pageId).eq("locale", job.locale)
      )
      .take(2)
    if (!life || !page || stateRows.length !== 1)
      throw new ConvexError("AI_JOB_SOURCE_UNAVAILABLE")
    const source = await currentLocaleSource(ctx, page, stateRows[0]!)
    const { slices: current = [], ...localized } = source.content as {
      slices?: Slice[]
      [key: string]: unknown
    }
    // AI-written sections carry no presentation choice (`assembleSlice` sets
    // none) and existing ones are not new assignments, so no catalog revision
    // is needed here.
    const result = await ctx.runMutation(api.cms.publication.saveEditorDraft, {
      pageId: job.pageId,
      expectedLifecycleGeneration: life.lifecycleGeneration,
      localized: {
        locale: job.locale,
        slug: source.slug,
        // The editor sends "typed" for an address the owner did not touch.
        addressIntent: "typed",
        draft: {
          pageType: page.pageType,
          localized,
          slices: [...current, ...chosenSlices],
        } as never,
        expectedGeneration: stateRows[0]!.draftGeneration,
      },
    })
    await ctx.db.patch("aiJobs", jobId, { reviewedAt: Date.now() })
    return {
      pageId: job.pageId,
      saved: chosenSlices.length,
      ...(result.draftGeneration !== undefined
        ? { draftGeneration: result.draftGeneration }
        : {}),
    }
  },
})
/** The only place that decides whether a job-created page is untouched. */
async function jobPageIsUntouched(ctx: Ctx, job: Job): Promise<boolean> {
  if (
    job.kind !== "write" ||
    job.startLifecycleGeneration === undefined ||
    job.startSharedDraftGeneration === undefined
  )
    return false
  const life = await lifecycleFor(ctx, job.pageId)
  if (
    !life ||
    life.lifecycleState !== "active" ||
    life.lifecycleGeneration !== job.startLifecycleGeneration
  )
    return false
  const shared = await ctx.db
    .query("pageSharedDrafts")
    .withIndex("by_pageId", (q) => q.eq("pageId", job.pageId))
    .take(2)
  if (
    shared.length !== 1 ||
    shared[0]!.generation !== job.startSharedDraftGeneration
  )
    return false
  const states = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", job.pageId))
    .take(2)
  const state = states[0]
  return (
    states.length === 1 &&
    state!.locale === job.locale &&
    state!.draftGeneration === job.draftGeneration &&
    state!.publicGeneration === 0 &&
    !state!.hasCurrentSnapshot &&
    state!.currentSnapshotId === undefined
  )
}
/**
 * The one decision both the Dismiss preview and Dismiss itself read: the job
 * page is untouched, is not the home page, and Trash would not be refused for
 * a live menu link (or a published post naming an author page).
 */
async function jobPageTrashEligible(ctx: Ctx, job: Job): Promise<boolean> {
  if (!(await jobPageIsUntouched(ctx, job))) return false
  // Raw setting, as the Trash path reads it.
  const settings = await ctx.db.query("siteSettings").take(2)
  if (settings.length === 1 && settings[0]!.homePageId === job.pageId)
    return false
  try {
    await assertSnapshotPageSoftDeleteAllowed(ctx, job.pageId)
  } catch (error) {
    if (error instanceof ConvexError) return false
    throw error
  }
  return true
}
/** Clears a finished job. A Write job's page goes to Trash only if untouched. */
export const dismissPageJob = mutation({
  args: { jobId: v.id("aiJobs") },
  returns: v.object({ pageMovedToTrash: v.boolean() }),
  handler: async (ctx, { jobId }): Promise<{ pageMovedToTrash: boolean }> => {
    let job = await ownedJobNoTaskGate(ctx, jobId)
    if (job.reviewedAt !== undefined) return { pageMovedToTrash: false }
    if (expired(job)) {
      await expire(ctx, job)
      job = { ...job, state: "expired" }
    }
    if (active(job)) throw new ConvexError("AI_JOB_NOT_REVIEWABLE")
    let pageMovedToTrash = false
    if (await jobPageTrashEligible(ctx, job)) {
      const life = (await lifecycleFor(ctx, job.pageId))!
      try {
        await ctx.runMutation(api.cms.publication.softDeletePage, {
          pageId: job.pageId,
          expectedLifecycleGeneration: life.lifecycleGeneration,
        })
        pageMovedToTrash = true
      } catch (error) {
        // Any doubt keeps the page; the job is still cleared.
        if (!(error instanceof ConvexError)) throw error
      }
    }
    // B3: Dismiss deletes a translation job's suggestion and unit text.
    if (job.kind === "translation" && job.state !== "expired")
      await deleteJobCopies(ctx, job)
    await ctx.db.patch("aiJobs", jobId, { reviewedAt: Date.now() })
    return { pageMovedToTrash }
  },
})
const unitProgressValidator = v.object({
  index: v.number(),
  kind: v.union(v.literal("write"), v.literal("translation")),
  sliceType: v.optional(v.string()),
  purpose: v.optional(v.string()),
  segmentIndex: v.optional(v.number()),
  address: v.optional(v.string()),
  state: unitStateValidator,
  reused: v.boolean(),
  costMicros: v.number(),
})
export const pageJobProgress = query({
  args: {},
  returns: v.array(
    v.object({
      jobId: v.id("aiJobs"),
      kind: v.union(v.literal("write"), v.literal("translation")),
      title: v.string(),
      locale: v.string(),
      state: aiPageJobStateValidator,
      pageId: v.id("pages"),
      sourceLocale: v.optional(v.string()),
      targetLocale: v.optional(v.string()),
      estimateMicros: v.number(),
      costMicros: v.number(),
      createdAt: v.number(),
      expiresAt: v.number(),
      failedIndex: v.optional(v.number()),
      reusedCount: v.number(),
      canResume: v.boolean(),
      resumeEstimateMicros: v.number(),
      /** What Dismiss would do to the page now; the same test Dismiss uses. */
      dismissMovesPageToTrash: v.boolean(),
      month: monthValidator,
      units: v.array(unitProgressValidator),
    })
  ),
  handler: async (ctx) => {
    const owner = await requireOwnerAndOptionalModule(ctx, "ai")
    const jobs = await ctx.db
      .query("aiJobs")
      .withIndex("by_authId_and_reviewedAt", (q) =>
        q.eq("authId", owner.authId).eq("reviewedAt", undefined)
      )
      .order("desc")
      .take(100)
    const result = []
    for (const job of jobs) {
      // Owner and AI-module refusals already failed above. A translation job
      // whose Multilingual gate is not ready is hidden, not an error.
      if (job.kind === "translation")
        try {
          await requireAiTranslationModule(ctx)
        } catch (error) {
          if (
            error instanceof ConvexError &&
            error.data === "CMS_MODULE_NOT_READY"
          )
            continue
          throw error
        }
      const units = expired(job) ? [] : await unitsFor(ctx, job._id)
      const month = await monthBlock(ctx, job)
      let resumeEstimateMicros = 0,
        canResume = false
      if (
        !expired(job) &&
        ["canceled", "failed", "capped"].includes(job.state) &&
        !(await jobIsStillSettling(ctx, units))
      ) {
        try {
          await requireJobProvider(ctx, job)
          resumeEstimateMicros = await estimateUnits(ctx, job, units)
          const others = await ctx.db
            .query("aiJobs")
            .withIndex("by_authId_and_state", (q) =>
              q.eq("authId", owner.authId).eq("state", "running")
            )
            .take(1)
          const canceling = await ctx.db
            .query("aiJobs")
            .withIndex("by_authId_and_state", (q) =>
              q.eq("authId", owner.authId).eq("state", "canceling")
            )
            .take(1)
          canResume =
            ![...others, ...canceling].some((other) => !expired(other)) &&
            fits(await monthBlock(ctx), resumeEstimateMicros)
        } catch {
          /* Unpriced or unavailable work is not resumable. */
        }
      }
      result.push({
        jobId: job._id,
        kind: job.kind,
        title: job.title,
        locale: job.locale,
        state: expired(job) ? ("expired" as const) : job.state,
        pageId: job.pageId,
        ...(job.sourceLocale ? { sourceLocale: job.sourceLocale } : {}),
        ...(job.targetLocale ? { targetLocale: job.targetLocale } : {}),
        estimateMicros: job.estimateMicros,
        costMicros: job.costMicros,
        createdAt: job.createdAt,
        expiresAt: job.expiresAt,
        ...(units.some((unit) => unit.state === "failed")
          ? {
              failedIndex: units.find((unit) => unit.state === "failed")!.index,
            }
          : {}),
        reusedCount: units.filter((unit) => unit.reused).length,
        canResume,
        resumeEstimateMicros,
        // Follows Dismiss's own order: expired is allowed, then a running or
        // canceling job is refused, then the shared Trash decision.
        dismissMovesPageToTrash:
          expired(job) || !active(job)
            ? await jobPageTrashEligible(ctx, job)
            : false,
        month,
        units: units.map((unit) => ({
          index: unit.index,
          kind: unit.kind,
          ...(unit.sliceType ? { sliceType: unit.sliceType } : {}),
          ...(unit.purpose ? { purpose: unit.purpose } : {}),
          ...(unit.kind === "translation"
            ? { segmentIndex: unit.index, address: unit.address }
            : {}),
          state: unit.state,
          reused: unit.reused,
          costMicros: unit.costMicros,
        })),
      })
    }
    return result
  },
})

/** B5: erase active roots first; every late claim/save fences by their absence. */
export async function erasePageJobsForUser(
  ctx: MutationCtx,
  authId: string
): Promise<boolean> {
  const running = await ctx.db
    .query("aiJobs")
    .withIndex("by_authId_and_state", (q) =>
      q.eq("authId", authId).eq("state", "running")
    )
    .take(2)
  const canceling = await ctx.db
    .query("aiJobs")
    .withIndex("by_authId_and_state", (q) =>
      q.eq("authId", authId).eq("state", "canceling")
    )
    .take(2)
  const batch = await ctx.db
    .query("aiJobs")
    .withIndex("by_authId_and_reviewedAt", (q) => q.eq("authId", authId))
    .take(5)
  const jobs = new Map(
    [...running, ...canceling, ...batch].map((job) => [job._id, job])
  )
  for (const job of jobs.values()) {
    const units = await unitsFor(ctx, job._id)
    for (const unit of units) {
      if (unit.workId) await pageJobPool.cancel(ctx, unit.workId as WorkId)
      for (const attemptKey of unit.attemptKeys)
        await settleAttempt(ctx, { attemptKey, outcome: "failed" })
    }
    const reservations = await ctx.db
      .query("aiSpendingJobReservations")
      .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
      .take(200)
    for (const reservation of reservations) {
      await releasePageJobReservation(ctx, reservation.reservationKey)
      await ctx.db.delete("aiSpendingJobReservations", reservation._id)
    }
    for (const unit of units) await ctx.db.delete("aiJobUnits", unit._id)
    await ctx.db.delete("aiJobs", job._id)
  }
  // Old Resume reservations can outnumber one batch. Drain identifying
  // remnants even after their job root has already been removed.
  const remaining = await ctx.db
    .query("aiSpendingJobReservations")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .take(200)
  for (const reservation of remaining) {
    await releasePageJobReservation(ctx, reservation.reservationKey)
    await ctx.db.delete("aiSpendingJobReservations", reservation._id)
  }
  return batch.length === 5 || remaining.length === 200
}
