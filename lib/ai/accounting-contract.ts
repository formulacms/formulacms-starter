import type {
  ApiProvider,
  ExecutionLane,
  GenerationUsage,
  TaskProfile,
  WorkflowPhase,
} from "./execution-contract"

/** Metadata only: no prompt, generated content, credentials or provider errors. */
export interface AttemptAdmissionRequest {
  readonly attemptKey: string
  /** One live operation root for retries/queued subcalls; U1b job reservations
   * fill this same argument rather than introducing another liveness mechanism. */
  readonly anchorAttemptKey?: string
  readonly runId?: string
  readonly unitId?: string
  readonly provider: ApiProvider
  readonly modelId: string
  readonly lane: ExecutionLane
  readonly phase: WorkflowPhase
  readonly profile: TaskProfile
  readonly imageTokens: number
  readonly inputTokens: number
  readonly maxOutputTokens: number
}

export interface AttemptAdmission {
  readonly attemptKey: string
  readonly admitted: true
  readonly estimateMicros: number
  readonly priceRevision: string
}

export type CostSource = "reported" | "calculated" | "estimate"
export interface AttemptReceipt {
  readonly attemptKey: string
  readonly chargedMicros: number
  readonly currency: "USD"
  readonly costSource: CostSource
}
export interface AttemptSettlement {
  readonly attemptKey: string
  readonly outcome: "completed" | "failed" | "not-called"
  readonly usage?: GenerationUsage
}

/** Required at the runner boundary. Production implementations establish owner
 * authority and price the request in the admission mutation, never in the UI. */
export interface GenerationAccounting {
  readonly anchorAttemptKey?: string
  admit(request: AttemptAdmissionRequest): Promise<AttemptAdmission>
  settle(request: AttemptSettlement): Promise<AttemptReceipt | null>
}

// Operation provenance belongs to the accounting port, not rebuilt results/errors.
const operations = new WeakMap<GenerationAccounting, GenerationAccounting>()
export function accountingOperation(
  transport: GenerationAccounting
): GenerationAccounting {
  const existing = operations.get(transport)
  if (existing) return existing
  let anchorAttemptKey: string | undefined
  let opening: Promise<AttemptAdmission> | undefined
  const operation: GenerationAccounting = {
    get anchorAttemptKey() {
      return anchorAttemptKey
    },
    async admit(request) {
      // Establish exactly one root before parallel/queued subcalls can admit.
      if (!anchorAttemptKey && opening) await opening
      const admit = async () => {
        const admitted = await transport.admit({
          ...request,
          ...(anchorAttemptKey ? { anchorAttemptKey } : {}),
        })
        if (
          admitted?.admitted === true &&
          admitted.attemptKey === request.attemptKey
        )
          anchorAttemptKey ??= admitted.attemptKey
        return admitted
      }
      if (anchorAttemptKey) return admit()
      opening = admit()
      try {
        return await opening
      } finally {
        opening = undefined
      }
    },
    settle: (request) => transport.settle(request),
  }
  operations.set(transport, operation)
  operations.set(operation, operation)
  return operation
}
