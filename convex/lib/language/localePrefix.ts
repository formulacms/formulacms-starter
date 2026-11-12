import { SUPPORTED_LOCALES } from "../../../lib/i18n/config"

/** The exact and descendant portion of one locale's reserved URL prefix. */
export function localePrefixRange(locale: string): {
  start: string
  end: string
} {
  const root = `/${locale}`
  return { start: root, end: `${root}0` }
}

/** True only for `/<locale>` and `/<locale>/…`, never `/<locale>-…`. */
export function isLocalePrefixPath(path: string, locale: string): boolean {
  const root = `/${locale}`
  return path === root || path.startsWith(`${root}/`)
}

/** Supported locale codes are permanently reserved as a URL's first segment. */
export function hasReservedLocalePrefix(path: string): boolean {
  return (SUPPORTED_LOCALES as readonly string[]).some((locale) =>
    isLocalePrefixPath(path, locale)
  )
}
