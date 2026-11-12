import type { Buffered } from "./publication-base"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import type { FunctionReturnType } from "convex/server"
import type { PrePublishChecklistParams } from "@/convex/lib/publishing/checklist"
import { type Slice } from "@/convex/lib/slices"
import { type Locale } from "@/lib/i18n/config"

// Re-exported: the editor's own modules and tests treat this file as the
// page-editor type surface and import `Slice` from here.
export type { Slice }

/**
 * The page shape the editor consumes. Wraps `Doc<"pages">` with the
 * staged-overlay `scheduledAt` that `pages.getForEdit` folds in via
 * `overlayStagingOnPage` (ADR-0041 Deploy 2 PR B). The editor no longer
 * reads or writes it (FR2c row C); it stays as a compatibility field.
 */
export type Page = Doc<"pages"> & { scheduledAt?: number }
/**
 * Lightweight page row for the parent picker. `listSummaries` returns titles
 * already resolved per locale, so consumers read `localizedTitles` rather than
 * reaching into `content` — the full document is deliberately never sent.
 */
export type PageSummaryRow = FunctionReturnType<
  typeof api.cms.pages.listSummaries
>[number]
export type ActivePanel = "slices" | "seo" | "settings" | "history"
export type TranslateMode = "translate" | "copy"
export type { PrePublishChecklistParams } from "@/convex/lib/publishing/checklist"

export type PrePublishChecklistItem = {
  code: string
  severity: "blocker" | "warning"
  message: string
  params?: PrePublishChecklistParams
  field?: string
  locales?: string[]
}
export type PrePublishChecklist = {
  canPublish: boolean
  blockers: PrePublishChecklistItem[]
  warnings: PrePublishChecklistItem[]
}
export type LocaleContentSummary = {
  hasAny: boolean
  hasTranslatable: boolean
}
export type LocaleDraft = Buffered<{
  removedTitleLinks?: import("@/convex/lib/richtext/write").TitleWriteReport[]
  title: string
  slug: string
  slugLinked: boolean
  addressWasTyped?: boolean
  metaTitle: string
  metaDescription: string
  slices: Slice[]
  /** Descriptor-localized fields cached with the system-owned page fields. */
  localizedFieldValues: Record<string, unknown>
}>
export type PageEditorRecoveryDraft = {
  /** Optional on read for pre-base v3 payloads; null denotes legacy authority. */
  base?: import("./publication-base").RecoveryBase | null
  removedTitleLinks?: import("@/convex/lib/richtext/write").TitleWriteReport[]
  inlineConflicts?: import("../../visual-editing-types").PreviewInlineEditCommit[]
  /** Schema version — bumped when the payload shape changes so stale
   *  localStorage payloads are ignored instead of restoring silently
   *  incomplete state. See `lib/recovery.ts` for the current version. */
  version?: number
  savedAt: number
  locale: Locale
  title: string
  slug: string
  slugLinked?: boolean
  addressWasTyped?: boolean
  pageType: Page["pageType"]
  parentId: string
  authorIds: Id<"pages">[]
  tags: string[]
  metaTitle: string
  metaDescription: string
  slices: Slice[]
  seoNoIndex: boolean
  seoNoFollow: boolean
  seoOgTitle: string
  seoOgDescription: string
  seoOgImage: string
  /** Descriptor-generic field bags — plan 029 C8. Populated for every
   *  descriptor field the generic Content panel renders (author roleTitle
   *  / bio today, more as descriptors grow). `sharedFieldValues` covers
   *  non-system-owned shared fields; `localizedFieldValues` covers
   *  non-system-owned localized fields per the active locale. */
  sharedFieldValues: Record<string, unknown>
  localizedFieldValues: Record<string, unknown>
}

export const staleSaveMessage =
  "This page changed since you opened it. Reload before saving, or save your current draft as a copy."
