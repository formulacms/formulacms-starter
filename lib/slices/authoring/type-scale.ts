/**
 * Single source of truth for the source-markup-to-design-token mapping the
 * slice-authoring prompts teach an agent translating raw Tailwind fixed-size
 * type classes (`text-4xl`, `text-5xl`, …) into the site's fluid type-scale
 * tokens (`text-title`, `text-display`, …) — see `agent-prompts.ts` (A1,
 * 2026-08-04, `docs/planning/slice-fidelity-implementation-2026-08-04.md`).
 *
 * `kind: "exact"` means the token's fluid clamp tops out at precisely the
 * Tailwind class's fixed size, so collapsing that class into a different
 * token is a silent downgrade, not a rounding. `kind: "nearest"` means the
 * token is the closest available role but does not reproduce the class's
 * exact size — the prompt must say so rather than imply equality.
 * `type-scale.node.test.ts` checks both claims against the real installed
 * Tailwind scale and the real token values so this file can't drift silently.
 */

export interface TypeScaleMapping {
  /** Tailwind's fixed-size utility class, e.g. `"text-4xl"`. */
  readonly tailwindClass: string
  /** The design-system fluid type-scale token, e.g. `"text-title"`. */
  readonly token: string
  readonly kind: "exact" | "nearest"
}

export const TYPE_SCALE_MAPPINGS: readonly TypeScaleMapping[] = [
  { tailwindClass: "text-5xl", token: "text-display", kind: "exact" },
  { tailwindClass: "text-4xl", token: "text-title", kind: "exact" },
  { tailwindClass: "text-3xl", token: "text-heading", kind: "nearest" },
]

/** Prompt-facing description, generated from the mapping above so the prompt
 *  text and the test expectations never fork into two hand-typed copies. */
export function describeTypeScaleMappings(): string {
  const exact = TYPE_SCALE_MAPPINGS.filter((m) => m.kind === "exact")
    .map((m) => `\`${m.tailwindClass}\`→\`${m.token}\``)
    .join(", ")
  const nearest = TYPE_SCALE_MAPPINGS.filter((m) => m.kind === "nearest")
    .map((m) => `\`${m.tailwindClass}\`→\`${m.token}\` (nearest role, not an exact size match)`)
    .join(", ")
  return `${exact} (exact); ${nearest}`
}
