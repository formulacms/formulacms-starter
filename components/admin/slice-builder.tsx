"use client"

import { readSliceMetadata } from "@/lib/slices/builder"
import { readSlice } from "@/convex/lib/slices/identity"

import {
  adminSliceMetadata,
  adminSliceGroupLabel,
} from "@/lib/i18n/admin-metadata"

import { useEffect, useLayoutEffect, useId, useRef, useState } from "react"
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
import type { Slice } from "@/convex/lib/slices"
import { INSTALLED_SLICE_TYPES } from "@/convex/lib/slices"
import type { SlicePresentationCatalog } from "@/convex/lib/slices/presentationResolution"
import {
  repairSliceIds,
  withUniqueSliceRenderIds,
} from "@/convex/lib/slices/identity"
import { SLICE_GROUPS, type SliceType } from "@/lib/slices/builder"
import { createSampleSlice } from "@/lib/slices/sample"
import { useDragReorder, moveItem } from "@/lib/use-drag-reorder"
import { useConfirm } from "@/components/providers/confirm-provider"
import { SliceEditor } from "./slice-editor"
import { PageSaveRefusedError } from "@/components/admin/page-editor/lib/page-save-refused-error"
import type { FieldTranslate, FieldGenerate } from "./fields/field-editor"
import { ImageFieldLocaleProvider } from "./fields/image-field-editor"
import type {
  SliceFieldFocusTarget,
  SliceFirstControlFocusTarget,
} from "./visual-editing-types"
import {
  captureSliceOccurrence,
  currentSliceOccurrence,
} from "./page-editor/lib/slice-occurrence"

// How long a field selected from the preview may wait for a lazily loaded
// editor before focus is abandoned.
const FOCUS_WAIT_LIMIT_MS = 5_000

/**
 * Resolve the source-locale slice that corresponds to `slices[index]` by ordinal
 * among slices of the same type: the k-th slice of its type here maps to the k-th
 * slice of that type in `sourceSlices`. Returns undefined when the source has no
 * such peer (different structure), which hides per-field translation for it.
 */
function nthOfTypeInSource(
  slices: Slice[],
  sourceSlices: Slice[] | undefined,
  index: number
): Slice | undefined {
  if (!sourceSlices) return undefined
  const type = readSlice(slices[index]).type
  const ordinal = slices
    .slice(0, index)
    .filter((s) => readSlice(s).type === type).length
  let seen = 0
  for (const s of sourceSlices) {
    if (readSlice(s).type === type) {
      if (seen === ordinal) return s
      seen += 1
    }
  }
  return undefined
}

type SliceBuilderLatest = {
  slices: Slice[]
  currentLocale: string
  onChange: (next: Slice[]) => void
  onPickerOpenChange: (open: boolean) => void
  generationAvailable: boolean
  archivedTypes: readonly string[] | null
  selectedSliceId?: string | null
  onSelectedSliceIdChange?: (sliceId: string | null) => void
}

/**
 * The try/catch/finally of "generate a starter slice". Module-level so the
 * component body has no `finally` clause: React Compiler 1.0.0 skips whole
 * components containing one (react/react#34131). Behaviour is unchanged.
 */
async function runStarterSliceGeneration({
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
  type: SliceType
  metaLabel: string
  latest: { current: SliceBuilderLatest | null }
  currentLocale: string
  setExpanded: (sliceId: string | null) => void
  setStarterType: (type: SliceType | null) => void
  changedDuringEditMessage: string
  starterFailedMessage: string
}): Promise<void> {
  try {
    const slice = await generate.runSlice(
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
    state.onChange([...repairSliceIds(state.slices), slice])
    setExpanded(readSlice(slice).id)
    state.onSelectedSliceIdChange?.(readSlice(slice).id)
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

export function SliceBuilder({
  title,
  pageId,
  contentEpoch,
  otherLocales,
  slices,
  onChange,
  currentLocale,
  sourceSlices,
  translate,
  generate,
  pickerOpen,
  onPickerOpenChange,
  selectedSliceId,
  focusedFieldTarget,
  focusedFirstControlTarget,
  onSelectedSliceIdChange,
  archiveStateVerificationFailure = false,
  presentationCatalog,
}: {
  title?: string
  pageId?: string
  contentEpoch?: number
  otherLocales?: readonly string[]
  slices: Slice[]
  onChange: (next: Slice[]) => void
  currentLocale: string
  /** Source-locale slices for per-field translation; matched by index + type. */
  sourceSlices?: Slice[]
  translate?: FieldTranslate
  generate?: FieldGenerate
  pickerOpen: boolean
  onPickerOpenChange: (open: boolean) => void
  selectedSliceId?: string | null
  focusedFieldTarget?: SliceFieldFocusTarget | null
  focusedFirstControlTarget?: SliceFirstControlFocusTarget | null
  onSelectedSliceIdChange?: (sliceId: string | null) => void
  archiveStateVerificationFailure?: boolean
  presentationCatalog?: SlicePresentationCatalog
}) {
  const sectionRegionsId = useId()
  const t = useTranslations("editor.sliceBuilder")
  const tMetadata = useTranslations("metadata")
  const confirm = useConfirm()
  // Archived slice types are retired from the picker (curation, not deletion).
  const observedArchivedTypesQuery = useQuery_experimental({
    query: api.cms.slices.getArchivedSliceTypes,
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
  const availableTypes = INSTALLED_SLICE_TYPES.filter(
    (type) => !archivedSet.has(type)
  )
  const emptyWithNoTypes =
    slices.length === 0 &&
    archivedTypesQuery.status === "success" &&
    availableTypes.length === 0
  const [expanded, setExpanded] = useState<string | null>(null)
  const [starterType, setStarterType] = useState<SliceType | null>(null)
  const rowSelectedSliceId = useRef<string | null>(null)
  const pointerDisclosureId = useRef<string | null>(null)
  const rowRefs = useRef<Map<string, HTMLDivElement> | null>(null)
  if (rowRefs.current === null) {
    rowRefs.current = new Map()
  }
  const renderSlices = withUniqueSliceRenderIds(slices)
  const latest = useRef<SliceBuilderLatest | null>({
    slices,
    currentLocale,
    onChange,
    onPickerOpenChange,
    generationAvailable: Boolean(generate),
    archivedTypes,
    selectedSliceId,
    onSelectedSliceIdChange,
  })
  const dragBaseline = useRef<{ locale: string; slices: string } | null>(null)
  // A layout effect, not a passive one: TipTap's onUpdate reads options that
  // are assigned during render, so a keystroke can fire between a commit and
  // its passive effects. The baseline must already be this commit's slices, or
  // updateSlice refuses a legitimate edit with the "slice changed" toast.
  useLayoutEffect(() => {
    latest.current = {
      slices,
      currentLocale,
      onChange,
      onPickerOpenChange,
      generationAvailable: Boolean(generate),
      archivedTypes,
      selectedSliceId,
      onSelectedSliceIdChange,
    }
    return () => {
      latest.current = null
    }
  }, [
    slices,
    currentLocale,
    onChange,
    onPickerOpenChange,
    generate,
    archivedTypes,
    selectedSliceId,
    onSelectedSliceIdChange,
  ])

  const { dragHandlers } = useDragReorder((from, to) => {
    const state = latest.current
    const baseline = dragBaseline.current
    if (!state || !baseline) return
    if (
      state.currentLocale !== baseline.locale ||
      JSON.stringify(state.slices) !== baseline.slices
    ) {
      toast.error(t("changedDuringEdit"))
      return
    }
    state.onChange(moveItem(repairSliceIds(state.slices), from, to))
  })

  useEffect(() => {
    const repaired = repairSliceIds(slices)
    if (repaired !== slices) onChange(repaired)
  }, [slices, onChange])

  useEffect(() => {
    const selectedFromRow = rowSelectedSliceId.current === selectedSliceId
    rowSelectedSliceId.current = null
    // Keep the control under the pointer between focus and click. Preview and
    // navigation selections still bring the whole row into view.
    if (selectedFromRow) return
    if (!selectedSliceId) return
    rowRefs.current?.get(selectedSliceId)?.scrollIntoView({
      block: "nearest",
    })
  }, [selectedSliceId])

  useEffect(() => {
    if (!focusedFieldTarget) return
    const row = rowRefs.current?.get(focusedFieldTarget.sliceId)
    if (!row) return
    const target = focusedFieldTarget
    const rowNode = row
    function focusField(preferEditableOnly = false) {
      const field = Array.from(
        rowNode.querySelectorAll<HTMLElement>("[data-slice-field-path]")
      ).find((node) => node.dataset.sliceFieldPath === target.fieldPath)
      if (!field) return false
      const primaryFocusable = field.matches(
        "input, textarea, select, [contenteditable='true']"
      )
        ? field
        : field.querySelector<HTMLElement>(
            "input, textarea, select, [contenteditable='true']"
          )
      if (!primaryFocusable && preferEditableOnly) return false
      field.scrollIntoView({ block: "center" })
      if (primaryFocusable) {
        primaryFocusable.focus({ preventScroll: true })
        return true
      }
      // While a lazily loaded editor is still arriving, wait for it rather
      // than settling for a nearby button such as "Write with AI".
      if (field.querySelector("[data-slice-field-loading]")) return false
      const focusable = field.matches("button, [tabindex]")
        ? field
        : field.querySelector<HTMLElement>(
            "button:not(:disabled), [tabindex]:not(:disabled)"
          )
      focusable?.focus({ preventScroll: true })
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
    }
  }, [focusedFieldTarget])

  useEffect(() => {
    if (!focusedFirstControlTarget) return
    const row = rowRefs.current?.get(focusedFirstControlTarget.sliceId)
    if (!row) return
    const rowNode = row
    const frame = requestAnimationFrame(() => {
      const control = rowNode.querySelector<HTMLElement>(
        "input:not([type='hidden']):not(:disabled):not([disabled]):not([aria-disabled='true']), textarea:not(:disabled):not([disabled]):not([aria-disabled='true']), select:not(:disabled):not([disabled]):not([aria-disabled='true']), [contenteditable='true']:not([disabled]):not([aria-disabled='true']), [role='combobox']:not(:disabled):not([disabled]):not([aria-disabled='true'])"
      )
      control?.scrollIntoView({ block: "center" })
      if (control) control.focus({ preventScroll: true })
      else rowNode.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusedFirstControlTarget])

  function selectSlice(sliceId: string | null, fromRow = false) {
    rowSelectedSliceId.current =
      fromRow && sliceId !== selectedSliceId ? sliceId : null
    onSelectedSliceIdChange?.(sliceId)
  }

  function addSlice(type: SliceType) {
    // Seed every newly-added slice with the descriptor's sample content (the
    // same data the thumbnail/sim renders), so an editor never lands on an
    // empty checkerboard — handoff Track 1. Editors override from there.
    const slice = createSampleSlice(type)
    onChange([...repairSliceIds(slices), slice])
    setExpanded(readSlice(slice).id)
    selectSlice(readSlice(slice).id)
    onPickerOpenChange(false)
  }

  async function addStarterSlice(type: SliceType) {
    if (!generate || starterType) return
    const meta = readSliceMetadata(type)
    const metaLabel = meta?.label ?? type
    setStarterType(type)
    await runStarterSliceGeneration({
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

  function updateSlice(previous: Slice, next: Slice) {
    const baseline = captureSliceOccurrence(
      [previous],
      currentLocale,
      readSlice(previous).id
    )
    const state = latest.current
    const current =
      state &&
      baseline &&
      currentSliceOccurrence(state.slices, state.currentLocale, baseline)
    if (!state || !current) {
      toast.error(t("changedDuringEdit"))
      return
    }
    state.onChange(
      state.slices.map((slice) =>
        slice === current
          ? Object.assign({}, next, { id: readSlice(current).id })
          : slice
      )
    )
  }

  async function removeSlice(index: number) {
    const slice = renderSlices[index]
    const baseline = captureSliceOccurrence(
      slices,
      currentLocale,
      readSlice(slice).id
    )
    if (!baseline) {
      toast.error(t("removeUnavailable"))
      return
    }
    const label =
      adminSliceMetadata(readSlice(slice).type, tMetadata)?.label ??
      readSlice(slice).type
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
    const current = currentSliceOccurrence(
      state.slices,
      state.currentLocale,
      baseline
    )
    if (!current) {
      toast.error(t("changedDuringEdit"))
      return
    }
    state.onChange(state.slices.filter((slice) => slice !== current))
    if (state.selectedSliceId === readSlice(current).id)
      state.onSelectedSliceIdChange?.(null)
  }

  return (
    <div className="space-y-3" data-preview-sidebar>
      {slices.length === 0 && title && (
        <h3 className="text-[1.75rem] leading-tight font-semibold tracking-tight break-words">
          {title}
        </h3>
      )}
      {emptyWithNoTypes && (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      )}

      {renderSlices.map((slice, i) => {
        // A retired/renamed slice type may still be stored on the page; fall
        // back to a generic label + icon so the row (and its remove control)
        // still renders instead of crashing the whole builder.
        const meta = adminSliceMetadata(readSlice(slice).type, tMetadata)
        const Icon = meta?.icon ?? AlertTriangle
        const label = meta?.label ?? readSlice(slice).type
        const sectionName = t("sectionName", { label, position: i + 1 })
        const regionId = `${sectionRegionsId}-${readSlice(slice).id}`
        const selected = selectedSliceId === readSlice(slice).id
        const isOpen = expanded === readSlice(slice).id || selected
        const disabled = readSlice(slice).enabled === false
        const drag = dragHandlers(i)
        return (
          <div
            key={`${currentLocale}:${readSlice(slice).id}`}
            ref={(node) => {
              if (node) rowRefs.current?.set(readSlice(slice).id, node)
              else rowRefs.current?.delete(readSlice(slice).id)
            }}
            tabIndex={-1}
            onClickCapture={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest(
                  "[data-slice-reorder], [data-slice-disclosure]"
                )
              )
                return
              selectSlice(readSlice(slice).id, true)
            }}
            onFocusCapture={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("[data-slice-reorder]")
              )
                return
              // Pointer focus precedes click. Let the disclosure click decide
              // its state; keyboard focus still selects and opens the row.
              if (pointerDisclosureId.current === readSlice(slice).id) return
              selectSlice(readSlice(slice).id, true)
            }}
            // No `overflow-hidden` here: it would clip the rich-text editor's
            // sticky toolbar, preventing it from pinning to the top of the
            // scroll container while editing a long slice.
            className={`rounded-lg border bg-card transition-[border-color,box-shadow] ${
              selected ? "border-primary/60 ring-2 ring-primary/15" : ""
            }`}
          >
            <div
              {...drag}
              onDragStart={() => {
                dragBaseline.current = {
                  locale: currentLocale,
                  slices: JSON.stringify(slices),
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
                data-slice-disclosure=""
                onPointerDown={() => {
                  pointerDisclosureId.current = readSlice(slice).id
                }}
                onPointerCancel={() => {
                  pointerDisclosureId.current = null
                }}
                onBlur={() => {
                  if (pointerDisclosureId.current === readSlice(slice).id)
                    pointerDisclosureId.current = null
                }}
                onClick={() => {
                  pointerDisclosureId.current = null
                  const shouldCollapse = isOpen && selected
                  selectSlice(shouldCollapse ? null : readSlice(slice).id, true)
                  setExpanded(shouldCollapse ? null : readSlice(slice).id)
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
                    onChange(moveItem(repairSliceIds(slices), i, i - 1))
                  }
                  disabled={i === 0}
                  data-slice-reorder=""
                  aria-label={t("moveUp", { label: sectionName })}
                  className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ArrowUp className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onChange(moveItem(repairSliceIds(slices), i, i + 1))
                  }
                  disabled={i === renderSlices.length - 1}
                  data-slice-reorder=""
                  aria-label={t("moveDown", { label: sectionName })}
                  className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ArrowDown className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateSlice(
                      slice,
                      Object.assign({}, slice, { enabled: disabled })
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
                  onClick={() => removeSlice(i)}
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
                  <SliceEditor
                    slice={slice}
                    onChange={(next) => updateSlice(slice, next)}
                    locale={currentLocale}
                    // Cross-locale correspondence by *ordinal among same type*: the
                    // Nth slice of a type here maps to the Nth slice of that type in
                    // the source. Plain index breaks on independently-authored pages
                    // (e.g. a source locale with an extra leading slice of another
                    // type); ordinal survives that. No same-type peer → undefined,
                    // which correctly hides per-field translation.
                    sourceSlice={nthOfTypeInSource(slices, sourceSlices, i)}
                    translate={translate}
                    generate={generate}
                    presentationCatalog={presentationCatalog}
                    presentationContext={{
                      pageId,
                      contentEpoch,
                      pageTitle: title,
                      occurrenceLabel: `${label} #${slices.slice(0, i + 1).filter((peer) => readSlice(peer).type === readSlice(slice).type).length}`,
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
      {(pickerOpen || slices.length === 0) && !emptyWithNoTypes ? (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{t("chooseType")}</p>
            {slices.length > 0 && (
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
            {SLICE_GROUPS.map((group) => {
              if (archivedTypesQuery.status !== "success") return null
              const types = availableTypes.filter(
                (type) => readSliceMetadata(type)?.group === group.id
              )
              if (types.length === 0) return null
              return (
                <div key={group.id} className="space-y-2">
                  <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {adminSliceGroupLabel(group.id, group.label, tMetadata)}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {types.map((type) => {
                      const meta = adminSliceMetadata(type, tMetadata)
                      const Icon = meta?.icon ?? AlertTriangle
                      const label = meta?.label ?? type
                      return (
                        <div
                          key={type}
                          className="flex flex-col items-stretch gap-2 rounded-md border p-2 text-left transition-colors hover:border-ring hover:bg-accent/50"
                        >
                          <div className="relative aspect-[16/9] overflow-hidden rounded-sm border bg-muted">
                            <Image
                              src={`/slice-sim/${type}.png`}
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
                              onClick={() => addSlice(type)}
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
                                onClick={() => addStarterSlice(type)}
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
        slices.length > 0 && (
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
