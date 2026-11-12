import type { ComponentType, ReactNode } from "react"

import type { Doc } from "@/convex/_generated/dataModel"

/**
 * Neutral full-text search state a core list renders. While `query` is empty
 * the host keeps its own paginated list; `results` is `undefined` while the
 * participant is loading.
 */
export type AdminListSearchResult<Item> = Readonly<{
  control: ReactNode
  query: string
  results: readonly Item[] | undefined
  reset: () => void
}>

/** A Pages list row as a Search participant returns it. */
export type AdminListSearchPage = Doc<"pages"> & {
  effectiveTitles?: Record<string, string>
  scheduledAt?: number
}

/** Neutral Pages list inputs for the Search slot. */
export type AdminPagesListSearchHostProps = Readonly<{
  /** False while the list reads the successor admin projection. */
  searchable: boolean
  status: "published" | "draft" | "archived" | undefined
  children: (result: AdminListSearchResult<AdminListSearchPage>) => ReactNode
}>

/** Neutral Media browser inputs for the Search slot. */
export type AdminMediaSearchHostProps = Readonly<{
  folder: string | undefined
  children: (result: AdminListSearchResult<Doc<"media">>) => ReactNode
}>

export type AdminListSearchBrowserBinding = Readonly<{
  PagesListSlot: ComponentType<AdminPagesListSearchHostProps>
  MediaSlot: ComponentType<AdminMediaSearchHostProps>
}>

/** Community installs no M04 participant. Keep this a literal empty binding. */
export const ADMIN_LIST_SEARCH_BROWSER_BINDING: AdminListSearchBrowserBinding | null =
  null
