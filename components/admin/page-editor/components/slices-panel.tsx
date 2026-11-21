import type { Slice } from "@/convex/lib/slices"
import type { SlicePresentationCatalog } from "@/convex/lib/slices/presentationResolution"
import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import type { Locale } from "@/lib/i18n/config"
import { SliceBuilder } from "../../slice-builder"
import { PageLivePreview } from "../../page-live-preview"
import { PREVIEW_CLICK_SETTLE_MS } from "../../rich-text-caret"
import { EditorSplit } from "./editor-split"
import type {
  PreviewActiveEditHandle,
  PreviewFieldSelection,
  PreviewInlineActivationResult,
  PreviewInlineRefusalReason,
  PreviewInlineEditCommit,
  SliceFieldFocusTarget,
  SliceFirstControlFocusTarget,
  SlicePreviewClickSelection,
} from "../../visual-editing-types"
import type { FieldGenerate, FieldTranslate } from "../../fields/field-editor"

/**
 * Keeps a sticky element at its current place on screen until the returned
 * function runs.
 * Its sticky line sits at the content edge of the nearest scrolling ancestor;
 * an offset from that line holds it even when its container grows.
 */
function holdStickyPlace(element: HTMLElement) {
  let line = 0
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.overflowY === "visible" || style.overflowY === "clip") continue
    line =
      node.getBoundingClientRect().top +
      parseFloat(style.borderTopWidth || "0") +
      parseFloat(style.paddingTop || "0")
    break
  }
  element.style.top = `${element.getBoundingClientRect().top - line}px`
  return () => {
    element.style.top = ""
  }
}

type SlicesPanelProps = {
  pageId?: string
  pageType?: string
  languageVersion?: number
  contentEpoch?: number
  draftRevision?: number
  getDraftRevision?(): number
  inlineEditingBlocked?: boolean
  currentLocale: Locale
  defaultLocale: Locale
  title: string
  slices: Slice[]
  sharedFieldValues?: Record<string, unknown>
  localizedFieldValues?: Record<string, unknown>
  authorIds?: string[]
  sourceSlices: Slice[]
  fieldTranslate: FieldTranslate | undefined
  fieldGenerate: FieldGenerate | undefined
  slicePickerOpen: boolean
  selectedSliceId: string | null
  focusedFieldTarget: SliceFieldFocusTarget | null
  focusedFirstControlTarget: SliceFirstControlFocusTarget | null
  previewClickSelection?: SlicePreviewClickSelection | null
  previewInlineRefusal: PreviewInlineRefusalReason | null
  previewInlineEditingEnabled: boolean
  archiveStateVerificationFailure?: boolean
  otherLocales?: readonly string[]
  presentationCatalog?: SlicePresentationCatalog
  onSlicesChange(value: Slice[]): void
  onSlicePickerOpenChange(value: boolean): void
  onSelectedSliceIdChange(value: string | null): void
  onPreviewSelectSlice(value: string): void
  onPreviewSelectSliceFallback(value: string): void
  onPreviewSelectField(
    value: PreviewFieldSelection,
    result?: PreviewInlineActivationResult
  ): void
  onPreviewInlineEditCommit(value: PreviewInlineEditCommit): boolean | void
  onPreviewActiveEditHandleChange?(value: PreviewActiveEditHandle | null): void
  onPreviewActiveEditChange?(value: PreviewInlineEditCommit | null): void
  onPreviewActiveEditConflict?(): void
  onPreviewInlineEditingEnabledChange(value: boolean): void
  onSave(): void
  onOpenSavedPreview(): void
}

export function SlicesPanel({
  pageId,
  pageType,
  languageVersion,
  contentEpoch,
  draftRevision,
  getDraftRevision,
  inlineEditingBlocked,
  currentLocale,
  defaultLocale,
  title,
  slices,
  sharedFieldValues,
  localizedFieldValues,
  authorIds,
  sourceSlices,
  fieldTranslate,
  fieldGenerate,
  slicePickerOpen,
  selectedSliceId,
  focusedFieldTarget,
  focusedFirstControlTarget,
  previewClickSelection,
  previewInlineRefusal,
  previewInlineEditingEnabled,
  archiveStateVerificationFailure = false,
  presentationCatalog,
  otherLocales,
  onSlicesChange,
  onSlicePickerOpenChange,
  onSelectedSliceIdChange,
  onPreviewSelectSlice,
  onPreviewSelectSliceFallback,
  onPreviewSelectField,
  onPreviewInlineEditCommit,
  onPreviewActiveEditHandleChange,
  onPreviewActiveEditChange,
  onPreviewActiveEditConflict,
  onPreviewInlineEditingEnabledChange,
  onSave,
  onOpenSavedPreview,
}: SlicesPanelProps) {
  const t = useTranslations("editor.slicesPanel")
  const previewColumn = useRef<HTMLElement>(null)
  const columnHold = useRef<{ timer?: number; release(): void } | null>(null)
  useEffect(() => () => columnHold.current?.release(), [])

  // A click in the preview opens the block's form, which can make the split
  // view taller. A sticky preview column that had no room to stick would then
  // drop to its sticky line, under the pointer, between the clicks of a
  // double or triple click. It stays where it is until the click sequence is
  // over, or until the owner scrolls.
  function holdPreviewColumn() {
    const column = previewColumn.current
    if (!column) return
    if (!columnHold.current) {
      if (getComputedStyle(column).position !== "sticky") return
      const unhold = holdStickyPlace(column)
      const hold: { timer?: number; release(): void } = {
        release() {
          window.clearTimeout(hold.timer)
          document.removeEventListener("wheel", hold.release, true)
          columnHold.current = null
          unhold()
        },
      }
      columnHold.current = hold
      document.addEventListener("wheel", hold.release, {
        capture: true,
        passive: true,
      })
    }
    const hold = columnHold.current
    window.clearTimeout(hold.timer)
    hold.timer = window.setTimeout(hold.release, PREVIEW_CLICK_SETTLE_MS)
  }

  return (
    <div className="w-full space-y-4">
      {previewInlineRefusal && (
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          {t(`inlineRefusal.${previewInlineRefusal}`)}
        </p>
      )}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t("heading", { locale: currentLocale.toUpperCase() })}
        </h2>
        <span className="text-xs text-muted-foreground">
          {t("count", { count: slices.length })}
        </span>
      </div>
      <EditorSplit
        blocks={
          <SliceBuilder
            title={title}
            pageId={pageId}
            contentEpoch={contentEpoch}
            otherLocales={otherLocales}
            slices={slices}
            onChange={onSlicesChange}
            currentLocale={currentLocale}
            sourceSlices={sourceSlices}
            translate={fieldTranslate}
            generate={fieldGenerate}
            pickerOpen={slicePickerOpen}
            onPickerOpenChange={onSlicePickerOpenChange}
            selectedSliceId={selectedSliceId}
            focusedFieldTarget={focusedFieldTarget}
            focusedFirstControlTarget={focusedFirstControlTarget}
            previewClickSelection={previewClickSelection}
            onSelectedSliceIdChange={onSelectedSliceIdChange}
            archiveStateVerificationFailure={archiveStateVerificationFailure}
            presentationCatalog={presentationCatalog}
          />
        }
        preview={(hidePreviewButton) => (
          <aside
            ref={previewColumn}
            className={
              previewInlineEditingEnabled
                ? "min-w-0"
                : "min-w-0 xl:sticky xl:top-0"
            }
          >
            <PageLivePreview
              pageId={pageId}
              pageType={pageType}
              languageVersion={languageVersion}
              contentEpoch={contentEpoch}
              draftRevision={draftRevision}
              getDraftRevision={getDraftRevision}
              catalogRevision={presentationCatalog?.revision}
              inlineEditingBlocked={inlineEditingBlocked}
              title={title}
              slices={slices}
              sharedFieldValues={sharedFieldValues}
              localizedFieldValues={localizedFieldValues}
              authorIds={authorIds}
              locale={currentLocale}
              defaultLocale={defaultLocale}
              selectedSliceId={selectedSliceId}
              onSelectSlice={onPreviewSelectSlice}
              onSelectSliceFallback={(sliceId) => {
                holdPreviewColumn()
                onPreviewSelectSliceFallback(sliceId)
              }}
              onSelectField={(...selection) => {
                holdPreviewColumn()
                onPreviewSelectField(...selection)
              }}
              onInlineEditCommit={onPreviewInlineEditCommit}
              onActiveEditHandleChange={onPreviewActiveEditHandleChange}
              onActiveEditChange={onPreviewActiveEditChange}
              onActiveEditConflict={onPreviewActiveEditConflict}
              onInlineEditingEnabledChange={onPreviewInlineEditingEnabledChange}
              onSave={onSave}
              onOpenSavedPreview={onOpenSavedPreview}
              toolbarEnd={hidePreviewButton}
            />
          </aside>
        )}
      />
    </div>
  )
}
