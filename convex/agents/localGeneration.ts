import { writePostAdmissionAudit } from "../cms/ai"
import { ConvexError, v } from "convex/values"
import { internal } from "../_generated/api"
import { action, internalQuery, mutation } from "../_generated/server"
import { requireOperationAccess } from "../lib/access/policy"
import { requireOwnerAndOptionalModule } from "../lib/modules/state"
import { enforceAiAuditRateLimit, enforceAiRateLimit } from "../lib/aiRateLimit"
import { AGENTS, type AgentId } from "../lib/agents/registry"
import {
  aiAttemptCountValidator,
  generationEngineValidator,
  generationIdentityEvidenceValidator,
  reasoningEffortValidator,
  taskProfileValidator,
  workflowPhaseValidator,
} from "../lib/aiValidators"
import { verifyLocalAiAuditProof } from "../lib/localAiAuditProof"
import type { WorkflowPhase } from "../../lib/ai/execution-contract"

export const localGenerationKindValidator = v.union(
  v.literal("field-translate"),
  v.literal("page-translate"),
  v.literal("field-generate"),
  v.literal("field-refine"),
  v.literal("slice-generate"),
  v.literal("page-generate-fill"),
  v.literal("page-generate-meta"),
  v.literal("page-generate-outline"),
  v.literal("help-answer")
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

// Community authorizes every local-generation task through the one F01
// operation-access seam, so the task table no longer carries a permission
// slug. Task identity still drives agent, profile, phase and rate-limit shape.
type LocalGenerationTask = {
  agent: AgentId
  profile: LocalGenerationProfile
  phase: WorkflowPhase
  pageOp: boolean
  usesUserPrompt: boolean
  usesBrandVoice: boolean
}

type LocalGenerationProfile =
  | "mechanical-translation"
  | "brand-translation"
  | "editorial-copy"
  | "structured-outline-meta"
  | "grounded-help"

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
})

type LocalGenerationPreflight = {
  profile: LocalGenerationProfile
  phase: WorkflowPhase
  userPromptTemplate: string | null
  brandVoice: string | null
}

export const prepare = internalQuery({
  args: { kind: localGenerationKindValidator },
  returns: localGenerationPreflightValidator,
  handler: async (ctx, { kind }): Promise<LocalGenerationPreflight> => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    const task = LOCAL_GENERATION_TASKS[kind]
    const [settings, agentConfig] = await Promise.all([
      ctx.db.query("siteSettings").first(),
      ctx.db
        .query("agentConfigs")
        .withIndex("by_agent", (q) => q.eq("agent", task.agent))
        .unique(),
    ])
    const definition = AGENTS[task.agent]
    return {
      profile: task.profile,
      phase: task.phase,
      userPromptTemplate: task.usesUserPrompt
        ? (agentConfig?.userPromptTemplate ??
          definition.defaultUserPromptTemplate)
        : null,
      brandVoice: task.usesBrandVoice ? (settings?.brandVoice ?? null) : null,
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
  attempts: aiAttemptCountValidator,
  tokenUsage: v.object({
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
  }),
  success: v.boolean(),
  errorCode: v.optional(
    v.union(
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
  ),
}

const SAFE_LOCAL_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/

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

export const recordAudit = mutation({
  args: {
    ...localAuditArgs,
    auditProofExpiresAt: v.optional(v.number()),
    auditProofSignature: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { auditProofExpiresAt, auditProofSignature, ...args }
  ): Promise<null> => {
    const task = LOCAL_GENERATION_TASKS[args.kind]
    const auth = await requireOperationAccess(ctx)
    if (
      !(await verifyLocalAiAuditProof(args, {
        auditProofExpiresAt,
        auditProofSignature,
      }))
    ) {
      throw new ConvexError("A valid local AI server proof is required.")
    }
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
    assertLocalAuditBriefHash(args)
    assertLocalAuditCounts(args)
    const selectedProvider = providerForEngine(args.selectedEngine)
    const actualProvider = args.actualEngine
      ? providerForEngine(args.actualEngine)
      : undefined
    const event = {
      authId: auth.authId,
      kind: args.kind,
      ...(args.briefHash ? { briefHash: args.briefHash } : {}),
      sliceCount: args.sliceCount ?? 0,
      modelId: args.selectedEngine,
      profile: task.profile,
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
      ...(args.actualReasoning
        ? { actualReasoning: args.actualReasoning }
        : {}),
      phase: task.phase,
      attempts: args.attempts,
      ...(args.identityEvidence
        ? { identityEvidence: args.identityEvidence }
        : {}),
      tokenUsage: args.tokenUsage,
      success: args.success,
      ...(args.errorCode ? { errorCode: args.errorCode } : {}),
    }
    if (args.attemptId)
      return writePostAdmissionAudit(
        ctx,
        { ...event, attemptId: args.attemptId },
        () => enforceAiAuditRateLimit(ctx, auth.tokenIdentifier)
      )
    // Operations refused before any admission retain the pre-admission audit path.
    await enforceAiAuditRateLimit(ctx, auth.tokenIdentifier)
    await ctx.runMutation(internal.cms.aiAuditLog.recordEvent, event)
    return null
  },
})
