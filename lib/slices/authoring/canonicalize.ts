// Canonicalize a model-authored renderer body into the compliant Tailwind
// dialect BEFORE it reaches the style gate.
//
// Why this exists: the gate bans arbitrary bracket values (ADR-0020 token
// discipline), but several bracket forms have an EXACT, lossless standard-
// utility equivalent. A model that writes the v3 dialect (`aspect-[4/5]`,
// `min-h-[24rem]`) is expressing a legal design intent in an illegal syntax —
// rejecting it throws away an otherwise-good generation over a spelling.
// Empirically this was the dominant failure: 5/5 live Claude cells tripped the
// gate, and 4 of them leaked ONLY values this module rewrites.
//
// The bar for a rule here is EXACT EQUIVALENCE, not "close enough":
//   - `aspect-[4/5]` ≡ `aspect-4/5`  — Tailwind v4 matches bare `ratio` values
//     (`@utility aspect-* { aspect-ratio: --value(--aspect-ratio-*, ratio, [ratio]) }`).
//   - `min-h-[24rem]` ≡ `min-h-96`   — spacing utilities are
//     `calc(var(--spacing) * n)`, and `--spacing` is Tailwind's 0.25rem default
//     (app/globals.css overrides only NAMED spacing tokens, never the base).
//
// Anything requiring judgment is NOT rewritten — it stays a gate failure.
// Silently "fixing" a value we only half-understand would trade a loud, correct
// rejection for a quiet, wrong acceptance.

/** One applied rewrite, so canonicalization is reported and never silent. */
export interface CanonicalizedClass {
  readonly from: string
  readonly to: string
}

export interface CanonicalizedBody {
  readonly body: string
  readonly changes: readonly CanonicalizedClass[]
}

/** Tailwind's default spacing step, in rem. */
export const DEFAULT_SPACING_REM_STEP = 0.25

export interface CanonicalizeOptions {
  /**
   * rem per spacing step, for the `min-h-[24rem]` → `min-h-96` rewrite.
   *
   * `null` disables the spacing arm entirely. This matters: ADR-0020 gives every
   * site its own token layer and it MAY override `--spacing`, in which case
   * `min-h-96` is no longer 24rem and the "lossless" rewrite would silently
   * resize the design. When the step cannot be established, decline to rewrite
   * and let the gate reject — a loud rejection beats a quiet resize.
   */
  readonly spacingRemStep?: number | null
}

/** Read the site's spacing step from its design-system layer. Returns `null`
 *  when the site overrides `--spacing` with something we cannot resolve, which
 *  disables the spacing rewrite rather than guessing at it. */
export function spacingRemStepFromCss(css: string): number | null {
  // Only a BARE `--spacing:` redefines the scale; `--spacing-gutter` and friends
  // are named tokens and leave the numeric scale alone.
  const declaration = css.match(/(?<![\w-])--spacing:\s*([^;]+);/)
  if (!declaration) return DEFAULT_SPACING_REM_STEP

  // The site DID redefine the scale. Resolve it, or decline — falling back to
  // Tailwind's default here would be the worst outcome: a confident rewrite
  // against a step we know to be wrong.
  const rem = declaration[1].trim().match(/^([0-9.]+)rem$/)
  if (!rem) return null
  const value = Number(rem[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Spacing-scale utilities whose bracket form is exactly `calc(--spacing * n)`.
 *
 *  WIDTHS ARE DELIBERATELY ABSENT. `max-w-[57rem]` → `max-w-228` is a lossless
 *  CSS rewrite but a harmful one: width is precisely where ADR-0020 wants a
 *  token (`max-w-content`) or a named utility (`max-w-4xl`), so rewriting it
 *  would launder a violation the gate correctly caught into a degenerate magic
 *  number the gate can no longer see. Heights and gaps have no token layer —
 *  they are geometry, and a scale utility is the sanctioned answer there. */
const SPACING_UTILITIES = [
  "h",
  "min-h",
  "max-h",
  "gap",
  "gap-x",
  "gap-y",
] as const

const VARIANT = String.raw`(?:[a-z0-9-]+:)*`

/** `aspect-[4/5]` → `aspect-4/5`. Ratios only — never a keyword or a length. */
const ASPECT_RE = new RegExp(
  String.raw`\b(${VARIANT})aspect-\[(\d+)\s*/\s*(\d+)\]`,
  "g"
)

/** `min-h-[24rem]` → `min-h-96`, when the rem value lands on the spacing scale. */
const SPACING_REM_RE = new RegExp(
  String.raw`\b(${VARIANT})(${SPACING_UTILITIES.join("|")})-\[(\d+(?:\.\d+)?)rem\]`,
  "g"
)

export function canonicalizeRendererBody(
  body: string,
  options: CanonicalizeOptions = {}
): CanonicalizedBody {
  const changes: CanonicalizedClass[] = []
  const spacingRemStep =
    options.spacingRemStep === undefined
      ? DEFAULT_SPACING_REM_STEP
      : options.spacingRemStep

  let next = body.replace(ASPECT_RE, (match, variant: string, w: string, h: string) => {
    const to = `${variant}aspect-${w}/${h}`
    changes.push({ from: match, to })
    return to
  })

  // A ratio means the same thing under any token layer, so it is always safe.
  // A spacing STEP is only meaningful against a known `--spacing`.
  if (spacingRemStep === null) return { body: next, changes }

  next = next.replace(
    SPACING_REM_RE,
    (match, variant: string, utility: string, rem: string) => {
      const steps = Number(rem) / spacingRemStep
      // A non-integer step has no standard-utility equivalent. Leave it alone
      // and let the gate reject it — a wrong rewrite is worse than a rejection.
      if (!Number.isInteger(steps) || steps <= 0) return match
      const to = `${variant}${utility}-${steps}`
      changes.push({ from: match, to })
      return to
    }
  )

  return { body: next, changes }
}
