import type {
  GenerationErrorCategory,
  GenerationNextAction,
  GenerationUsage,
  ReasoningEffort,
  WorkflowPhase,
} from "../../lib/ai/execution-contract"
import type { SubscriptionCliEngine } from "./subscription-cli-capabilities"
import type { SubscriptionCliProcessFailureKind } from "./subscription-cli-process"

export interface SelectedSubscriptionCliIdentity {
  readonly lane: "local-build"
  readonly engine: SubscriptionCliEngine
  readonly model: string
  readonly effort: ReasoningEffort
}

export interface ActualSubscriptionCliIdentity {
  readonly engine: SubscriptionCliEngine
  readonly model: string
  readonly effort: ReasoningEffort
  readonly modelEvidence: "transcript"
  readonly effortEvidence: "configured" | "transcript"
}

/**
 * How honestly the run can describe the identity that actually served it.
 *
 * - `transcript-observed` — the CLI transcript proves one concrete effective
 *   MODEL (Claude `stream-json` init/assistant events). The reasoning EFFORT is
 *   still only `configured` evidence; the transcript does not prove it.
 * - `selected-only` — argv plus an installed-catalog preflight prove SELECTION,
 *   not resolution (`codex exec --json` does not expose the resolved starting
 *   model or effort). An honest success state, not a failure.
 *
 * See docs/planning/subscription-cli-invariants.md § Identity evidence.
 */
export type SubscriptionCliIdentityEvidence =
  | "transcript-observed"
  | "selected-only"

interface SubscriptionCliGenerationBase {
  readonly text: string
  readonly output: string
  readonly selected: SelectedSubscriptionCliIdentity
  readonly attempts: 1
  readonly usage: GenerationUsage
  readonly finishReason: "stop"
}

/**
 * `actual` exists if and only if the identity was transcript-observed. The union
 * makes fabricating an unobserved identity a type error rather than a rule to
 * remember: a `selected-only` result has no `actual` to fill in.
 */
export type SubscriptionCliGenerationResult =
  | (SubscriptionCliGenerationBase & {
      readonly identityEvidence: "transcript-observed"
      readonly actual: ActualSubscriptionCliIdentity
    })
  | (SubscriptionCliGenerationBase & {
      readonly identityEvidence: "selected-only"
      readonly actual?: undefined
    })

export interface SafeSubscriptionCliError {
  readonly category: GenerationErrorCategory
  readonly message: string
  readonly selected: SelectedSubscriptionCliIdentity
  readonly attempts: number
  readonly phase: WorkflowPhase
  readonly retryable: false
  readonly nextAction: GenerationNextAction
}

const SAFE_ERROR_COPY: Partial<
  Record<
    GenerationErrorCategory,
    { message: string; nextAction: GenerationNextAction }
  >
> = {
  CONFIG_MISSING: {
    message: "The selected local AI CLI is not available.",
    nextAction: "check-local-cli",
  },
  AUTH_REQUIRED: {
    message: "The selected local AI CLI requires authentication.",
    nextAction: "authenticate-provider",
  },
  RATE_LIMITED: {
    message: "The selected local AI subscription rate-limited the request.",
    nextAction: "retry-later",
  },
  QUOTA_EXHAUSTED: {
    message: "The selected local AI subscription has no available quota.",
    nextAction: "check-provider-quota",
  },
  UNSUPPORTED_CAPABILITY: {
    message: "The selected local AI CLI does not support the requested capability.",
    nextAction: "choose-supported-input",
  },
  INPUT_TOO_LARGE: {
    message: "The local AI request exceeds the selected CLI input limit.",
    nextAction: "reduce-input-size",
  },
  TIMEOUT: {
    message: "The selected local AI CLI exceeded its deadline.",
    nextAction: "retry-request",
  },
  CANCELLED: {
    message: "The selected local AI CLI run was cancelled.",
    nextAction: "retry-request",
  },
  INVALID_OUTPUT: {
    message: "The selected local AI CLI returned incomplete or invalid output.",
    nextAction: "review-generated-output",
  },
  LOCAL_PROCESS_FAILED: {
    message: "The selected local AI CLI process failed.",
    nextAction: "check-local-cli",
  },
}

export class SubscriptionCliGenerationError extends Error {
  readonly category: GenerationErrorCategory
  readonly selected: SelectedSubscriptionCliIdentity
  readonly attempts: number
  readonly phase: WorkflowPhase
  readonly retryable = false as const
  readonly nextAction: GenerationNextAction

  constructor(value: SafeSubscriptionCliError) {
    super(value.message)
    this.name = value.category
    this.category = value.category
    this.selected = value.selected
    this.attempts = value.attempts
    this.phase = value.phase
    this.nextAction = value.nextAction
  }

  toJSON(): SafeSubscriptionCliError {
    return {
      category: this.category,
      message: this.message,
      selected: this.selected,
      attempts: this.attempts,
      phase: this.phase,
      retryable: false,
      nextAction: this.nextAction,
    }
  }
}

export function makeSubscriptionCliError(
  category: GenerationErrorCategory,
  context: {
    selected: SelectedSubscriptionCliIdentity
    attempts: number
    phase: WorkflowPhase
  }
): SubscriptionCliGenerationError {
  const copy = SAFE_ERROR_COPY[category]
  if (!copy) {
    throw new Error(`Unsupported subscription CLI error category: ${category}`)
  }
  return new SubscriptionCliGenerationError({
    category,
    message: copy.message,
    selected: context.selected,
    attempts: context.attempts,
    phase: context.phase,
    retryable: false,
    nextAction: copy.nextAction,
  })
}

export function processFailureCategory(
  kind: SubscriptionCliProcessFailureKind
): GenerationErrorCategory {
  switch (kind) {
    case "missing-cli":
      return "CONFIG_MISSING"
    case "auth-required":
      return "AUTH_REQUIRED"
    case "quota-exhausted":
      return "QUOTA_EXHAUSTED"
    case "rate-limited":
      return "RATE_LIMITED"
    case "unsupported-capability":
      return "UNSUPPORTED_CAPABILITY"
    case "input-too-large":
      return "INPUT_TOO_LARGE"
    case "timeout":
      return "TIMEOUT"
    case "cancelled":
      return "CANCELLED"
    case "local-process-failed":
      return "LOCAL_PROCESS_FAILED"
  }
}
