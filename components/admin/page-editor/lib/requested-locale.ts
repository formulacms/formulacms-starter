import { isValidLocale } from "@/lib/i18n/config"

/** Server-only validation at the route; absent/invalid requests preserve content order. */
export function resolveRequestedEditorLocale(
  raw: string | string[] | undefined,
  enabledLocales: readonly string[]
): string | undefined {
  const locale = Array.isArray(raw) ? raw[0] : raw
  return locale && isValidLocale(locale, enabledLocales) ? locale : undefined
}
