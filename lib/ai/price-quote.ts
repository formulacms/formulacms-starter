import type {
  ApiProvider,
  GenerationRequest,
  GenerationUsage,
} from "./execution-contract"

export const DEFAULT_AI_MONTHLY_CAP_MICROS = 5_000_000
/** Owner 2026-11-08: enforcement is parked until after launch; keep the meter. */
export const AI_MONTHLY_CAP_ENFORCED = false

export function effectiveMonthlyCapMicros(
  stored: number | undefined,
  enforced: boolean = AI_MONTHLY_CAP_ENFORCED
): number {
  return enforced
    ? (stored ?? DEFAULT_AI_MONTHLY_CAP_MICROS)
    : Number.MAX_SAFE_INTEGER
}
export const PRICE_CHECKED_AT = "2026-11-09"
export const PRICE_REVISION = "direct-2026-11-09-v1"
export const IMAGE_INPUT_TOKEN_ESTIMATE = 10_000

export interface PriceQuote {
  readonly revision: string
  readonly sourceUrl: string
  readonly checkedAt: string
  readonly endsAt: number | null
  /** Integer micro-USD per million tokens; cacheWrite uses the highest TTL. */
  readonly inputPerM: number
  readonly cacheReadPerM: number
  readonly cacheWritePerM: number
  readonly outputPerM: number
  readonly maxInputTokens: number
}

const anthropicSource =
  "https://platform.claude.com/docs/en/about-claude/pricing"
const openaiSource = "https://developers.openai.com/api/docs/pricing"
function direct(
  sourceUrl: string,
  input: number,
  read: number,
  write: number,
  output: number,
  maxInputTokens: number,
  endsAt: number | null = null
): PriceQuote {
  return Object.freeze({
    revision: PRICE_REVISION,
    sourceUrl,
    checkedAt: PRICE_CHECKED_AT,
    endsAt,
    inputPerM: input,
    cacheReadPerM: read,
    cacheWritePerM: write,
    outputPerM: output,
    maxInputTokens,
  })
}

/** Exactly the direct catalog IDs. No test models. The highest
 * cache-write TTL is conservative where providers aggregate TTL usage. */
export const DIRECT_PRICES: Readonly<Record<string, PriceQuote>> =
  Object.freeze({
    "anthropic:claude-sonnet-5-5": direct(
      anthropicSource,
      2_000_000,
      100_000,
      4_000_000,
      10_000_000,
      1_000_000
    ),
    "anthropic:claude-opus-5-5": direct(
      anthropicSource,
      4_000_000,
      200_000,
      8_000_000,
      20_000_000,
      1_000_000
    ),
    "anthropic:claude-haiku-5-5": direct(
      anthropicSource,
      100_000,
      10_000,
      200_000,
      500_000,
      100_000
    ),
    "anthropic:claude-fable-5-1": direct(
      anthropicSource,
      10_000_000,
      250_000,
      20_000_000,
      50_000_000,
      1_000_000
    ),
    "openai:gpt-6.1-sol": direct(
      openaiSource,
      2_000_000,
      100_000,
      5_000_000,
      10_000_000,
      272_000
    ),
    "openai:gpt-6-astra": direct(
      openaiSource,
      10_000_000,
      1_000_000,
      25_000_000,
      50_000_000,
      272_000
    ),
    "openai:gpt-6.1-terra": direct(
      openaiSource,
      1_000_000,
      50_000,
      2_500_000,
      5_000_000,
      272_000
    ),
    "openai:gpt-6-sol": direct(
      openaiSource,
      2_000_000,
      200_000,
      5_000_000,
      10_000_000,
      272_000
    ),
    "openai:gpt-6-luna": direct(
      openaiSource,
      100_000,
      10_000,
      250_000,
      500_000,
      272_000
    ),
    "anthropic:claude-sonnet-5": direct(
      anthropicSource,
      2_000_000,
      200_000,
      4_000_000,
      10_000_000,
      1_000_000
    ),
    "anthropic:claude-opus-4-8": direct(
      anthropicSource,
      5_000_000,
      500_000,
      10_000_000,
      25_000_000,
      1_000_000
    ),
    "anthropic:claude-haiku-4-5-20251001": direct(
      anthropicSource,
      1_000_000,
      100_000,
      2_000_000,
      5_000_000,
      200_000
    ),
    "openai:gpt-5.6-luna": direct(
      openaiSource,
      200_000,
      20_000,
      500_000,
      1_200_000,
      272_000
    ),
    "openai:gpt-5.6-terra": direct(
      openaiSource,
      2_000_000,
      200_000,
      5_000_000,
      12_000_000,
      272_000
    ),
    "openai:gpt-5.6-sol": direct(
      openaiSource,
      4_000_000,
      400_000,
      10_000_000,
      20_000_000,
      272_000,
      Date.UTC(2026, 11, 1)
    ),
  })

export interface QuoteRequest {
  readonly inputTokens: number
  readonly now?: number
  readonly serviceTier?: string
  readonly fast?: boolean
  readonly priority?: boolean
  readonly regional?: boolean
  readonly catalog?: {
    readonly ceilingInputPerM?: number
    readonly ceilingOutputPerM?: number
    readonly syncedAt: number
  }
}

export function moneyInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("AI accounting requires non-negative integer micro-USD.")
  return value
}

export function quote(
  provider: ApiProvider,
  modelId: string,
  request: QuoteRequest
): PriceQuote {
  if (
    (request.serviceTier !== undefined && request.serviceTier !== "default") ||
    request.fast ||
    request.priority ||
    request.regional
  ) {
    throw new Error(
      "AI pricing does not support this service tier or processing mode."
    )
  }
  moneyInteger(request.inputTokens)
  let price: PriceQuote | undefined
  if (provider === "openrouter") {
    const catalog = request.catalog
    const input = catalog?.ceilingInputPerM,
      output = catalog?.ceilingOutputPerM
    if (
      input !== undefined &&
      output !== undefined &&
      Number.isFinite(input) &&
      Number.isFinite(output) &&
      input >= 0 &&
      output >= 0 &&
      Number.isSafeInteger(catalog!.syncedAt)
    ) {
      const rate = (n: number) => moneyInteger(Math.ceil(n * 1_000_000))
      price = {
        revision: `openrouter-${catalog!.syncedAt}`,
        sourceUrl: "https://openrouter.ai/api/v1/models",
        checkedAt: new Date(catalog!.syncedAt).toISOString(),
        endsAt: null,
        inputPerM: rate(input),
        cacheReadPerM: rate(input),
        cacheWritePerM: rate(input),
        outputPerM: rate(output),
        maxInputTokens: Number.MAX_SAFE_INTEGER,
      }
    }
  } else {
    price = DIRECT_PRICES[`${provider}:${modelId}`]
  }
  if (!price) throw new Error("AI model has no complete price quote.")
  if (price.endsAt !== null && (request.now ?? Date.now()) >= price.endsAt)
    throw new Error("AI model price has expired.")
  if (request.inputTokens > price.maxInputTokens)
    throw new Error("AI input exceeds the supported base-price tier.")
  return price
}

function tokenCost(terms: readonly (readonly [number, number])[]): number {
  let numerator = 0n
  for (const [tokens, rate] of terms)
    numerator += BigInt(moneyInteger(tokens)) * BigInt(moneyInteger(rate))
  return moneyInteger(Number((numerator + 999_999n) / 1_000_000n))
}
export function estimateMicros(
  price: PriceQuote,
  inputTokens: number,
  maxOutputTokens: number,
  imageTokens = 0
): number {
  return tokenCost([
    [
      moneyInteger(inputTokens - imageTokens),
      Math.max(price.inputPerM, price.cacheReadPerM, price.cacheWritePerM),
    ],
    [imageTokens, price.inputPerM],
    [maxOutputTokens, price.outputPerM],
  ])
}
export function chargeMicros(
  price: PriceQuote,
  estimate: number,
  usage: GenerationUsage | undefined,
  outcome: "completed" | "failed" | "not-called"
): {
  chargedMicros: number
  costSource: "reported" | "calculated" | "estimate"
} {
  if (outcome === "not-called")
    return { chargedMicros: 0, costSource: "calculated" }
  if (
    outcome === "completed" &&
    usage?.providerCostUsd !== undefined &&
    Number.isFinite(usage.providerCostUsd) &&
    usage.providerCostUsd >= 0
  ) {
    return {
      chargedMicros: moneyInteger(Math.ceil(usage.providerCostUsd * 1_000_000)),
      costSource: "reported",
    }
  }
  const counts = [
    usage?.noCacheInputTokens,
    usage?.cacheReadTokens,
    usage?.cacheWriteTokens,
    usage?.outputTokens,
  ]
  if (
    outcome === "completed" &&
    counts.every(
      (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    )
  ) {
    return {
      chargedMicros: tokenCost([
        [counts[0]!, price.inputPerM],
        [counts[1]!, price.cacheReadPerM],
        [counts[2]!, price.cacheWritePerM],
        [counts[3]!, price.outputPerM],
      ]),
      costSource: "calculated",
    }
  }
  return { chargedMicros: moneyInteger(estimate), costSource: "estimate" }
}

export function textTokenEstimate(text: string): number {
  let ascii = 0,
    other = 0
  for (const point of text) {
    if (point.codePointAt(0)! <= 0x7f) ascii++
    else other++
  }
  return Math.ceil(ascii / 3) + other
}
/** Fixed message overhead and image bounds are documented in output-limits.md. */
export function inputTokenEstimate(
  request: GenerationRequest<unknown>
): number {
  let tokens = 32
  if (request.instructions !== undefined)
    tokens += 32 + textTokenEstimate(request.instructions)
  if (request.system !== undefined)
    tokens += 32 + textTokenEstimate(request.system)
  if (request.input.prompt !== undefined)
    return tokens + 32 + textTokenEstimate(request.input.prompt)
  for (const message of request.input.messages) {
    tokens += 32
    if (typeof message.content === "string")
      tokens += textTokenEstimate(message.content)
    else
      for (const part of message.content) {
        if (part.type === "text") tokens += textTokenEstimate(part.text)
        else {
          if (!part.mediaType.startsWith("image/"))
            throw new Error(
              "AI accounting does not support non-image file inputs."
            )
          tokens += IMAGE_INPUT_TOKEN_ESTIMATE
        }
      }
  }
  return moneyInteger(tokens)
}

export function imageTokenEstimate(
  request: GenerationRequest<unknown>
): number {
  if (!request.input.messages) return 0
  return request.input.messages.reduce(
    (sum, message) =>
      sum +
      (typeof message.content === "string"
        ? 0
        : message.content.filter(
            (part) =>
              part.type === "file" && part.mediaType.startsWith("image/")
          ).length * IMAGE_INPUT_TOKEN_ESTIMATE),
    0
  )
}
