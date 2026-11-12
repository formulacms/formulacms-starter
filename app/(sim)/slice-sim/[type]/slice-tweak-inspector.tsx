"use client"

/**
 * The two small consumers of the editor-scoped tweak store (ADR-0030 +
 * 2026-07-06 perf addendum) — the only components that re-render on a nudge:
 *
 * - `SliceTweakInspector` binds the selected target to the store via
 *   `useSliceTweak` and renders the presentational box-model toolbar. A stepper
 *   fires an instant inline preview + records the edit in the batch; it never
 *   writes source.
 * - `VisualTweakSaveBar` shows the unsaved count + Save / Discard. Save flushes
 *   the whole batch in one server write (one recompile); Discard reloads the
 *   preview to wipe the dev-only inline styles.
 *
 * Both read the store through context, so the workbench, source panes and AI
 * form (stable children of the provider) never re-render while you nudge.
 */

import { useState } from "react"
import { Globe2, Monitor, RotateCcw, Smartphone } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SliceTweakToolbar } from "./slice-tweak-toolbar"
import { useSliceTweak } from "./use-slice-tweak"
import { useVisualTweak } from "./visual-tweak-store"
import {
  UNLINKED,
  type LinkedTones,
  type ToolbarSpacingAxis,
} from "./slice-tweak-toolbar-types"
import type { TargetInfo } from "./slice-preview"
import type { TweakScope } from "@/lib/slices/visual-tweak/class-operations"
import { SimInspectorSection } from "./sim-inspector-section"
import { SimTextFormatting, SimTypographyBadge } from "./sim-text-formatting"
import { SimTypographyControls } from "./sim-typography-controls"

export function SliceTweakInspector({
  target,
  onPreview,
  onClose,
  compact = false,
}: {
  target: TargetInfo
  onPreview: (
    axis: ToolbarSpacingAxis,
    valueRem: number,
    loc: string,
    scope: TweakScope
  ) => void
  onClose: () => void
  compact?: boolean
}) {
  // Per-tone link toggles: padding link (four padding sides move together) and
  // margin link (same for margin) are independent — the previous "one link
  // ties all 8" behaviour was rejected as absurd since padding and margin are
  // separate design decisions. Local state so switching elements doesn't lock
  // the mode across the session.
  const [linked, setLinked] = useState<LinkedTones>(UNLINKED)
  const store = useVisualTweak()
  const tweak = useSliceTweak({ target, onPreview, linked })
  if (!target.metrics) return null
  const ScopeIcon =
    store.scope === "all"
      ? Globe2
      : store.scope === "below-sm"
        ? Smartphone
        : Monitor
  const scopeLabels = {
    all: "Default",
    "sm-and-up": "≥ 640 px",
    "below-sm": "< 640 px",
  }
  return (
    <div className="flex flex-col gap-3">
      <SimInspectorSection name="presentation" label="Presentation">
        <Select
          value={store.scope}
          onValueChange={(value) => store.setScope(value as TweakScope)}
        >
          <SelectTrigger
            aria-label="Change scope"
            className="w-full justify-start [&_[data-slot=select-value]]:mr-auto"
            size="sm"
          >
            <ScopeIcon />
            <SelectValue>{scopeLabels[store.scope]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {Object.entries(scopeLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </SimInspectorSection>
      <SimInspectorSection
        name="spacing"
        label="Spacing"
        className="border-t pt-2"
        headerExtras={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reset pending spacing"
            title="Reset pending spacing for this size"
            disabled={store.saving || !store.edits?.[target.loc]}
            onClick={() => store.resetTarget(target.loc)}
          >
            <RotateCcw />
          </Button>
        }
      >
        <SliceTweakToolbar
          label={target.label}
          metrics={target.metrics}
          capabilities={tweak.capabilities}
          scope={store.scope}
          sourceClassTokens={target.sourceClassTokens}
          busy={tweak.busy}
          values={tweak.values}
          compact={compact}
          linked={linked}
          onLinkedChange={setLinked}
          onSpacingStep={tweak.onSpacingStep}
          onSpacingSet={tweak.onSpacingSet}
          onTypographyStep={tweak.onTypographyStep}
          onClose={onClose}
        />
      </SimInspectorSection>
      {(target.role || store.activeText) && (
        <SimInspectorSection
          name="typography"
          label="Typography"
          className="border-t pt-2"
          headerExtras={<SimTypographyBadge />}
        >
          <div className="flex flex-col gap-3">
            <SimTypographyControls
              target={target}
              busy={tweak.busy}
              onStep={tweak.onTypographyStep}
            />
            <SimTextFormatting />
          </div>
        </SimInspectorSection>
      )}
    </div>
  )
}

export { VisualTweakSaveBar } from "./visual-tweak-save-bar"
