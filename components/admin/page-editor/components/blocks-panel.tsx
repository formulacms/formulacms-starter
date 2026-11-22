import type { Block } from "@/convex/lib/blocks"
import type { BlockPresentationCatalog } from "@/convex/lib/blocks/presentationResolution"
import { useTranslations } from "next-intl"
import type { Locale } from "@/lib/i18n/config"
import { BlockBuilder } from "../../block-builder"
import { PageLivePreview } from "../../page-live-preview"
import { EditorSplit } from "./editor-split"
import type {
  PreviewActiveEditHandle,
  PreviewFieldSelection,
  PreviewInlineActivationResult,
  PreviewInlineRefusalReason,
  PreviewInlineEditCommit,
  BlockFieldFocusTarget,
  BlockFirstControlFocusTarget,
  BlockPreviewClickSelection,
} from "../../visual-editing-types"
import type { FieldGenerate, FieldTranslate } from "../../fields/field-editor"

type BlocksPanelProps = {
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
  blocks: Block[]
  sharedFieldValues?: Record<string, unknown>
  localizedFieldValues?: Record<string, unknown>
  authorIds?: string[]
  sourceBlocks: Block[]
  fieldTranslate: FieldTranslate | undefined
  fieldGenerate: FieldGenerate | undefined
  blockPickerOpen: boolean
  selectedBlockId: string | null
  focusedFieldTarget: BlockFieldFocusTarget | null
  focusedFirstControlTarget: BlockFirstControlFocusTarget | null
  previewClickSelection?: BlockPreviewClickSelection | null
  /** A form-only field shows no notice: the focused form control is the feedback. */
  previewInlineRefusal: Exclude<PreviewInlineRefusalReason, "unsupported"> | null
  archiveStateVerificationFailure?: boolean
  otherLocales?: readonly string[]
  presentationCatalog?: BlockPresentationCatalog
  onBlocksChange(value: Block[]): void
  onBlockPickerOpenChange(value: boolean): void
  onSelectedBlockIdChange(value: string | null): void
  onPreviewSelectBlock(value: string): void
  onPreviewSelectBlockFallback(value: string): void
  onPreviewSelectField(
    value: PreviewFieldSelection,
    result?: PreviewInlineActivationResult
  ): void
  onPreviewInlineEditCommit(value: PreviewInlineEditCommit): boolean | void
  onPreviewActiveEditHandleChange?(value: PreviewActiveEditHandle | null): void
  onPreviewActiveEditChange?(value: PreviewInlineEditCommit | null): void
  onPreviewActiveEditConflict?(): void
  onSave(): void
  onOpenSavedPreview(): void
}

export function BlocksPanel({
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
  blocks,
  sharedFieldValues,
  localizedFieldValues,
  authorIds,
  sourceBlocks,
  fieldTranslate,
  fieldGenerate,
  blockPickerOpen,
  selectedBlockId,
  focusedFieldTarget,
  focusedFirstControlTarget,
  previewClickSelection,
  previewInlineRefusal,
  archiveStateVerificationFailure = false,
  presentationCatalog,
  otherLocales,
  onBlocksChange,
  onBlockPickerOpenChange,
  onSelectedBlockIdChange,
  onPreviewSelectBlock,
  onPreviewSelectBlockFallback,
  onPreviewSelectField,
  onPreviewInlineEditCommit,
  onPreviewActiveEditHandleChange,
  onPreviewActiveEditChange,
  onPreviewActiveEditConflict,
  onSave,
  onOpenSavedPreview,
}: BlocksPanelProps) {
  const t = useTranslations("editor.blocksPanel")
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
          {t("count", { count: blocks.length })}
        </span>
      </div>
      <EditorSplit
        blocks={
          <BlockBuilder
            title={title}
            pageId={pageId}
            contentEpoch={contentEpoch}
            otherLocales={otherLocales}
            blocks={blocks}
            onChange={onBlocksChange}
            currentLocale={currentLocale}
            sourceBlocks={sourceBlocks}
            translate={fieldTranslate}
            generate={fieldGenerate}
            pickerOpen={blockPickerOpen}
            onPickerOpenChange={onBlockPickerOpenChange}
            selectedBlockId={selectedBlockId}
            focusedFieldTarget={focusedFieldTarget}
            focusedFirstControlTarget={focusedFirstControlTarget}
            previewClickSelection={previewClickSelection}
            onSelectedBlockIdChange={onSelectedBlockIdChange}
            archiveStateVerificationFailure={archiveStateVerificationFailure}
            presentationCatalog={presentationCatalog}
          />
        }
        preview={(hidePreviewButton) => (
          <aside className="min-w-0">
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
              blocks={blocks}
              sharedFieldValues={sharedFieldValues}
              localizedFieldValues={localizedFieldValues}
              authorIds={authorIds}
              locale={currentLocale}
              defaultLocale={defaultLocale}
              selectedBlockId={selectedBlockId}
              onSelectBlock={onPreviewSelectBlock}
              onSelectBlockFallback={onPreviewSelectBlockFallback}
              onSelectField={onPreviewSelectField}
              onInlineEditCommit={onPreviewInlineEditCommit}
              onActiveEditHandleChange={onPreviewActiveEditHandleChange}
              onActiveEditChange={onPreviewActiveEditChange}
              onActiveEditConflict={onPreviewActiveEditConflict}
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
