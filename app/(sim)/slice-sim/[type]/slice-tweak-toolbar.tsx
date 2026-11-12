"use client"

import { SIM_ACCENT } from "./sim-accent"

/** Token spacing controls for the approved simulator inspector. */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import {
  ArrowLeftRight,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Link2,
  Unlink,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { canAxisGoNegative } from "@/lib/slices/visual-tweak/capabilities"
import { cn } from "@/lib/utils"
import type { TweakScope } from "@/lib/slices/visual-tweak/class-operations"
import { findExpectedSpacingUtility } from "@/lib/slices/visual-tweak/spacing-operation"

import {
  metricForAxis,
  type LinkedTones,
  type SliceTweakToolbarProps,
  type ToolbarSpacingAxis,
  type SpacingLink,
} from "./slice-tweak-toolbar-types"

/** Stable empty-values default so an absent `values` prop doesn't create a fresh
 *  object each render (react-doctor: `rerender-memo-with-default-value`). */
const EMPTY_VALUES: Partial<Record<ToolbarSpacingAxis, string>> = {}

/** Compact `px` display, dropping the `px` unit and trailing zeros so an input
 *  reads "64" not "64px". `normal`/empty gap renders as "0". */
function shortLength(value: string): string {
  const n = Number.parseFloat(value)
  if (!Number.isFinite(n)) return "0"
  return String(Math.round(n * 10) / 10)
}

type SideMarker = "top" | "right" | "bottom" | "left" | "gap"

/** Small SVG that shows which edge of a box a control affects — a dashed square
 *  with one solid edge for T/R/B/L, and two parallel bars for the gap control.
 *  Mirrors Figma's spacing inspector, but rendered inline so we don't ship a
 *  bespoke icon font. */
function SideIcon({ side }: { side: SideMarker }) {
  const ghost = {
    stroke: "currentColor",
    strokeOpacity: 0.35,
    strokeWidth: 1,
    strokeDasharray: "1.5 1.5",
    fill: "none" as const,
  }
  const solid = {
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    fill: "none" as const,
  }

  if (side === "gap") {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden
        className="text-muted-foreground"
      >
        <line x1="3" y1="2" x2="3" y2="10" {...solid} />
        <line x1="9" y1="2" x2="9" y2="10" {...solid} />
      </svg>
    )
  }

  const edges: Record<Exclude<SideMarker, "gap">, string> = {
    top: "M1.5 2 L10.5 2",
    right: "M10 1.5 L10 10.5",
    bottom: "M1.5 10 L10.5 10",
    left: "M2 1.5 L2 10.5",
  }

  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden
      className="text-muted-foreground"
    >
      <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" {...ghost} />
      <path d={edges[side]} {...solid} />
    </svg>
  )
}

interface SideInputProps {
  axis: ToolbarSpacingAxis
  label: string
  side: SideMarker
  value: string
  disabled: boolean
  onStep: (axis: ToolbarSpacingAxis, direction: "up" | "down") => void
  onSet: (axis: ToolbarSpacingAxis, remValue: number) => void
  marker?: "set" | "inherited"
}

/** One editable value cell: side-marker icon + numeric input. Enter/blur commits
 *  the typed value (snapped on-token in the hook), ArrowUp/ArrowDown walks the
 *  token scale without losing focus, Escape reverts. The input keeps its own
 *  `draft` so partial typing survives external re-renders — but when the value
 *  changes and the input is NOT being typed into (unfocused, or the change came
 *  from an arrow-key step), the draft resyncs from the new value. */
function SideInput({
  axis,
  label,
  side,
  value,
  disabled,
  onStep,
  onSet,
  marker,
}: SideInputProps) {
  const [draft, setDraft] = useState(value)
  const typingRef = useRef(false)
  const cancelBlurRef = useRef(false)

  // Resync draft from the prop when the designer isn't mid-typing. Arrow-key
  // steps and external edits (linked mode, save/discard, selection change) all
  // land through this path so the input reflects the source of truth.
  useEffect(() => {
    if (!typingRef.current) setDraft(value)
  }, [value])

  // Margins accept a negative typed value (`-mt-4`); padding/gap clamp at 0, so
  // a negative there is rejected locally (draft reverts). The hook re-checks the
  // same axis policy, but reverting here keeps a bad padding entry from lingering
  // in the field.
  const allowNegative = canAxisGoNegative(axis)

  function commit(el: HTMLInputElement) {
    typingRef.current = false
    const n = Number.parseFloat(el.value)
    if (Number.isFinite(n) && (n >= 0 || allowNegative)) {
      onSet(axis, n / 16)
    } else {
      setDraft(value)
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowUp":
        event.preventDefault()
        typingRef.current = false
        onStep(axis, "up")
        return
      case "ArrowDown":
        event.preventDefault()
        typingRef.current = false
        onStep(axis, "down")
        return
      case "Enter":
        event.preventDefault()
        commit(event.currentTarget)
        event.currentTarget.blur()
        return
      case "Escape":
        cancelBlurRef.current = true
        typingRef.current = false
        setDraft(value)
        event.currentTarget.blur()
        return
    }
  }

  return (
    <div
      className={cn(
        "group relative flex h-7 w-full min-w-0 items-center gap-1 rounded-md border border-transparent bg-muted px-1.5 transition-colors",
        "focus-within:border-ring focus-within:ring-1 focus-within:ring-ring",
        disabled && "opacity-60"
      )}
    >
      <SideIcon side={side} />
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(event) => {
          typingRef.current = true
          setDraft(event.target.value)
        }}
        onBlur={(event) => {
          if (cancelBlurRef.current) {
            cancelBlurRef.current = false
            return
          }
          commit(event.currentTarget)
        }}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-label={label}
        className="w-full min-w-0 bg-transparent text-[11px] text-foreground tabular-nums outline-none disabled:cursor-not-allowed"
      />
      <span aria-hidden className="text-[10px] text-muted-foreground">
        px
      </span>
      <span className="flex shrink-0 flex-col opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-3 w-4 rounded-none"
          disabled={disabled}
          aria-label={`Increase ${label}`}
          title={`Increase ${label}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            typingRef.current = false
            onStep(axis, "up")
          }}
        >
          <ChevronUp />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-3 w-4 rounded-none"
          disabled={disabled}
          aria-label={`Decrease ${label}`}
          title={`Decrease ${label}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            typingRef.current = false
            onStep(axis, "down")
          }}
        >
          <ChevronDown />
        </Button>
      </span>
      {!disabled && marker && (
        <span
          role="img"
          aria-label={
            marker === "set" ? "Set for this size" : "Inherited from Default"
          }
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            marker === "set" ? SIM_ACCENT.dot : "border border-muted-foreground"
          )}
        />
      )}
    </div>
  )
}

export interface SliceTweakToolbarPropsExt extends SliceTweakToolbarProps {
  compact?: boolean
  scope?: TweakScope
  sourceClassTokens?: string[]
  linked: LinkedTones
  onLinkedChange: (next: LinkedTones) => void
  onSpacingSet: (axis: ToolbarSpacingAxis, remValue: number) => void
}

const LINKS = [
  { value: "all", label: "All sides linked", icon: Link2 },
  { value: "x", label: "Left and right linked", icon: ArrowLeftRight },
  { value: "y", label: "Top and bottom linked", icon: ArrowUpDown },
  { value: "none", label: "Unlinked", icon: Unlink },
] as const

export function SliceTweakToolbar({
  metrics,
  capabilities,
  busy,
  values = EMPTY_VALUES,
  linked,
  onLinkedChange,
  onSpacingStep,
  onSpacingSet,
  scope = "all",
  sourceClassTokens = [],
}: SliceTweakToolbarPropsExt) {
  function input(
    axis: ToolbarSpacingAxis,
    label: string,
    side: SideMarker,
    disabled = false
  ) {
    const marker =
      values[axis] !== undefined ||
      findExpectedSpacingUtility(sourceClassTokens, axis, scope)
        ? "set"
        : scope !== "all" &&
            findExpectedSpacingUtility(sourceClassTokens, axis, "all")
          ? "inherited"
          : undefined
    return (
      <SideInput
        marker={marker}
        key={axis}
        axis={axis}
        label={label}
        side={side}
        value={
          capabilities.spacing && !disabled
            ? (values[axis] ?? shortLength(metricForAxis(axis, metrics)))
            : ""
        }
        disabled={busy || !capabilities.spacing || disabled}
        onStep={onSpacingStep}
        onSet={onSpacingSet}
      />
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex flex-col gap-2"
        title={
          capabilities.gap ? "Gap between list items" : "Gap — select a list"
        }
      >
        <span className="text-xs text-muted-foreground">Gap</span>
        {input("gap", "Gap", "gap", !capabilities.gap)}
      </div>
      {(["padding", "margin"] as const).map((tone) => {
        const prefix = tone === "padding" ? "p" : "m"
        const mode = linked[tone]
        const sides = ["top", "right", "bottom", "left"] as const
        const suffix = { top: "t", right: "r", bottom: "b", left: "l" } as const
        return (
          <div key={tone} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {tone === "padding" ? "Padding" : "Margin"}
              </span>
              <ToggleGroup
                type="single"
                size="sm"
                value={mode}
                aria-label={`${tone} linking`}
                onValueChange={(next) => {
                  if (next)
                    onLinkedChange({ ...linked, [tone]: next as SpacingLink })
                }}
              >
                {LINKS.map(({ value, label, icon: Icon }) => (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    aria-label={`${label} — ${tone}`}
                    title={label}
                    disabled={busy || !capabilities.spacing}
                  >
                    <Icon />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <div className="relative grid grid-cols-2 gap-x-3 gap-y-5">
              {mode !== "none" && (
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute top-3 bottom-3 border-primary/40",
                    mode === "all"
                      ? "right-1/4 left-1/4 rounded border"
                      : mode === "x"
                        ? "left-3/4 border-l"
                        : "left-1/4 border-l"
                  )}
                />
              )}
              {sides.map((side) =>
                input(
                  `${prefix}${suffix[side]}` as ToolbarSpacingAxis,
                  `${tone} ${side}`,
                  side
                )
              )}
            </div>
          </div>
        )
      })}
      {!capabilities.spacing && (
        <p className="text-xs text-muted-foreground">
          {capabilities.spacingDisabledReason}
        </p>
      )}
    </div>
  )
}
