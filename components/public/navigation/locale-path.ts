export function localePath(
  locale: string,
  defaultLocale: string,
  relativePath: string
): string {
  const path = relativePath.startsWith("/") ? relativePath : `/${relativePath}`
  if (locale === defaultLocale) return path
  return path === "/" ? `/${locale}` : `/${locale}${path}`
}
