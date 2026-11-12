"use client"

/* eslint-disable @next/next/no-img-element -- snapshot URLs are local comparison artifacts, not site content */

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import Link from "next/link"
import {
  Image as ImageIcon,
  ChevronDown,
  GitCompare,
  Heading1,
  PanelLeftClose,
  PanelLeftOpen,
  Layers,
  Monitor,
  MousePointer2,
  SquareSquare,
  Smartphone,
  Tablet,
} from "lucide-react"
import {
  SLICE_HIGHLIGHT_EVENT,
  SLICE_LAYER_READY_EVENT,
  SLICE_PREVIEW_STYLE_EVENT,
  SLICE_TARGET_CLEAR_EVENT,
  SLICE_TARGET_CLEAR_REQUEST_EVENT,
  SLICE_TARGET_EVENT,
  SLICE_TARGET_REFRESH_EVENT,
  SLICE_SAMPLES_APPLIED_EVENT,
  type TargetInfo,
} from "./slice-preview"
import { SliceCanvas } from "./slice-canvas"
import { BuilderSidebar } from "./builder-sidebar"
import type { CanvasScale, ScaleMode as CanvasScaleMode } from "./canvas-scale"
import { VisualTweakSaveBar } from "./slice-tweak-inspector"
import type { SimFrameBridge } from "./sim-frame-bridge"
import { useVisualTweak, VisualTweakProvider } from "./visual-tweak-store"
import { SimModeControl, SimSampleControls } from "./sim-sample-controls"
import type { ToolbarSpacingAxis } from "./slice-tweak-toolbar-types"
import type { TweakScope } from "@/lib/slices/visual-tweak/class-operations"
import {
  INITIAL_SLICE_PREVIEW_HEIGHT,
  SLICE_PREVIEW_WIDTHS,
  type SlicePreviewFrame,
  type SlicePreviewView,
} from "./slice-preview-frame"
import {
  SNAPSHOT_STALE_EVENT,
  SNAPSHOT_UPDATED_EVENT,
  type SnapshotUpdatedDetail,
} from "@/components/admin/slices/slice-sim-events"
import type { ThumbnailVariant } from "@/lib/slices/thumbnails"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import type { TypographyTokenValues } from "@/lib/slices/visual-tweak/typography"
import { SIM_ACCENT } from "./sim-accent"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { SliceOutline } from "./slice-outline"
import type { TargetEntry } from "@/lib/slices/flatten-content"
import {
  markSnapshotsFresh,
  markSnapshotsStale,
  type SnapshotPair,
  type SnapshotState,
} from "./snapshot-state"

const PHONE_VIEWPORT_QUERY = "(max-width: 760px)"
function phoneViewportSnapshot() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(PHONE_VIEWPORT_QUERY).matches
  )
}
function subscribePhoneViewport(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {}
  const query = window.matchMedia(PHONE_VIEWPORT_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}
function serverPhoneViewportSnapshot() {
  return false
}

type CompareMode = "source-current" | "before-after"
type SourceUrlPair = SnapshotPair

// Instant optimistic preview: post the nudged value into the iframe as a
// dev-only inline style on the selected element (no write, no reload). Pure and
// state-free, so it lives at module scope — a stable reference that never
// re-renders the memoized inspector it's passed to.
function postPreview(
  axis: ToolbarSpacingAxis,
  valueRem: number,
  loc: string,
  scope: TweakScope,
  sourceHash: string
) {
  window.dispatchEvent(
    new CustomEvent(SLICE_PREVIEW_STYLE_EVENT, {
      detail: { axis, valueRem, loc, scope, sourceHash },
    })
  )
}

export function SliceWorkbench({
  type,
  label,
  initialSourceUrls,
  typographyTokens,
  initialSnapshot,
  snapshotAction,
  outline,
}: {
  type: string
  label: string
  typographyTokens?: TypographyTokenValues
  initialSourceUrls: SourceUrlPair
  initialSnapshot: SnapshotState
  snapshotAction: ReactNode
  outline: TargetEntry[]
}) {
  const [view, setViewState] = useState<SlicePreviewView>("desktop")
  const [compareMode, setCompareModeState] =
    useState<CompareMode>("source-current")
  // The workbench owns selected field identity across frame revisions and devices.
  const [selected, setSelected] = useState<TargetInfo | null>(null)
  const selectedRef = useRef<TargetInfo | null>(null)
  const pendingLayerPath = useRef<string | null>(null)
  const selectedSourceHash = selected?.sourceHash
  function previewSelection(
    axis: ToolbarSpacingAxis,
    valueRem: number,
    loc: string,
    scope: TweakScope
  ) {
    if (selectedSourceHash)
      postPreview(axis, valueRem, loc, scope, selectedSourceHash)
  }

  // Selection is semantic state across all views/devices. Only an explicit
  // clear or a missing-target acknowledgement removes it.
  function dropSelection() {
    if (!selectedRef.current && !pendingLayerPath.current) return
    selectedRef.current = null
    pendingLayerPath.current = null
    setSelected(null)
    window.dispatchEvent(new Event(SLICE_TARGET_CLEAR_EVENT))
  }
  const clearRequested = useEffectEvent(() => dropSelection())

  useEffect(() => {
    function onSelect(event: Event) {
      const target = (event as CustomEvent).detail as TargetInfo
      selectedRef.current = target
      pendingLayerPath.current = null
      setSelected(target)
    }
    function onRefresh(event: Event) {
      const target = (event as CustomEvent).detail as TargetInfo
      if (
        target.path !== (pendingLayerPath.current ?? selectedRef.current?.path)
      )
        return
      selectedRef.current = target
      pendingLayerPath.current = null
      setSelected(target)
    }
    function onPathIntent(event: Event) {
      const detail = (event as CustomEvent).detail
      if (detail?.mode === "select" && typeof detail.path === "string")
        pendingLayerPath.current = detail.path
    }
    function onClear() {
      selectedRef.current = null
      pendingLayerPath.current = null
      setSelected(null)
    }
    function onClearRequest() {
      clearRequested()
    }
    window.addEventListener(SLICE_TARGET_CLEAR_REQUEST_EVENT, onClearRequest)
    window.addEventListener(SLICE_HIGHLIGHT_EVENT, onPathIntent)
    window.addEventListener(SLICE_TARGET_EVENT, onSelect)
    window.addEventListener(SLICE_TARGET_REFRESH_EVENT, onRefresh)
    window.addEventListener(SLICE_TARGET_CLEAR_EVENT, onClear)
    return () => {
      window.removeEventListener(
        SLICE_TARGET_CLEAR_REQUEST_EVENT,
        onClearRequest
      )
      window.removeEventListener(SLICE_HIGHLIGHT_EVENT, onPathIntent)
      window.removeEventListener(SLICE_TARGET_EVENT, onSelect)
      window.removeEventListener(SLICE_TARGET_REFRESH_EVENT, onRefresh)
      window.removeEventListener(SLICE_TARGET_CLEAR_EVENT, onClear)
    }
  }, [])

  const frameBridge = useRef<SimFrameBridge | null>(null)
  function setView(next: SlicePreviewView) {
    if (frameBridge.current?.flush() === false) return
    setViewState(next)
  }
  const [canvasMode, setCanvasMode] = useState<CanvasScaleMode>("auto")
  const [showSource, setShowSource] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false)
  const phoneViewport = useSyncExternalStore(
    subscribePhoneViewport,
    phoneViewportSnapshot,
    serverPhoneViewportSnapshot
  )
  const inspectorRef = useRef<HTMLDivElement>(null)
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null)
  const [showCode, setShowCode] = useState(false)
  const [pageOpening, setPageOpening] = useState(false)
  const [canvasScale, setCanvasScale] = useState<CanvasScale>({
    scale: 1,
    effective: "1:1",
    clipped: false,
  })
  const [sourceUrls, setSourceUrls] = useState<SourceUrlPair>(initialSourceUrls)
  const [snapshots, setSnapshots] = useState<SnapshotState>(initialSnapshot)
  const [frames, setFrames] = useState<
    Record<SlicePreviewView, SlicePreviewFrame>
  >({
    desktop: {
      width: SLICE_PREVIEW_WIDTHS.desktop,
      height: INITIAL_SLICE_PREVIEW_HEIGHT,
    },
    tablet: {
      width: SLICE_PREVIEW_WIDTHS.tablet,
      height: INITIAL_SLICE_PREVIEW_HEIGHT,
    },
    mobile: {
      width: SLICE_PREVIEW_WIDTHS.mobile,
      height: INITIAL_SLICE_PREVIEW_HEIGHT,
    },
  })
  function handleFrameChange(frame: SlicePreviewFrame) {
    setFrames((current) => ({
      ...current,
      [view]: frame,
    }))
  }
  function handleSourceChange(variant: ThumbnailVariant, url: string) {
    setSourceUrls((current) => ({ ...current, [variant]: url }))
  }

  useEffect(() => {
    function onUpdated(event: Event) {
      const detail = (event as CustomEvent<SnapshotUpdatedDetail | undefined>)
        .detail
      if (detail?.type !== type) return
      const version = detail.version ?? Date.now()
      setSnapshots((previous) =>
        markSnapshotsFresh({
          before: {
            desktop: detail?.before?.desktop
              ? snapshotUrl(type, "desktop", "before", version)
              : previous.before.desktop,
            mobile: detail?.before?.mobile
              ? snapshotUrl(type, "mobile", "before", version)
              : previous.before.mobile,
          },
          current: makeSnapshotPair(type, "current", version),
          stale: previous.stale,
        })
      )
    }
    function onStale() {
      setSnapshots(markSnapshotsStale)
    }
    window.addEventListener(SNAPSHOT_UPDATED_EVENT, onUpdated)
    window.addEventListener(SNAPSHOT_STALE_EVENT, onStale)
    return () => {
      window.removeEventListener(SNAPSHOT_UPDATED_EVENT, onUpdated)
      window.removeEventListener(SNAPSHOT_STALE_EVENT, onStale)
    }
  }, [type])

  const captureView = view === "tablet" ? null : view
  const sourceUrl = captureView ? sourceUrls[captureView] : null
  const beforeUrl = captureView ? snapshots.before[captureView] : null
  const currentUrl = captureView ? snapshots.current[captureView] : null
  const hasBeforeAfter = Boolean(beforeUrl && currentUrl)
  const activeCompareMode =
    compareMode === "before-after" && hasBeforeAfter
      ? "before-after"
      : "source-current"

  const snapshotView = activeCompareMode === "before-after"
  const phoneInspectorOpen =
    phoneViewport && mobileInspectorOpen && !snapshotView
  const effectiveShowSource = showSource && captureView !== null
  const fitPercent =
    !snapshotView && Number.isFinite(canvasScale.scale) && canvasScale.scale > 0
      ? Math.round(canvasScale.scale * 100)
      : null
  const zoomLabel =
    canvasMode === "auto" && fitPercent !== null
      ? `Fit · ${fitPercent}%`
      : canvasMode === "auto"
        ? "Fit"
        : canvasMode === "half"
          ? "50%"
          : canvasMode === "double"
            ? "200%"
            : "100%"
  const scaleLabels = {
    auto: "Fit",
    half: "50%",
    "one-to-one": "100%",
    double: "200%",
  }
  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat) return
    const target = event.target instanceof HTMLElement ? event.target : null
    if (
      event.key === "Escape" &&
      phoneInspectorOpen &&
      target &&
      (target === inspectorTriggerRef.current ||
        inspectorRef.current?.contains(target))
    ) {
      event.preventDefault()
      setMobileInspectorOpen(false)
      inspectorTriggerRef.current?.focus()
      return
    }
    if (
      target?.closest(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="menu"]'
      )
    )
      return
    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "c"
    ) {
      if (!snapshotView) {
        event.preventDefault()
        setShowCode(!showCode)
        setMobileInspectorOpen(true)
      }
      return
    }
    if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const next = ({ "1": "desktop", "2": "tablet", "3": "mobile" } as const)[
        event.key as "1" | "2" | "3"
      ]
      if (next) {
        event.preventDefault()
        setView(next)
      }
    }
  })
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      handleShortcut(event)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const restoreSelection = useEffectEvent(() => {
    if (snapshotView) return
    const path = pendingLayerPath.current ?? selectedRef.current?.path
    if (path === undefined) return
    window.dispatchEvent(
      new CustomEvent(SLICE_HIGHLIGHT_EVENT, {
        detail: { path, mode: "restore" },
      })
    )
  })
  useEffect(() => {
    function onLayerReady() {
      restoreSelection()
    }
    window.addEventListener(SLICE_LAYER_READY_EVENT, onLayerReady)
    window.addEventListener(SLICE_SAMPLES_APPLIED_EVENT, onLayerReady)
    return () => {
      window.removeEventListener(SLICE_LAYER_READY_EVENT, onLayerReady)
      window.removeEventListener(SLICE_SAMPLES_APPLIED_EVENT, onLayerReady)
    }
  }, [])
  function selectLayer(path: string) {
    pendingLayerPath.current = path
    if (snapshotView) {
      setShowSource(false)
      setCompareModeState("source-current")
      return
    }
    window.dispatchEvent(
      new CustomEvent(SLICE_HIGHLIGHT_EVENT, {
        detail: { path, mode: "select" },
      })
    )
  }

  return (
    <VisualTweakProvider
      type={type}
      view={view}
      typographyTokens={typographyTokens}
    >
      <section
        aria-label="Block workbench"
        className="grid h-dvh min-h-0 min-w-0 grid-cols-1 grid-rows-[132px_minmax(0,1fr)] [@media(width>760px)]:grid-cols-[46px_minmax(0,1fr)] [@media(width>760px)]:grid-rows-[48px_minmax(0,1fr)]"
      >
        <header
          role="toolbar"
          aria-label="Simulator toolbar"
          className="flex h-full min-h-0 min-w-0 flex-wrap content-center items-center gap-1.5 border-b bg-background px-3 py-1.5 [@media(width>760px)]:col-span-2 [@media(width>760px)]:h-12 [@media(width>760px)]:min-h-0 [@media(width>760px)]:flex-nowrap [@media(width>760px)]:gap-3 [@media(width>760px)]:px-3"
        >
          <SimModeControl />
          <div className="min-w-0 flex-1 [@media(max-width:760px)]:order-first [@media(max-width:760px)]:flex-none [@media(max-width:760px)]:basis-full">
            <h2 className="truncate text-xs font-semibold">{label}</h2>
            <Link
              href="/admin/slices"
              className="text-[10px] text-muted-foreground"
            >
              All blocks
            </Link>
          </div>
          <ToggleGroup
            type="single"
            value={view}
            aria-label="Preview size"
            className="[@media(max-width:760px)]:gap-1 [@media(max-width:760px)]:[&_button]:size-7 [@media(max-width:760px)]:[&_button]:min-w-7 [@media(max-width:760px)]:[&_button]:px-0"
            size="sm"
            onValueChange={(value) => {
              if (value) setView(value as SlicePreviewView)
            }}
          >
            <ToggleGroupItem
              value="desktop"
              aria-label="Desktop · 1280 px"
              title="Desktop · 1280 px (1)"
            >
              <Monitor />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="tablet"
              aria-label="Tablet · 768 px"
              title="Tablet · 768 px (2)"
            >
              <Tablet />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="mobile"
              aria-label="Mobile · 390 px"
              title="Mobile · 390 px (3)"
            >
              <Smartphone />
            </ToggleGroupItem>
          </ToggleGroup>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Zoom · ${zoomLabel}`}
                className="[@media(max-width:760px)]:h-7 [@media(max-width:760px)]:px-2"
              >
                {zoomLabel}
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" aria-label="Canvas scale">
              {Object.entries(scaleLabels).map(([value, text]) => (
                <DropdownMenuItem
                  key={value}
                  aria-label={text}
                  onSelect={() => setCanvasMode(value as CanvasScaleMode)}
                >
                  {text}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Show as page opening — first heading becomes the page title (H1)"
            title="Show as page opening — first heading becomes the page title (H1)"
            aria-pressed={pageOpening}
            className="border-0 shadow-none aria-pressed:bg-muted [@media(max-width:760px)]:size-7"
            onClick={() => {
              if (frameBridge.current?.flush() !== false)
                setPageOpening(!pageOpening)
            }}
          >
            <Heading1 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="[@media(max-width:760px)]:size-7 [@media(width>760px)]:hidden"
            aria-label={layersOpen ? "Hide side panel" : "Show side panel"}
            onClick={() => setLayersOpen(!layersOpen)}
          >
            <PanelLeftOpen />
          </Button>
          <VisualTweakSaveBar compact />
        </header>
        <nav
          aria-label="Panels"
          className="hidden min-h-0 flex-col items-center border-r bg-background py-3 [@media(width>760px)]:flex"
        >
          <button
            type="button"
            aria-label="Layers"
            aria-pressed={layersOpen}
            title="Layers"
            onClick={() => setLayersOpen(!layersOpen)}
            className="flex w-full flex-col items-center gap-1 py-2 text-muted-foreground hover:text-foreground"
          >
            <Layers className="size-4" />
            <span className="text-[9px]">Layers</span>
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="mt-auto"
            aria-label={layersOpen ? "Hide side panel" : "Show side panel"}
            title={layersOpen ? "Hide side panel" : "Show side panel"}
            onClick={() => setLayersOpen(!layersOpen)}
          >
            {layersOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
        </nav>
        <div
          className={cn(
            "relative grid min-h-0 min-w-0",
            snapshotView
              ? layersOpen
                ? "[@media(width>760px)]:grid-cols-[280px_minmax(0,1fr)]"
                : "[@media(width>760px)]:grid-cols-1"
              : layersOpen
                ? "[@media(width>760px)]:grid-cols-[280px_minmax(0,1fr)_280px]"
                : "[@media(width>760px)]:grid-cols-[minmax(0,1fr)_280px]"
          )}
        >
          {layersOpen && (
            <div className="border-r bg-background [@media(max-width:760px)]:absolute [@media(max-width:760px)]:inset-y-0 [@media(max-width:760px)]:left-0 [@media(max-width:760px)]:z-40 [@media(max-width:760px)]:w-[280px]">
              <SliceOutline
                embedded
                entries={outline}
                activePath={selected?.path ?? null}
                open={layersOpen}
                onOpenChange={setLayersOpen}
                onSelectPath={selectLayer}
              />
            </div>
          )}
          <div
            aria-label="Simulator canvas"
            className="relative h-full min-h-0 min-w-0 overflow-hidden bg-muted/30"
            style={{
              backgroundImage:
                "radial-gradient(var(--border) 1px, transparent 1px)",
              backgroundSize: "12px 12px",
            }}
          >
            <div className="absolute top-3 left-1/2 z-10 -translate-x-1/2">
              <SimSampleControls />
            </div>
            <div
              className="flex h-full flex-col overflow-auto px-6 py-14 [&>*]:shrink-0 [@media(max-width:760px)]:px-4 [@media(max-width:760px)]:py-24"
              style={{ justifyContent: "safe center" }}
            >
              {snapshotView ? (
                <div className="grid min-h-0 gap-4 xl:grid-cols-2">
                  <WorkbenchPane label="Before">
                    <SnapshotPane
                      label="Before"
                      sliceLabel={label}
                      view={view}
                      url={beforeUrl}
                      mode={canvasMode}
                      frameWidth={SLICE_PREVIEW_WIDTHS[view]}
                      emptyMessage="Capture once, make a renderer tweak, then capture again to compare before and after."
                    />
                  </WorkbenchPane>
                  <WorkbenchPane label="After">
                    <SnapshotPane
                      label="After"
                      sliceLabel={label}
                      view={view}
                      url={currentUrl}
                      mode={canvasMode}
                      frameWidth={SLICE_PREVIEW_WIDTHS[view]}
                      emptyMessage="Capture the current render to create the after snapshot."
                    />
                  </WorkbenchPane>
                </div>
              ) : (
                <SliceCanvas
                  key={type}
                  type={type}
                  selectedPath={selected?.path ?? null}
                  view={view}
                  frame={frames[view]}
                  sourceUrl={sourceUrl}
                  onSourceChange={handleSourceChange}
                  onViewChange={setView}
                  onFrameChange={handleFrameChange}
                  onFrameBridge={(bridge) => {
                    frameBridge.current = bridge
                    if (bridge)
                      bridge.readTargetPath = () =>
                        frameBridge.current === bridge && bridge.current()
                          ? (pendingLayerPath.current ??
                            selectedRef.current?.path ??
                            null)
                          : null
                  }}
                  mode={canvasMode}
                  showSource={effectiveShowSource}
                  onScaleChange={setCanvasScale}
                  pageOpening={pageOpening}
                  caption={
                    <FrameCaption
                      label={label}
                      view={view}
                      width={SLICE_PREVIEW_WIDTHS[view] * canvasScale.scale}
                      clipped={canvasScale.clipped}
                    />
                  }
                />
              )}
            </div>
            <div
              aria-label="Tools"
              role="toolbar"
              hidden={phoneInspectorOpen}
              className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-background p-1 shadow-md [&[hidden]]:hidden [@media(max-width:760px)]:fixed [@media(max-width:760px)]:bottom-3 [@media(max-width:760px)]:z-5 [@media(max-width:760px)]:[&_button]:size-[34px] [@media(max-width:760px)]:[&_button]:min-w-[34px]"
            >
              <ToggleGroup
                type="single"
                size="sm"
                aria-label="Canvas view"
                value={
                  activeCompareMode === "before-after"
                    ? "before-after"
                    : effectiveShowSource
                      ? "reference"
                      : "edit"
                }
                onValueChange={(value) => {
                  if (!value || frameBridge.current?.flush() === false) return
                  setCompareModeState(
                    value === "before-after" ? "before-after" : "source-current"
                  )
                  setShowSource(value === "reference")
                }}
              >
                <ToggleGroupItem
                  value="edit"
                  className={SIM_ACCENT.pressedTool}
                  aria-label="Select"
                  title="Select"
                >
                  <MousePointer2 />
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="reference"
                  className={SIM_ACCENT.pressedTool}
                  aria-label="Compare with design reference"
                  title={
                    captureView
                      ? "Compare with design reference"
                      : "Desktop and Mobile only"
                  }
                  disabled={!captureView}
                >
                  <ImageIcon />
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="before-after"
                  className={SIM_ACCENT.pressedTool}
                  aria-label="Before / After"
                  title={
                    captureView ? "Before / After" : "Desktop and Mobile only"
                  }
                  disabled={!hasBeforeAfter}
                >
                  <GitCompare />
                </ToggleGroupItem>
              </ToggleGroup>
              <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
              <div
                className="relative"
                title={
                  captureView ? "Take snapshot" : "Desktop and Mobile only"
                }
              >
                <fieldset
                  disabled={!captureView}
                  aria-label="Snapshot"
                  className="m-0 min-w-0 border-0 p-0"
                >
                  {snapshotAction}
                </fieldset>
                {captureView && snapshots.stale[captureView] && (
                  <span
                    role="img"
                    aria-label="The After snapshot is out of date"
                    title="The After snapshot is out of date"
                    className="absolute top-1 right-1 size-1.5 rounded-full bg-amber-500"
                  />
                )}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-[14px] right-2 z-[24] bg-background [@media(width>760px)]:hidden"
              ref={inspectorTriggerRef}
              aria-label="Show spacing inspector"
              aria-controls="sim-inspector"
              aria-expanded={phoneInspectorOpen}
              aria-disabled={snapshotView}
              onClick={() => {
                if (!snapshotView) setMobileInspectorOpen(!mobileInspectorOpen)
              }}
            >
              <SquareSquare />
            </Button>
          </div>
          <div
            id="sim-inspector"
            ref={inspectorRef}
            hidden={snapshotView || (phoneViewport && !mobileInspectorOpen)}
            className={
              snapshotView
                ? "hidden"
                : cn(
                    "[@media(width>760px)]:block",
                    mobileInspectorOpen
                      ? "[@media(max-width:760px)]:fixed [@media(max-width:760px)]:inset-x-0 [@media(max-width:760px)]:bottom-0 [@media(max-width:760px)]:z-20 [@media(max-width:760px)]:max-h-[66vh] [@media(max-width:760px)]:overflow-y-auto"
                      : "hidden"
                  )
            }
          >
            <BuilderSidebar
              showCode={showCode}
              onShowCodeChange={setShowCode}
              type={type}
              outline={outline}
              target={selected}
              sourceUrl={sourceUrl}
              referenceAvailable={captureView !== null}
              onPreview={previewSelection}
              onClose={dropSelection}
              canvasMode={canvasMode}
              canvasScale={canvasScale}
              showSource={effectiveShowSource}
              onCanvasModeChange={setCanvasMode}
              onShowSourceChange={setShowSource}
            />
          </div>
        </div>
      </section>
    </VisualTweakProvider>
  )
}

function WorkbenchPane({
  label,
  children,
  flush = false,
}: {
  label: string
  children: ReactNode
  /** `true` = strip inner padding + fixed min-height so the child (the live
   *  render iframe) sits flush inside its border and the pane collapses to the
   *  child's intrinsic height. Off by default so panes with placeholder-only
   *  states (Source, snapshot compare) still reserve a reasonable minimum. */
  flush?: boolean
}) {
  return (
    <figure className="min-w-0 space-y-2">
      <figcaption className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </figcaption>
      <div
        className={cn(
          "overflow-hidden rounded-lg border bg-background",
          flush ? "" : "min-h-[420px] p-2"
        )}
      >
        {children}
      </div>
    </figure>
  )
}

function FrameCaption({
  label,
  view,
  width,
  clipped = false,
}: {
  label: string
  view: SlicePreviewView
  width: number | string
  clipped?: boolean
}) {
  const { scope } = useVisualTweak()
  const DeviceIcon =
    view === "desktop" ? Monitor : view === "tablet" ? Tablet : Smartphone
  const ScopeIcon = scope === "below-sm" ? Smartphone : Monitor
  return (
    <div
      aria-label="Canvas frame caption"
      className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground"
      style={{
        width,
        maxWidth: "100%",
        marginInline: clipped ? undefined : "auto",
      }}
    >
      <span className="text-xs font-semibold text-foreground">{label}</span>
      <span aria-hidden>·</span>
      <DeviceIcon className="size-3" />
      <span className="[@media(max-width:760px)]:text-[10px]">
        {SLICE_PREVIEW_WIDTHS[view]}
      </span>
      {scope !== "all" && (
        <span
          aria-label="Current appearance scope"
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
            SIM_ACCENT.chip
          )}
        >
          <ScopeIcon className="size-3" />
          {scope === "below-sm" ? "< 640 px" : "≥ 640 px"}
        </span>
      )}
    </div>
  )
}

function SnapshotPane({
  label,
  url,
  mode,
  frameWidth,
  sliceLabel,
  view,
  emptyMessage,
}: {
  label: string
  url: string | null
  mode: CanvasScaleMode
  frameWidth: number
  sliceLabel: string
  view: SlicePreviewView
  emptyMessage: string
}) {
  if (!url) {
    return (
      <div className="flex min-h-[404px] items-center justify-center rounded-md bg-muted/20 px-6 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="min-h-[404px] overflow-auto rounded-md bg-background">
      <FrameCaption
        label={sliceLabel}
        view={view}
        width={
          mode === "auto"
            ? "100%"
            : frameWidth * (mode === "half" ? 0.5 : mode === "double" ? 2 : 1)
        }
        clipped={mode !== "auto"}
      />
      {/* react-doctor-disable-next-line react-doctor/nextjs-no-img-element */}
      <img
        src={url}
        alt={`${label} snapshot`}
        className={cn(
          "block max-w-none",
          mode === "auto" && "w-full",
          mode !== "auto" && "w-auto"
        )}
        style={
          mode === "auto"
            ? undefined
            : {
                width:
                  frameWidth *
                  (mode === "half" ? 0.5 : mode === "double" ? 2 : 1),
              }
        }
      />
    </div>
  )
}

function makeSnapshotPair(
  type: string,
  slot: "current" | "before",
  version: number
): SnapshotPair {
  return {
    desktop: snapshotUrl(type, "desktop", slot, version),
    mobile: snapshotUrl(type, "mobile", slot, version),
  }
}

function snapshotUrl(
  type: string,
  viewport: ThumbnailVariant,
  slot: "current" | "before",
  version: number
) {
  const suffix =
    slot === "before"
      ? viewport === "mobile"
        ? ".mobile.full.before"
        : ".full.before"
      : viewport === "mobile"
        ? ".mobile.full"
        : ".full"
  return `/slice-sim/${type}${suffix}.png?v=${version}`
}
