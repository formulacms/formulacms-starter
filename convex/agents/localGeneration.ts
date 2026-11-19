import { writePostAdmissionAudit } from "../cms/ai"
import { ConvexError, v, type Infer, type ObjectType } from "convex/values"
import { internal } from "../_generated/api"
import { action, internalQuery, mutation } from "../_generated/server"
import type { MutationCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"
import { getActor } from "../lib/access/actor"
import { readOwnerState } from "../lib/access/owner"
import { requireOperationAccess } from "../lib/access/policy"
import { requireOwnerAndOptionalModule } from "../lib/modules/state"
import { enforceAiAuditRateLimit, enforceAiRateLimit } from "../lib/aiRateLimit"
import { AGENTS, type AgentId } from "../lib/agents/registry"
import {
  aiAttemptCountValidator,
  generationEngineValidator,
  generationIdentityEvidenceValidator,
  localToolFundingValidator,
  reasoningEffortValidator,
  taskProfileValidator,
  workflowPhaseValidator,
} from "../lib/aiValidators"
import { verifyLocalAiAuditProof } from "../lib/localAiAuditProof"
import type { WorkflowPhase } from "../../lib/ai/execution-contract"
import {
  assistantForProfile,
  resolveAssistantInstructions,
} from "../../lib/ai/task-profiles"

export const localGenerationKindValidator = v.union(
  v.literal("field-translate"),
  v.literal("page-translate"),
  v.literal("field-generate"),
  v.literal("field-refine"),
  v.literal("slice-generate"),
  v.literal("page-generate-fill"),
  v.literal("page-generate-meta"),
  v.literal("page-generate-outline"),
  v.literal("help-answer"),
  // Block creator (internal name Slice creator): one kind per profile, so the
  // spec steps (create, tweak, text-only create) share `slice-spec`.
  v.literal("slice-spec"),
  v.literal("slice-renderer"),
  // One unit of a whole-page job run by the local job runner. Only
  // `recordLocalJobUnitAudit` writes these, stored as page-generate-fill and
  // page-translate rows.
  v.literal("page-job-write"),
  v.literal("page-job-translation")
)

export type LocalGenerationKind =
  | "field-translate"
  | "page-translate"
  | "field-generate"
  | "field-refine"
  | "slice-generate"
  | "page-generate-fill"
  | "page-generate-meta"
  | "page-generate-outline"
  | "help-answer"
  | "slice-spec"
  | "slice-renderer"
  | "page-job-write"
  | "page-job-translation"

// Community authorizes every local-generation task through the one F01
// operation-access seam, so the task table no longer carries a permission
// slug. Task identity still drives agent, profile, phase and rate-limit shape.
type PreflightTask = {
  agent: AgentId
  profile: LocalGenerationProfile
  phase: WorkflowPhase
  pageOp: boolean
  usesUserPrompt: boolean
  usesBrandVoice: boolean
}

// The Block creator has no Convex agent definition and no saved prompt: its
// prompts and Instructions live with the dev-only Next server actions
// (`slices/ai-actions.ts`), so it is audit-only here and `preflight` refuses it.
type AuditOnlyTask = {
  agent: null
  profile: BlockCreatorProfile
  phase: WorkflowPhase
  pageOp: false
  usesUserPrompt: false
  usesBrandVoice: false
}

type LocalGenerationTask = PreflightTask | AuditOnlyTask

type LocalGenerationProfile =
  | "mechanical-translation"
  | "brand-translation"
  | "editorial-copy"
  | "structured-outline-meta"
  | "grounded-help"

type BlockCreatorProfile = "vision-spec" | "renderer-jsx"

const LOCAL_GENERATION_TASKS: Record<LocalGenerationKind, LocalGenerationTask> =
  {
    "field-translate": {
      agent: "translation",
      profile: "mechanical-translation",
      phase: "translation",
      pageOp: false,
      usesUserPrompt: true,
      usesBrandVoice: false,
    },
    "page-translate": {
      agent: "translation",
      profile: "brand-translation",
      phase: "translation",
      pageOp: true,
      usesUserPrompt: true,
      usesBrandVoice: false,
    },
    "field-generate": {
      agent: "content",
      profile: "editorial-copy",
      phase: "content-generation",
      pageOp: false,
      usesUserPrompt: true,
      usesBrandVoice: true,
    },
    "field-refine": {
      agent: "content",
      profile: "editorial-copy",
      phase: "content-refinement",
      pageOp: false,
      usesUserPrompt: false,
      usesBrandVoice: true,
    },
    "slice-generate": {
      agent: "content",
      profile: "editorial-copy",
      phase: "content-generation",
      pageOp: false,
      usesUserPrompt: true,
      usesBrandVoice: true,
    },
    "page-generate-fill": {
      agent: "content",
      profile: "editorial-copy",
      phase: "page-fill",
      pageOp: false,
      usesUserPrompt: true,
      usesBrandVoice: true,
    },
    "page-generate-meta": {
      agent: "content",
      profile: "structured-outline-meta",
      phase: "page-meta",
      pageOp: true,
      usesUserPrompt: false,
      usesBrandVoice: true,
    },
    "page-generate-outline": {
      agent: "content",
      profile: "structured-outline-meta",
      phase: "page-outline",
      pageOp: true,
      usesUserPrompt: true,
      usesBrandVoice: true,
    },
    "help-answer": {
      agent: "help-assistant",
      profile: "grounded-help",
      phase: "help-answer",
      pageOp: false,
      usesUserPrompt: true,
      usesBrandVoice: false,
    },
    "slice-spec": {
      agent: null,
      profile: "vision-spec",
      phase: "slice-spec",
      pageOp: false,
      usesUserPrompt: false,
      usesBrandVoice: false,
    },
    "slice-renderer": {
      agent: null,
      profile: "renderer-jsx",
      phase: "renderer-jsx",
      pageOp: false,
      usesUserPrompt: false,
      usesBrandVoice: false,
    },
    "page-job-write": {
      agent: "content",
      profile: "editorial-copy",
      phase: "page-fill",
      pageOp: true,
      usesUserPrompt: true,
      usesBrandVoice: true,
    },
    "page-job-translation": {
      agent: "translation",
      profile: "brand-translation",
      phase: "translation",
      pageOp: true,
      usesUserPrompt: true,
      usesBrandVoice: false,
    },
  }

/** Every task profile a local tool can run, and the audit kinds that record it
 *  (exported for the sibling-sweep test). */
export function auditKindsForProfile(profile: string): LocalGenerationKind[] {
  return (Object.keys(LOCAL_GENERATION_TASKS) as LocalGenerationKind[]).filter(
    (kind) => LOCAL_GENERATION_TASKS[kind].profile === profile
  )
}

/** The `aiAuditLog.kind` a local kind is stored under. Block creator runs use
 *  the table's existing `slice-author-propose`, as the API route does
 *  (`convex/cms/ai.ts`); the rest are stored under their own name. */
function auditRowKind(kind: LocalGenerationKind) {
  if (kind === "slice-spec" || kind === "slice-renderer")
    return "slice-author-propose" as const
  if (kind === "page-job-write") return "page-generate-fill" as const
  if (kind === "page-job-translation") return "page-translate" as const
  return kind
}

type GenerationEngine =
  "openrouter-api" | "anthropic-api" | "openai-api" | "claude-cli" | "codex-cli"

function providerForEngine(engine: GenerationEngine) {
  switch (engine) {
    case "openrouter-api":
      return "openrouter" as const
    case "anthropic-api":
      return "anthropic" as const
    case "openai-api":
      return "openai" as const
    case "claude-cli":
    case "codex-cli":
      return undefined
  }
}

type LocalIdentityEvidence =
  "runtime-observed" | "transcript-observed" | "selected-only"

function validateLocalAuditIdentity(args: {
  selectedEngine: GenerationEngine
  actualEngine?: GenerationEngine
  actualReasoning?: string
  identityEvidence?: LocalIdentityEvidence
  success: boolean
}): void {
  const hasActualDetails = args.actualReasoning !== undefined
  if (!args.actualEngine && hasActualDetails) {
    throw new ConvexError("Actual generation details require an actual engine.")
  }
  if (args.actualEngine && args.actualEngine !== args.selectedEngine) {
    throw new ConvexError(
      "The selected local engine cannot fall back to another engine."
    )
  }

  if (args.selectedEngine === "codex-cli") {
    if (
      args.identityEvidence !== undefined &&
      args.identityEvidence !== "selected-only"
    ) {
      throw new ConvexError("Codex identity evidence must be selected-only.")
    }
    if (args.actualEngine) {
      throw new ConvexError(
        "Selected-only generation cannot claim an actual engine."
      )
    }
    if (args.success && args.identityEvidence !== "selected-only") {
      throw new ConvexError(
        "Successful Codex generation requires selected-only evidence."
      )
    }
    return
  }

  const expectedEvidence =
    args.selectedEngine === "claude-cli"
      ? "transcript-observed"
      : "runtime-observed"
  if (
    args.identityEvidence !== undefined &&
    args.identityEvidence !== expectedEvidence
  ) {
    throw new ConvexError(
      `The selected engine requires ${expectedEvidence} identity evidence.`
    )
  }
  if (
    args.success &&
    (args.identityEvidence !== expectedEvidence || !args.actualEngine)
  ) {
    throw new ConvexError(
      `Successful generation requires ${expectedEvidence} actual identity.`
    )
  }
}

const localGenerationPreflightValidator = v.object({
  profile: taskProfileValidator,
  phase: workflowPhaseValidator,
  userPromptTemplate: v.union(v.string(), v.null()),
  brandVoice: v.union(v.string(), v.null()),
  assistantInstructions: v.union(v.string(), v.null()),
})

type LocalGenerationPreflight = {
  profile: LocalGenerationProfile
  phase: WorkflowPhase
  userPromptTemplate: string | null
  brandVoice: string | null
  /** The owner's Instructions for this task's assistant, as the Convex jobs send them. */
  assistantInstructions: string | null
}

export const prepare = internalQuery({
  args: { kind: localGenerationKindValidator },
  returns: localGenerationPreflightValidator,
  handler: async (ctx, { kind }): Promise<LocalGenerationPreflight> => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    const task = LOCAL_GENERATION_TASKS[kind]
    if (task.agent === null) {
      throw new ConvexError(
        "The Block creator does not use preflight; it has its own Instructions."
      )
    }
    const [settings, agentConfig] = await Promise.all([
      ctx.db.query("siteSettings").first(),
      ctx.db
        .query("agentConfigs")
        .withIndex("by_agent", (q) => q.eq("agent", task.agent))
        .unique(),
    ])
    const definition = AGENTS[task.agent]
    // Same source as the Convex jobs (`composeRuntimeAssistant`): the saved
    // Instructions, or the code default when none was saved. Read without the
    // provider-readiness check, which only API routes need. Never log them.
    const assistantId = assistantForProfile(task.profile)
    const instructions = assistantId
      ? resolveAssistantInstructions(
          assistantId,
          settings?.aiRuntime?.assistants?.[assistantId]?.instructions
        )
      : ""
    return {
      profile: task.profile,
      phase: task.phase,
      userPromptTemplate: task.usesUserPrompt
        ? (agentConfig?.userPromptTemplate ??
          definition.defaultUserPromptTemplate)
        : null,
      brandVoice: task.usesBrandVoice ? (settings?.brandVoice ?? null) : null,
      assistantInstructions: instructions || null,
    }
  },
})

export const preflight = action({
  args: { kind: localGenerationKindValidator },
  returns: localGenerationPreflightValidator,
  handler: async (ctx, args): Promise<LocalGenerationPreflight> => {
    const prepared: LocalGenerationPreflight = await ctx.runQuery(
      internal.agents.localGeneration.prepare,
      args
    )
    await enforceAiRateLimit(ctx, {
      pageOp: LOCAL_GENERATION_TASKS[args.kind].pageOp,
    })
    return prepared
  },
})

export const localAuditErrorCodeValidator = v.union(
  v.literal("AI_OFF"),
  v.literal("CONFIG_MISSING"),
  v.literal("AUTH_REQUIRED"),
  v.literal("RATE_LIMITED"),
  v.literal("QUOTA_EXHAUSTED"),
  v.literal("UNSUPPORTED_CAPABILITY"),
  v.literal("INPUT_TOO_LARGE"),
  v.literal("TIMEOUT"),
  v.literal("CANCELLED"),
  v.literal("PROVIDER_UNAVAILABLE"),
  v.literal("INVALID_OUTPUT"),
  v.literal("VALIDATION_FAILED"),
  v.literal("LOCAL_PROCESS_FAILED")
)

const localAuditArgs = {
  attemptId: v.optional(v.string()),
  kind: localGenerationKindValidator,
  briefHash: v.optional(v.string()),
  sliceCount: v.optional(v.number()),
  selectedEngine: generationEngineValidator,
  selectedModel: v.optional(v.string()),
  selectedReasoning: v.optional(reasoningEffortValidator),
  actualEngine: v.optional(generationEngineValidator),
  actualModel: v.optional(v.string()),
  actualReasoning: v.optional(reasoningEffortValidator),
  identityEvidence: v.optional(generationIdentityEvidenceValidator),
  /** How a local tool run was billed; CLI engines only (ADR-0057). */
  funding: v.optional(localToolFundingValidator),
  attempts: aiAttemptCountValidator,
  tokenUsage: v.object({
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
  }),
  success: v.boolean(),
  errorCode: v.optional(localAuditErrorCodeValidator),
}
type LocalAuditInput = ObjectType<typeof localAuditArgs>

const SAFE_LOCAL_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/

/** Whether a local model name is a bounded model identifier. */
export function isSafeLocalModelId(model: string): boolean {
  return SAFE_LOCAL_MODEL_ID.test(model)
}

function assertLocalAuditModelIdentity(args: {
  selectedModel?: string
  actualEngine?: GenerationEngine
  actualModel?: string
}): void {
  for (const [label, model] of [
    ["selected", args.selectedModel],
    ["actual", args.actualModel],
  ] as const) {
    if (model !== undefined && !SAFE_LOCAL_MODEL_ID.test(model)) {
      throw new ConvexError(
        `The ${label} local model must be a bounded model identifier.`
      )
    }
  }
  if (args.actualModel !== undefined && args.actualEngine === undefined) {
    throw new ConvexError("An actual local model requires an actual engine.")
  }
}

function assertLocalAuditFunding(args: {
  selectedEngine: GenerationEngine
  funding?: string
}): void {
  if (
    args.funding !== undefined &&
    args.selectedEngine !== "claude-cli" &&
    args.selectedEngine !== "codex-cli"
  ) {
    throw new ConvexError("Only a local tool run may record its funding.")
  }
}

function assertLocalAuditBriefHash(args: {
  kind: LocalGenerationKind
  briefHash?: string
}): void {
  const requiresBriefHash =
    args.kind === "page-generate-fill" || args.kind === "page-generate-outline"
  if (!requiresBriefHash) {
    if (args.briefHash !== undefined) {
      throw new ConvexError(
        "Only page fill or page outline may include a brief hash."
      )
    }
    return
  }
  if (!args.briefHash || !/^[a-f0-9]{64}$/.test(args.briefHash)) {
    throw new ConvexError(
      "Page fill and page outline require a lowercase SHA-256 brief hash."
    )
  }
}

function assertLocalAuditCounts(args: {
  sliceCount?: number
  tokenUsage: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}): void {
  const counts = [
    args.sliceCount,
    args.tokenUsage.promptTokens,
    args.tokenUsage.completionTokens,
    args.tokenUsage.totalTokens,
  ]
  for (const count of counts) {
    if (
      count !== undefined &&
      (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000)
    ) {
      throw new ConvexError(
        "Local audit counts must be bounded non-negative integers."
      )
    }
  }
}

function isPageTranslationNoGenerationAudit(args: {
  kind: LocalGenerationKind
  actualEngine?: GenerationEngine
  actualReasoning?: string
  identityEvidence?: LocalIdentityEvidence
  attempts: 0 | 1 | 2
  tokenUsage: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
  success: boolean
  errorCode?: string
}): boolean {
  return (
    args.kind === "page-translate" &&
    args.success &&
    args.attempts === 0 &&
    args.actualEngine === undefined &&
    args.actualReasoning === undefined &&
    args.identityEvidence === undefined &&
    args.errorCode === undefined &&
    args.tokenUsage.promptTokens === undefined &&
    args.tokenUsage.completionTokens === undefined &&
    args.tokenUsage.totalTokens === undefined
  )
}

// A local tool run can outlive the 60-second access token, so the Next server
// authorizes the owner at run start and signs `authId` + `authorizedAt` into
// the audit. A run that ends without a session may record on that signature
// for a bounded time (5-minute tool ceiling plus margin), once per attempt.
const LOCAL_AUDIT_AUTHORIZATION_MAX_AGE_MS = 10 * 60 * 1000
const LOCAL_AUDIT_AUTHORIZATION_MAX_SKEW_MS = 60 * 1000
const LOCAL_AUDIT_ATTEMPT_ID_MAX_LENGTH = 128

type LocalAuditCaller = {
  authId: string
  rateLimitKey: string
  /** True when the signed authorization stood in for a session. */
  viaSignedAuthorization: boolean
}

async function assertLocalRunNotRecorded(
  ctx: MutationCtx,
  attemptId: string
): Promise<void> {
  const earlier = await ctx.db
    .query("aiAuditLog")
    .withIndex("by_attemptId", (q) => q.eq("attemptId", attemptId))
    .take(8)
  if (earlier.some((row) => row.selectedLane === "local-build")) {
    throw new ConvexError("This local run's audit is already recorded.")
  }
}

async function resolveLocalAuditCaller(
  ctx: MutationCtx,
  signed: { authId?: string; authorizedAt?: number },
  attemptId: string | undefined
): Promise<LocalAuditCaller> {
  if ((signed.authId === undefined) !== (signed.authorizedAt === undefined)) {
    throw new ConvexError(
      "A signed owner authorization needs both the owner and its time."
    )
  }
  if (await getActor(ctx)) {
    // Live owner session: the existing path. A signed authId must match it.
    const auth = await requireOperationAccess(ctx)
    if (signed.authId !== undefined && signed.authId !== auth.authId) {
      throw new ConvexError("The signed owner does not match the session.")
    }
    return {
      authId: auth.authId,
      rateLimitKey: auth.tokenIdentifier,
      viaSignedAuthorization: false,
    }
  }
  const { authId, authorizedAt } = signed
  const now = Date.now()
  if (
    authId === undefined ||
    authorizedAt === undefined ||
    !Number.isFinite(authorizedAt) ||
    now - authorizedAt > LOCAL_AUDIT_AUTHORIZATION_MAX_AGE_MS ||
    authorizedAt - now > LOCAL_AUDIT_AUTHORIZATION_MAX_SKEW_MS
  ) {
    throw new ConvexError(
      "Recording this audit needs the owner's session or a recent owner authorization."
    )
  }
  const state = await readOwnerState(ctx)
  if (state.status !== "ready" || state.owner.authId !== authId) {
    throw new ConvexError("The signed authorization is not the owner's.")
  }
  if (
    attemptId === undefined ||
    attemptId.length === 0 ||
    attemptId.length > LOCAL_AUDIT_ATTEMPT_ID_MAX_LENGTH
  ) {
    throw new ConvexError(
      "An audit without a session needs a bounded attempt identifier."
    )
  }
  await assertLocalRunNotRecorded(ctx, attemptId)
  return {
    authId,
    rateLimitKey: state.owner.tokenIdentifier,
    viaSignedAuthorization: true,
  }
}

/** The audit row of one local generation, metadata only (no prompt, no output). */
function buildLocalAuditEvent(
  authId: string,
  args: LocalAuditInput,
  task: LocalGenerationTask
) {
  const selectedProvider = providerForEngine(args.selectedEngine)
  const actualProvider = args.actualEngine
    ? providerForEngine(args.actualEngine)
    : undefined
  return {
    authId,
    kind: auditRowKind(args.kind),
    ...(args.briefHash ? { briefHash: args.briefHash } : {}),
    sliceCount: args.sliceCount ?? 0,
    modelId: args.selectedEngine,
    // The audit table's `profile` field has no Block creator profiles; the
    // phase (`slice-spec` or `renderer-jsx`) names the step on those rows.
    ...(task.agent === null ? {} : { profile: task.profile }),
    selectedLane: "local-build" as const,
    selectedEngine: args.selectedEngine,
    ...(args.selectedModel ? { selectedModel: args.selectedModel } : {}),
    ...(selectedProvider ? { selectedProvider } : {}),
    ...(args.selectedReasoning
      ? { selectedReasoning: args.selectedReasoning }
      : {}),
    ...(args.actualEngine ? { actualEngine: args.actualEngine } : {}),
    ...(args.actualModel ? { actualModel: args.actualModel } : {}),
    ...(actualProvider ? { actualProvider } : {}),
    ...(args.actualReasoning ? { actualReasoning: args.actualReasoning } : {}),
    phase: task.phase,
    attempts: args.attempts,
    ...(args.identityEvidence ? { identityEvidence: args.identityEvidence } : {}),
    ...(args.funding ? { funding: args.funding } : {}),
    tokenUsage: args.tokenUsage,
    success: args.success,
    ...(args.errorCode ? { errorCode: args.errorCode } : {}),
  }
}

/**
 * Stores one local tool audit row, once per attempt identifier. A local tool
 * run writes no spending record, so its attempt is never admitted and
 * `recordEvent` would drop the row: write it directly.
 */
async function insertLocalToolAuditRow(
  ctx: MutationCtx,
  attemptId: string,
  event: ReturnType<typeof buildLocalAuditEvent> & {
    runId?: string
    unitId?: string
  },
  enforceLimit?: () => Promise<void>
): Promise<void> {
  if (attemptId.length > LOCAL_AUDIT_ATTEMPT_ID_MAX_LENGTH) {
    throw new ConvexError("The attempt identifier is too long.")
  }
  await assertLocalRunNotRecorded(ctx, attemptId)
  await enforceLimit?.()
  await ctx.db.insert("aiAuditLog", { ...event, attemptId, createdAt: Date.now() })
}

/**
 * The metadata-only audit row of one unit of a local whole-page job, written in
 * the same transaction as the unit's save or failure. The engine, model and
 * effort come from the job's frozen route. `attemptId` is the unit's claim
 * token, unique per claim, so a claim is recorded at most once. The per-user
 * audit rate limit does not apply: the secret-authorized job mutations bound
 * the rows (one per claim of one of at most 60 units), and a limit error here
 * would roll back the unit's saved result.
 */
export async function recordLocalJobUnitAudit(
  ctx: MutationCtx,
  input: {
    job: Pick<Doc<"aiJobs">, "_id" | "authId" | "kind" | "localRoute">
    unit: Pick<Doc<"aiJobUnits">, "_id">
    claimToken: string
    funding: Infer<typeof localToolFundingValidator>
    result: { success: true } | { success: false; errorCode: LocalAuditInput["errorCode"] }
  }
): Promise<void> {
  const { job, unit, claimToken, funding, result } = input
  const route = job.localRoute
  if (!route) throw new Error("A local job audit needs the job's local route.")
  const kind = job.kind === "write" ? "page-job-write" : "page-job-translation"
  const args: LocalAuditInput = {
    kind,
    attemptId: claimToken,
    sliceCount: job.kind === "write" ? 1 : 0,
    selectedEngine: route.engine === "claude" ? "claude-cli" : "codex-cli",
    selectedModel: route.model,
    selectedReasoning: route.effort,
    funding,
    attempts: 1,
    tokenUsage: {},
    success: result.success,
    ...(result.success ? {} : { errorCode: result.errorCode }),
  }
  assertLocalAuditModelIdentity(args)
  assertLocalAuditFunding(args)
  assertLocalAuditCounts(args)
  await insertLocalToolAuditRow(ctx, claimToken, {
    ...buildLocalAuditEvent(job.authId, args, LOCAL_GENERATION_TASKS[kind]),
    runId: job._id,
    unitId: unit._id,
  })
}

export const recordAudit = mutation({
  args: {
    ...localAuditArgs,
    /** Owner authorized by the Next server at run start (signed). */
    authId: v.optional(v.string()),
    /** When that authorization happened, in ms since the epoch (signed). */
    authorizedAt: v.optional(v.number()),
    auditProofExpiresAt: v.optional(v.number()),
    auditProofSignature: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (
    ctx,
    {
      auditProofExpiresAt,
      auditProofSignature,
      authId: signedAuthId,
      authorizedAt,
      ...args
    }
  ): Promise<null> => {
    // No session and no signed authorization: refuse as before, first.
    if (signedAuthId === undefined && authorizedAt === undefined) {
      await requireOperationAccess(ctx)
    }
    // The signature covers every signed field, including the authorization.
    if (
      !(await verifyLocalAiAuditProof(
        {
          ...args,
          ...(signedAuthId !== undefined ? { authId: signedAuthId } : {}),
          ...(authorizedAt !== undefined ? { authorizedAt } : {}),
        },
        { auditProofExpiresAt, auditProofSignature }
      ))
    ) {
      throw new ConvexError("A valid local AI server proof is required.")
    }
    const auth = await resolveLocalAuditCaller(
      ctx,
      { authId: signedAuthId, authorizedAt },
      args.attemptId
    )
    if (args.success && args.attempts === 0) {
      if (!isPageTranslationNoGenerationAudit(args)) {
        throw new ConvexError(
          "Only a no-generation page translation may record a successful zero-attempt audit."
        )
      }
    } else {
      validateLocalAuditIdentity(args)
    }
    assertLocalAuditModelIdentity(args)
    assertLocalAuditFunding(args)
    assertLocalAuditBriefHash(args)
    assertLocalAuditCounts(args)
    const event = buildLocalAuditEvent(
      auth.authId,
      args,
      LOCAL_GENERATION_TASKS[args.kind]
    )
    if (
      args.attemptId &&
      (args.selectedEngine === "claude-cli" ||
        args.selectedEngine === "codex-cli")
    ) {
      // A local tool run writes no spending record, so its attempt is never
      // admitted. Store its audit once, keyed by the attempt identifier, on
      // both the session and the signed-authorization paths. API engines and
      // admitted attempts keep the post-admission path below.
      const admitted = await ctx.db
        .query("aiSpendingAttempts")
        .withIndex("by_attemptKey", (q) => q.eq("attemptKey", args.attemptId!))
        .unique()
      if (!admitted) {
        await insertLocalToolAuditRow(ctx, args.attemptId, event, () =>
          enforceAiAuditRateLimit(ctx, auth.rateLimitKey)
        )
        return null
      }
    }
    if (args.attemptId)
      return writePostAdmissionAudit(
        ctx,
        { ...event, attemptId: args.attemptId },
        () => enforceAiAuditRateLimit(ctx, auth.rateLimitKey)
      )
    // Operations refused before any admission retain the pre-admission audit path.
    await enforceAiAuditRateLimit(ctx, auth.rateLimitKey)
    await ctx.runMutation(internal.cms.aiAuditLog.recordEvent, event)
    return null
  },
})
