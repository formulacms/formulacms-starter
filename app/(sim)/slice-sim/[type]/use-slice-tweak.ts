"use client"

/**
 * Binds the selected target to the editor-scoped tweak store (ADR-0030 +
 * 2026-07-06 perf addendum). A spacing nudge does TWO cheap things and never
 * touches the renderer source:
 *  1. `onPreview(axis, valueRem)` — imperative inline-style preview on the one
 *     selected node in the iframe (zero React render, no compile, no reload; the
 *     change renders instantly and *stays* because nothing reloads the iframe).
 *  2. `setEdit(...)` — records the on-token value in the client batch, which the
 *     inspector reads back as the displayed value and Save later flushes in one
 *     write.
 *
 * All value math stays in the pure `scale` layer. Nothing here calls the server —
 * persistence is the store's `save()`, invoked only by the explicit Save button.
 * Typography joins preview history; exact token persistence belongs to the workspace.
 */

import { useVisualTweak } from "./visual-tweak-store"
import {
  TYPOGRAPHY_ROLES,
  type TypographyRole,
  canAxisGoNegative,
} from "@/lib/slices/visual-tweak/capabilities"
import type { ClassAnchorVerdict } from "@/lib/slices/visual-tweak/class-anchor"
import type { TweakScope } from "@/lib/slices/visual-tweak/class-operations"
import {
  nextSignedSuffix,
  signedSpacingSuffixToRem,
  snapRemToSpacingSuffix,
} from "@/lib/slices/visual-tweak/scale"
import {
  metricForAxis,
  UNLINKED,
  type LinkedTones,
  type ToolbarCapabilities,
  type ToolbarMetrics,
  type ToolbarSpacingAxis,
  type ToolbarTypographyProperty,
} from "./slice-tweak-toolbar-types"

/** The selected target the tweak controls act on — a structural subset of the
 *  preview's `TargetInfo` (path + role + measured box). */
export interface TweakTarget {
  loc: string
  tag: string
  sourceHash: string
  sourceClassTokens: string[]
  editable: boolean
  templateWide: boolean
  label: string
  path: string
  classAnchor: ClassAnchorVerdict
  role?: string | null
  isList?: boolean
  metrics?: ToolbarMetrics
}

/** Parse a computed px length (`"72px"`, `"normal"`, `""`) to rem, 0 when not a
 *  number. Used only to pick the on-scale step to nudge *from*. */
function computedPxToRem(value: string | undefined): number {
  const n = Number.parseFloat(value ?? "")
  return Number.isFinite(n) ? n / 16 : 0
}

/** Current on-scale spacing suffix for an axis, derived from the measured box. */
function measuredSuffix(
  axis: ToolbarSpacingAxis,
  metrics: ToolbarMetrics
): string {
  return snapRemToSpacingSuffix(computedPxToRem(metricForAxis(axis, metrics)))
}

/** `px` display string for an on-token suffix (`"2"` → `"8"`), matching the
 *  measured-metric format the toolbar shows for un-nudged sides. */
function suffixToDisplay(suffix: string): string {
  // Sign-aware: a negative-margin suffix (`"-4"`) must display as −16px, not the
  // literal "-4". `spacingSuffixToRem` returns null for a signed suffix, so
  // reading it unsigned here silently mis-shows (and a blur would then re-commit
  // −4px). `signedSpacingSuffixToRem` keeps the round-trip stable.
  const rem = signedSpacingSuffixToRem(suffix)
  return rem === null ? suffix : String(Math.round(rem * 16 * 10) / 10)
}

/** The four padding-side axes tied together by the padding link toggle. */
const PADDING_AXES: readonly ToolbarSpacingAxis[] = ["pt", "pr", "pb", "pl"]
/** The four margin-side axes tied together by the margin link toggle. */
const MARGIN_AXES: readonly ToolbarSpacingAxis[] = ["mt", "mr", "mb", "ml"]

/** Which tone (if any) an axis belongs to for linked stepping. Gap is its own
 *  control and never participates in a link. */
function toneAxes(
  axis: ToolbarSpacingAxis
): readonly ToolbarSpacingAxis[] | null {
  if ((PADDING_AXES as readonly ToolbarSpacingAxis[]).includes(axis)) {
    return PADDING_AXES
  }
  if ((MARGIN_AXES as readonly ToolbarSpacingAxis[]).includes(axis)) {
    return MARGIN_AXES
  }
  return null
}

export interface UseSliceTweak {
  capabilities: ToolbarCapabilities
  busy: boolean
  /** Optimistic per-axis display overrides for the current target (from the
   *  unsaved batch), shown in place of the measured value. */
  values: Partial<Record<ToolbarSpacingAxis, string>>
  onSpacingStep: (axis: ToolbarSpacingAxis, direction: "up" | "down") => void
  /** Commit a typed value on an axis: the caller passes rem (the input's
   *  parsed px / 16) and the hook snaps to the nearest on-token spacing suffix,
   *  keeping the emitted className on-scale (ADR-0020 drift guard). Same linked
   *  routing as `onSpacingStep`: in linked mode a typed value on any linkable
   *  side sets all eight padding+margin axes. Gap is exempt. */
  onSpacingSet: (axis: ToolbarSpacingAxis, remValue: number) => void
  onTypographyStep: (
    property: ToolbarTypographyProperty,
    direction: "up" | "down"
  ) => void
}

export function useSliceTweak({
  target,
  onPreview,
  linked = UNLINKED,
}: {
  target: TweakTarget | null
  /** Reflect a spacing nudge instantly as an inline style in the preview iframe
   *  (dev/edit-time only, never persisted). */
  onPreview: (
    axis: ToolbarSpacingAxis,
    valueRem: number,
    loc: string,
    scope: TweakScope
  ) => void
  /** Per-tone link toggles. When `padding` is on, a step/set on any padding
   *  side moves all four padding sides together; same for `margin`. Gap is
   *  independent and never linked. */
  linked?: LinkedTones
}): UseSliceTweak {
  const store = useVisualTweak()

  function pendingTarget(current: TweakTarget) {
    return {
      loc: current.loc,
      tag: current.tag,
      sourceHash: current.sourceHash,
      sourceClassTokens: current.sourceClassTokens,
      editable: current.editable,
      templateWide: current.templateWide,
      label: current.label,
      path: current.path,
    }
  }

  /** The linked tone's axis set for `axis`, or null when the axis is not part
   *  of a currently-linked tone (unlinked, or the axis is gap). */
  function linkedAxesFor(axis: ToolbarSpacingAxis) {
    const axes = toneAxes(axis)
    if (!axes) return null
    const mode = axes === PADDING_AXES ? linked.padding : linked.margin
    if (mode === "all") return axes
    if (mode === "x" && (axis.endsWith("l") || axis.endsWith("r"))) {
      return axes.filter((side) => side.endsWith("l") || side.endsWith("r"))
    }
    if (mode === "y" && (axis.endsWith("t") || axis.endsWith("b"))) {
      return axes.filter((side) => side.endsWith("t") || side.endsWith("b"))
    }
    return null
  }

  function onSpacingStep(axis: ToolbarSpacingAxis, direction: "up" | "down") {
    if (!target?.metrics || (axis === "gap" && !target.isList)) return
    const path = target.loc
    // Only margins may step past 0 into the negative ramp (ADR-0030 addendum:
    // Tailwind has no negative padding/gap). The sign is plumbed here, at the
    // boundary — the scale ramp stays unsigned.
    const allowNegative = canAxisGoNegative(axis)
    const axes = linkedAxesFor(axis)
    // Linked path: the four sides of one tone (padding OR margin) step together.
    // The clicked axis anchors the current suffix so the step is deterministic
    // regardless of which corner the designer touched.
    if (axes) {
      const current =
        store.edits[path]?.[axis]?.suffix ??
        measuredSuffix(axis, target.metrics)
      const suffix = nextSignedSuffix(current, direction, allowNegative)
      if (!suffix) return
      const valueRem = signedSpacingSuffixToRem(suffix) ?? 0
      for (const a of axes) onPreview(a, valueRem, target.loc, store.scope)
      store.setEdits(path, axes, {
        suffix,
        valueRem,
        target: pendingTarget(target),
      })
      return
    }
    const current =
      store.edits[path]?.[axis]?.suffix ?? measuredSuffix(axis, target.metrics)
    const suffix = nextSignedSuffix(current, direction, allowNegative)
    if (!suffix) return // at the edge of the scale — no-op
    const valueRem = signedSpacingSuffixToRem(suffix) ?? 0
    // 1. Instant, persistent inline preview (no reload wipes it — no write here).
    onPreview(axis, valueRem, target.loc, store.scope)
    // 2. Accumulate in the client batch; Save flushes it later in one write.
    store.setEdit(path, axis, {
      suffix,
      valueRem,
      target: pendingTarget(target),
    })
  }

  function onSpacingSet(axis: ToolbarSpacingAxis, remValue: number) {
    if (!target?.metrics || (axis === "gap" && !target.isList)) return
    if (!Number.isFinite(remValue)) return
    // Negative typed values are accepted on margin axes only; padding clamps by
    // rejecting them (the SideInput reverts its draft to the last good value).
    const allowNegative = canAxisGoNegative(axis)
    if (remValue < 0 && !allowNegative) return
    const path = target.loc
    const negative = remValue < 0
    const magnitude = snapRemToSpacingSuffix(Math.abs(remValue))
    const suffix = negative ? `-${magnitude}` : magnitude
    const snappedRem = signedSpacingSuffixToRem(suffix) ?? remValue
    const axes = linkedAxesFor(axis)
    if (axes) {
      for (const a of axes) onPreview(a, snappedRem, target.loc, store.scope)
      store.setEdits(path, axes, {
        suffix,
        valueRem: snappedRem,
        target: pendingTarget(target),
      })
      return
    }
    onPreview(axis, snappedRem, target.loc, store.scope)
    store.setEdit(path, axis, {
      suffix,
      valueRem: snappedRem,
      target: pendingTarget(target),
    })
  }

  function onTypographyStep(
    property: ToolbarTypographyProperty,
    direction: "up" | "down"
  ) {
    if (
      !target?.role ||
      !target.metrics ||
      !(TYPOGRAPHY_ROLES as readonly string[]).includes(target.role)
    )
      return
    const role = target.role as TypographyRole
    const initialValue = store.typographyTokens[role]?.[property]
    if (!initialValue) return
    store.stepTypography({
      role,
      property,
      initialValue,
      delta:
        (direction === "up" ? 1 : -1) *
        (property === "font-size"
          ? 1
          : property === "line-height"
            ? 0.05
            : 0.005),
      rootFontSizePx: Number.parseFloat(target.metrics.rootFontSize ?? ""),
      computedLetterSpacing: target.metrics.letterSpacing,
      fontSizePx: Number.parseFloat(target.metrics.fontSize),
    })
  }

  const spacingEditable = Boolean(target?.editable)
  const capabilities: ToolbarCapabilities = {
    spacing: spacingEditable,
    gap: spacingEditable && Boolean(target?.isList),
    typography: Boolean(target?.role),
    role: target?.role ?? null,
    spacingScope: target?.templateWide ? "All repeated instances" : null,
    spacingDisabledReason: target?.editable
      ? undefined
      : "This element's className is dynamic and cannot be edited safely.",
  }

  const path = target?.loc ?? ""
  const forPath = store.edits[path] ?? {}
  const values: Partial<Record<ToolbarSpacingAxis, string>> = {}
  for (const [axis, edit] of Object.entries(forPath)) {
    if (edit) values[axis as ToolbarSpacingAxis] = suffixToDisplay(edit.suffix)
  }

  return {
    capabilities,
    busy: store.saving,
    values,
    onSpacingStep,
    onSpacingSet,
    onTypographyStep,
  }
}
