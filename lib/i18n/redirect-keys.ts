import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { reportContainedModuleFailure } from "@/lib/modules/containment"
import { isSiteLanguageVersionChanged } from "@/lib/cms/cache"

// Must match `REDIRECT_KEY_CAP` in `convex/cms/redirects.ts`. If `listActiveKeys`
// returns exactly this many keys the set may be truncated, so we treat it as
// unknowable and fail OPEN (call `resolve` unconditionally) rather than risk
// silently dropping a redirect whose key fell beyond the cap.
const REDIRECT_KEY_CAP = 5000

export interface RedirectKey {
  fromPath: string
  locale?: string
}

// Composite key mirroring the `by_locale_fromPath` index scope: locale-agnostic
// redirects (stored with `locale === undefined`) get the "*" bucket.
export function redirectKeyId(
  locale: string | undefined,
  fromPath: string
): string {
  return `${locale ?? "*"}:${fromPath}`
}

export function buildRedirectKeySet(keys: readonly RedirectKey[]): Set<string> {
  const set = new Set<string>()
  for (const key of keys) set.add(redirectKeyId(key.locale, key.fromPath))
  return set
}

// Mirrors `findMatch` in `convex/cms/redirects.ts`: try the locale-scoped key
// first, then fall back to the locale-agnostic ("*") key. A hit means a
// `resolve` call is warranted; a miss means we can skip it entirely.
export function hasRedirectKey(
  set: Set<string>,
  path: string,
  locale: string | undefined
): boolean {
  if (locale && set.has(redirectKeyId(locale, path))) return true
  return set.has(redirectKeyId(undefined, path))
}

const TTL_MS = 15_000
const FETCH_TIMEOUT_MS = 750

function withKeyTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error("Redirect key lookup timed out")),
        FETCH_TIMEOUT_MS
      )
    }),
  ])
}

// Instantiable cache so tests can inject a fetcher/clock and get a fresh
// module-scoped-equivalent state per case. Returns:
//   - a `Set` (possibly empty) when the key index is known — proxy checks it and
//     may skip `resolve` on a miss;
//   - `null` when the index is unknown (fetch failed with no stale value, or the
//     result was capped) — proxy must FAIL OPEN and call `resolve` as before.
export function createRedirectKeyCache(
  fetcher: (languageVersion: number) => Promise<RedirectKey[]>,
  now: () => number = Date.now
) {
  let cache: {
    languageVersion: number
    value: Set<string>
    expiresAt: number
  } | null = null

  return async function getKeySet(
    languageVersion: number
  ): Promise<Set<string> | null> {
    const current = now()
    if (
      cache &&
      cache.languageVersion === languageVersion &&
      cache.expiresAt > current
    ) {
      return cache.value
    }

    try {
      const keys = await withKeyTimeout(fetcher(languageVersion))
      // Possibly truncated — cannot trust the set for miss-skipping, so drop the
      // cache and fail open on every request until it shrinks below the cap.
      if (keys.length >= REDIRECT_KEY_CAP) {
        cache = null
        return null
      }
      const value = buildRedirectKeySet(keys)
      cache = { languageVersion, value, expiresAt: current + TTL_MS }
      return value
    } catch (error) {
      if (isSiteLanguageVersionChanged(error)) throw error
      // Containing boundary (recovery design C4, RG8): signal the failure, then
      // keep the stale-value fallback (like site-config); if there is no stale
      // value the caller fails open. A disabled module is not a failure:
      // `listActiveKeys` returns [] instead.
      reportContainedModuleFailure("redirects", "proxy.key-cache", error)
      return cache && cache.languageVersion === languageVersion
        ? cache.value
        : null
    }
  }
}

const getCachedRedirectKeySetInternal = createRedirectKeyCache(
  (languageVersion) =>
    fetchQuery(api.cms.redirects.listActiveKeys, { languageVersion })
)

// Module-scoped singleton used by `proxy.ts`. Never throws — a `null` return is
// the fail-open signal.
export function getCachedRedirectKeySet(
  languageVersion: number
): Promise<Set<string> | null> {
  return getCachedRedirectKeySetInternal(languageVersion)
}
