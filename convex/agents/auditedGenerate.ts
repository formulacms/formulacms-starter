import type { GenerationAccounting } from "../../lib/ai/accounting-contract"
// convex/agents/auditedGenerate.ts
// ADR-0015 audit wrapper. Run an LLM call (or a small fan-out of them),
// record one metadata-only audit row on success or failure, rethrow the
// original error. Centralises the page-level pattern from `generatePageMeta`
// so every AI action shares one implementation — adding a call site means
// "wrap it", not "copy 30 lines of try/catch".
import type { ActionCtx } from "../_generated/server"
import { ConvexError } from "convex/values"
import { internal } from "../_generated/api"
import { DEFAULT_AI_MODEL } from "../lib/aiConfig"
import type {
  ApiProvider,
  GenerationResult,
  ReasoningEffort,
  WorkflowPhase,
} from "../../lib/ai/execution-contract"
import { WORKFLOW_PHASES } from "../../lib/ai/execution-contract"

/** Audit-log `kind` values. Mirrors the closed union on the table schema
 *  (convex/schema.ts) and the `recordEvent` arg validator. Extending this
 *  type is a schema migration — keep all three in lock-step. */
export type AuditKind =
  | "page-generate-outline"
  | "page-generate-fill"
  | "page-generate-meta"
  | "help-answer"
  | "page-translate"
  | "field-translate"
  | "field-generate"
  | "field-refine"
  | "slice-generate"
  | "slice-author-propose"

/** Resolve the model id an audit row records: the effective configured model,
 *  else the committed default the runtime itself falls back to. One shared
 *  rule so every agent's rows stay attributable when the fallback changes. */
export function resolveAuditModelId(
  modelId: string | null | undefined
): string {
  return modelId || DEFAULT_AI_MODEL
}

export interface AuditMeta {
  accounting?: GenerationAccounting
  authId: string
  kind: AuditKind
  modelId: string
  /** Defaults to 0. Outline/fill set the real count; translate/refine/generate
   *  field-level calls don't produce slices, so 0 is the natural value. */
  sliceCount?: number
  briefHash?: string
}

/** Subset of AI SDK v7's `LanguageModelUsage` we actually persist. Duck-typed
 *  to keep this module free of the `ai` import — the wrapper doesn't call the
 *  model itself, callers do. */
export interface AuditTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type AuditGeneration = Pick<
  GenerationResult<unknown>,
  "selected" | "actual" | "attempts"
> & { phase: WorkflowPhase }

export function toAuditGeneration(
  result: GenerationResult<unknown>,
  phase: WorkflowPhase,
): AuditGeneration {
  return {
    selected: result.selected,
    actual: result.actual,
    attempts: result.attempts,
    phase,
  }
}

export function auditGenerationFields(generation: AuditGeneration) {
  return {
    ...(generation.selected.provider === "off"
      ? {}
      : { selectedProvider: generation.selected.provider }),
    selectedModel: generation.selected.model,
    ...(generation.selected.effort
      ? { selectedReasoning: generation.selected.effort }
      : {}),
    actualProvider: generation.actual.provider,
    actualModel: generation.actual.model,
    ...(generation.actual.effort
      ? { actualReasoning: generation.actual.effort }
      : {}),
    ...(generation.actual.routedProvider
      ? { routedProvider: generation.actual.routedProvider }
      : {}),
    phase: generation.phase,
    attempts: generation.attempts,
  }
}

export function auditFailureFields(error: unknown): {
  errorCode: string
  selectedProvider?: ApiProvider
  selectedModel?: string
  selectedReasoning?: ReasoningEffort
  attempts?: 0 | 1 | 2
  phase?: WorkflowPhase
} {
  const data = error instanceof ConvexError ? error.data : undefined
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { errorCode: error instanceof Error ? error.name : "UnknownError" }
  }
  const safe = data as Record<string, unknown>
  const selected =
    safe.selected && typeof safe.selected === "object" && !Array.isArray(safe.selected)
      ? (safe.selected as Record<string, unknown>)
      : undefined
  const provider = selected?.provider
  const effort = selected?.effort
  return {
    errorCode:
      typeof safe.category === "string"
        ? safe.category
        : error instanceof Error
          ? error.name
          : "UnknownError",
    ...(provider === "openrouter" || provider === "anthropic" || provider === "openai"
      ? { selectedProvider: provider }
      : {}),
    ...(typeof selected?.model === "string"
      ? { selectedModel: selected.model }
      : {}),
    ...(effort === "none" || effort === "minimal" || effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max"
      ? { selectedReasoning: effort }
      : {}),
    ...(typeof safe.attempts === "number" && [0, 1, 2].includes(safe.attempts)
      ? { attempts: safe.attempts as 0 | 1 | 2 }
      : {}),
    ...(typeof safe.phase === "string" &&
    (WORKFLOW_PHASES as readonly string[]).includes(safe.phase)
      ? { phase: safe.phase as WorkflowPhase }
      : {}),
  }
}

export interface AuditRunResult<T> {
  value: T
  /** AI SDK v7 `result.usage`. Optional because fan-out callers may sum across
   *  calls themselves, and rich-text per-segment usage isn't always
   *  aggregatable without restructuring. */
  usage?: AuditTokenUsage
  /** Canonical D2 selected-versus-actual execution metadata. Historical and
   *  pre-D2 callers may omit it while their audit rows remain valid. */
  generation?: AuditGeneration
  /** Overrides `meta.sliceCount` on the success row only — for actions that
   *  don't know the slice count until after the model has answered (e.g. the
   *  outline call counts the parsed sections). Failure rows always use
   *  `meta.sliceCount` because the model never produced anything. */
  sliceCount?: number
}

/** Run `run()`, log one audit row, rethrow on failure. The AI SDK v7 single-step
 *  usage shape (`inputTokens`/`outputTokens`/`totalTokens`) is mapped to the
 *  ADR-0015 schema names (`promptTokens`/`completionTokens`/`totalTokens`)
 *  at the boundary so callers can pass `result.usage` verbatim. */
export async function withAiAudit<T>(
  ctx: ActionCtx,
  meta: AuditMeta,
  run: () => Promise<AuditRunResult<T>>,
): Promise<T> {
  let tokenUsage: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  } = {}
  let completed: AuditRunResult<T>
  try {
    completed = await run()
  } catch (e) {
    try {
      await ctx.runMutation(internal.cms.aiAuditLog.recordEvent, {
        ...(meta.accounting?.anchorAttemptKey ? { attemptId: meta.accounting.anchorAttemptKey } : {}),
        authId: meta.authId,
        kind: meta.kind,
        ...(meta.briefHash ? { briefHash: meta.briefHash } : {}),
        sliceCount: meta.sliceCount ?? 0,
        modelId: meta.modelId,
        tokenUsage,
        success: false,
        ...auditFailureFields(e),
      })
    } catch {
      // Best effort only; never replace the generation failure.
    }
    throw e
  }

  const { value, usage, generation, sliceCount } = completed
    tokenUsage = {
      promptTokens: usage?.inputTokens,
      completionTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
    }
  try {
      await ctx.runMutation(internal.cms.aiAuditLog.recordEvent, {
        ...(meta.accounting?.anchorAttemptKey ? { attemptId: meta.accounting.anchorAttemptKey } : {}),
        authId: meta.authId,
        kind: meta.kind,
        ...(meta.briefHash ? { briefHash: meta.briefHash } : {}),
        sliceCount: sliceCount ?? meta.sliceCount ?? 0,
        modelId: meta.modelId,
        ...(generation ? auditGenerationFields(generation) : {}),
        tokenUsage,
        success: true,
      })
    } catch {
      // Best effort only; never turn a successful generation into failure.
    }
  return value
}

/** Sum AI SDK usage records from a fan-out (e.g. per-segment rich-text). An
 *  individual record contributes its `totalTokens` if present, else the sum of
 *  its input/output tokens. Missing values are treated as 0; a returned field
 *  is `undefined` if every input was undefined for that field, so the wrapper
 *  writes `undefined` (which `tokenUsage` allows) rather than misleading 0s. */
export function sumUsage(
  parts: Array<AuditTokenUsage | undefined>,
): AuditTokenUsage | undefined {
  if (parts.length === 0) return undefined
  let input = 0
  let output = 0
  let total = 0
  let sawInput = false
  let sawOutput = false
  let sawTotal = false
  for (const p of parts) {
    if (!p) continue
    if (typeof p.inputTokens === "number") {
      input += p.inputTokens
      sawInput = true
    }
    if (typeof p.outputTokens === "number") {
      output += p.outputTokens
      sawOutput = true
    }
    // Each part contributes its `totalTokens` when present, otherwise the sum
    // of its input/output tokens — never both, to avoid double-counting parts
    // that already carry a pre-computed total.
    if (typeof p.totalTokens === "number") {
      total += p.totalTokens
      sawTotal = true
    } else if (
      typeof p.inputTokens === "number" ||
      typeof p.outputTokens === "number"
    ) {
      total += (p.inputTokens ?? 0) + (p.outputTokens ?? 0)
      sawTotal = true
    }
  }
  if (!sawInput && !sawOutput && !sawTotal) return undefined
  return {
    inputTokens: sawInput ? input : undefined,
    outputTokens: sawOutput ? output : undefined,
    totalTokens: sawTotal ? total : undefined,
  }
}
