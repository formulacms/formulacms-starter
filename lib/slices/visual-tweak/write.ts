/**
 * Surgical CSS-source writers for the contextual visual tweak editor (ADR-0030).
 *
 * The clean-CSS bar demands that after a tweak, `git diff` shows ONLY the real
 * className/token change — the file must read as hand-authored. So these are
 * byte-level string edits, never a template regeneration: the renderer-body
 * persist template (`updateSliceRendererBody`) is lossy for hand-authored
 * renderers (it can't represent e.g. `hero-agency`'s `headingId`/`aria` wiring),
 * so routing a tweak through it would regress the file (ADR-0030 finding F2).
 *
 * One writer remains: `applySpacingTweak` patches a spacing utility in a
 * renderer className. The typography half — a first-match role-token edit in
 * `app/globals.css` — was retired in Plan 033 Phase 2; site-wide token edits
 * belong to `/admin/design-system`, which addresses a declaration by exact
 * source span rather than by the first variable name it happens to match.
 *
 * It is pure `(source, …) → source`; the caller writes the result to disk and
 * runs the existing gate (typecheck + verify-slice) with snapshot/rollback.
 */

import { canAxisGoNegative } from "./capabilities"
import {
  axisUtilityRegExp,
  childVariantPrefix,
  isListItemSpacingPath,
  isResponsiveBreakpoint,
  resolveListItemSpacing,
  resolveSpacingSpan,
  responsiveAxisUtilityRegExp,
  responsiveVariantPrefix,
  variantAxisUtilityRegExp,
  SPACING_AXES,
  type ChildVariant,
  type ResponsiveBreakpoint,
  type SpacingAxis,
} from "./map-target"
import { classAnchorVerdict } from "./class-anchor"

export { isResponsiveBreakpoint }
export type { ChildVariant, ResponsiveBreakpoint, SpacingAxis }

/** Runtime check that a string is one of the supported spacing axes. Spacing
 *  edits skip the heavy gate (ADR-0030 addendum), so this boundary check —
 *  not the `SpacingAxis` type, which doesn't constrain a network caller — is
 *  what stops a malformed axis from reaching the regex/patch below. */
export function isSpacingAxis(value: string): value is SpacingAxis {
  return (SPACING_AXES as readonly string[]).includes(value)
}

/** Runtime check that a string is safe to splice into a className literal as
 *  a spacing suffix: a plain Tailwind value (letters/digits/`.`/`_`, e.g. `16`,
 *  `section`, `1.5`) or an arbitrary value in brackets (e.g. `[5rem]`) with no
 *  quotes, whitespace, braces, backticks, or angle brackets — anything that
 *  could break out of the surrounding `className="…"` string. */
export function isSpacingSuffix(value: string): boolean {
  return (
    /^-?[A-Za-z0-9][\w.]{0,31}$/.test(value) ||
    /^\[[^\]"'`\s{}<>]{1,64}\]$/.test(value)
  )
}

/**
 * Build the emitted utility text for `axis`+`suffix` under an optional Tailwind
 * variant `prefix`. Tailwind's negative form is a LEADING dash AFTER any variant
 * prefix (`-mt-4`, `*:-mt-4`), and only margins may go negative — padding/gap
 * have no `-p-*`/`-gap-*`, so a negative there clamps to 0. `canAxisGoNegative`
 * owns that policy, shared with the toolbar input and the tweak hook.
 */
function emitSpacingUtility(
  axis: SpacingAxis,
  suffix: string,
  prefix: string
): string {
  const negative = suffix.startsWith("-")
  const canNegate = canAxisGoNegative(axis)
  const magnitude = negative ? (canNegate ? suffix.slice(1) : "0") : suffix
  const sign = negative && canNegate ? "-" : ""
  return `${prefix}${sign}${axis}-${magnitude}`
}

/**
 * Replace the utility matched by `re` with `next`, or append `next` when the
 * axis is absent (so the element gains the intent). The replacement is a
 * callback, not the raw string — a `next` containing `$&`/`$'`/… must never be
 * reinterpreted as a replacement pattern by `String#replace`.
 */
function patchOrAppend(className: string, re: RegExp, next: string): string {
  if (re.test(className)) return className.replace(re, () => next)
  return className.length === 0 ? next : `${className} ${next}`
}

/**
 * Replace (or append) the utility for `axis` in a className string with
 * `axis-<suffix>`. Idempotent shape: if the axis utility is absent it is
 * appended; if present, only that token changes.
 */
export function patchSpacingClassName(
  className: string,
  axis: SpacingAxis,
  suffix: string
): string {
  return patchOrAppend(
    className,
    axisUtilityRegExp(axis),
    emitSpacingUtility(axis, suffix, "")
  )
}

/**
 * Replace (or append) a variant-prefixed spacing utility (`[&>:nth-child(1)]:pt-4`,
 * `*:-mt-6`) for `axis` under `variant` — the Item 7 (option D) writer that edits
 * a list container's children via a Tailwind child-combinator variant on the
 * static grid parent. Uses the variant-scoped regex so it only ever touches its
 * own variant's utility, never the bare axis or a sibling card/variant.
 */
export function patchVariantSpacingClassName(
  className: string,
  variant: ChildVariant,
  axis: SpacingAxis,
  suffix: string
): string {
  return patchOrAppend(
    className,
    variantAxisUtilityRegExp(variant, axis),
    emitSpacingUtility(axis, suffix, childVariantPrefix(variant))
  )
}

/**
 * Replace (or append) a responsive-prefixed spacing utility (`max-sm:pt-4`,
 * `max-sm:-mt-6`) for `axis` at `breakpoint` — the Item 8 (viewport honesty)
 * writer. An edit made on the slice-sim Mobile tab emits a `max-sm:` (max-width)
 * variant so it applies on the phone ONLY and leaves the base (desktop) utility
 * alone — see `responsiveAxisUtilityRegExp` for why max-width, not `sm:`. Uses
 * the breakpoint-scoped regex so it only touches its own responsive utility,
 * never the bare axis or a different breakpoint.
 */
export function patchResponsiveSpacingClassName(
  className: string,
  breakpoint: ResponsiveBreakpoint,
  axis: SpacingAxis,
  suffix: string
): string {
  return patchOrAppend(
    className,
    responsiveAxisUtilityRegExp(breakpoint, axis),
    emitSpacingUtility(axis, suffix, responsiveVariantPrefix(breakpoint))
  )
}

/**
 * Apply a spacing tweak to a renderer source: resolve the target path (axis-aware
 * — a container tweak lands on the nearest ancestor owning the axis) to its
 * className span, patch the one axis utility, splice it back. Returns the new
 * source, or `null` when the target can't be located (caller leaves the file
 * untouched). Everything outside the className quotes is preserved verbatim.
 *
 * `breakpoint` (Item 8) scopes the edit to a responsive prefix (`max-sm:pt-4`) so
 * a Mobile-tab tweak doesn't mutate desktop. It applies only to directly-anchored
 * (non-list) paths: list cards already write through a child-combinator variant
 * (`[&>:nth-child(n)]:`), and stacking a responsive prefix on that variant is out
 * of scope, so a list edit stays base (all-viewport) even from the Mobile tab —
 * the workbench banner states this. `breakpoint` is therefore ignored on list
 * paths, honored elsewhere.
 */
export function applySpacingTweak(
  source: string,
  path: string,
  axis: SpacingAxis,
  suffix: string,
  breakpoint?: ResponsiveBreakpoint
): string | null {
  // List paths (`items`, `items[i]`) edit the cards via a structural variant on
  // the static grid parent (Item 7, option D) — resolved/patched separately, and
  // skipped (null, never thrown) when the parent isn't a clean anchor. Responsive
  // scoping does NOT apply here (see docstring); breakpoint is intentionally unused.
  if (isListItemSpacingPath(path)) {
    const res = resolveListItemSpacing(source, path)
    if (!res) return null
    // ADR-0044: appending a utility to a stylesheet-only element would split
    // its spacing across two sources, with Tailwind silently winning.
    if (classAnchorVerdict(res.span.className) === "no-anchor") return null
    const nextClass = patchVariantSpacingClassName(
      res.span.className,
      res.variant,
      axis,
      suffix
    )
    if (nextClass === res.span.className) return source
    return (
      source.slice(0, res.span.start) + nextClass + source.slice(res.span.end)
    )
  }

  const span = resolveSpacingSpan(source, path, axis)
  if (!span) return null
  if (classAnchorVerdict(span.className) === "no-anchor") return null
  const nextClass = breakpoint
    ? patchResponsiveSpacingClassName(span.className, breakpoint, axis, suffix)
    : patchSpacingClassName(span.className, axis, suffix)
  if (nextClass === span.className) return source
  return source.slice(0, span.start) + nextClass + source.slice(span.end)
}

/**
 * Typography properties that live on a role token in the site stylesheet.
 *
 * The type survives so a stale caller still typechecks against a refusal, but
 * the writer behind it is gone (Plan 033 Phase 2). Editing a site-wide token by
 * searching the stylesheet for the first matching variable name could not name
 * the selector, cascade layer, register or mode it had just changed — ADR-0046
 * moved that work to `/admin/design-system`, where the change is addressed by
 * exact source span, previewed with its blast radius, and undoable.
 */
export type { TypographyProperty } from "./typography"
