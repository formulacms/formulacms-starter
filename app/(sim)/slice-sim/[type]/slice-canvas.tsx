"use client"

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { SOURCE_IMAGE_UPDATED_EVENT } from "@/components/admin/slices/slice-sim-events"
import type { ThumbnailVariant } from "@/lib/slices/thumbnails"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import {
  resolveCanvasScale,
  type CanvasScale,
  type ScaleMode,
} from "./canvas-scale"
import {
  clampWipePct,
  isModeAvailable,
  resolveCompareLayout,
  resolveLayerStyles,
  type CompareMode,
} from "./canvas-state"
import {
  applyRegistration,
  nudgeRegistration,
  registrationKey,
  UNALIGNED,
  type Registration,
} from "./registration"
import type { SimFrameBridge } from "./sim-frame-bridge"
import { SlicePreview } from "./slice-preview"
import {
  SLICE_PREVIEW_WIDTHS,
  type SlicePreviewFrame,
  type SlicePreviewView,
} from "./slice-preview-frame"
import { SourceReferencePane } from "./source-reference-pane"
import { useElementWidth } from "./use-element-width"

const COMPARE_MODES: ReadonlyArray<{ value: CompareMode; label: string }> = [
  { value: "side", label: "Side by side" },
  { value: "overlay", label: "Overlay" },
  { value: "wipe", label: "Wipe" },
  { value: "flip", label: "Flip" },
]

type CanvasSurface = CompareMode | "align"

const REGISTRATION_STORAGE_EVENT = "formulacms:slice-sim:registration-updated"
const memoryRegistrations = new Map<string, string>()

/**
 * Auto renders 1:1 whenever the complete frame fits and falls back to Fit only
 * to prevent accidental clipping. Side-by-side remains honest without shared
 * coordinates; Overlay, Wipe and Flip require explicit reference alignment.
 */
export function SliceCanvas({
  type,
  selectedPath,
  view,
  frame,
  sourceUrl,
  onSourceChange,
  onViewChange,
  onFrameChange,
  onFrameBridge,
  mode,
  showSource,
  onScaleChange,
  pageOpening,
  caption,
}: {
  type: string
  selectedPath?: string | null
  view: SlicePreviewView
  frame: SlicePreviewFrame
  sourceUrl: string | null
  onSourceChange: (variant: ThumbnailVariant, url: string) => void
  onViewChange: (view: SlicePreviewView) => void
  onFrameChange: (frame: SlicePreviewFrame) => void
  onFrameBridge?: (bridge: SimFrameBridge | null) => void
  mode: ScaleMode
  showSource: boolean
  onScaleChange: (scale: CanvasScale) => void
  pageOpening?: boolean
  caption?: ReactNode
}) {
  const renderRef = useRef<HTMLDivElement>(null)
  const availableWidth = useElementWidth(renderRef, 0)
  const storageKey = registrationKey(type, view)
  const storedRegistration = useSyncExternalStore(
    subscribeToRegistrationStorage,
    () => readStoredRegistration(storageKey),
    () => null
  )
  const registration = readRegistration(storedRegistration)
  const [surface, setSurface] = useState<CanvasSurface>("side")
  const [sourceOpacity, setSourceOpacity] = useState(0.5)
  const [wipePct, setWipePct] = useState(50)
  const [flipHeld, setFlipHeld] = useState(false)

  useEffect(() => {
    function resetAfterSourceReplacement() {
      const reset = { ...UNALIGNED }
      setSurface("side")
      setFlipHeld(false)
      writeStoredRegistration(storageKey, reset)
    }

    window.addEventListener(
      SOURCE_IMAGE_UPDATED_EVENT,
      resetAfterSourceReplacement
    )
    return () =>
      window.removeEventListener(
        SOURCE_IMAGE_UPDATED_EVENT,
        resetAfterSourceReplacement
      )
  }, [storageKey])

  const frameWidth = SLICE_PREVIEW_WIDTHS[view]
  const resolution = resolveCanvasScale({
    availableWidth,
    frameWidth,
    mode,
  })
  const { scale, effective, clipped } = resolution
  const reportScaleChange = useEffectEvent(onScaleChange)

  useEffect(() => {
    reportScaleChange({ scale, effective, clipped })
  }, [scale, effective, clipped])

  function updateRegistration(patch: Partial<Registration>) {
    const next = nudgeRegistration(registration, patch)
    writeStoredRegistration(storageKey, next)
    if (!next.aligned) {
      setSurface("align")
      setFlipHeld(false)
    }
  }

  // Tablet has a live preview but no persisted reference/upload variant.
  const showReference = showSource && view !== "tablet"
  const registeredModesAvailable =
    view !== "tablet" && Boolean(sourceUrl) && registration.aligned
  const alignmentPreview =
    surface === "align" && showReference && Boolean(sourceUrl)
  const requestedCompareMode = surface === "align" ? "side" : surface
  const effectiveCompareMode = isModeAvailable(
    requestedCompareMode,
    showReference && registeredModesAvailable
  )
    ? requestedCompareMode
    : "side"
  const layout = alignmentPreview
    ? "registered-stack"
    : resolveCompareLayout(effectiveCompareMode)
  const layerStyles = alignmentPreview
    ? { source: { opacity: 0.5 }, render: {} }
    : effectiveCompareMode === "side"
      ? null
      : resolveLayerStyles({
          mode: effectiveCompareMode,
          sourceOpacity,
          wipePct,
          flipHeld,
        })
  const showSourceSibling = showReference && layout === "side-by-side"

  return (
    <div className="min-w-0 space-y-3">
      {showReference && (
        <CompareControls
          type={type}
          view={view}
          sourceUrl={sourceUrl}
          registration={registration}
          registeredModesAvailable={registeredModesAvailable}
          alignmentPreview={alignmentPreview}
          compareMode={alignmentPreview ? null : effectiveCompareMode}
          sourceOpacity={sourceOpacity}
          wipePct={wipePct}
          onRegistrationChange={updateRegistration}
          onAlignmentPreview={() => {
            setFlipHeld(false)
            setSurface("align")
          }}
          onCompareModeChange={(nextMode) => {
            setFlipHeld(false)
            setSurface(nextMode)
          }}
          onSourceOpacityChange={setSourceOpacity}
          onWipePctChange={setWipePct}
          onFlipHeldChange={setFlipHeld}
        />
      )}

      {alignmentPreview && (
        <p className="text-xs font-medium text-muted-foreground">
          Alignment preview · {registration.aligned ? "Aligned" : "Unaligned"}
          {registration.aligned
            ? " — comparison modes are available."
            : " — adjust the reference, then mark it aligned to unlock comparison modes."}
        </p>
      )}

      <div
        data-compare-layout={layout}
        data-canvas-surface={
          alignmentPreview ? "alignment-preview" : effectiveCompareMode
        }
        className={cn(
          "grid gap-3",
          showSourceSibling ? "grid-cols-2" : "grid-cols-1"
        )}
      >
        <div ref={renderRef} className="min-w-0 overflow-x-auto">
          {caption}
          <div
            style={{
              width: frameWidth * scale,
              height: frame.height * scale,
              marginInline: clipped ? undefined : "auto",
            }}
          >
            <div
              className="relative overflow-hidden rounded-md border bg-background shadow-sm"
              style={{
                width: frameWidth,
                height: frame.height,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
            >
              <div style={layerStyles?.render}>
                <SlicePreview
                  key={type}
                  type={type}
                  selectedPath={selectedPath}
                  view={view}
                  onViewChange={onViewChange}
                  onFrameChange={onFrameChange}
                  onFrameBridge={onFrameBridge}
                  showTabs={false}
                  showOpeningControl={false}
                  pageOpening={pageOpening}
                />
              </div>
              {layerStyles && sourceUrl && (
                <div
                  data-registration-layer="reference"
                  className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
                  style={layerStyles.source}
                >
                  {/* eslint-disable @next/next/no-img-element -- the alignment surface needs the runtime image's natural aspect ratio without a frame-height-sized fill box */}
                  {/* react-doctor-disable-next-line react-doctor/nextjs-no-img-element */}
                  <img
                    data-registration-image="reference"
                    src={sourceUrl}
                    alt=""
                    width={frameWidth}
                    className="block h-auto max-w-none"
                    style={{
                      width: frameWidth,
                      height: "auto",
                      ...applyRegistration(registration),
                    }}
                  />
                  {/* eslint-enable @next/next/no-img-element */}
                </div>
              )}
              {effectiveCompareMode === "wipe" && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 z-30 w-px bg-foreground/70 shadow-sm"
                  style={{ left: `${clampWipePct(wipePct)}%` }}
                />
              )}
            </div>
          </div>
        </div>

        {showSourceSibling && (
          <SourceReferencePane
            type={type}
            view={view}
            url={sourceUrl}
            frame={frame}
            onChange={onSourceChange}
          />
        )}
      </div>
    </div>
  )
}

function CompareControls({
  type,
  view,
  sourceUrl,
  registration,
  registeredModesAvailable,
  alignmentPreview,
  compareMode,
  sourceOpacity,
  wipePct,
  onRegistrationChange,
  onAlignmentPreview,
  onCompareModeChange,
  onSourceOpacityChange,
  onWipePctChange,
  onFlipHeldChange,
}: {
  type: string
  view: SlicePreviewView
  sourceUrl: string | null
  registration: Registration
  registeredModesAvailable: boolean
  alignmentPreview: boolean
  compareMode: CompareMode | null
  sourceOpacity: number
  wipePct: number
  onRegistrationChange: (patch: Partial<Registration>) => void
  onAlignmentPreview: () => void
  onCompareModeChange: (mode: CompareMode) => void
  onSourceOpacityChange: (opacity: number) => void
  onWipePctChange: (percentage: number) => void
  onFlipHeldChange: (held: boolean) => void
}) {
  function updateNumber(field: "scale" | "offsetX" | "offsetY", value: number) {
    if (Number.isFinite(value)) onRegistrationChange({ [field]: value })
  }

  return (
    <div className="space-y-3 rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Compare with reference</p>
          <p className="text-xs text-muted-foreground">
            Align the reference before using a shared view.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            variant={alignmentPreview ? "default" : "outline"}
            size="sm"
            disabled={!sourceUrl}
            aria-pressed={alignmentPreview}
            onClick={onAlignmentPreview}
          >
            Alignment preview
          </Button>
          <div
            role="group"
            aria-label="Comparison mode"
            className="flex flex-wrap gap-1.5"
          >
            {COMPARE_MODES.map((option) => {
              const available = isModeAvailable(
                option.value,
                registeredModesAvailable
              )
              return (
                <Button
                  key={option.value}
                  type="button"
                  variant={compareMode === option.value ? "default" : "outline"}
                  size="sm"
                  disabled={!available}
                  title={available ? undefined : "Align the reference first"}
                  aria-pressed={compareMode === option.value}
                  onClick={() => onCompareModeChange(option.value)}
                >
                  {option.label}
                </Button>
              )
            })}
          </div>
        </div>
      </div>

      {sourceUrl ? (
        <div className="grid gap-3 border-t pt-3 lg:grid-cols-[minmax(180px,1fr)_110px_110px_auto] lg:items-end">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={`${type}-${view}-reference-scale`}>
                Reference scale
              </Label>
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.round(registration.scale * 100)}%
              </span>
            </div>
            <input
              id={`${type}-${view}-reference-scale`}
              type="range"
              min={0.1}
              max={4}
              step={0.01}
              value={registration.scale}
              className="h-9 w-full cursor-pointer accent-foreground"
              onChange={(event) =>
                updateNumber("scale", event.target.valueAsNumber)
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${type}-${view}-reference-x`}>
              Left / right (X)
            </Label>
            <Input
              id={`${type}-${view}-reference-x`}
              type="number"
              step={1}
              value={registration.offsetX}
              onChange={(event) =>
                updateNumber("offsetX", event.target.valueAsNumber)
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${type}-${view}-reference-y`}>Up / down (Y)</Label>
            <Input
              id={`${type}-${view}-reference-y`}
              type="number"
              step={1}
              value={registration.offsetY}
              onChange={(event) =>
                updateNumber("offsetY", event.target.valueAsNumber)
              }
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onRegistrationChange({ ...UNALIGNED })}
            >
              Reset
            </Button>
            <Button
              type="button"
              variant={registration.aligned ? "default" : "outline"}
              size="sm"
              aria-pressed={registration.aligned}
              onClick={() =>
                onRegistrationChange({ aligned: !registration.aligned })
              }
            >
              {registration.aligned ? "Aligned ✓" : "Mark aligned"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="border-t pt-3 text-xs text-muted-foreground">
          Add a reference image in the pane below to align shared views.
        </p>
      )}

      {compareMode === "overlay" && (
        <div className="space-y-1.5 border-t pt-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${type}-${view}-source-opacity`}>
              Reference opacity
            </Label>
            <span className="text-xs text-muted-foreground tabular-nums">
              {Math.round(sourceOpacity * 100)}%
            </span>
          </div>
          <input
            id={`${type}-${view}-source-opacity`}
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={sourceOpacity}
            className="h-9 w-full cursor-pointer accent-foreground"
            onChange={(event) =>
              onSourceOpacityChange(event.target.valueAsNumber)
            }
          />
        </div>
      )}

      {compareMode === "wipe" && (
        <div className="space-y-1.5 border-t pt-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${type}-${view}-wipe-position`}>
              Wipe divider
            </Label>
            <span className="text-xs text-muted-foreground tabular-nums">
              {Math.round(wipePct)}%
            </span>
          </div>
          <input
            id={`${type}-${view}-wipe-position`}
            type="range"
            min={3}
            max={97}
            step={1}
            value={wipePct}
            className="h-9 w-full cursor-pointer accent-foreground"
            onChange={(event) => onWipePctChange(event.target.valueAsNumber)}
          />
        </div>
      )}

      {compareMode === "flip" && (
        <div className="border-t pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onPointerDown={() => onFlipHeldChange(true)}
            onPointerUp={() => onFlipHeldChange(false)}
            onPointerCancel={() => onFlipHeldChange(false)}
            onPointerLeave={() => onFlipHeldChange(false)}
            onKeyDown={(event) => {
              if (event.key === " " || event.key === "Enter") {
                onFlipHeldChange(true)
              }
            }}
            onKeyUp={() => onFlipHeldChange(false)}
            onBlur={() => onFlipHeldChange(false)}
          >
            Hold to show reference
          </Button>
        </div>
      )}
    </div>
  )
}

function readRegistration(raw: string | null): Registration {
  if (!raw) return { ...UNALIGNED }
  try {
    const value = JSON.parse(raw) as Partial<Registration>
    if (
      !Number.isFinite(value.scale) ||
      !Number.isFinite(value.offsetX) ||
      !Number.isFinite(value.offsetY) ||
      typeof value.aligned !== "boolean"
    ) {
      return { ...UNALIGNED }
    }
    return nudgeRegistration(UNALIGNED, value)
  } catch {
    return { ...UNALIGNED }
  }
}

function subscribeToRegistrationStorage(onStoreChange: () => void): () => void {
  window.addEventListener(REGISTRATION_STORAGE_EVENT, onStoreChange)
  return () =>
    window.removeEventListener(REGISTRATION_STORAGE_EVENT, onStoreChange)
}

function readStoredRegistration(storageKey: string): string | null {
  try {
    return (
      window.localStorage.getItem(storageKey) ??
      memoryRegistrations.get(storageKey) ??
      null
    )
  } catch {
    return memoryRegistrations.get(storageKey) ?? null
  }
}

function writeStoredRegistration(
  storageKey: string,
  registration: Registration
): void {
  const serialized = JSON.stringify(registration)
  memoryRegistrations.set(storageKey, serialized)
  try {
    window.localStorage.setItem(storageKey, serialized)
  } catch {
    // Browser storage is optional; comparison still works for this session.
  }
  window.dispatchEvent(new Event(REGISTRATION_STORAGE_EVENT))
}
