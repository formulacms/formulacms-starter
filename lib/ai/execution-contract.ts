import type { AnthropicApiTuple } from "./capabilities/anthropic-api"
import type {
  LegacyOpenRouterApiTuple,
  OpenRouterApiTuple,
} from "./capabilities/openrouter-api"
import type { OpenAIApiTuple } from "./capabilities/openai-api"

export const EXECUTION_LANES = ["runtime", "local-build"] as const
export type ExecutionLane = (typeof EXECUTION_LANES)[number]

export const API_PROVIDERS = ["openrouter", "anthropic", "openai"] as const
export type ApiProvider = (typeof API_PROVIDERS)[number]

export const API_ENGINE_IDS = [
  "openrouter-api",
  "anthropic-api",
  "openai-api",
] as const
export type ApiEngineId = (typeof API_ENGINE_IDS)[number]

export const TASK_PROFILES = [
  "mechanical-translation",
  "brand-translation",
  "editorial-copy",
  "structured-outline-meta",
  "vision-spec",
  "renderer-jsx",
  "grounded-help",
  "judgment-transform",
  "explicit-agentic-rescue",
] as const
export type TaskProfile = (typeof TASK_PROFILES)[number]

export const WORKFLOW_PHASES = [
  "translation",
  "content-generation",
  "content-refinement",
  "page-meta",
  "page-outline",
  "page-fill",
  "slice-spec",
  "renderer-jsx",
  "help-answer",
] as const
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number]

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export type InputModality = "text" | "image" | "file" | "audio" | "video"

export interface CapabilitySource {
  readonly url: string
  readonly retrievedAt: "2026-07-12" | "2026-07-15" | "2026-11-09"
  readonly claim: string
}

export interface ApiModelCapability {
  readonly name?: string
  readonly inputModalities: readonly InputModality[]
  readonly outputModalities: readonly ["text"]
  readonly structuredOutput: boolean
  readonly reasoning:
    | {
        readonly kind: "effort"
        readonly supportedEfforts: readonly ReasoningEffort[]
        readonly providerDefault: ReasoningEffort
      }
    | { readonly kind: "unsupported" }
  /** USD price per one million tokens, input and output. Present for models
   *  whose catalog reports pricing (the generated OpenRouter list). Display
   *  only — never used for routing. */
  readonly pricing?: {
    readonly inputPerM: number
    readonly outputPerM: number
  }
}

export type ApiModelTuple =
  | OpenRouterApiTuple
  | LegacyOpenRouterApiTuple
  | AnthropicApiTuple
  | OpenAIApiTuple

export type GenerationContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file"
      readonly data: string
      readonly mediaType: string
    }

export type GenerationMessage = {
  readonly role: "user"
  readonly content: string | readonly GenerationContentPart[]
}

export type GenerationInput =
  | { readonly prompt: string; readonly messages?: never }
  | {
      readonly messages: readonly GenerationMessage[]
      readonly prompt?: never
    }

export interface GenerationRequirements {
  readonly inputModalities: readonly InputModality[]
  readonly structuredOutput: boolean
}

export type GenerationOutputContract<T> =
  | { readonly kind: "text" }
  | {
      readonly kind: "validated"
      readonly validate: (text: string) => T
    }

export interface GenerationTarget {
  readonly lane: ExecutionLane
  readonly provider: ApiProvider
  readonly engine?: ApiEngineId
}

export interface GenerationRequest<T = string> {
  readonly target: GenerationTarget
  readonly tuple: Readonly<ApiModelTuple>
  readonly profile: TaskProfile
  readonly phase: WorkflowPhase
  readonly instructions?: string
  /** Compatibility for the one Unit C help call that still uses AI SDK `system`.
   * New callers use `instructions`; preflight rejects supplying both. */
  readonly system?: string
  readonly input: GenerationInput
  readonly requirements: GenerationRequirements
  readonly output: GenerationOutputContract<T>
  readonly deadlineMs?: number
  readonly signal?: AbortSignal
}

export interface GenerationUsage {
  readonly noCacheInputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly providerCostUsd?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

export interface SelectedGenerationIdentity {
  readonly lane: ExecutionLane
  readonly provider: ApiProvider | "off"
  readonly engine?: ApiEngineId
  readonly model: string
  readonly effort?: ReasoningEffort
}

export interface ActualGenerationIdentity {
  readonly provider: ApiProvider
  readonly engine?: ApiEngineId
  readonly model: string
  readonly effort?: ReasoningEffort
  readonly routedProvider?: string
}

export interface AdapterGenerationRequest {
  readonly tuple: Readonly<ApiModelTuple>
  readonly instructions?: string
  readonly system?: string
  readonly input: GenerationInput
  readonly abortSignal: AbortSignal
  readonly maxRetries: 0
  readonly maxOutputTokens: number
}

export interface AdapterGenerationResult {
  readonly text: string
  readonly finishReason: string
  readonly usage?: GenerationUsage
  readonly actualModel?: string
  readonly routedProvider?: string
}

export interface ApiGenerationAdapter {
  readonly provider: ApiProvider
  generate(request: AdapterGenerationRequest): Promise<AdapterGenerationResult>
}

export interface GenerationResult<T = string> {
  readonly text: string
  readonly output: T
  readonly selected: SelectedGenerationIdentity
  readonly actual: ActualGenerationIdentity
  readonly attempts: 1 | 2
  readonly usage: GenerationUsage
  readonly finishReason: string
}

export const GENERATION_ERROR_CATEGORIES = [
  "AI_OFF",
  "CONFIG_MISSING",
  "AUTH_REQUIRED",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "UNSUPPORTED_CAPABILITY",
  "INPUT_TOO_LARGE",
  "TIMEOUT",
  "CANCELLED",
  "PROVIDER_UNAVAILABLE",
  "INVALID_OUTPUT",
  "VALIDATION_FAILED",
  "LOCAL_PROCESS_FAILED",
] as const
export type GenerationErrorCategory =
  (typeof GENERATION_ERROR_CATEGORIES)[number]

export const GENERATION_NEXT_ACTIONS = [
  "configure-provider",
  "authenticate-provider",
  "retry-later",
  "check-provider-quota",
  "choose-supported-input",
  "reduce-input-size",
  "retry-request",
  "review-generated-output",
  "fix-validation-input",
  "check-local-cli",
] as const
export type GenerationNextAction = (typeof GENERATION_NEXT_ACTIONS)[number]

export interface SafeGenerationError {
  readonly category: GenerationErrorCategory
  readonly message: string
  readonly selected: SelectedGenerationIdentity
  readonly attempts: number
  readonly phase: WorkflowPhase
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly nextAction: GenerationNextAction
}

export class GenerationError extends Error {
  readonly category: GenerationErrorCategory
  readonly selected: SelectedGenerationIdentity
  readonly attempts: number
  readonly phase: WorkflowPhase
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly nextAction: GenerationNextAction

  constructor(value: SafeGenerationError) {
    super(value.message)
    this.name = value.category
    this.category = value.category
    this.selected = value.selected
    this.attempts = value.attempts
    this.phase = value.phase
    this.retryable = value.retryable
    this.retryAfterMs = value.retryAfterMs
    this.nextAction = value.nextAction
  }

  toJSON(): SafeGenerationError {
    return {
      category: this.category,
      message: this.message,
      selected: this.selected,
      attempts: this.attempts,
      phase: this.phase,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: this.retryAfterMs }),
      nextAction: this.nextAction,
    }
  }
}

export function tupleEffort(tuple: ApiModelTuple): ReasoningEffort | undefined {
  return "reasoning" in tuple && tuple.reasoning
    ? tuple.reasoning.effort
    : undefined
}

export function selectedIdentity(
  request: Pick<GenerationRequest<unknown>, "target" | "tuple">
): SelectedGenerationIdentity {
  const effort = tupleEffort(request.tuple)
  return {
    lane: request.target.lane,
    provider: request.target.provider,
    ...(request.target.engine ? { engine: request.target.engine } : {}),
    model: request.tuple.model,
    ...(effort ? { effort } : {}),
  }
}

/** Retained subscription implementations are unavailable through launch (G3). */
export function assertReleaseOneByok(engine: string): void {
  if (engine === "claude" || engine === "codex")
    throw new Error(
      "Subscription AI engines are disabled for release 1; use an owner-session BYOK engine."
    )
}
