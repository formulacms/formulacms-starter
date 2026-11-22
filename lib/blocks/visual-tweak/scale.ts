/**
 * Token/scale navigation for the contextual visual tweak editor (ADR-0030).
 *
 * The editor never lets a designer type a raw px value and snap it back: named
 * responsive tokens like `py-section` are `clamp(3rem, …, 6rem)` and have no
 * single computed value to round-trip. Instead the stepper walks an *ordered
 * scale* of utilities — every step is, by construction, a clean token — so the
 * emitted className stays inside the design system (the ADR-0020 drift guard).
 *
 * Spacing values are expressed in rem for ordering; named tokens are pinned to
 * their nominal rem (the clamp midpoint for `section`) so a nudge off a named
 * token lands on the adjacent numeric step.
 */

/** Nominal rem for the named `--spacing-*` tokens (Tailwind v4 → `*-section`,
 *  `*-gutter`, `*-stack` utilities). `section` is a clamp; we pin its nominal to
 *  the midpoint purely so stepping resolves a sensible neighbour. */
const NAMED_SPACING_REM: Record<string, number> = {
  section: 4.5, // clamp(3rem, 2rem + 5vw, 6rem) → midpoint
  gutter: 1.5,
  stack: 1,
}

/** Ordered numeric Tailwind spacing suffixes (suffix N ⇒ N × 0.25rem). The
 *  stepper always resolves to one of these — named tokens are entry points, not
 *  landing spots, so the scale stays monotonic and unambiguous. */
const NUMERIC_SPACING_SUFFIXES = [
  "0", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "5", "6", "7", "8", "9",
  "10", "11", "12", "14", "16", "20", "24", "28", "32", "40", "48",
] as const

const numericRem = (suffix: string) => Number(suffix) * 0.25

/** rem value of any spacing utility suffix, named or numeric. `null` for an
 *  arbitrary value (`[5rem]`) or an unknown token — the caller keeps the current
 *  utility rather than guessing. */
export function spacingSuffixToRem(suffix: string): number | null {
  if (suffix in NAMED_SPACING_REM) return NAMED_SPACING_REM[suffix]
  if (/^\d+(?:\.\d+)?$/.test(suffix)) return numericRem(suffix)
  return null
}

/** Signed rem of a spacing suffix that may carry a leading `-` (`"-4"` → −1rem).
 *  `null` for an arbitrary value (`[5rem]`) or unknown token — same contract as
 *  `spacingSuffixToRem`, just sign-aware. Margins are the only axes that reach
 *  the negative branch (padding/gap clamp at 0 upstream). */
export function signedSpacingSuffixToRem(suffix: string): number | null {
  const negative = suffix.startsWith("-")
  const rem = spacingSuffixToRem(negative ? suffix.slice(1) : suffix)
  if (rem === null) return null
  return negative ? -rem : rem
}

export type StepDirection = "up" | "down"

/**
 * The next numeric spacing suffix strictly larger ("up") or smaller ("down")
 * than the current utility's rem. Strict inequality gives clean stepping even
 * when the current value sits exactly on a scale point or on a named token.
 * Returns `null` at the ends of the scale (nothing to move to).
 */
export function nextSpacingSuffix(
  currentSuffix: string,
  direction: StepDirection
): string | null {
  const rem = spacingSuffixToRem(currentSuffix)
  if (rem === null) return null
  const ordered = NUMERIC_SPACING_SUFFIXES
  if (direction === "up") {
    const hit = ordered.find((s) => numericRem(s) > rem)
    return hit ?? null
  }
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    if (numericRem(ordered[i]) < rem) return ordered[i]
  }
  return null
}

/**
 * Step a spacing suffix that may be negative, walking one continuous scale that
 * runs `… -1, -0.5, 0, 0.5, 1 …`. Sign lives only here (the raw ramp in
 * `NUMERIC_SPACING_SUFFIXES` stays unsigned); the caller gates `allowNegative`
 * on axis membership (margins yes, padding/gap no — Tailwind has no negative
 * padding). Zero is emitted as plain `"0"`, never `"-0"`. `null` at either end
 * (or, when `allowNegative` is false, at 0 stepping down — the padding floor).
 */
export function nextSignedSuffix(
  currentSuffix: string,
  direction: StepDirection,
  allowNegative: boolean
): string | null {
  if (!allowNegative) return nextSpacingSuffix(currentSuffix, direction)

  const negative = currentSuffix.startsWith("-")
  const magnitude = negative ? currentSuffix.slice(1) : currentSuffix
  const rem = spacingSuffixToRem(magnitude)
  if (rem === null) return null
  const signedRem = negative ? -rem : rem

  if (direction === "up") {
    // Toward +∞. From ≥0: grow the positive magnitude. From <0: shrink the
    // negative magnitude toward 0 (a `down`-step of |value|).
    if (signedRem >= 0) return nextSpacingSuffix(magnitude, "up")
    const smaller = nextSpacingSuffix(magnitude, "down")
    if (smaller === null || smaller === "0") return "0"
    return `-${smaller}`
  }
  // direction === "down": toward −∞. From ≤0: grow the negative magnitude.
  // From >0: shrink the positive magnitude toward 0.
  if (signedRem <= 0) {
    const larger = nextSpacingSuffix(magnitude, "up")
    return larger === null ? null : `-${larger}`
  }
  return nextSpacingSuffix(magnitude, "down")
}

/** Nearest numeric spacing suffix to a raw rem (fallback for a value that
 *  arrives as px/rem rather than as a step nudge). Ties resolve to the smaller
 *  step. */
export function snapRemToSpacingSuffix(rem: number): string {
  let best: string = NUMERIC_SPACING_SUFFIXES[0]
  let bestGap = Infinity
  for (const s of NUMERIC_SPACING_SUFFIXES) {
    const gap = Math.abs(numericRem(s) - rem)
    if (gap < bestGap) {
      bestGap = gap
      best = s
    }
  }
  return best
}

/** Line-height scale (unitless). Typography leading is a role token
 *  (`--text-<role>--line-height`), stepped along this ramp. */
export const LINE_HEIGHT_SCALE = [
  1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6,
] as const

/** Tolerance for treating a `current` value as sitting *on* a ramp point. The
 *  ratio arrives from `getComputedStyle` as a division (`52.8px / 48px =
 *  1.0999999999999999`), so a strict `>`/`<` comparison would step "up" onto the
 *  same nominal value (1.1) it started on — a silent no-op. Snapping within this
 *  epsilon makes a nudge always advance to the true neighbour. */
const LINE_HEIGHT_EPSILON = 1e-4

/** Next line-height on the ramp, strictly up/down from `current` (epsilon-
 *  tolerant so a value a hair off a ramp point still advances). `null` at the
 *  ends. `current` need not be exactly on the ramp. */
export function nextLineHeight(
  current: number,
  direction: StepDirection
): number | null {
  if (direction === "up") {
    return LINE_HEIGHT_SCALE.find((v) => v > current + LINE_HEIGHT_EPSILON) ?? null
  }
  for (let i = LINE_HEIGHT_SCALE.length - 1; i >= 0; i -= 1) {
    if (LINE_HEIGHT_SCALE[i] < current - LINE_HEIGHT_EPSILON) {
      return LINE_HEIGHT_SCALE[i]
    }
  }
  return null
}
