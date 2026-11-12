"use client"

import { ArrowUpToLine, Code2, MousePointer2, Repeat2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { CanvasScale, ScaleMode } from "./canvas-scale"
import { SLICE_HIGHLIGHT_EVENT, type TargetInfo } from "./slice-preview"
import { SliceTweakInspector } from "./slice-tweak-inspector"
import type { ToolbarSpacingAxis } from "./slice-tweak-toolbar-types"
import type { TweakScope } from "@/lib/slices/visual-tweak/class-operations"

export function InspectorRail({
  target,
  onPreview,
  onClose,
  onCode,
  embedded = false,
  showHeader = true,
}: {
  target: TargetInfo | null
  sourceUrl: string | null
  onPreview: (
    axis: ToolbarSpacingAxis,
    valueRem: number,
    loc: string,
    scope: TweakScope
  ) => void
  onClose: () => void
  onCode?: () => void
  canvasMode: ScaleMode
  canvasScale: CanvasScale
  showSource: boolean
  referenceAvailable?: boolean
  onCanvasModeChange: (mode: ScaleMode) => void
  onShowSourceChange: (show: boolean) => void
  embedded?: boolean
  showHeader?: boolean
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 bg-background p-3 [@media(max-width:760px)]:px-3 [@media(max-width:760px)]:py-2.5",
        !embedded && "rounded-lg border"
      )}
    >
      {target ? (
        <>
          {showHeader && (
            <header className="flex items-center gap-2 border-b pb-3">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {target.label}
              </span>
              {target.templateWide && (
                <span
                  role="img"
                  aria-label="All repeated instances"
                  title="All repeated instances"
                >
                  <Repeat2 className="size-4" />
                </span>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Select parent"
                title="Select parent"
                disabled={!target.parentLoc}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent(SLICE_HIGHLIGHT_EVENT, {
                      detail: { path: target.parentLoc, mode: "select" },
                    })
                  )
                }
              >
                <ArrowUpToLine />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Code"
                title="Code"
                onClick={onCode}
              >
                <Code2 />
              </Button>
            </header>
          )}
          <SliceTweakInspector
            compact
            target={target}
            onPreview={onPreview}
            onClose={onClose}
          />
        </>
      ) : (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <MousePointer2 className="size-5" />
          <span>Nothing selected</span>
        </div>
      )}
    </div>
  )
}
