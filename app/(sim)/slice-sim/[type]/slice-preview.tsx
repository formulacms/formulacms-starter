"use client"

import {
  currentSimBridge,
  postToSimFrame,
  simMessageMatches,
  SIM_FRAME_CONNECTED,
  SIM_FRAME_SOURCE,
  type SimFrameBridge,
} from "./sim-frame-bridge"

import { SIM_ACCENT } from "./sim-accent"

import { useEffect, useEffectEvent, useRef, useState } from "react"
import { Monitor, Smartphone, Tablet } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  isSpacingEditablePath,
  parseListItemIndex,
} from "@/lib/slices/visual-tweak/capabilities"
import type { ClassAnchorVerdict } from "@/lib/slices/visual-tweak/class-anchor"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  INITIAL_SLICE_PREVIEW_HEIGHT,
  SLICE_PREVIEW_WIDTHS,
  type SlicePreviewFrame,
  type SlicePreviewView,
} from "./slice-preview-frame"
import type { ToolbarMetrics } from "./slice-tweak-toolbar-types"
export const SLICE_APPLIED_EVENT = "formulacms:slice-applied"
/** Fired on the parent window by the workbench inspector to reflect a spacing
 *  nudge instantly in the preview: `detail` is `{ axis, valueRem }`. This
 *  component forwards it into the iframe, where the target layer sets it as a
 *  dev-only inline style on the selected element (never persisted). */
export const SLICE_PREVIEW_STYLE_EVENT = "formulacms:slice-preview-style"
/** Fired on the parent window when a preview element is clicked to target it.
 *  `detail` is {@link TargetInfo}; the brief panel listens to insert a chip. */
export const SLICE_TARGET_EVENT = "formulacms:slice-target-selected"
/** Fired on the parent window by the brief panel's part index to drive the
 *  preview *from* the pills (reverse direction). `detail` is
 *  {@link HighlightRequest}; this component forwards it into the iframe so the
 *  target layer can resolve the field path back to a DOM element. */
export const SLICE_HIGHLIGHT_EVENT = "formulacms:slice-highlight-path"
/** Fired on the parent window when the current target is cleared (preview Esc /
 *  click-away, or the brief panel's chip ×). The panel drops its chip and the
 *  preview drops its highlight box, keeping the two in sync. */
export const SLICE_TARGET_CLEAR_REQUEST_EVENT =
  "formulacms:slice-target-clear-request"
export const SLICE_TARGET_CLEAR_EVENT = "formulacms:slice-target-clear"
/** Fired on the parent window when the in-iframe target layer has (re)mounted
 *  and targeting is live again — first load, Fast Refresh, or post-Save HMR
 *  reload. The store listens to re-apply the unsaved batch (Items 2+3) and the
 *  workbench listens to re-measure the current selection (finding 6b). */
export const SLICE_LAYER_READY_EVENT = "formulacms:slice-layer-ready"
/** Fired on the parent window by the store to ask the preview to re-post the
 *  whole unsaved batch into the iframe (so a reload restores the optimistic
 *  inline styles, not just the unsaved count). `detail` is
 *  `{ edits: { path, axis, valueRem }[] }`. */
export const SLICE_REAPPLY_EVENT = "formulacms:slice-reapply"
/** Fired on the parent window with the outcome of a batch reconcile: `detail` is
 *  `{ missing: number }` — how many pending edits couldn't be re-applied to the
 *  reloaded document. The store turns a non-zero count into a visible warning. */
export const SLICE_REAPPLY_RESULT_EVENT = "formulacms:slice-reapply-result"

export const SLICE_TARGET_REFRESH_EVENT = "formulacms:slice-target-refreshed"
export const SLICE_SAMPLES_APPLIED_EVENT = "formulacms:slice-samples-applied"

type HighlightRequest = {
  path: string | null
  mode?: "highlight" | "select" | "restore"
}

type TargetRect = { left: number; top: number; width: number; height: number }
/** The measured box the target layer reports — the same shape the inspector
 *  consumes, so there is one definition of "measured box" across the sim. */
export type TargetBoxMetrics = ToolbarMetrics
export type TargetInfo = {
  loc: string
  tag: string
  /** Actual resolved native heading, presentation only; tag remains source JSX identity. */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
  sourceHash: string
  sourceClassTokens: string[]
  editable: boolean
  templateWide: boolean
  isList?: boolean
  parentLoc?: string | null
  path: string
  label: string
  text: string
  rect: TargetRect
  metrics?: TargetBoxMetrics
  /** Runtime DOM classes observed on the selected element. Provenance can
   *  prove an anchor exists, but never infer stylesheet ownership when absent. */
  className?: string
  /** Whether the concrete DOM class list has a source-rewritable Tailwind
   *  anchor for safe spacing edits. Classified once inside the iframe. */
  classAnchor: ClassAnchorVerdict
  /** Design-system typography role the selected element carries (`display`,
   *  `title`, …), or null — drives whether the toolbar's token-edit controls
   *  are available. */
  role?: string | null
}

function readHeadingLevel(value: unknown): TargetInfo["headingLevel"] {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 6
    ? (value as TargetInfo["headingLevel"])
    : undefined
}

// True-viewport widths. The iframe's `width` attribute becomes the inner
// document's viewport width, so Tailwind's sm:/md:/lg: breakpoints actually
// evaluate at these widths - unlike a plain narrow <div>, which never triggers
// them. This is what makes the Mobile toggle show real reflow, not just shrink.
// Height is driven by the slice's intrinsic content via postMessage from the
// bare route (see sim-size-reporter.tsx); the initial value is just a
// placeholder until the first message arrives.
export function SlicePreview({
  type,
  selectedPath = null,
  view: controlledView,
  onViewChange,
  onFrameChange,
  onFrameBridge,
  showTabs = true,
  pageOpening,
  showOpeningControl = true,
  fit = false,
}: {
  type: string
  selectedPath?: string | null
  view?: SlicePreviewView
  onViewChange?: (view: SlicePreviewView) => void
  onFrameChange?: (frame: SlicePreviewFrame) => void
  onFrameBridge?: (bridge: SimFrameBridge | null) => void
  showTabs?: boolean
  pageOpening?: boolean
  showOpeningControl?: boolean
  /** Scale the whole frame down to fit the available width (contain), instead
   *  of the workbench's true 1:1 render + horizontal scroll. The `.relative`
   *  wrapper — iframe *and* its overlays — scales as one unit, so highlight
   *  boxes and click-to-target stay aligned. Never upscales past 1:1. Used by
   *  the admin slice card, where the 1280px desktop render would otherwise be
   *  clipped by the narrow card. */
  fit?: boolean
}) {
  const [internalView, setInternalView] = useState<SlicePreviewView>("desktop")
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [contentHeight, setContentHeight] = useState(
    INITIAL_SLICE_PREVIEW_HEIGHT
  )
  const [hovered, setHovered] = useState<TargetInfo | null>(null)
  const [measuredSelection, setMeasuredSelection] = useState<TargetInfo | null>(
    null
  )
  const fitRef = useRef<HTMLDivElement>(null)
  const [fitScale, setFitScale] = useState(1)
  const view = controlledView ?? internalView
  const [localOpening, setShowOpening] = useState(false)
  const showOpening = pageOpening ?? localOpening
  const reportBridge = useEffectEvent((bridge: SimFrameBridge | null) => {
    onFrameBridge?.(bridge)
  })
  const reportFrameChange = useEffectEvent((height: number) => {
    onFrameChange?.({ width: SLICE_PREVIEW_WIDTHS[view], height })
  })

  const selected =
    measuredSelection?.path === selectedPath ? measuredSelection : null
  const receiveSelection = useEffectEvent(
    (data: Record<string, unknown>, bridge: SimFrameBridge) => {
      const currentPath = bridge.readTargetPath
        ? bridge.readTargetPath()
        : selectedPath
      if (data.type === "target-missing") {
        if (
          data.path === currentPath &&
          Number.isSafeInteger(data.appliedRevision) &&
          (data.appliedRevision as number) >= bridge.lastReplaceRevision
        ) {
          window.dispatchEvent(new Event(SLICE_TARGET_CLEAR_REQUEST_EVENT))
        }
        return
      }
      if (data.type === "target-hidden") {
        if (data.path === currentPath) setMeasuredSelection(null)
        return
      }
      if (data.type === "samples-applied") {
        window.dispatchEvent(new Event(SLICE_SAMPLES_APPLIED_EVENT))
        return
      }
      if (data.type === "target-refresh" && data.path !== currentPath) return
      const info = {
        ...data,
        headingLevel: readHeadingLevel(data.headingLevel),
      } as unknown as TargetInfo
      setMeasuredSelection(info)
      window.dispatchEvent(
        new CustomEvent(
          data.type === "target-select"
            ? SLICE_TARGET_EVENT
            : SLICE_TARGET_REFRESH_EVENT,
          { detail: info }
        )
      )
    }
  )
  const receiveSize = useEffectEvent(
    (data: { width?: number; height?: number }) => {
      if (
        data.width !== SLICE_PREVIEW_WIDTHS[view] ||
        !Number.isFinite(data.height)
      )
        return
      const next = Math.max(120, Math.ceil(data.height!))
      setContentHeight((previous) => (previous === next ? previous : next))
      reportFrameChange(next)
    }
  )

  useEffect(() => {
    let currentGeneration = ""
    let lastRevision = 0
    function hello() {
      iframeRef.current?.contentWindow?.postMessage(
        { source: SIM_FRAME_SOURCE, type: "hello" },
        window.location.origin
      )
    }
    function onMessage(event: MessageEvent) {
      // The iframe embeds the sim route same-origin by design — refuse
      // anything else before even looking at `data`.
      const frameWindow = iframeRef.current?.contentWindow ?? null
      const bridge = currentSimBridge(frameWindow)
      if (
        !simMessageMatches(event, window.location.origin, frameWindow, bridge)
      )
        return
      if (currentGeneration !== bridge!.generation) {
        currentGeneration = bridge!.generation
        lastRevision = 0
      }
      if (event.data.revision <= lastRevision) return
      lastRevision = event.data.revision
      const data = event.data
      if (
        !data ||
        typeof data !== "object" ||
        data.source !== "formulacms-sim"
      ) {
        return
      }
      if (data.type === "size" && typeof data.height === "number") {
        receiveSize(data)
        return
      }
      if (data.type === "target-hover") {
        setHovered({
          path: data.path,
          label: data.label,
          text: data.text,
          rect: data.rect,
          metrics: data.metrics,
          className: data.className,
          classAnchor: data.classAnchor,
          role: data.role,
          loc: data.loc,
          tag: data.tag,
          headingLevel: readHeadingLevel(data.headingLevel),
          sourceHash: data.sourceHash,
          sourceClassTokens: data.sourceClassTokens,
          editable: data.editable,
          templateWide: data.templateWide,
          isList: data.isList === true,
          parentLoc: data.parentLoc,
        })
        return
      }
      if (data.type === "target-out") {
        setHovered(null)
        return
      }
      if (data.type === "target-clear") {
        setHovered(null)
        setMeasuredSelection(null)
        window.dispatchEvent(new Event(SLICE_TARGET_CLEAR_REQUEST_EVENT))
        return
      }
      if (
        [
          "target-select",
          "target-refresh",
          "target-missing",
          "target-hidden",
          "samples-applied",
        ].includes(data.type)
      ) {
        receiveSelection(data, bridge!)
        return
      }
      // Targeting came (back) online in the iframe — let the store re-apply the
      // batch and the workbench re-measure the selection. Ack back into the
      // iframe so it stops re-announcing (the retry exists to survive a parent
      // that attached its listener after the iframe's first announcement).
      if (data.type === "layer-ready") {
        reportBridge(bridge)
        window.dispatchEvent(
          new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
        )
        postToSimFrame(frameWindow, { type: "layer-ack" })
        receiveSize(data)
        window.dispatchEvent(new Event(SLICE_LAYER_READY_EVENT))
        return
      }
      // Result of a batch reconcile — forward the unresolved count so the store
      // can warn rather than let the count/render diverge silently.
      if (data.type === "reapply-result") {
        window.dispatchEvent(
          new CustomEvent(SLICE_REAPPLY_RESULT_EVENT, {
            detail: { missing: Number(data.missing) || 0 },
          })
        )
        return
      }
    }
    window.addEventListener("message", onMessage)
    window.addEventListener(`${SIM_FRAME_CONNECTED}:hello`, hello)
    hello()
    return () => {
      reportBridge(null)
      window.removeEventListener("message", onMessage)
      window.removeEventListener(`${SIM_FRAME_CONNECTED}:hello`, hello)
    }
  }, [])

  // Forward a batch-reconcile request into the iframe. The store fires this on
  // `layer-ready` with the pending edits; the target layer resolves each field
  // path to an element and re-sets the optimistic inline style.
  useEffect(() => {
    function onReapply(event: Event) {
      const detail = (event as CustomEvent).detail as
        { edits: unknown } | undefined
      const win = iframeRef.current?.contentWindow
      if (!win || !detail) return
      postToSimFrame(win, {
        source: "formulacms-sim",
        type: "reapply-styles",
        edits: detail.edits,
      })
    }
    window.addEventListener(SLICE_REAPPLY_EVENT, onReapply)
    return () => window.removeEventListener(SLICE_REAPPLY_EVENT, onReapply)
  }, [])

  useEffect(() => {
    function onApplied() {
      const win = iframeRef.current?.contentWindow
      if (win && currentSimBridge(win)?.flush() !== false) win.location.reload()
    }
    window.addEventListener(SLICE_APPLIED_EVENT, onApplied)
    return () => window.removeEventListener(SLICE_APPLIED_EVENT, onApplied)
  }, [])

  // Forward an optimistic spacing preview into the iframe so the target layer can
  // reflect it as an inline style on the selected element (no write, no reload).
  useEffect(() => {
    function onPreviewStyle(event: Event) {
      const detail = (event as CustomEvent).detail as
        | {
            axis: string
            valueRem: number
            loc: string
            scope: string
            sourceHash: string
          }
        | undefined
      const win = iframeRef.current?.contentWindow
      if (!win || !detail) return
      postToSimFrame(win, {
        source: "formulacms-sim",
        type: "preview-style",
        axis: detail.axis,
        valueRem: detail.valueRem,
        loc: detail.loc,
        scope: detail.scope,
        sourceHash: detail.sourceHash,
      })
    }
    window.addEventListener(SLICE_PREVIEW_STYLE_EVENT, onPreviewStyle)
    return () =>
      window.removeEventListener(SLICE_PREVIEW_STYLE_EVENT, onPreviewStyle)
  }, [])

  // Reverse channel: the brief panel's part index posts a field path; forward it
  // into the iframe so the target layer can light up the matching element. The
  // layer replies on the same `target-hover` / `target-select` channel above.
  useEffect(() => {
    function onHighlight(event: Event) {
      const detail = (event as CustomEvent).detail as
        HighlightRequest | undefined
      const win = iframeRef.current?.contentWindow
      if (!win) return
      reportBridge(currentSimBridge(win))
      postToSimFrame(win, {
        source: "formulacms-sim",
        type:
          detail?.mode === "select"
            ? "select-path"
            : detail?.mode === "restore"
              ? "restore-path"
              : "highlight-path",
        path: detail?.path ?? null,
      })
    }
    window.addEventListener(SLICE_HIGHLIGHT_EVENT, onHighlight)
    return () => window.removeEventListener(SLICE_HIGHLIGHT_EVENT, onHighlight)
  }, [])

  // Panel-initiated clear (chip ×): drop the highlight box to stay in sync.
  useEffect(() => {
    function onClear() {
      setHovered(null)
      setMeasuredSelection(null)
    }
    window.addEventListener(SLICE_TARGET_CLEAR_EVENT, onClear)
    return () => window.removeEventListener(SLICE_TARGET_CLEAR_EVENT, onClear)
  }, [])

  const width = SLICE_PREVIEW_WIDTHS[view]

  // Fit-to-width: measure the available container and scale the frame so the
  // full render is visible instead of clipped. Never upscales past 1:1. Kept as
  // its own gated effect rather than `useElementWidth`: the workbench (`fit`
  // off) is the common case and must not pay for an observer it never reads.
  useEffect(() => {
    if (!fit) return
    const el = fitRef.current
    if (!el) return
    const update = () => {
      const avail = el.clientWidth
      setFitScale(avail > 0 ? Math.min(1, avail / width) : 1)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [fit, width])

  function selectView(nextView: SlicePreviewView) {
    onViewChange?.(nextView)
    if (!controlledView) setInternalView(nextView)
    setHovered(null)
  }

  // Default (workbench) — owner: "rendered slice must be 100% size, 1:1". No
  // `transform: scale`: the iframe renders at its true viewport width (1280
  // desktop / 390 mobile) and the pane scrolls horizontally when the render
  // exceeds it, rather than shrinking. The `fit` prop opts out of this (admin
  // card) by scaling the whole frame to fit — see the fit effect above.
  //
  const previewFrame = (
    <div
      ref={fitRef}
      className={cn("min-w-0", fit ? "overflow-hidden" : "overflow-x-auto")}
      // In fit mode the inner frame is transform-scaled (which doesn't shrink
      // its layout box), so reserve the *scaled* height here — otherwise the
      // unscaled 1280-tall box leaves a large empty gap below the render.
      style={fit ? { height: contentHeight * fitScale } : undefined}
    >
      <div
        className="relative"
        style={{
          width,
          height: contentHeight,
          ...(fit
            ? { transform: `scale(${fitScale})`, transformOrigin: "top left" }
            : null),
        }}
      >
        <iframe
          onLoad={() =>
            iframeRef.current?.contentWindow?.postMessage(
              { source: SIM_FRAME_SOURCE, type: "hello" },
              window.location.origin
            )
          }
          ref={iframeRef}
          key={type}
          src={`/slice-sim/${type}?bare=1${showOpening ? "&opening=1" : ""}`}
          title={`${type} preview`}
          width={width}
          height={contentHeight}
          scrolling="no"
          // `allow-scripts` alone gives the frame an opaque origin, and
          // Next.js 16's dev-mode RSC/hydration runtime fails to commit a
          // render there, blanking the preview. The previewed slice is
          // trusted first-party dev-only code, so granting `allow-same-origin`
          // is safe and restores the styled render. (slice-sim is never served
          // in production - see page.tsx `notFound()`.)
          sandbox="allow-scripts allow-same-origin"
          className="block border-0 bg-background"
          style={{ width, height: contentHeight }}
        />
        {selected && selected.rect.width > 0 && selected.rect.height > 0 && (
          <TargetBox target={selected} scale={1} variant="selected" />
        )}
        {hovered && hovered.path !== selected?.path && (
          <>
            <TargetBox target={hovered} scale={1} variant="hover" />
            <HoverBadge target={hovered} scale={1} />
          </>
        )}
      </div>
    </div>
  )

  // The inspector is mounted in SliceWorkbench's viewport-pinned rail. This
  // component owns only the render, click targeting, and highlight overlays.
  const framedPreview = (
    <div className="min-w-0">
      {showOpeningControl && (
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showOpening}
            onChange={(event) => {
              if (
                currentSimBridge(
                  iframeRef.current?.contentWindow ?? null
                )?.flush() !== false
              )
                setShowOpening(event.target.checked)
            }}
          />
          Show as page opening
        </label>
      )}
      {previewFrame}
    </div>
  )

  if (!showTabs) {
    return framedPreview
  }

  return (
    <Tabs
      value={view}
      onValueChange={(v) => selectView(v as SlicePreviewView)}
      className="min-w-0 gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList>
          <TabsTrigger value="desktop">
            <Monitor className="size-4" />
            Desktop
          </TabsTrigger>
          <TabsTrigger value="tablet">
            <Tablet className="size-4" />
            Tablet
          </TabsTrigger>
          <TabsTrigger value="mobile">
            <Smartphone className="size-4" />
            Mobile
          </TabsTrigger>
        </TabsList>
      </div>

      {framedPreview}
    </Tabs>
  )
}

/**
 * Highlight box + content tooltip drawn over the scaled preview. The reported
 * rect is in the iframe's own coordinate space, so it scales by the same factor
 * the iframe does and positions against the (relative) frame wrapper.
 */
function TargetBox({
  target,
  scale,
  variant,
}: {
  target: TargetInfo
  scale: number
  variant: "hover" | "selected"
}) {
  const { rect } = target
  // The selected heading tag uses existing target metadata and coordinates;
  // no iframe adapter or targeting protocol is needed.
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-10 ring-1",
        variant === "selected" ? SIM_ACCENT.selectionRing : SIM_ACCENT.hoverRing
      )}
      style={{
        left: rect.left * scale,
        top: rect.top * scale,
        width: rect.width * scale,
        height: rect.height * scale,
      }}
    >
      {variant === "selected" && (
        <span
          aria-label={`Selected ${target.label || target.tag}${target.headingLevel ? ` · H${target.headingLevel}` : ""}`}
          className={cn(
            "absolute top-0 left-0 -translate-y-full rounded-t px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
            SIM_ACCENT.tag
          )}
        >
          {target.label || target.tag}
          {target.headingLevel ? ` · H${target.headingLevel}` : ""}
        </span>
      )}
    </div>
  )
}

/**
 * Figma-style semantic tag (Plan 025 Phase 0b) pinned to the top-left of the
 * hovered element, so *before* the click the designer sees (a) what they're about
 * to select and (b) whether it takes a direct spacing edit or routes to the AI
 * escape hatch. It is honest to the CURRENT targeting model: `isSpacingEditablePath`
 * is the same predicate the toolbar uses to enable the spacing controls, and
 * `items[i]` paths carry the card number the model already knows. Card-N-of-M and
 * CMS→content-editor routing are deliberately absent — those arrive with the
 * Phase 1 loc-stamping rebuild, not on this model.
 */
function HoverBadge({ target, scale }: { target: TargetInfo; scale: number }) {
  const { rect, label, path } = target
  const editable = isSpacingEditablePath(path)
  const card = parseListItemIndex(path)
  const scopeNote = card === null ? null : `card ${card + 1}`
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-20 flex max-w-full items-center gap-1.5",
        "rounded-tl-md rounded-br-md px-1.5 py-0.5 text-[11px] leading-none font-medium shadow-sm",
        editable
          ? "bg-primary text-primary-foreground"
          : "bg-amber-500 text-white"
      )}
      style={{
        left: rect.left * scale,
        top: rect.top * scale,
        maxWidth: rect.width * scale,
      }}
    >
      <span className="truncate">{label || "Element"}</span>
      {scopeNote ? <span className="opacity-80">· {scopeNote}</span> : null}
      <span className="opacity-90">· {editable ? "spacing" : "AI tweak"}</span>
    </div>
  )
}
