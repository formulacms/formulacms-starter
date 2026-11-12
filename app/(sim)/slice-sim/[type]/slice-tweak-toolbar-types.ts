import type { TypographyProperty } from "@/lib/slices/visual-tweak/typography"
/**
 * Frozen prop contract for the contextual visual tweak inspector (ADR-0030).
 * It is a right-docked panel (not a floating overlay): controls sit off the
 * canvas so they never clip or cover the target — the Figma inspector model.
 *
 * The panel is purely presentational: it receives the selected element's label +
 * measured values + what the target supports, and emits *step* intents (which
 * control, which direction). It never talks to the server or the postMessage
 * channel — the parent (`slice-preview.tsx`) owns the scale.ts snapping, the
 * `applyVisualTweakAction` call, the gate result, and the iframe reload. This
 * split keeps it a bounded, testable UI unit.
 */

/** Spacing axes the inspector can hold edits for (a subset of the write layer's
 *  `SpacingAxis`): a per-side box model — padding T/R/B/L and margin T/R/B/L —
 *  the vertical/horizontal shorthands, plus gap. Each maps to one Tailwind
 *  utility on the targeted element.
 *
 *  The `x`/`y` shorthands are here because the write layer has always emitted
 *  them (`SPACING_AXES` in lib/slices/visual-tweak/map-target.ts) and the
 *  reducer stores edits keyed by axis without validating against this union —
 *  so a `py` edit round-tripped correctly at runtime while failing to compile.
 *  Note this type governs what the inspector can *hold*, not what it renders as
 *  steppers: the per-side controls are still driven by `sides` in
 *  slice-tweak-toolbar.tsx, so widening this adds no UI on its own. */
export type ToolbarSpacingAxis =
  | "pt"
  | "pr"
  | "pb"
  | "pl"
  | "mt"
  | "mr"
  | "mb"
  | "ml"
  | "px"
  | "py"
  | "mx"
  | "my"
  | "gap"

/** Typography properties the inspector exposes; each moves the element's role
 *  token site-wide. */
export type ToolbarTypographyProperty = TypographyProperty

/** Per-tone link state — each tone owns its own link toggle so a designer can
 *  keep padding linked (all four sides step together) while leaving margin
 *  per-side, and vice versa. Owner's ruling: tying padding + margin together
 *  under a single link is "absurd" — they are independent design decisions. */
export type SpacingLink = "all" | "x" | "y" | "none"

export interface LinkedTones {
  padding: SpacingLink
  margin: SpacingLink
}

/** Both tones unlinked — the default, and the shared empty value so the toolbar
 *  and the hook can't drift on what "no links" means. */
export const UNLINKED: LinkedTones = { padding: "none", margin: "none" }

/** Measured current values from `getComputedStyle`, shown next to each control
 *  (display only — the toolbar never parses these into steps). */
export interface ToolbarMetrics {
  size: { width: number; height: number }
  padding: { top: string; right: string; bottom: string; left: string }
  margin: { top: string; right: string; bottom: string; left: string }
  gap: string
  fontSize: string
  lineHeight: string
  letterSpacing?: string
  rootFontSize?: string
}

/** The measured box side a spacing axis reads its current value from. Shared by
 *  the toolbar (which displays it) and the tweak hook (which snaps it onto the
 *  token scale) so the axis→metric mapping has one definition. */
export function metricForAxis(
  axis: ToolbarSpacingAxis,
  metrics: ToolbarMetrics
): string {
  switch (axis) {
    case "pt":
      return metrics.padding.top
    case "pr":
      return metrics.padding.right
    case "pb":
      return metrics.padding.bottom
    case "pl":
      return metrics.padding.left
    case "mt":
      return metrics.margin.top
    case "mr":
      return metrics.margin.right
    case "mb":
      return metrics.margin.bottom
    case "ml":
      return metrics.margin.left
    // The shorthands set both edges of their axis to the same value, so either
    // edge is the current reading; the leading one is used. If the two edges
    // differ (because the per-side axes were nudged individually) this reports
    // the leading edge rather than inventing a combined value.
    case "py":
      return metrics.padding.top
    case "px":
      return metrics.padding.left
    case "my":
      return metrics.margin.top
    case "mx":
      return metrics.margin.left
    case "gap":
      return metrics.gap
  }
}

/** What the selected target supports, computed by the parent from the field
 *  path + class list (see `capabilities.ts`). */
export interface ToolbarCapabilities {
  /** className spacing edits available (false for list items / dynamic cn()). */
  spacing: boolean
  gap?: boolean
  /** typography token edits available (a `text-<role>` was identified). */
  typography: boolean
  /** the role for typography edits, e.g. `"display"`; `null` when unknown. */
  role: string | null
  /** human-readable reason spacing is unavailable, shown as a hint when
   *  `spacing` is false. */
  spacingDisabledReason?: string
  /** human-readable write scope shown when `spacing` is true but the edit lands
   *  somewhere other than the selected element itself — e.g. a list item, whose
   *  spacing is written as an `nth-child` variant on the list's parent (Item 7).
   *  `null`/absent for a plain element that edits its own className. */
  spacingScope?: string | null
}

/** Result of the last apply attempt, surfaced inline so the designer sees the
 *  clean change (or the gate error) without leaving the canvas. */
export interface ToolbarStatus {
  kind: "applied" | "error"
  message: string
}

export interface SliceTweakToolbarProps {
  /** Short label for the selected target (e.g. "Whole slice", "Title"). */
  label: string
  metrics: ToolbarMetrics
  capabilities: ToolbarCapabilities
  /** A typography (gated) apply is in flight — disable controls and show
   *  progress. Spacing nudges are optimistic + debounced and never set this. */
  busy: boolean
  /** Optimistic per-axis display overrides (e.g. `{ pt: "8px" }`) reflecting
   *  nudges not yet reconciled from a fresh measurement — shown in place of the
   *  measured `metrics` side so the value tracks the live inline preview. */
  values?: Partial<Record<ToolbarSpacingAxis, string>>
  /** Step a spacing axis on the selected element (per-slice-type className). */
  onSpacingStep: (axis: ToolbarSpacingAxis, direction: "up" | "down") => void
  /** Step a typography property on the role token (site-wide, every element of
   *  that role). */
  onTypographyStep: (
    property: ToolbarTypographyProperty,
    direction: "up" | "down"
  ) => void
  /** Dismiss the toolbar (also clears the selection). */
  onClose: () => void
}
