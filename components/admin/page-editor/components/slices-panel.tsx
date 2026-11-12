import type { Slice } from "@/convex/lib/slices"
import type { SlicePresentationCatalog } from "@/convex/lib/slices/presentationResolution"
import { useTranslations } from "next-intl"
import type { Locale } from "@/lib/i18n/config"
import { SliceBuilder } from "../../slice-builder"
import { PageLivePreview } from "../../page-live-preview"
import type {
  PreviewActiveEditHandle,
  PreviewFieldSelection,
  PreviewInlineActivationResult,
  PreviewInlineRefusalReason,
  PreviewInlineEditCommit,
  SliceFieldFocusTarget,
  SliceFirstControlFocusTarget,
} from "../../visual-editing-types"
import type { FieldGenerate, FieldTranslate } from "../../fields/field-editor"

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
  sourceSlices: Slice[]
  fieldTranslate: FieldTranslate | undefined
  fieldGenerate: FieldGenerate | undefined
  slicePickerOpen: boolean
  selectedSliceId: string | null
  focusedFieldTarget: SliceFieldFocusTarget | null
  focusedFirstControlTarget: SliceFirstControlFocusTarget | null
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
  sourceSlices,
  fieldTranslate,
  fieldGenerate,
  slicePickerOpen,
  selectedSliceId,
  focusedFieldTarget,
  focusedFirstControlTarget,
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
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {
          <section className="min-w-0 space-y-3">
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
              onSelectedSliceIdChange={onSelectedSliceIdChange}
              archiveStateVerificationFailure={archiveStateVerificationFailure}
              presentationCatalog={presentationCatalog}
            />
          </section>
        }
        <aside
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
            locale={currentLocale}
            defaultLocale={defaultLocale}
            selectedSliceId={selectedSliceId}
            onSelectSlice={onPreviewSelectSlice}
            onSelectSliceFallback={onPreviewSelectSliceFallback}
            onSelectField={onPreviewSelectField}
            onInlineEditCommit={onPreviewInlineEditCommit}
            onActiveEditHandleChange={onPreviewActiveEditHandleChange}
            onActiveEditChange={onPreviewActiveEditChange}
            onActiveEditConflict={onPreviewActiveEditConflict}
            onInlineEditingEnabledChange={onPreviewInlineEditingEnabledChange}
            onSave={onSave}
            onOpenSavedPreview={onOpenSavedPreview}
          />
        </aside>
      </div>
    </div>
  )
}
