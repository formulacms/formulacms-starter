import type {
  AdapterGenerationResult,
  ApiProvider,
  GenerationUsage,
} from "./execution-contract"

interface StepUsage {
  raw?: unknown
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  inputTokenDetails?: {
    noCacheTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  outputTokenDetails?: { reasoningTokens?: number }
}
interface ProviderStep {
  usage?: StepUsage
  providerMetadata?: Record<string, unknown>
  response?: { modelId?: string }
}
interface ProviderResult {
  text: string
  finishReason: string
  usage?: StepUsage
  steps?: readonly ProviderStep[]
  finalStep?: ProviderStep
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}
function reportedCost(step: ProviderStep): number | undefined {
  const usage = record(step.usage?.raw)
  const cost = usage?.cost
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
    return undefined
  if (usage?.is_byok !== true) return cost
  const upstream = record(usage.cost_details)?.upstream_inference_cost
  // BYOK platform cost excludes the separately billed upstream inference.
  // Missing either piece cannot establish the complete actual charge.
  return typeof upstream === "number" &&
    Number.isFinite(upstream) &&
    upstream >= 0
    ? cost + upstream
    : undefined
}
/** SDK 7 metadata is final-step only on result, so aggregate step receipts. */
export function captureUsage(
  provider: ApiProvider,
  result: ProviderResult
): GenerationUsage {
  const steps = result.steps?.length
    ? result.steps
    : [{ ...result.finalStep, usage: result.usage }]
  const parts = steps.map((step) => {
    // SDK defaults (including all-zero emptyUsage) are not provider measurements.
    const u = record(step.usage?.raw) ? step.usage : undefined
    const input = count(u?.inputTokens),
      output = count(u?.outputTokens)
    const read =
      count(u?.inputTokenDetails?.cacheReadTokens) ??
      (input === undefined ? undefined : 0)
    const write =
      count(u?.inputTokenDetails?.cacheWriteTokens) ??
      (input === undefined ? undefined : 0)
    const rawNoCache = count(u?.inputTokenDetails?.noCacheTokens)
    // OpenRouter's SDK includes writes inside noCacheTokens. Other providers do not.
    const noCache =
      provider === "openrouter" &&
      rawNoCache !== undefined &&
      write !== undefined
        ? count(rawNoCache - write)
        : (rawNoCache ??
          (input !== undefined && read !== undefined && write !== undefined
            ? count(input - read - write)
            : undefined))
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: count(u?.totalTokens),
      noCacheInputTokens: noCache,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      reasoningTokens: count(u?.outputTokenDetails?.reasoningTokens),
      providerCostUsd:
        provider === "openrouter" ? reportedCost(step) : undefined,
    }
  })
  const keys = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "noCacheInputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "providerCostUsd",
  ] as const
  const usage: Record<string, number> = {}
  for (const key of keys) {
    // A partial reported cost is not a total. Incomplete usage falls back to the estimate.
    if (parts.every((part) => part[key] !== undefined))
      usage[key] = parts.reduce((sum, part) => sum + part[key]!, 0)
  }
  return usage
}

/** A provider already returned. Never classify this as a transport failure. */
export class ProviderResponseError extends Error {
  constructor(readonly usage: GenerationUsage) {
    super("AI provider response could not be read.")
    this.name = "ProviderResponseError"
  }
}
export function providerReceipt(
  provider: ApiProvider,
  result: ProviderResult
): AdapterGenerationResult {
  let usage: GenerationUsage = {}
  try {
    usage = captureUsage(provider, result)
    const finalStep = result.finalStep ?? result.steps?.at(-1)
    const metadata = record(finalStep?.providerMetadata?.openrouter)
    const routedProvider =
      typeof metadata?.provider === "string" ? metadata.provider : undefined
    return {
      text: result.text,
      finishReason: result.finishReason,
      usage,
      actualModel: finalStep?.response?.modelId,
      ...(routedProvider === undefined ? {} : { routedProvider }),
    }
  } catch {
    throw new ProviderResponseError(usage)
  }
}
