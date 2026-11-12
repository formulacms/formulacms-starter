import { ConvexError } from "convex/values"

/** Which notice a failed Help answer shows. */
export type HelpErrorKind = "unreachable" | "busy" | "refused" | "missing" | "other"

// Categories of the AI execution contract (`lib/ai/execution-contract.ts`).
// Written out here: the admin shell must not import the AI runtime library.
const KIND_BY_CATEGORY: Readonly<Record<string, HelpErrorKind>> = {
  PROVIDER_UNAVAILABLE: "unreachable",
  TIMEOUT: "unreachable",
  RATE_LIMITED: "busy",
  QUOTA_EXHAUSTED: "busy",
  AUTH_REQUIRED: "refused",
  CONFIG_MISSING: "missing",
  AI_OFF: "missing",
}

/**
 * Maps the value thrown by the Help action to a notice. Only a `ConvexError`
 * with object data counts: its `category`, or the rate limiter's own refusal
 * (`isRateLimitError` in `@convex-dev/rate-limiter`: `data.kind` is
 * "RateLimited"). Everything else is "other"; the message is never shown.
 */
export function helpErrorKind(error: unknown): HelpErrorKind {
  if (!(error instanceof ConvexError)) return "other"
  const data: unknown = error.data
  if (typeof data !== "object" || data === null) return "other"
  if ("kind" in data && data.kind === "RateLimited") return "busy"
  if (!("category" in data) || typeof data.category !== "string") return "other"
  return Object.hasOwn(KIND_BY_CATEGORY, data.category)
    ? KIND_BY_CATEGORY[data.category]!
    : "other"
}
