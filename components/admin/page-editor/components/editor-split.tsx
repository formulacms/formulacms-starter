"use client"

import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  Eye,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PencilLine,
} from "lucide-react"
import { usePanelRef, type Layout } from "react-resizable-panels"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export const SPLIT_STORAGE_KEY = "formulacms:page-editor:split:v1"
/** Block list share of the width, in percent: today's 1fr : 2fr. */
export const DEFAULT_BLOCKS_PERCENT = 100 / 3

const SIDES = ["blocks", "preview"] as const
type HiddenSide = (typeof SIDES)[number] | null
type NarrowView = "edit" | "preview"
export type SplitLayout = {
  /** Block list share of the width (percent) when both sides show. */
  blocks: number
  hidden: HiddenSide
  view: NarrowView
}

const DEFAULT_LAYOUT: SplitLayout = {
  blocks: DEFAULT_BLOCKS_PERCENT,
  hidden: null,
  view: "edit",
}

/** Reads the remembered layout; any storage failure gives the default. */
export function readSplitLayout(): SplitLayout {
  try {
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(SPLIT_STORAGE_KEY) ?? "null"
    )
    if (!saved || typeof saved !== "object") return DEFAULT_LAYOUT
    const { blocks, hidden, view } = saved as Record<string, unknown>
    return {
      blocks:
        typeof blocks === "number" && blocks > 0 && blocks < 100
          ? blocks
          : DEFAULT_BLOCKS_PERCENT,
      hidden: hidden === "blocks" || hidden === "preview" ? hidden : null,
      view: view === "preview" ? "preview" : "edit",
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

export function writeSplitLayout(layout: SplitLayout) {
  try {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // Storage is optional: the layout then lasts until the page reloads.
  }
}

function initialGroupLayout({ blocks, hidden }: SplitLayout): Layout {
  // A collapsible panel asked for 0% snaps to its rail width.
  if (hidden === "blocks") return { blocks: 0, preview: 100 }
  if (hidden === "preview") return { blocks: 100, preview: 0 }
  return { blocks, preview: 100 - blocks }
}

const RAIL = "36px"
const ghostButton =
  "hidden h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground xl:inline-flex [&_svg]:size-4"
const railButton =
  "hidden min-h-36 w-9 flex-col items-center gap-2 rounded-lg border bg-background py-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground xl:flex [&_svg]:size-4"

/**
 * The page editor's block list and live preview side by side (xl and up):
 * a draggable divider, a hide button on each side, and one remembered
 * layout per browser. Below xl an Edit / Preview switch shows one side.
 * Both sides stay mounted when hidden, so the preview frame keeps its state.
 */
export function EditorSplit({
  blocks,
  preview,
}: {
  blocks: ReactNode
  /** Renders the preview with the "Hide preview" button for its toolbar. */
  preview(hideButton: ReactNode): ReactNode
}) {
  const t = useTranslations("editor.blocksPanel.split")
  const [initial] = useState(readSplitLayout)
  const [hidden, setHidden] = useState<HiddenSide>(initial.hidden)
  const [view, setView] = useState<NarrowView>(initial.view)
  const remembered = useRef(initial)
  const pendingFocus = useRef<string | null>(null)
  // Remember only what the owner chose: drags and keys on the divider, a
  // double-click on it, and the hide/show buttons. Layout changes forced by
  // the window size are not remembered.
  const ownerAction = useRef(false)
  // While the divider is held, the preview frame must not catch the pointer:
  // a fast first move over it would otherwise never reach the divider.
  const [dragging, setDragging] = useState(false)
  const blocksPanel = usePanelRef()
  const previewPanel = usePanelRef()

  function remember(next: Partial<SplitLayout>) {
    remembered.current = { ...remembered.current, ...next }
    writeSplitLayout(remembered.current)
  }

  const panels = { blocks: blocksPanel, preview: previewPanel }
  const blocksLabelId = useId()

  function currentHidden(): HiddenSide {
    return SIDES.find((side) => panels[side].current?.isCollapsed()) ?? null
  }

  useEffect(() => {
    if (!dragging) return
    const end = () => setDragging(false)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
    return () => {
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
    }
  }, [dragging])

  useEffect(() => {
    if (!pendingFocus.current) return
    document.getElementById(pendingFocus.current)?.focus()
    pendingFocus.current = null
  }, [hidden])

  function hide(side: NonNullable<HiddenSide>) {
    pendingFocus.current = `editor-split-show-${side}`
    ownerAction.current = true
    panels[side].current?.collapse()
  }

  function show(side: NonNullable<HiddenSide>) {
    pendingFocus.current = `editor-split-hide-${side}`
    ownerAction.current = true
    blocksPanel.current?.resize(`${remembered.current.blocks}%`)
  }

  // In a narrow preview toolbar (an `@container`) the button shows its icon
  // only; the tooltip and the hidden text keep its name.
  const hidePreviewButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          id="editor-split-hide-preview"
          className={cn(ghostButton, "ml-auto h-8")}
          onClick={() => hide("preview")}
        >
          <PanelRightClose aria-hidden />
          <span className="@max-[36rem]:sr-only">{t("hidePreview")}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{t("hidePreview")}</TooltipContent>
    </Tooltip>
  )

  return (
    <div className="space-y-4">
      <ToggleGroup
        type="single"
        size="sm"
        value={view}
        aria-label={t("view")}
        className="w-fit rounded-lg bg-muted p-[3px] xl:hidden"
        onValueChange={(value) => {
          if (value !== "edit" && value !== "preview") return
          setView(value)
          remember({ view: value })
        }}
      >
        <ToggleGroupItem
          value="edit"
          className="px-3.5 data-[state=on]:bg-background data-[state=on]:shadow-sm"
        >
          <PencilLine aria-hidden />
          {t("edit")}
        </ToggleGroupItem>
        <ToggleGroupItem
          value="preview"
          className="px-3.5 data-[state=on]:bg-background data-[state=on]:shadow-sm"
        >
          <Eye aria-hidden />
          {t("preview")}
        </ToggleGroupItem>
      </ToggleGroup>
      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={initialGroupLayout(initial)}
        // The page scrolls, not the panels; overflow stays visible so the
        // preview can stick to the top while the block list scrolls by.
        style={{ height: "auto", overflow: "visible" }}
        className={cn(
          "items-stretch max-xl:block!",
          dragging && "select-none [&_iframe]:pointer-events-none"
        )}
        onLayoutChange={() => setHidden(currentHidden())}
        onLayoutChanged={(layout, meta) => {
          const side = currentHidden()
          setHidden(side)
          if (!meta.isUserInteraction && !ownerAction.current) return
          ownerAction.current = false
          const requested = meta.requestedLayout ?? layout
          remember(
            side === null && typeof requested.blocks === "number"
              ? { hidden: side, blocks: requested.blocks }
              : { hidden: side }
          )
        }}
      >
        <ResizablePanel
          id="blocks"
          panelRef={blocksPanel}
          defaultSize={`${DEFAULT_BLOCKS_PERCENT}%`}
          minSize={280}
          collapsible
          collapsedSize={RAIL}
          style={{ overflow: "visible" }}
          className={cn("min-w-0", view === "preview" && "max-xl:hidden")}
        >
          {hidden === "blocks" && (
            <button
              type="button"
              id="editor-split-show-blocks"
              title={t("showBlocks")}
              aria-label={t("showBlocks")}
              className={railButton}
              onClick={() => show("blocks")}
            >
              <PanelLeftOpen aria-hidden />
              <span className="[writing-mode:vertical-rl]">
                {t("blocksLabel")}
              </span>
            </button>
          )}
          <section
            aria-labelledby={blocksLabelId}
            className={cn(
              "min-w-0 space-y-3",
              hidden === "blocks" && "xl:hidden"
            )}
          >
            <div className="flex min-h-9 items-center justify-between gap-2">
              <span
                id={blocksLabelId}
                className="text-xs font-medium text-muted-foreground"
              >
                {t("blocksLabel")}
              </span>
              <button
                type="button"
                id="editor-split-hide-blocks"
                className={ghostButton}
                onClick={() => hide("blocks")}
              >
                <PanelLeftClose aria-hidden />
                {t("hideBlocks")}
              </button>
            </div>
            {blocks}
          </section>
        </ResizablePanel>
        <ResizableHandle
          withHandle
          title={t("divider")}
          aria-labelledby={blocksLabelId}
          // A double-click resets the divider; it reaches the library first.
          onPointerDown={() => {
            ownerAction.current = true
            setDragging(true)
          }}
          // The same focus ring as the admin's buttons.
          className="mx-3 items-start focus-visible:bg-ring focus-visible:ring-3 focus-visible:ring-ring/50 max-xl:hidden [&>div]:sticky [&>div]:top-40 [&>div]:mt-32"
        />
        <ResizablePanel
          id="preview"
          panelRef={previewPanel}
          defaultSize={`${100 - DEFAULT_BLOCKS_PERCENT}%`}
          minSize={360}
          collapsible
          collapsedSize={RAIL}
          style={{ overflow: "visible" }}
          // A full-height column, so the preview can stick while the page scrolls.
          className={cn(
            "flex min-w-0 flex-col",
            view === "edit" && "max-xl:hidden"
          )}
        >
          {hidden === "preview" && (
            <button
              type="button"
              id="editor-split-show-preview"
              title={t("showPreview")}
              aria-label={t("showPreview")}
              className={railButton}
              onClick={() => show("preview")}
            >
              <PanelRightOpen aria-hidden />
              <span className="[writing-mode:vertical-rl]">
                {t("previewLabel")}
              </span>
            </button>
          )}
          <div
            className={cn(
              "min-w-0 flex-1",
              hidden === "preview" && "xl:hidden"
            )}
          >
            {preview(hidePreviewButton)}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
