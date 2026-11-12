import { ConvexError } from "convex/values"

/**
 * Stable server refusal codes the Pages list maps to plain copy. Server text
 * is never shown; unknown failures use the caller's translated fallback.
 */
export type RowErrorKind =
  | "stale"
  | "ancestryInUse"
  | "homeMustBeRoot"
  | "releaseReplacement"
  | "homeLifecycle"
  | "writerDisabled"

function errorText(error: unknown): string {
  const parts: string[] = []
  if (error instanceof ConvexError) {
    const data: unknown = error.data
    if (typeof data === "string") parts.push(data)
    else if (
      data !== null &&
      typeof data === "object" &&
      "code" in data &&
      typeof data.code === "string"
    ) {
      parts.push(data.code)
    }
  }
  // A transport may preserve only the formatted message; read it solely to
  // recover an allowlisted code.
  if (error instanceof Error) parts.push(error.message)
  return parts.join(" ")
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return errorText(error).includes(code)
}

export function rowErrorKind(error: unknown): RowErrorKind | null {
  const text = errorText(error)
  // Every stale-token refusal (PAGE_*_STALE, PUBLICATION_*_STALE, ...): the
  // page or its settings changed since the row was read.
  if (/\b[A-Z][A-Z_]*_STALE\b/.test(text)) return "stale"
  if (text.includes("PAGE_ANCESTRY_IN_USE")) return "ancestryInUse"
  if (text.includes("PUBLICATION_HOME_MUST_BE_ROOT")) return "homeMustBeRoot"
  if (text.includes("PAGE_LOCALE_RELEASE_REPLACEMENT_REQUIRED")) {
    return "releaseReplacement"
  }
  if (text.includes("PAGE_HOME_LIFECYCLE_REFUSED")) return "homeLifecycle"
  if (text.includes("LEGACY_PUBLICATION_WRITER_DISABLED")) {
    return "writerDisabled"
  }
  return null
}
