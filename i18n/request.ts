import { getRequestConfig } from "next-intl/server";
import { resolveAdminLocale } from "@/lib/i18n/admin-locale";
import {
  ADMIN_DICTIONARY_LOCALES,
  hasAdminDictionary,
} from "@/lib/i18n/admin-dictionaries";
import { FALLBACK_LOCALE } from "@/lib/i18n/config";

type AdminDictionaryLocale = (typeof ADMIN_DICTIONARY_LOCALES)[number];

// Literal imports keep every admin dictionary a checked, traceable module.
// Keyed by ADMIN_DICTIONARY_LOCALES, so a new dictionary needs a loader here.
const ADMIN_MESSAGES = {
  en: () => import("../messages/admin/en.json"),
  fr: () => import("../messages/admin/fr.json"),
} satisfies Record<
  AdminDictionaryLocale,
  () => Promise<{ default: Record<string, unknown> }>
>;

async function loadAdminMessages(
  locale: string,
): Promise<Record<string, unknown>> {
  const key = hasAdminDictionary(locale) ? locale : FALLBACK_LOCALE;
  return (await ADMIN_MESSAGES[key as AdminDictionaryLocale]()).default;
}

// Single source of truth for admin-UI locale + messages.
//
// Server components reach this via `getTranslations()` / `getLocale()`;
// client components reach it via `NextIntlClientProvider` (which the (core)
// layout hydrates from `getLocale()` + `getMessages()`).
//
// Public routes (`(public)/[locale]/...`) currently do not use next-intl —
// they have their own per-URL `<html lang>` and ship no message bundle yet.
// If/when a public dictionary lands, this resolver will need to branch on the
// request path (admin vs public) rather than always returning the admin bundle.
export default getRequestConfig(async () => {
  let locale: string;
  try {
    locale = await resolveAdminLocale();
  } catch {
    locale = FALLBACK_LOCALE;
  }
  locale = hasAdminDictionary(locale) ? locale : FALLBACK_LOCALE;

  let messages: Record<string, unknown>;
  try {
    messages = await loadAdminMessages(locale);
  } catch {
    locale = FALLBACK_LOCALE;
    messages = await loadAdminMessages(FALLBACK_LOCALE);
  }

  return {
    locale,
    messages,
    onError(error) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[next-intl]", error.message);
      }
    },
    // Missing keys render as the dotted path rather than throwing — partial
    // fr translations mid-rollout don't blank the UI, and dev gets a console
    // warning via onError so gaps are obvious.
    getMessageFallback({ key, namespace }) {
      return [namespace, key].filter(Boolean).join(".");
    },
  };
});
