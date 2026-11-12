// Locale config is DB-driven (siteSettings.defaultLocale / enabledLocales).
// This module only holds the STATIC code-known catalog and pure helpers. The
// active set always comes from the DB. Direction is metadata only: every
// current locale is LTR, and this does not claim RTL support.

export type Locale = string;
export type LocaleDirection = "ltr" | "rtl";

type LocaleDefinition = {
  code: string;
  direction: LocaleDirection;
};

// Code-known locale identities. Lowercase short codes preserve the existing
// clean URLs and direct Intl.DisplayNames input.
export const LOCALE_DEFINITIONS = [
  { code: "en", direction: "ltr" },
  { code: "fr", direction: "ltr" },
  { code: "es", direction: "ltr" },
  { code: "it", direction: "ltr" },
  { code: "pt", direction: "ltr" },
  { code: "pt-br", direction: "ltr" },
  { code: "nl", direction: "ltr" },
  { code: "sv", direction: "ltr" },
  { code: "pl", direction: "ltr" },
  { code: "ru", direction: "ltr" },
  { code: "tr", direction: "ltr" },
  { code: "hi", direction: "ltr" },
  { code: "zh", direction: "ltr" },
  { code: "ja", direction: "ltr" },
  { code: "ko", direction: "ltr" },
] as const satisfies readonly LocaleDefinition[];

type KnownLocale = (typeof LOCALE_DEFINITIONS)[number]["code"];

export const SUPPORTED_LOCALES: readonly KnownLocale[] =
  LOCALE_DEFINITIONS.map(({ code }) => code);

// Used only when no siteSettings row exists yet (pre-onboarding safety).
export const FALLBACK_LOCALE: Locale = "en";

const LOCALE_DIRECTIONS = new Map<string, LocaleDirection>(
  LOCALE_DEFINITIONS.map(({ code, direction }) => [code, direction] as const),
);

export function getLocaleDirection(code: string): LocaleDirection {
  return (
    LOCALE_DIRECTIONS.get(code) ??
    // The fallback identity is part of the exhaustive catalog above.
    LOCALE_DIRECTIONS.get(FALLBACK_LOCALE)!
  );
}

// Endonym for the locale (its name in its own language), e.g. "Français".
export function getLocaleLabel(code: string): string {
  try {
    const dn = new Intl.DisplayNames([code], { type: "language" });
    return dn.of(code) ?? code;
  } catch {
    return code;
  }
}

// The endonym as a UI name: first letter capitalised in the language's own
// locale ("Français", "Español"). `getLocaleLabel` stays the raw endonym.
export function getLocaleDisplayName(code: string): string {
  const label = getLocaleLabel(code);
  try {
    return label.charAt(0).toLocaleUpperCase(code) + label.slice(1);
  } catch {
    return label;
  }
}

export function isValidLocale(
  code: string,
  enabledLocales: readonly string[],
): boolean {
  return enabledLocales.includes(code);
}
