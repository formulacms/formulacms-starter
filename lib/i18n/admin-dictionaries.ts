import { FALLBACK_LOCALE, type Locale } from "./config";

// Locales that ship an admin dictionary in `messages/admin/<locale>.json`.
// `admin-dictionaries.test.ts` keeps this list equal to the directory, so a new
// dictionary file cannot silently go unused.
export const ADMIN_DICTIONARY_LOCALES = ["en", "fr"] as const;

export type AdminDictionaryLocale = (typeof ADMIN_DICTIONARY_LOCALES)[number];

export function hasAdminDictionary(locale: string): boolean {
  return (ADMIN_DICTIONARY_LOCALES as readonly string[]).includes(locale);
}

/**
 * Admin language when the signed-in owner has saved no preference (F09
 * contract, "Admin language and initial setup"): follow the site language only
 * when its dictionary exists, otherwise English. This keeps the loaded messages
 * and the `lang` attribute consistent.
 */
export function unsetAdminLocaleFor(siteLocale: string | null | undefined): Locale {
  return siteLocale && hasAdminDictionary(siteLocale) ? siteLocale : FALLBACK_LOCALE;
}
