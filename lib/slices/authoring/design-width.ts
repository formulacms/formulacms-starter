/**
 * The one definition of "how wide was this design made for?" (slice-fidelity
 * plan §5 B2). Deliberately free of any `"use client"` directive and of Node
 * built-ins, so the browser prompt, the two server actions, and the CLI all
 * share the rule instead of re-typing it — four copies is how they drift.
 */

/** The question every ingestion surface asks before it saves a design. */
export const DESIGN_WIDTH_QUESTION = "How wide was this design made for?"

/** Plain-language refusal, used wherever a width is missing or unusable. */
export const DESIGN_WIDTH_REQUIRED =
  "Say how wide this design was made for, in pixels — it must be more than zero."

/** A design width is a number of pixels greater than zero. */
export function isDesignWidth(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/**
 * Read a typed or form-supplied answer. Kept pure so "a positive finite width
 * is required before save" is testable without a browser.
 */
export function parseDesignWidth(
  value: string
): { ok: true; cssWidth: number } | { ok: false; error: string } {
  const trimmed = value.trim()
  if (trimmed === "") {
    return { ok: false, error: "Enter how wide this design was made for." }
  }
  const cssWidth = Number(trimmed)
  if (!isDesignWidth(cssWidth)) {
    return {
      ok: false,
      error: "Use a number of pixels greater than zero, like 1440.",
    }
  }
  return { ok: true, cssWidth }
}
