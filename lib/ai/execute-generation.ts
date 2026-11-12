import { accountingOperation } from "./accounting-contract"
import type { GenerationAccounting, AttemptSettlement } from "./accounting-contract"

/** Optional runtime-only metadata, forwarded unchanged by accountingOperation.
 * The Convex composition root adds provider/key identity in the action. Local
 * settlement keeps the base contract and never accepts provider health. */
export type ProviderAttemptSettlement = AttemptSettlement & {
  providerObservation?: {
    state: "ok" | "refused" | "unreachable"
    observedAt: number
  }
}
export interface ProviderGenerationAccounting extends GenerationAccounting {
  settle(request: ProviderAttemptSettlement): ReturnType<GenerationAccounting["settle"]>
}

/** A 403 stays AUTH_REQUIRED for the caller, but only a rejected credential
 * (see credentialRejected) marks the provider key as refused. */
export function providerHealthForError(error: GenerationError, raw?: unknown): "refused" | "unreachable" | undefined {
  if (error.category === "AUTH_REQUIRED") return credentialRejected(raw) ? "refused" : undefined
  if (error.category === "TIMEOUT" ||
      (error.category === "PROVIDER_UNAVAILABLE" && error.retryable)) return "unreachable"
  return undefined
}
import { inputTokenEstimate, imageTokenEstimate } from "./price-quote"
import { maxOutputTokensFor } from "./task-profiles"
import { ProviderResponseError } from "./provider-receipt"
class ProviderAttemptFailure {
  constructor(readonly error: unknown) {}
}
import {
  GenerationError,
  type AdapterGenerationResult,
  type ApiGenerationAdapter,
  type GenerationErrorCategory,
  type GenerationNextAction,
  type GenerationRequest,
  type GenerationResult,
  type SafeGenerationError,
  selectedIdentity,
  tupleEffort,
} from "./execution-contract"
import { capabilityForTuple, validateApiModelTuple } from "./task-profiles"

export const RUNTIME_GENERATION_CEILING_MS = 90_000
export const LOCAL_GENERATION_CEILING_MS = 5 * 60_000
export const MAX_GENERATION_ATTEMPTS = 2
export const SDK_MAX_RETRIES = 0 as const

const SAFE_ERROR_COPY: Record<
  GenerationErrorCategory,
  { message: string; nextAction: GenerationNextAction }
> = {
  AI_OFF: {
    message: "AI is disabled for this deployment.",
    nextAction: "configure-provider",
  },
  CONFIG_MISSING: {
    message: "The selected AI provider is not configured.",
    nextAction: "configure-provider",
  },
  AUTH_REQUIRED: {
    message: "The selected AI provider requires valid authentication.",
    nextAction: "authenticate-provider",
  },
  RATE_LIMITED: {
    message: "The selected AI provider rate-limited the request.",
    nextAction: "retry-later",
  },
  QUOTA_EXHAUSTED: {
    message: "The selected AI provider has no available quota.",
    nextAction: "check-provider-quota",
  },
  UNSUPPORTED_CAPABILITY: {
    message: "The selected model does not support the requested capability.",
    nextAction: "choose-supported-input",
  },
  INPUT_TOO_LARGE: {
    message: "The AI request exceeds the selected model's input limit.",
    nextAction: "reduce-input-size",
  },
  TIMEOUT: {
    message: "The AI request exceeded its total deadline.",
    nextAction: "retry-request",
  },
  CANCELLED: {
    message: "The AI request was cancelled by the caller.",
    nextAction: "retry-request",
  },
  PROVIDER_UNAVAILABLE: {
    message: "The selected AI provider is temporarily unavailable.",
    nextAction: "retry-later",
  },
  INVALID_OUTPUT: {
    message: "The AI provider returned incomplete or empty output.",
    nextAction: "review-generated-output",
  },
  VALIDATION_FAILED: {
    message: "The generated output failed deterministic validation.",
    nextAction: "fix-validation-input",
  },
  LOCAL_PROCESS_FAILED: {
    message: "The selected local AI process failed.",
    nextAction: "check-local-cli",
  },
}

interface ErrorContext<T> {
  readonly request: GenerationRequest<T>
  readonly attempts: number
  readonly timedOut?: boolean
  readonly cancelled?: boolean
}

export function makeGenerationError<T>(
  category: GenerationErrorCategory,
  context: Pick<ErrorContext<T>, "request" | "attempts">,
  options: {
    retryable?: boolean
    retryAfterMs?: number
  } = {}
): GenerationError {
  const copy = SAFE_ERROR_COPY[category]
  return new GenerationError({
    category,
    message: copy.message,
    selected: selectedIdentity(context.request),
    attempts: context.attempts,
    phase: context.request.phase,
    retryable: options.retryable ?? false,
    ...(options.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: options.retryAfterMs }),
    nextAction: copy.nextAction,
  })
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined
  }
  const candidate = Number((value as Record<string, unknown>)[key])
  return Number.isFinite(candidate) ? candidate : undefined
}

const KEY_REJECTION_CODES = new Set(["INVALID_API_KEY", "UNAUTHORIZED", "AUTHENTICATION_ERROR"])

/** True for HTTP 401, or when the provider body the AI SDK parsed into
 * `APICallError.data.error` says the key itself is invalid: OpenAI and
 * OpenRouter `code` (invalid_api_key; OpenRouter may send a numeric 401),
 * Anthropic `type` (authentication_error). Any other 403 body, such as
 * permission_error or moderation, is not a key rejection. */
function credentialRejected(error: unknown): boolean {
  if ((numberField(error, "statusCode") ?? numberField(error, "status")) === 401) return true
  const data = typeof error === "object" && error !== null ? (error as { data?: unknown }).data : undefined
  const body = typeof data === "object" && data !== null ? (data as { error?: unknown }).error : undefined
  if (numberField(body, "code") === 401) return true
  return [stringField(body, "code"), stringField(body, "type")]
    .some((value) => value !== undefined && KEY_REJECTION_CODES.has(value.toUpperCase()))
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined
  }
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === "string" ? candidate : undefined
}

function errorMessageForClassification(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : ""
}

function retryAfterFromHeaders(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const record = error as Record<string, unknown>
  const candidates = [record.responseHeaders, record.headers]
  if (typeof record.response === "object" && record.response !== null) {
    candidates.push((record.response as Record<string, unknown>).headers)
  }
  for (const candidate of candidates) {
    if (!candidate) continue
    let raw: string | null | undefined
    if (candidate instanceof Headers) {
      raw = candidate.get("retry-after")
    } else if (typeof candidate === "object") {
      const headers = candidate as Record<string, unknown>
      const value = headers["retry-after"] ?? headers["Retry-After"]
      raw =
        typeof value === "string" || typeof value === "number"
          ? String(value)
          : undefined
    }
    if (!raw) continue
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
    const date = Date.parse(raw)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  return undefined
}

export function normalizeGenerationError<T>(
  error: unknown,
  context: ErrorContext<T>
): GenerationError {
  if (context.cancelled || context.request.signal?.aborted) {
    return makeGenerationError("CANCELLED", context)
  }
  if (context.timedOut) return makeGenerationError("TIMEOUT", context)
  if (error instanceof GenerationError) {
    return makeGenerationError(error.category, context, {
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    })
  }

  const name = error instanceof Error ? error.name : ""
  if (name === "AbortError") return makeGenerationError("TIMEOUT", context)

  const message = errorMessageForClassification(error)
  const statusCode =
    numberField(error, "statusCode") ?? numberField(error, "status")
  const code = stringField(error, "code")?.toUpperCase()
  const retryAfterMs = retryAfterFromHeaders(error)

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    code === "UNAUTHORIZED" ||
    code === "INVALID_API_KEY"
  ) {
    return makeGenerationError("AUTH_REQUIRED", context)
  }
  if (
    statusCode === 402 ||
    (statusCode === 429 &&
      (message.includes("quota") ||
        message.includes("billing") ||
        message.includes("credit")))
  ) {
    return makeGenerationError("QUOTA_EXHAUSTED", context)
  }
  if (statusCode === 429) {
    return makeGenerationError("RATE_LIMITED", context, {
      retryable: retryAfterMs !== undefined,
      retryAfterMs,
    })
  }
  if (
    statusCode === 413 ||
    code === "PAYLOAD_TOO_LARGE" ||
    message.includes("too large")
  ) {
    return makeGenerationError("INPUT_TOO_LARGE", context)
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 422) {
    return makeGenerationError("UNSUPPORTED_CAPABILITY", context)
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    return makeGenerationError("PROVIDER_UNAVAILABLE", context, {
      retryable: true,
      retryAfterMs,
    })
  }
  if (
    error instanceof TypeError ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT"
  ) {
    return makeGenerationError("PROVIDER_UNAVAILABLE", context, {
      retryable: true,
    })
  }
  return makeGenerationError("PROVIDER_UNAVAILABLE", context)
}

function preflight<T>(
  request: GenerationRequest<T>,
  adapter: ApiGenerationAdapter
): void {
  const context = { request, attempts: 0 }
  if (request.instructions !== undefined && request.system !== undefined) {
    throw makeGenerationError("UNSUPPORTED_CAPABILITY", context)
  }
  if (request.target.provider !== request.tuple.provider) {
    throw makeGenerationError("UNSUPPORTED_CAPABILITY", context)
  }
  if (adapter.provider !== request.target.provider) {
    throw makeGenerationError("UNSUPPORTED_CAPABILITY", context)
  }
  if (request.target.lane === "local-build") {
    if (request.target.engine !== `${request.target.provider}-api`) {
      throw makeGenerationError("UNSUPPORTED_CAPABILITY", context)
    }
  } else if (request.target.engine !== undefined) {
    throw makeGenerationError("UNSUPPORTED_CAPABILITY", context)
  }

  if (request.tuple.mode === "catalog") {
    try {
      validateApiModelTuple(request.tuple)
    } catch {
      throw makeGenerationError("UNSUPPORTED_CAPABILITY", context)
    }
    const reasoning =
      "reasoning" in request.tuple ? request.tuple.reasoning : undefined
    if (
      !Object.isFrozen(request.tuple) ||
      (reasoning !== undefined && !Object.isFrozen(reasoning))
    ) {
      throw makeGenerationError("UNSUPPORTED_CAPABILITY", context)
    }
  } else if (
    request.tuple.provider !== "openrouter" ||
    !request.tuple.model.trim() ||
    !Object.isFrozen(request.tuple)
  ) {
    throw makeGenerationError("UNSUPPORTED_CAPABILITY", context)
  }

  const capability = capabilityForTuple(request.tuple)
  if (!capability) return // Explicit D1 legacy OpenRouter compatibility path.
  const missingModality = request.requirements.inputModalities.some(
    (modality) => !capability.inputModalities.includes(modality)
  )
  if (
    missingModality ||
    (request.requirements.structuredOutput && !capability.structuredOutput)
  ) {
    throw makeGenerationError("UNSUPPORTED_CAPABILITY", context)
  }
}

function totalDeadlineMs<T>(request: GenerationRequest<T>): number {
  const ceiling =
    request.target.lane === "runtime"
      ? RUNTIME_GENERATION_CEILING_MS
      : LOCAL_GENERATION_CEILING_MS
  const requested = request.deadlineMs ?? ceiling
  return Math.max(0, Math.min(requested, ceiling))
}

function isComplete(result: AdapterGenerationResult): boolean {
  return result.text.trim().length > 0 && result.finishReason === "stop"
}

function wait(
  ms: number,
  signal: AbortSignal,
  aborted: () => GenerationError
): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(aborted())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export async function executeGeneration<T>(
  request: GenerationRequest<T>,
  adapter: ApiGenerationAdapter,
  accounting: ProviderGenerationAccounting
): Promise<GenerationResult<T>> {
  preflight(request, adapter)
  if (!accounting)
    throw new Error("AI generation requires owner-session accounting.")
  accounting = accountingOperation(accounting)
  const inputTokens = inputTokenEstimate(request)
  const imageTokens = imageTokenEstimate(request)
  const maxOutputTokens = maxOutputTokensFor(request)
  let attempts = 0
  let timedOut = false
  let cancelled = request.signal?.aborted ?? false
  const controller = new AbortController()
  let rejectStop: ((error: GenerationError) => void) | undefined
  const stop = new Promise<never>((_resolve, reject) => {
    rejectStop = reject
  })
  const onCallerAbort = () => {
    cancelled = true
    controller.abort()
    rejectStop?.(makeGenerationError("CANCELLED", { request, attempts }))
  }
  request.signal?.addEventListener("abort", onCallerAbort, { once: true })
  if (cancelled) {
    request.signal?.removeEventListener("abort", onCallerAbort)
    throw makeGenerationError("CANCELLED", { request, attempts })
  }

  const deadlineMs = totalDeadlineMs(request)
  if (deadlineMs <= 0) {
    request.signal?.removeEventListener("abort", onCallerAbort)
    throw makeGenerationError("TIMEOUT", { request, attempts })
  }
  const startedAt = Date.now()
  const deadlineTimer = setTimeout(() => {
    timedOut = true
    controller.abort()
    rejectStop?.(makeGenerationError("TIMEOUT", { request, attempts }))
  }, deadlineMs)

  try {
    while (attempts < MAX_GENERATION_ATTEMPTS) {
      attempts += 1
      let result: AdapterGenerationResult
      const attemptKey = crypto.randomUUID()
      let admitted = false,
        called = false
      const settle = async (
        outcome: "completed" | "failed" | "not-called",
        usage?: import("./execution-contract").GenerationUsage,
        health?: "ok" | "refused" | "unreachable"
      ) => {
        const receipt = await accounting.settle({
          attemptKey,
          outcome,
          ...(usage ? { usage } : {}),
          ...(health && request.target.lane === "runtime" ? {
            providerObservation: { state: health, observedAt: Date.now() },
          } : {}),
        })
        if (receipt === null)
          throw new Error("AI attempt is no longer available.")
        return receipt
      }
      const attempt = async () => {
        const admission = await accounting.admit({
          attemptKey,
          provider: request.target.provider,
          modelId: request.tuple.model,
          lane: request.target.lane,
          profile: request.profile,
          phase: request.phase,
          inputTokens,
          imageTokens,
          maxOutputTokens,
        })
        if (
          !admission ||
          admission.admitted !== true ||
          admission.attemptKey !== attemptKey ||
          !Number.isSafeInteger(admission.estimateMicros) ||
          admission.estimateMicros < 0 ||
          !admission.priceRevision
        )
          throw new Error("AI admission was not established.")
        admitted = true
        if (controller.signal.aborted) {
          await settle("not-called")
          throw makeGenerationError(cancelled ? "CANCELLED" : "TIMEOUT", {
            request,
            attempts,
          })
        }
        let response: AdapterGenerationResult
        try {
          called = true
          response = await adapter.generate({
            tuple: request.tuple,
            instructions: request.instructions,
            system: request.system,
            input: request.input,
            abortSignal: controller.signal,
            maxRetries: SDK_MAX_RETRIES,
            maxOutputTokens,
          })
        } catch (error) {
          if (error instanceof ProviderResponseError) {
            await settle("completed", error.usage)
            throw makeGenerationError("INVALID_OUTPUT", { request, attempts })
          }
          const normalized = normalizeGenerationError(error, {
            request, attempts, timedOut, cancelled,
          })
          await settle("failed", undefined, providerHealthForError(normalized, error))
          throw new ProviderAttemptFailure(normalized)
        }
        // This continuation survives losing the abort race. Late results still
        // settle; the durable deadline and actual receipt use first-settle wins.
        await settle("completed", response.usage,
          !cancelled && isComplete(response) && response.actualModel?.trim() ? "ok" : undefined)
        return response
      }
      try {
        result = await Promise.race([attempt(), stop])
      } catch (error) {
        if ((timedOut || cancelled) && admitted)
          await settle(called ? "failed" : "not-called", undefined,
            called && timedOut && !cancelled ? "unreachable" : undefined)
        // Admission, accounting and post-response errors never enter provider
        // classification and therefore can never buy another attempt.
        if (!(error instanceof ProviderAttemptFailure)) throw error
        const normalized = normalizeGenerationError(error.error, {
          request,
          attempts,
          timedOut,
          cancelled,
        })
        const elapsed = Date.now() - startedAt
        const retryDelay = normalized.retryAfterMs ?? 0
        const retryFits =
          normalized.retryable &&
          attempts < MAX_GENERATION_ATTEMPTS &&
          elapsed + retryDelay < deadlineMs
        if (!retryFits) throw normalized
        await Promise.race([
          wait(retryDelay, controller.signal, () =>
            makeGenerationError(cancelled ? "CANCELLED" : "TIMEOUT", {
              request,
              attempts,
            })
          ),
          stop,
        ])
        continue
      }

      if (!isComplete(result) || !result.actualModel?.trim()) {
        throw makeGenerationError("INVALID_OUTPUT", { request, attempts })
      }

      let output: T
      if (request.output.kind === "text") {
        output = result.text as T
      } else {
        try {
          output = request.output.validate(result.text)
        } catch {
          throw makeGenerationError("VALIDATION_FAILED", {
            request,
            attempts,
          })
        }
      }

      const effort = tupleEffort(request.tuple)
      return {
        text: result.text,
        output,
        selected: selectedIdentity(request),
        actual: {
          provider: request.target.provider,
          ...(request.target.engine ? { engine: request.target.engine } : {}),
          model: result.actualModel,
          ...(effort ? { effort } : {}),
          ...(result.routedProvider
            ? { routedProvider: result.routedProvider }
            : {}),
        },
        attempts: attempts as 1 | 2,
        usage: result.usage ?? {},
        finishReason: result.finishReason,
      }
    }
    throw makeGenerationError("PROVIDER_UNAVAILABLE", { request, attempts })
  } finally {
    clearTimeout(deadlineTimer)
    request.signal?.removeEventListener("abort", onCallerAbort)
  }
}

export function safeGenerationError(
  error: GenerationError
): SafeGenerationError {
  return error.toJSON()
}
