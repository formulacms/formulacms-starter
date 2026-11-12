import type { ComponentType, ReactNode } from "react"
import { PageEditorTranslationSlot } from "../ai-translation/page-editor-participant"

import type { Locale } from "@/lib/i18n/config"
import type { AdminCommand } from "../command-palette"
import type { FieldTranslate } from "../fields/field-editor"
import type {
  LocaleContentSummary,
  LocaleDraft,
  Page,
} from "../page-editor/lib/types"
import type { AdminContributionRouteData } from "./types"

/** Opaque server data for the two Translation route-reader responsibilities. */
export type AdminAiTranslationRouteData = Readonly<{
  mechanicalTranslation: AdminContributionRouteData
  brandTranslation: AdminContributionRouteData
}>

/** Neutral Content Editor inputs for Translation's PageEditor mounts. */
export type AdminAiTranslationHostInput = Readonly<{
  routeData: AdminAiTranslationRouteData
  page: Pick<Page, "_id" | "pageType" | "content">
  currentLocale: Locale
  otherLocales: readonly Locale[]
  fieldSource: Locale | undefined
  getLocaleSummary: (locale: Locale) => LocaleContentSummary
  getActiveLocale: () => Locale
  ensureSaved: () => Promise<boolean>
  prepareTransfer: (source: Locale, target: Locale) => Promise<boolean>
  closeTransfer: () => void
  readSourceContent: (locale: Locale) => LocaleDraft
  storeDraft: (locale: Locale, draft: LocaleDraft) => LocaleDraft
  applyActiveDraft: (draft: LocaleDraft) => void
  /**
   * Called when Accept is pressed, before `ensureSaved`. After the server saves
   * the language's draft, `complete` reloads that tab at `draftGeneration` and
   * opens it, keeping text typed since the press.
   */
  beginSavedLanguage?: (locale: Locale) => SavedLanguageReload
}>

/** One Accept's pending tab reload; `complete` runs only after a server save. */
export type SavedLanguageReload = Readonly<{
  complete: (draftGeneration: number) => void
}>

/** Values the PageEditor host renders or calls from shared transfer machinery. */
export type AdminAiTranslationHostResult = Readonly<{
  fieldTranslate: FieldTranslate | undefined
  busy: boolean
  command: AdminCommand | null
  control: ReactNode | null
  /** Rendered once, under the editor header. */
  panel?: ReactNode | null
  setTranslateOpen: (open: boolean) => void
  runPushedTranslate: (source: Locale, target: Locale) => void | Promise<void>
}>

export type AdminAiTranslationHostProps = AdminAiTranslationHostInput &
  Readonly<{
    children: (result: AdminAiTranslationHostResult) => ReactNode
  }>

export type AdminAiTranslationBrowserBinding =
  ComponentType<AdminAiTranslationHostProps>

/** Installed Translation participant: "Translate page" in the page editor; it gates itself on AI and Multilingual. */
export const ADMIN_AI_TRANSLATION_BROWSER_BINDING: AdminAiTranslationBrowserBinding | null =
  PageEditorTranslationSlot
