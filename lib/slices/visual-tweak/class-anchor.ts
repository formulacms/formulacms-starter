import { SPACING_AXES } from "./map-target"
import { roleFromClassName } from "./capabilities"

export type ClassAnchorVerdict = "anchored" | "no-anchor" | "unknown"

// A concrete DOM/span class string may contain ordinary or arbitrary Tailwind
// variants before the utility (`max-sm:`, `*:`, `[&>:nth-child(2)]:`).
const VARIANT_PREFIX = String.raw`(?:(?:[\w-]+|\*|\[[^\]]+\]):)*`
const SPACING_UTILITY_RE = new RegExp(
  String.raw`(?:^|\s)${VARIANT_PREFIX}-?(?:${[...SPACING_AXES]
    .sort((a, b) => b.length - a.length)
    .join("|")})-(?:\[[^\]\s]+\]|[\w./-]+)(?=\s|$)`
)
const STRUCTURAL_UTILITY_RE = new RegExp(
  String.raw`(?:^|\s)${VARIANT_PREFIX}(?:flex|inline-flex|grid|block|inline-block|hidden|relative|absolute|fixed|sticky|mx-auto|items-[a-z-]+|justify-[a-z-]+|self-[a-z-]+|max-w-[\w./\[\]-]+|min-h-[\w./\[\]-]+|w-[\w./\[\]-]+|h-[\w./\[\]-]+|bg-[\w./\[\]-]+|border(?:-[\w./\[\]-]+)?|rounded(?:-[\w./\[\]-]+)?|overflow-[a-z-]+|aspect-[\w./\[\]-]+)(?=\s|$)`
)

/**
 * Client-safe target-level classifier shared by the simulator toolbar and the
 * spacing writer. `unknown` is reserved for an empty concrete class string;
 * every non-empty stylesheet-only class list is a definite `no-anchor`.
 */
export function classAnchorVerdict(className: string): ClassAnchorVerdict {
  const value = className.trim()
  if (value.length === 0) return "unknown"
  return SPACING_UTILITY_RE.test(value) ||
    roleFromClassName(value) ||
    STRUCTURAL_UTILITY_RE.test(value)
    ? "anchored"
    : "no-anchor"
}
