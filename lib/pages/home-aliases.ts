export const DEFAULT_HOME_SLUGS = ["homepage", "home"] as const

const HOME_SLUGS_BY_LOCALE: Record<string, readonly string[]> = {
  fr: ["accueil", "accuiel"],
}

export function homeSlugsForLocale(
  locale: string,
  defaultLocale: string
): readonly string[] {
  if (locale === defaultLocale) return DEFAULT_HOME_SLUGS
  return [...(HOME_SLUGS_BY_LOCALE[locale] ?? []), ...DEFAULT_HOME_SLUGS]
}

export function isHomeAliasPath(
  path: string,
  locale: string,
  defaultLocale: string
): boolean {
  const slug = path.startsWith("/") ? path.slice(1) : path
  return (
    slug.length > 0 &&
    !slug.includes("/") &&
    homeSlugsForLocale(locale, defaultLocale).includes(slug)
  )
}
