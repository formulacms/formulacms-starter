import { fetchAuthQuery } from "@/lib/auth-server";
import { api } from "@/convex/_generated/api";
import { getCachedSiteConfig } from "./site-config";
import { SUPPORTED_LOCALES, FALLBACK_LOCALE, type Locale } from "./config";
import { hasAdminDictionary, unsetAdminLocaleFor } from "./admin-dictionaries";

const VALID_LOCALES = SUPPORTED_LOCALES as readonly string[];
const REQUEST_FALLBACK_TIMEOUT_MS = 750;

function coerce(value: string | null | undefined): Locale | null {
  if (!value) return null;
  return VALID_LOCALES.includes(value) ? value : null;
}

function withRequestFallbackTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error("Admin locale lookup timed out")),
        REQUEST_FALLBACK_TIMEOUT_MS,
      );
    }),
  ]);
}

/**
 * Resolve the admin-UI locale for the current request:
 *
 *   1. The signed-in user's stored `adminLocale` preference (userPreferences).
 *      A saved preference is independent of the site language and survives
 *      every site-language change. If its dictionary has not shipped, the
 *      effective admin locale is English without changing the saved value.
 *   2. `siteSettings.defaultLocale`, only when an admin dictionary exists for it.
 *   3. `FALLBACK_LOCALE` ("en").
 *
 * Read by `app/(core)/layout.tsx` to drive `<html lang>` and the next-intl
 * messages bundle. Unauthenticated requests skip step 1; failures bubble down
 * the chain rather than throwing so the admin can still boot if Convex is slow.
 */
export async function resolveAdminLocale(): Promise<Locale> {
  try {
    const pref = await withRequestFallbackTimeout(
      fetchAuthQuery(api.cms.userPreferences.getAdminLocale, {}),
    );
    if (typeof pref === "string") {
      return hasAdminDictionary(pref) ? pref : FALLBACK_LOCALE;
    }
  } catch {
    // Unauthenticated, or query unavailable (e.g. mid-deploy) — fall through.
  }

  try {
    const site = await withRequestFallbackTimeout(getCachedSiteConfig());
    return unsetAdminLocaleFor(coerce(site.defaultLocale));
  } catch {
    // Convex unreachable — fall through to hardcoded fallback.
  }

  return FALLBACK_LOCALE;
}
