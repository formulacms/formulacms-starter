/**
 * Pre-apply diff surface for the contextual visual tweak editor (ADR-0030).
 *
 * `spec-diff.ts` (`diffSliceSpecs`) is content-model-only — it will not reflect a
 * className or token change — so the visual editor needs its own before/after
 * view of the exact CSS-source edit a tweak will make. These are pure
 * `(source, …) → diff | null` functions: `null` means "no change" (the target
 * couldn't be located, its className is dynamic, or the value already matches),
 * so the editor can disable Apply. The server action reuses them to echo the
 * diff it actually applied.
 */

import {
  axisUtilityRegExp,
  childVariantPrefix,
  isListItemSpacingPath,
  resolveListItemSpacing,
  resolveSpacingSpan,
  variantAxisUtilityRegExp,
  type SpacingAxis,
} from "./map-target"
import { patchSpacingClassName, patchVariantSpacingClassName } from "./write"
import type { TypographyProperty } from "./write"

/** A spacing tweak: one utility on one element's className, per-slice-type. */
export interface SpacingTweakDiff {
  kind: "spacing"
  /** Repo-relative renderer file, e.g. `components/slices/hero-agency.tsx`. */
  file: string
  path: string
  axis: SpacingAxis
  /** The whole className before/after, so the operator sees the surgical edit
   *  in context. */
  className: { before: string; after: string }
  /** Just the axis utility: `before` is `null` when the axis was absent (the
   *  tweak appends it). */
  utility: { before: string | null; after: string }
}

/**
 * A typography tweak: one role token's value in the site stylesheet.
 *
 * Nothing produces this any more. Site-wide token edits moved to
 * `/admin/design-system` in Plan 033 Phase 2 (ADR-0046), which describes a
 * change by exact source span rather than by first matching variable name. The
 * shape stays in the union so an older client still typechecks against the
 * refusal it now receives.
 */
export interface TypographyTweakDiff {
  kind: "typography"
  /** Repo-relative token file, i.e. `app/globals.css`. */
  file: string
  role: string
  property: TypographyProperty
  /** The CSS custom property edited, e.g. `--text-display--line-height`. */
  token: string
  value: { before: string; after: string }
}

export type VisualTweakDiff = SpacingTweakDiff | TypographyTweakDiff

/**
 * Describe the spacing tweak `axis-<suffix>` on `path` without writing. Returns
 * `null` when the target can't be located, its className is dynamic, or the
 * result is identical (no-op). Throws for unsupported paths (mirrors
 * `resolveSpacingSpan`), so the caller refuses rather than silently no-ops.
 */
export function describeSpacingTweak(
  source: string,
  file: string,
  path: string,
  axis: SpacingAxis,
  suffix: string
): SpacingTweakDiff | null {
  // List paths edit the cards via a variant on the static grid parent (Item 7);
  // the diff is the variant-prefixed utility before/after, read with the
  // variant-scoped regex so it isn't confused with the bare axis on the parent.
  if (isListItemSpacingPath(path)) {
    const res = resolveListItemSpacing(source, path)
    if (!res) return null
    const before = res.span.className
    const after = patchVariantSpacingClassName(
      before,
      res.variant,
      axis,
      suffix
    )
    if (after === before) return null
    const re = variantAxisUtilityRegExp(res.variant, axis)
    return {
      kind: "spacing",
      file,
      path,
      axis,
      className: { before, after },
      utility: {
        before: re.exec(before)?.[0] ?? null,
        after:
          re.exec(after)?.[0] ??
          `${childVariantPrefix(res.variant)}${axis}-${suffix}`,
      },
    }
  }

  const span = resolveSpacingSpan(source, path, axis)
  if (!span) return null
  const before = span.className
  const after = patchSpacingClassName(before, axis, suffix)
  if (after === before) return null
  const current = axisUtilityRegExp(axis).exec(before)
  // Read the emitted utility back out of the patched className rather than
  // rebuilding it from `suffix` — that way the sign normalisation (`-mt-4`) and
  // the padding clamp (`pt-0`) applied inside `patchSpacingClassName` are what
  // the diff surfaces, not a naive `${axis}-${suffix}` (which would be `mt--4`).
  const emitted = axisUtilityRegExp(axis).exec(after)
  return {
    kind: "spacing",
    file,
    path,
    axis,
    className: { before, after },
    utility: {
      before: current?.[0] ?? null,
      after: emitted?.[0] ?? `${axis}-${suffix}`,
    },
  }
}
