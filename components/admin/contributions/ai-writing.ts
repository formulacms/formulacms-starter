import type { ComponentType, ReactNode } from "react"
import { NewPageWritingSlot } from "../ai-writing/new-page-participant"

import type { Id } from "@/convex/_generated/dataModel"
import type { ContentType } from "@/convex/lib/contentTypes"
import type { Slice } from "@/convex/lib/slices"
import type { Locale } from "@/lib/i18n/config"
import type { AdminCommand } from "../command-palette"
import type { FieldGenerate } from "../fields/field-editor"
import type { ActivePanel, Page } from "../page-editor/lib/types"
import type { AdminContributionRouteData } from "./types"

/** Opaque server data for the two Writing route-reader responsibilities. */
export type AdminAiWritingRouteData = Readonly<{
  editorialCopy: AdminContributionRouteData
  structuredOutlineMeta: AdminContributionRouteData
}>

/** Neutral Content Editor inputs for Writing's new-page mounts. */
export type AdminAiWritingNewPageHostInput = Readonly<{
  routeData: AdminAiWritingRouteData
  title: string
  locale: Locale
  pageType: ContentType
  canSubmit: boolean
  canCreateSelected: boolean
  isCreating: boolean
  createShellPage: () => Promise<Id<"pages"> | undefined>
}>

/** Values the new-page host renders or uses to protect ordinary buttons. */
export type AdminAiWritingNewPageHostResult = Readonly<{
  busy: boolean
  starterHeroControl: ReactNode | null
  pageWizardControl: ReactNode | null
}>

export type AdminAiWritingNewPageHostProps = AdminAiWritingNewPageHostInput &
  Readonly<{
    children: (result: AdminAiWritingNewPageHostResult) => ReactNode
  }>

/** Neutral Content Editor inputs for Writing's PageEditor mounts. */
export type AdminAiWritingPageEditorHostInput = Readonly<{
  routeData: AdminAiWritingRouteData
  page: Page
  locale: Locale
  ensureSaved: () => Promise<boolean>
  slices: readonly Slice[]
  title: string
  setMetaTitle: (value: string) => void
  setMetaDescription: (value: string) => void
  setActivePanel: (panel: ActivePanel) => void
}>

/** Values the PageEditor host renders or forwards to its existing panels. */
export type AdminAiWritingPageEditorHostResult = Readonly<{
  fieldGenerate: FieldGenerate | undefined
  metaGenerationAvailable: boolean
  isGeneratingMeta: boolean
  generateMeta: () => Promise<void>
  commands: readonly AdminCommand[]
}>

export type AdminAiWritingPageEditorHostProps =
  AdminAiWritingPageEditorHostInput &
    Readonly<{
      children: (result: AdminAiWritingPageEditorHostResult) => ReactNode
    }>

export type AdminAiWritingBrowserBinding = Readonly<{
  NewPageSlot: ComponentType<AdminAiWritingNewPageHostProps>
  /** Absent: the page editor has no Writing participant yet. */
  PageEditorSlot?: ComponentType<AdminAiWritingPageEditorHostProps>
}>

/** Installed Writing participant: "Write page with AI" on New Page; it gates itself on the AI module. */
export const ADMIN_AI_WRITING_BROWSER_BINDING: AdminAiWritingBrowserBinding | null =
  { NewPageSlot: NewPageWritingSlot }
