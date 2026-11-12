import { canAxisGoNegative } from "./capabilities"
import { isSpacingSuffix } from "./write"
import type { SpacingAxis } from "./map-target"
import type { TweakScope } from "./class-operations"

export const TWEAK_SCOPE_LABELS: Record<TweakScope, string> = {
  all: "All sizes",
  "below-sm": "Small screens only (under 640 px)",
  "sm-and-up": "640 px and larger",
}

export function emitScopedSpacingUtility(
  axis: SpacingAxis,
  suffix: string,
  scope: TweakScope
): string {
  const prefix =
    scope === "below-sm" ? "max-sm:" : scope === "sm-and-up" ? "sm:" : ""
  const negative = suffix.startsWith("-")
  const magnitude = negative ? suffix.slice(1) : suffix
  const sign = negative && canAxisGoNegative(axis) ? "-" : ""
  return `${prefix}${sign}${axis}-${sign || !negative ? magnitude : "0"}`
}

export function findExpectedSpacingUtility(
  classTokens: readonly string[],
  axis: SpacingAxis,
  scope: TweakScope
): string | null {
  const prefix =
    scope === "below-sm" ? "max-sm:" : scope === "sm-and-up" ? "sm:" : ""
  const expression = new RegExp(`^${prefix.replace(":", "\\:")}-?${axis}-(.+)$`)
  const matches = classTokens.filter((token) => {
    const match = expression.exec(token)
    return Boolean(match && isSpacingSuffix(match[1]))
  })
  return matches.length === 1 ? matches[0] : null
}
