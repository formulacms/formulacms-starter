import type { AdminPageLocale } from "@/convex/cms/publication"
import { toPublicPath } from "@/lib/pages/url"

/**
 * Pure per-language row logic for the snapshot Pages list. The data is
 * `AdminPageLocale[]` from `listAdminPages`, the same projection the editor
 * reads, so the list and the editor cannot disagree.
 */

export type RowStatus = "published" | "draft" | "notTranslated"

type LocaleSource = { locales?: readonly AdminPageLocale[] }

/** Site order with the default language first. */
export function siteLocaleOrder(
  enabledLocales: readonly string[],
  defaultLocale: string | undefined
): string[] {
  if (!defaultLocale) return [...enabledLocales]
  return [
    defaultLocale,
    ...enabledLocales.filter((locale) => locale !== defaultLocale),
  ]
}

/** The language a list or editor opens on: the admin language when the site has it. */
export function openingLanguage(
  adminLocale: string,
  siteLocales: readonly string[],
  defaultLocale: string | undefined
): string {
  if (siteLocales.includes(adminLocale)) return adminLocale
  return defaultLocale ?? siteLocales[0] ?? adminLocale
}

export function localeEntry(
  page: LocaleSource,
  locale: string
): AdminPageLocale | undefined {
  return page.locales?.find((entry) => entry.locale === locale)
}

/** No entry, or an entry that says so, is Not translated. */
export function rowStatus(page: LocaleSource, locale: string): RowStatus {
  const entry = localeEntry(page, locale)
  if (!entry || entry.state === "not_translated") return "notTranslated"
  return entry.state
}

export function rowTitle(page: LocaleSource, locale: string): string {
  return localeEntry(page, locale)?.title?.trim() ?? ""
}

/**
 * The title a Not translated row shows (muted): the first site language, in
 * site order, that is translated and has a title; failing that, any titled
 * language of the page.
 */
export function firstTitle(
  page: LocaleSource & { localizedTitles?: Record<string, string> },
  siteLocales: readonly string[]
): { title: string; locale: string } | null {
  for (const locale of siteLocales) {
    if (rowStatus(page, locale) === "notTranslated") continue
    const title = rowTitle(page, locale)
    if (title) return { title, locale }
  }
  for (const locale of siteLocales) {
    const title = page.localizedTitles?.[locale]?.trim()
    if (title) return { title, locale }
  }
  return null
}

export type RowAddress =
  | { kind: "path"; value: string }
  /** Not knowable yet: show the grey placeholder. */
  | { kind: "none" }
  /** Non-routable content: show nothing. */
  | { kind: "hidden" }

export function rowAddress(
  page: LocaleSource,
  locale: string,
  defaultLocale: string
): RowAddress {
  const path = localeEntry(page, locale)?.path
  if (path === null) return { kind: "hidden" }
  if (path === undefined) return { kind: "none" }
  return { kind: "path", value: toPublicPath(path, locale, defaultLocale) }
}

/**
 * Does the page match the status filter? Single-language view: that language.
 * All languages: any language of the page. Archived is a lifecycle scope the
 * server already applied.
 */
export function pageMatchesStatus(
  page: LocaleSource,
  filter: "all" | RowStatus,
  languages: readonly string[]
): boolean {
  if (filter === "all") return true
  return languages.some((locale) => rowStatus(page, locale) === filter)
}
