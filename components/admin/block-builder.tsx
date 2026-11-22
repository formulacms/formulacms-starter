"use client"

import { readBlockMetadata } from "@/lib/blocks/builder"
import { readBlock } from "@/convex/lib/blocks/identity"

import {
  adminBlockMetadata,
  adminBlockGroupLabel,
} from "@/lib/i18n/admin-metadata"

import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useId,
  useRef,
  useState,
} from "react"
import {
  PREVIEW_CLICK_SETTLE_MS,
  placeInputCaret,
  placeRichTextCaret,
} from "./rich-text-caret"
import Image from "next/image"
import { useTranslations } from "next-intl"
import { useQuery_experimental } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  GripVertical,
  Loader2,
  Plus,
  Trash2,
  WandSparkles,
} from "lucide-react"
import type { Block } from "@/convex/lib/blocks"
import { INSTALLED_BLOCK_TYPES } from "@/convex/lib/blocks"
import type { BlockPresentationCatalog } from "@/convex/lib/blocks/presentationResolution"
import {
  repairBlockIds,
  withUniqueBlockRenderIds,
} from "@/convex/lib/blocks/identity"
import { BLOCK_GROUPS, type BlockType } from "@/lib/blocks/builder"
import { createSampleBlock } from "@/lib/blocks/sample"
import { useDragReorder, moveItem } from "@/lib/use-drag-reorder"
import { useConfirm } from "@/components/providers/confirm-provider"
import { BlockEditor } from "./block-editor"
import { PageSaveRefusedError } from "@/components/admin/page-editor/lib/page-save-refused-error"
import type { FieldTranslate, FieldGenerate } from "./fields/field-editor"
import { ImageFieldLocaleProvider } from "./fields/image-field-editor"
import type {
  BlockFieldFocusTarget,
  BlockFirstControlFocusTarget,
  BlockPreviewClickSelection,
} from "./visual-editing-types"
import {
  captureBlockOccurrence,
  currentBlockOccurrence,
} from "./page-editor/lib/block-occurrence"

// How long a field selected from the preview may wait for a lazily loaded
// editor before focus is abandoned.
const FOCUS_WAIT_LIMIT_MS = 5_000
// A field selected from the preview is focused at once, without scrolling,
// and brought into view only PREVIEW_CLICK_SETTLE_MS after the last click.

/**
 * True when the field can be seen: wholly inside the window and every
 * clipping ancestor, or, when it is taller than that area, crossing it.
 */
function isFieldInView(field: HTMLElement) {
  const box = field.getBoundingClientRect()
  let top = 0
  let bottom = window.innerHeight
  for (let node = field.parentElement; node; node = node.parentElement) {
    if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(node).overflowY))
      continue
    const area = node.getBoundingClientRect()
    top = Math.max(top, area.top)
    bottom = Math.min(bottom, area.bottom)
  }
  if (box.height > bottom - top) return box.top < bottom && box.bottom > top
  return box.top >= top && box.bottom <= bottom
}

/**
 * Brings a field focused from a preview click into view once the click
 * sequence is over. A further click on the preview starts the wait over; the
 * owner's own scrolling or clicking in the page cancels it. Returns the cancel.
 */
function revealAfterPreviewClicks(field: HTMLElement) {
  function stop() {
    window.clearTimeout(reveal)
    document.removeEventListener("pointerdown", stop, true)
    document.removeEventListener("wheel", stop, true)
  }
  const reveal = window.setTimeout(() => {
    stop()
    if (!isFieldInView(field)) field.scrollIntoView({ block: "nearest" })
  }, PREVIEW_CLICK_SETTLE_MS)
  document.addEventListener("pointerdown", stop, true)
  document.addEventListener("wheel", stop, { capture: true, passive: true })
  return stop
}

/**
 * Resolve the source-locale block that corresponds to `blocks[index]` by ordinal
 * among blocks of the same type: the k-th block of its type here maps to the k-th
 * block of that type in `sourceBlocks`. Returns undefined when the source has no
 * such peer (different structure), which hides per-field translation for it.
 */
function nthOfTypeInSource(
  blocks: Block[],
  sourceBlocks: Block[] | undefined,
  index: number
): Block | undefined {
  if (!sourceBlocks) return undefined
  const type = readBlock(blocks[index]).type
  const ordinal = blocks
    .slice(0, index)
    .filter((s) => readBlock(s).type === type).length
  let seen = 0
  for (const s of sourceBlocks) {
    if (readBlock(s).type === type) {
      if (seen === ordinal) return s
      seen += 1
    }
  }
  return undefined
}

type BlockBuilderLatest = {
  blocks: Block[]
  currentLocale: string
  onChange: (next: Block[]) => void
  onPickerOpenChange: (open: boolean) => void
  generationAvailable: boolean
  archivedTypes: readonly string[] | null
  selectedBlockId?: string | null
  onSelectedBlockIdChange?: (blockId: string | null) => void
}

/**
 * The try/catch/finally of "generate a starter block". Module-level so the
 * component body has no `finally` clause: React Compiler 1.0.0 skips whole
 * components containing one (react/react#34131). Behaviour is unchanged.
 */
async function runStarterBlockGeneration({
  generate,
  type,
  metaLabel,
  latest,
  currentLocale,
  setExpanded,
  setStarterType,
  changedDuringEditMessage,
  starterFailedMessage,
}: {
  generate: FieldGenerate
  type: BlockType
  metaLabel: string
  latest: { current: BlockBuilderLatest | null }
  currentLocale: string
  setExpanded: (blockId: string | null) => void
  setStarterType: (type: BlockType | null) => void
  changedDuringEditMessage: string
  starterFailedMessage: string
}): Promise<void> {
  try {
    const block = await generate.runBlock(
      type,
      `Write starter content for a ${metaLabel} section on this page.`
    )
    const state = latest.current
    if (!state) return
    if (
      state.currentLocale !== currentLocale ||
      !state.generationAvailable ||
      !state.archivedTypes ||
      state.archivedTypes.includes(type)
    ) {
      toast.error(changedDuringEditMessage)
      return
    }
    state.onChange([...repairBlockIds(state.blocks), block])
    setExpanded(readBlock(block).id)
    state.onSelectedBlockIdChange?.(readBlock(block).id)
    state.onPickerOpenChange(false)
  } catch (err) {
    if (!latest.current) return
    if (!(err instanceof PageSaveRefusedError)) {
      console.error(err)
      toast.error(starterFailedMessage)
    }
  } finally {
    if (latest.current) setStarterType(null)
  }
}

export function BlockBuilder({
  title,
  pageId,
  contentEpoch,
  otherLocales,
  blocks,
  onChange,
  currentLocale,
  sourceBlocks,
  translate,
  generate,
  pickerOpen,
  onPickerOpenChange,
  selectedBlockId,
  focusedFieldTarget,
  focusedFirstControlTarget,
  previewClickSelection,
  onSelectedBlockIdChange,
  archiveStateVerificationFailure = false,
  presentationCatalog,
}: {
  title?: string
  pageId?: string
  contentEpoch?: number
  otherLocales?: readonly string[]
  blocks: Block[]
  onChange: (next: Block[]) => void
  currentLocale: string
  /** Source-locale blocks for per-field translation; matched by index + type. */
  sourceBlocks?: Block[]
  translate?: FieldTranslate
  generate?: FieldGenerate
  pickerOpen: boolean
  onPickerOpenChange: (open: boolean) => void
  selectedBlockId?: string | null
  focusedFieldTarget?: BlockFieldFocusTarget | null
  focusedFirstControlTarget?: BlockFirstControlFocusTarget | null
  /** A click on a preview field selected this block: do not scroll to it. */
  previewClickSelection?: BlockPreviewClickSelection | null
  onSelectedBlockIdChange?: (blockId: string | null) => void
  archiveStateVerificationFailure?: boolean
  presentationCatalog?: BlockPresentationCatalog
}) {
  const sectionRegionsId = useId()
  const t = useTranslations("editor.blockBuilder")
  const tMetadata = useTranslations("metadata")
  const confirm = useConfirm()
  // Archived block types are retired from the picker (curation, not deletion).
  const observedArchivedTypesQuery = useQuery_experimental({
    query: api.cms.blocks.getArchivedBlockTypes,
    args: {},
  })
  const archivedTypesQuery = archiveStateVerificationFailure
    ? ({
        status: "error",
        error: new Error("Verification fixture forced archive read failure."),
      } as const)
    : observedArchivedTypesQuery
  const archivedTypes =
    archivedTypesQuery.status === "success" ? archivedTypesQuery.data : null
  const archivedSet = new Set(archivedTypes ?? [])
  const availableTypes = INSTALLED_BLOCK_TYPES.filter(
    (type) => !archivedSet.has(type)
  )
  const emptyWithNoTypes =
    blocks.length === 0 &&
    archivedTypesQuery.status === "success" &&
    availableTypes.length === 0
  const [expanded, setExpanded] = useState<string | null>(null)
  const [starterType, setStarterType] = useState<BlockType | null>(null)
  const rowSelectedBlockId = useRef<string | null>(null)
  const pointerDisclosureId = useRef<string | null>(null)
  const rowRefs = useRef<Map<string, HTMLDivElement> | null>(null)
  if (rowRefs.current === null) {
    rowRefs.current = new Map()
  }
  const renderBlocks = withUniqueBlockRenderIds(blocks)
  const latest = useRef<BlockBuilderLatest | null>({
    blocks,
    currentLocale,
    onChange,
    onPickerOpenChange,
    generationAvailable: Boolean(generate),
    archivedTypes,
    selectedBlockId,
    onSelectedBlockIdChange,
  })
  const dragBaseline = useRef<{ locale: string; blocks: string } | null>(null)
  // A layout effect, not a passive one: TipTap's onUpdate reads options that
  // are assigned during render, so a keystroke can fire between a commit and
  // its passive effects. The baseline must already be this commit's blocks, or
  // updateBlock refuses a legitimate edit with the "block changed" toast.
  useLayoutEffect(() => {
    latest.current = {
      blocks,
      currentLocale,
      onChange,
      onPickerOpenChange,
      generationAvailable: Boolean(generate),
      archivedTypes,
      selectedBlockId,
      onSelectedBlockIdChange,
    }
    return () => {
      latest.current = null
    }
  }, [
    blocks,
    currentLocale,
    onChange,
    onPickerOpenChange,
    generate,
    archivedTypes,
    selectedBlockId,
    onSelectedBlockIdChange,
  ])

  const { dragHandlers } = useDragReorder((from, to) => {
    const state = latest.current
    const baseline = dragBaseline.current
    if (!state || !baseline) return
    if (
      state.currentLocale !== baseline.locale ||
      JSON.stringify(state.blocks) !== baseline.blocks
    ) {
      toast.error(t("changedDuringEdit"))
      return
    }
    state.onChange(moveItem(repairBlockIds(state.blocks), from, to))
  })

  useEffect(() => {
    const repaired = repairBlockIds(blocks)
    if (repaired !== blocks) onChange(repaired)
  }, [blocks, onChange])

  // Each preview click counts once: a later keyboard or navigation selection
  // of the same block scrolls to it again.
  const handledPreviewClick = useRef<number | null>(null)
  const selectedByPreviewClick = useEffectEvent((blockId?: string | null) => {
    const click = previewClickSelection
    if (!click || click.nonce === handledPreviewClick.current) return false
    handledPreviewClick.current = click.nonce
    return click.blockId === blockId
  })
  useEffect(() => {
    const selectedFromRow = rowSelectedBlockId.current === selectedBlockId
    rowSelectedBlockId.current = null
    // Keep the control under the pointer between focus and click. A click on
    // a preview field keeps the preview under the pointer: the row shows as
    // selected without a scroll. The block button in the preview and
    // navigation selections still bring the whole row into view.
    const selectedFromPreviewClick = selectedByPreviewClick(selectedBlockId)
    if (!selectedBlockId || selectedFromPreviewClick || selectedFromRow) return
    rowRefs.current?.get(selectedBlockId)?.scrollIntoView({
      block: "nearest",
    })
  }, [selectedBlockId])

  useEffect(() => {
    if (!focusedFieldTarget) return
    const row = rowRefs.current?.get(focusedFieldTarget.blockId)
    if (!row) return
    const target = focusedFieldTarget
    const rowNode = row
    let stopReveal = () => {}
    function revealAfterClicks(field: HTMLElement) {
      stopReveal()
      stopReveal = revealAfterPreviewClicks(field)
    }
    function focusField(preferEditableOnly = false) {
      const field = Array.from(
        rowNode.querySelectorAll<HTMLElement>("[data-block-field-path]")
      ).find((node) => node.dataset.blockFieldPath === target.fieldPath)
      if (!field) return false
      const primaryFocusable = field.matches(
        "input, textarea, select, [contenteditable='true']"
      )
        ? field
        : field.querySelector<HTMLElement>(
            "input, textarea, select, [contenteditable='true']"
          )
      if (!primaryFocusable && preferEditableOnly) return false
      if (primaryFocusable) {
        revealAfterClicks(field)
        // A click in the preview names a text spot; a text input or a
        // rich-text editor puts its caret there, or selects the word (double
        // click) or the clicked paragraph (triple click: an input's value, a
        // textarea's line). Anything else keeps its last caret position.
        if (
          target.textOffset === undefined ||
          !(
            placeInputCaret(
              primaryFocusable,
              target.textOffset,
              target.clickCount
            ) ||
            placeRichTextCaret(
              primaryFocusable,
              target.textOffset,
              target.clickCount
            )
          )
        )
          primaryFocusable.focus({ preventScroll: true })
        return true
      }
      // While a lazily loaded editor is still arriving, wait for it rather
      // than settling for a nearby button such as "Write with AI".
      if (field.querySelector("[data-block-field-loading]")) return false
      const focusable = field.matches("button, [tabindex]")
        ? field
        : field.querySelector<HTMLElement>(
            "button:not(:disabled), [tabindex]:not(:disabled)"
          )
      focusable?.focus({ preventScroll: true })
      revealAfterClicks(field)
      return Boolean(focusable) && document.activeElement === focusable
    }

    // Lazily loaded editors (rich text) mount their editable surface only
    // after their code arrives, which can take longer than any fixed delay.
    // Wait for it to appear instead, but give up after a cap or as soon as
    // the user interacts, so focus never jumps away from what they chose.
    let observer: MutationObserver | null = null
    let giveUp: number | undefined
    function stopWaiting() {
      observer?.disconnect()
      observer = null
      window.clearTimeout(giveUp)
      document.removeEventListener("pointerdown", stopWaiting, true)
      document.removeEventListener("keydown", stopWaiting, true)
      document.removeEventListener("focusin", stopWaiting, true)
      document.removeEventListener("wheel", stopWaiting, true)
    }
    const frame = requestAnimationFrame(() => {
      if (focusField()) return
      observer = new MutationObserver(() => {
        if (focusField(true)) stopWaiting()
      })
      observer.observe(rowNode, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["contenteditable"],
      })
      giveUp = window.setTimeout(stopWaiting, FOCUS_WAIT_LIMIT_MS)
      document.addEventListener("pointerdown", stopWaiting, true)
      document.addEventListener("keydown", stopWaiting, true)
      document.addEventListener("focusin", stopWaiting, true)
      document.addEventListener("wheel", stopWaiting, {
        capture: true,
        passive: true,
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      stopWaiting()
      stopReveal()
    }
  }, [focusedFieldTarget])

  useEffect(() => {
    if (!focusedFirstControlTarget) return
    const row = rowRefs.current?.get(focusedFirstControlTarget.blockId)
    if (!row) return
    const rowNode = row
    let stopReveal = () => {}
    const frame = requestAnimationFrame(() => {
      const control = rowNode.querySelector<HTMLElement>(
        "input:not([type='hidden']):not(:disabled):not([disabled]):not([aria-disabled='true']), textarea:not(:disabled):not([disabled]):not([aria-disabled='true']), select:not(:disabled):not([disabled]):not([aria-disabled='true']), [contenteditable='true']:not([disabled]):not([aria-disabled='true']), [role='combobox']:not(:disabled):not([disabled]):not([aria-disabled='true'])"
      )
      // A click on the block in the preview: focus at once, scroll only
      // after the click sequence, so nothing moves under the pointer.
      const focused = control ?? rowNode
      focused.focus({ preventScroll: true })
      stopReveal = revealAfterPreviewClicks(focused)
    })
    return () => {
      cancelAnimationFrame(frame)
      stopReveal()
    }
  }, [focusedFirstControlTarget])

  function selectBlock(blockId: string | null, fromRow = false) {
    rowSelectedBlockId.current =
      fromRow && blockId !== selectedBlockId ? blockId : null
    onSelectedBlockIdChange?.(blockId)
  }

  function addBlock(type: BlockType) {
    // Seed every newly-added block with the descriptor's sample content (the
    // same data the thumbnail/sim renders), so an editor never lands on an
    // empty checkerboard — handoff Track 1. Editors override from there.
    const block = createSampleBlock(type)
    onChange([...repairBlockIds(blocks), block])
    setExpanded(readBlock(block).id)
    selectBlock(readBlock(block).id)
    onPickerOpenChange(false)
  }

  async function addStarterBlock(type: BlockType) {
    if (!generate || starterType) return
    const meta = readBlockMetadata(type)
    const metaLabel = meta?.label ?? type
    setStarterType(type)
    await runStarterBlockGeneration({
      generate,
      type,
      metaLabel,
      latest,
      currentLocale,
      setExpanded,
      setStarterType,
      changedDuringEditMessage: t("changedDuringEdit"),
      starterFailedMessage: t("starterFailed"),
    })
  }

  function updateBlock(previous: Block, next: Block) {
    const baseline = captureBlockOccurrence(
      [previous],
      currentLocale,
      readBlock(previous).id
    )
    const state = latest.current
    const current =
      state &&
      baseline &&
      currentBlockOccurrence(state.blocks, state.currentLocale, baseline)
    if (!state || !current) {
      toast.error(t("changedDuringEdit"))
      return
    }
    state.onChange(
      state.blocks.map((block) =>
        block === current
          ? Object.assign({}, next, { id: readBlock(current).id })
          : block
      )
    )
  }

  async function removeBlock(index: number) {
    const block = renderBlocks[index]
    const baseline = captureBlockOccurrence(
      blocks,
      currentLocale,
      readBlock(block).id
    )
    if (!baseline) {
      toast.error(t("removeUnavailable"))
      return
    }
    const label =
      adminBlockMetadata(readBlock(block).type, tMetadata)?.label ??
      readBlock(block).type
    const locale = currentLocale?.toUpperCase() ?? t("thisLocale")
    const ok = await confirm({
      title: t("removeConfirm.title", { label, locale }),
      description: t("removeConfirm.description"),
      confirmText: t("removeConfirm.action"),
      destructive: true,
    })
    if (!ok) return
    const state = latest.current
    if (!state) {
      toast.error(t("removeUnavailable"))
      return
    }
    const current = currentBlockOccurrence(
      state.blocks,
      state.currentLocale,
      baseline
    )
    if (!current) {
      toast.error(t("changedDuringEdit"))
      return
    }
    state.onChange(state.blocks.filter((block) => block !== current))
    if (state.selectedBlockId === readBlock(current).id)
      state.onSelectedBlockIdChange?.(null)
  }

  return (
    <div className="space-y-3" data-preview-sidebar>
      {blocks.length === 0 && title && (
        <h3 className="text-[1.75rem] leading-tight font-semibold tracking-tight break-words">
          {title}
        </h3>
      )}
      {emptyWithNoTypes && (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      )}

      {renderBlocks.map((block, i) => {
        // A retired/renamed block type may still be stored on the page; fall
        // back to a generic label + icon so the row (and its remove control)
        // still renders instead of crashing the whole builder.
        const meta = adminBlockMetadata(readBlock(block).type, tMetadata)
        const Icon = meta?.icon ?? AlertTriangle
        const label = meta?.label ?? readBlock(block).type
        const sectionName = t("sectionName", { label, position: i + 1 })
        const regionId = `${sectionRegionsId}-${readBlock(block).id}`
        const selected = selectedBlockId === readBlock(block).id
        const isOpen = expanded === readBlock(block).id || selected
        const disabled = readBlock(block).enabled === false
        const drag = dragHandlers(i)
        return (
          <div
            key={`${currentLocale}:${readBlock(block).id}`}
            ref={(node) => {
              if (node) rowRefs.current?.set(readBlock(block).id, node)
              else rowRefs.current?.delete(readBlock(block).id)
            }}
            tabIndex={-1}
            onClickCapture={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest(
                  "[data-block-reorder], [data-block-disclosure]"
                )
              )
                return
              selectBlock(readBlock(block).id, true)
            }}
            onFocusCapture={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("[data-block-reorder]")
              )
                return
              // Pointer focus precedes click. Let the disclosure click decide
              // its state; keyboard focus still selects and opens the row.
              if (pointerDisclosureId.current === readBlock(block).id) return
              selectBlock(readBlock(block).id, true)
            }}
            // No `overflow-hidden` here: it would clip the rich-text editor's
            // sticky toolbar, preventing it from pinning to the top of the
            // scroll container while editing a long block.
            className={`rounded-lg border bg-card transition-[border-color,box-shadow] ${
              selected ? "border-primary/60 ring-2 ring-primary/15" : ""
            }`}
          >
            <div
              {...drag}
              onDragStart={() => {
                dragBaseline.current = {
                  locale: currentLocale,
                  blocks: JSON.stringify(blocks),
                }
                drag.onDragStart()
              }}
              onDrop={() => {
                drag.onDrop()
                dragBaseline.current = null
              }}
              onDragEnd={() => {
                drag.onDragEnd()
                dragBaseline.current = null
              }}
              className={`flex flex-wrap items-center gap-2 p-3 ${disabled ? "opacity-60" : ""}`}
            >
              <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" />
              <button
                type="button"
                data-block-disclosure=""
                onPointerDown={() => {
                  pointerDisclosureId.current = readBlock(block).id
                }}
                onPointerCancel={() => {
                  pointerDisclosureId.current = null
                }}
                onBlur={() => {
                  if (pointerDisclosureId.current === readBlock(block).id)
                    pointerDisclosureId.current = null
                }}
                onClick={() => {
                  pointerDisclosureId.current = null
                  const shouldCollapse = isOpen && selected
                  selectBlock(shouldCollapse ? null : readBlock(block).id, true)
                  setExpanded(shouldCollapse ? null : readBlock(block).id)
                }}
                aria-expanded={isOpen}
                aria-controls={regionId}
                className="flex min-w-[150px] flex-1 items-center gap-2 text-left"
              >
                {isOpen ? (
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                )}
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium">{label}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {i + 1}
                </span>
              </button>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    onChange(moveItem(repairBlockIds(blocks), i, i - 1))
                  }
                  disabled={i === 0}
                  data-block-reorder=""
                  aria-label={t("moveUp", { label: sectionName })}
                  className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ArrowUp className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onChange(moveItem(repairBlockIds(blocks), i, i + 1))
                  }
                  disabled={i === renderBlocks.length - 1}
                  data-block-reorder=""
                  aria-label={t("moveDown", { label: sectionName })}
                  className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ArrowDown className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateBlock(
                      block,
                      Object.assign({}, block, { enabled: disabled })
                    )
                  }
                  aria-label={t(disabled ? "enableNamed" : "disableNamed", {
                    label: sectionName,
                  })}
                  title={disabled ? t("enable") : t("disable")}
                  className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  {disabled ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => removeBlock(i)}
                  aria-label={t("removeNamed", { label: sectionName })}
                  title={t("remove")}
                  className="rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
            <div id={regionId} className="border-t p-4" hidden={!isOpen}>
              {isOpen && (
                <ImageFieldLocaleProvider locale={currentLocale}>
                  <BlockEditor
                    block={block}
                    onChange={(next) => updateBlock(block, next)}
                    locale={currentLocale}
                    // Cross-locale correspondence by *ordinal among same type*: the
                    // Nth block of a type here maps to the Nth block of that type in
                    // the source. Plain index breaks on independently-authored pages
                    // (e.g. a source locale with an extra leading block of another
                    // type); ordinal survives that. No same-type peer → undefined,
                    // which correctly hides per-field translation.
                    sourceBlock={nthOfTypeInSource(blocks, sourceBlocks, i)}
                    translate={translate}
                    generate={generate}
                    presentationCatalog={presentationCatalog}
                    presentationContext={{
                      pageId,
                      contentEpoch,
                      pageTitle: title,
                      occurrenceLabel: `${label} #${blocks.slice(0, i + 1).filter((peer) => readBlock(peer).type === readBlock(block).type).length}`,
                      locale: currentLocale,
                      otherLocales,
                    }}
                  />
                </ImageFieldLocaleProvider>
              )}
            </div>
          </div>
        )
      })}

      {/* Type picker */}
      {(pickerOpen || blocks.length === 0) && !emptyWithNoTypes ? (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{t("chooseType")}</p>
            {blocks.length > 0 && (
              <button
                type="button"
                onClick={() => onPickerOpenChange(false)}
                className="text-xs text-muted-foreground hover:underline"
              >
                {t("cancel")}
              </button>
            )}
          </div>
          {archivedTypesQuery.status === "pending" && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-md bg-muted/50 p-3 text-sm text-muted-foreground"
            >
              <Loader2 className="size-4 animate-spin" />
              {t("checkingTypes")}
            </div>
          )}
          {archivedTypesQuery.status === "error" && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{t("typesUnavailable")}</span>
            </div>
          )}
          <div className="space-y-4">
            {BLOCK_GROUPS.map((group) => {
              if (archivedTypesQuery.status !== "success") return null
              const types = availableTypes.filter(
                (type) => readBlockMetadata(type)?.group === group.id
              )
              if (types.length === 0) return null
              return (
                <div key={group.id} className="space-y-2">
                  <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {adminBlockGroupLabel(group.id, group.label, tMetadata)}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {types.map((type) => {
                      const meta = adminBlockMetadata(type, tMetadata)
                      const Icon = meta?.icon ?? AlertTriangle
                      const label = meta?.label ?? type
                      return (
                        <div
                          key={type}
                          className="flex flex-col items-stretch gap-2 rounded-md border p-2 text-left transition-colors hover:border-ring hover:bg-accent/50"
                        >
                          <div className="relative aspect-[16/9] overflow-hidden rounded-sm border bg-muted">
                            <Image
                              src={`/block-sim/${type}.png`}
                              alt=""
                              fill
                              sizes="(min-width: 640px) 50vw, 100vw"
                              // Skip next/image optimization: these PNGs are already
                              // sized for the tile (2048×1152 @ 2x dpr). Letting Next
                              // re-encode/downsample softens text.
                              unoptimized
                              className="object-contain"
                              // Thumbnails are best-effort. If the capture script hasn't
                              // been run yet, hide the broken image and let the caption
                              // carry the picker.
                              onError={(e) => {
                                e.currentTarget.style.visibility = "hidden"
                              }}
                            />
                          </div>
                          <div className="flex items-start gap-2 px-1 pb-1">
                            <Icon
                              aria-hidden
                              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                            />
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">
                                {label}
                              </div>
                              <div className="line-clamp-2 text-xs text-muted-foreground">
                                {meta?.description ?? ""}
                              </div>
                            </div>
                          </div>
                          <div
                            className={`grid gap-2 px-1 pb-1 ${generate ? "grid-cols-2" : "grid-cols-1"}`}
                          >
                            <button
                              type="button"
                              aria-label={`${t("sample")} — ${label}`}
                              onClick={() => addBlock(type)}
                              disabled={starterType !== null}
                              className="inline-flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Plus aria-hidden className="size-3.5" />
                              {t("sample")}
                            </button>
                            {generate && (
                              <button
                                type="button"
                                aria-label={`${t("starter")} — ${label}`}
                                onClick={() => addStarterBlock(type)}
                                disabled={starterType !== null}
                                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {starterType === type ? (
                                  <Loader2
                                    aria-hidden
                                    className="size-3.5 animate-spin"
                                  />
                                ) : (
                                  <WandSparkles
                                    aria-hidden
                                    className="size-3.5"
                                  />
                                )}
                                {t("starter")}
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        blocks.length > 0 && (
          <button
            type="button"
            onClick={() => onPickerOpenChange(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50"
          >
            <Plus className="size-3.5" />
            {t("add")}
          </button>
        )
      )}
    </div>
  )
}
