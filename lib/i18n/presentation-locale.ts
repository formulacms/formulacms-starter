/**
 * The one language a public response is presented in (M05 M20). A request
 * whose locale segment names an enabled language is presented in it; anything
 * else (a known but disabled language, or a stale route) is presented in the
 * default language chosen in Admin → Languages. The layout's `<html lang>`,
 * header, footer and every fixed screen (not-found, error, loading) use this
 * one value.
 */
export function resolvePresentationLocale(
  requestedLocale: string,
  enabledLocales: readonly string[],
  defaultLocale: string
): string {
  return enabledLocales.includes(requestedLocale)
    ? requestedLocale
    : defaultLocale
}

/**
 * Match navigation against the public URL on both sides of a default-locale
 * rewrite: prerender /en/services and browser /services both use /services.
 * Non-default locale prefixes remain part of the public URL. Private preview
 * frames already supply a public path (or null to suppress active state).
 */
export function resolveNavigationPathname(
  routePathname: string,
  presentation: {
    locale: string
    defaultLocale: string
    publicPath?: string | null
  }
): string {
  const { locale, defaultLocale, publicPath } = presentation
  if (publicPath !== undefined) return publicPath ?? ""
  if (locale !== defaultLocale) return routePathname

  const prefix = `/${defaultLocale}`
  if (routePathname === prefix) return "/"
  return routePathname.startsWith(`${prefix}/`)
    ? routePathname.slice(prefix.length)
    : routePathname
}
