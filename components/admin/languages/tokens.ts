import { getLocaleDisplayName } from "@/lib/i18n/config"
import type { LanguagesState } from "./types"

/** The version tokens every combined owner command compares on entry. */
export function commandTokenArgs(state: LanguagesState) {
  const { settingsUpdatedAt, moduleConfigurationVersion, authorityVersion } =
    state.commandTokens
  return {
    expectedSettingsUpdatedAt: settingsUpdatedAt,
    expectedModuleConfigurationVersion: moduleConfigurationVersion,
    expectedAuthorityVersion: authorityVersion,
  }
}

/** Orders the enabled languages with the default first. */
export function orderedLocales(state: LanguagesState): string[] {
  const { defaultLocale, enabledLocales } = state
  return defaultLocale
    ? [defaultLocale, ...enabledLocales.filter((code) => code !== defaultLocale)]
    : [...enabledLocales]
}

/** A language written in its own language, first letter capitalised. */
export function languageName(code: string): string {
  return getLocaleDisplayName(code)
}
