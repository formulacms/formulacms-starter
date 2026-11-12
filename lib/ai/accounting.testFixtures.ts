import { accountingOperation } from "./accounting-contract"
import type {
  GenerationAccounting,
  AttemptAdmissionRequest,
  AttemptReceipt,
  AttemptSettlement,
} from "./accounting-contract"
import { chargeMicros, estimateMicros, type PriceQuote } from "./price-quote"
/** One test seam injects both accounting IO and its price source. No test ID is
 * added to the shipped table, and production callers never import this file. */
export function createTestAccounting(
  options: {
    quoteSource?: (request: AttemptAdmissionRequest) => PriceQuote
  } = {}
): GenerationAccounting & {
  admissions: AttemptAdmissionRequest[]
  settlements: AttemptSettlement[]
} {
  const admissions: AttemptAdmissionRequest[] = [],
    settlements: AttemptSettlement[] = []
  const rows = new Map<
    string,
    { price: PriceQuote; estimate: number; receipt?: AttemptReceipt }
  >()
  const transport: GenerationAccounting = {
    async admit(request) {
      const price = options.quoteSource?.(request) ?? {
        revision: "fake-price-v1",
        sourceUrl: "https://example.invalid/test-price",
        checkedAt: "2026-11-07",
        endsAt: null,
        inputPerM: 1_000_000,
        cacheReadPerM: 100_000,
        cacheWritePerM: 2_000_000,
        outputPerM: 5_000_000,
        maxInputTokens: 1_000_000,
      }
      const estimate = estimateMicros(
        price,
        request.inputTokens,
        request.maxOutputTokens,
        request.imageTokens
      )
      admissions.push(request)
      rows.set(request.attemptKey, { price, estimate })
      return {
        attemptKey: request.attemptKey,
        admitted: true,
        estimateMicros: estimate,
        priceRevision: price.revision,
      }
    },
    async settle(request) {
      settlements.push(request)
      const row = rows.get(request.attemptKey)
      if (!row) return null
      return (row.receipt ??= {
        attemptKey: request.attemptKey,
        currency: "USD",
        ...chargeMicros(
          row.price,
          row.estimate,
          request.usage,
          request.outcome
        ),
      })
    },
  }
  return Object.assign(accountingOperation(transport), {
    admissions,
    settlements,
  })
}
