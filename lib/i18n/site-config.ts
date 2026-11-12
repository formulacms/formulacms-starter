import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { FALLBACK_LOCALE } from "./config"

export interface SiteConfig {
  onboardingCompletedAt: number | null
  defaultLocale: string
  enabledLocales: string[]
  languageVersion: number
}

type SiteConfigCacheEntry = { value: SiteConfig; expiresAt: number }

export type SiteConfigState =
  | { status: "ready"; value: SiteConfig }
  | { status: "unavailable"; fallback: SiteConfig }

const FALLBACK: SiteConfig = {
  onboardingCompletedAt: null,
  defaultLocale: FALLBACK_LOCALE,
  enabledLocales: [FALLBACK_LOCALE],
  languageVersion: 0,
}

// Locale + onboarding config is read by middleware on every matched request.
// It changes rarely (single-tenant), so we cache it in a short-lived
// module-scoped value to bound Convex round-trips. Staleness self-heals after
// the TTL.
//
// One asymmetry, deliberate: a *not-onboarded* verdict is never served from
// cache. Onboarding is a one-way transition, so a cached `null` is the only
// reading that can be both stale and consequential — it funnels the operator
// back into the wizard they just finished. Re-reading it costs one Convex
// round-trip per request, but only in the pre-onboarding window of a brand-new
// deployment; once the transition happens the cache is authoritative forever.
//
// This replaces a cookie that used to paper over that window. It was written
// by the browser with a one-year max-age, so it was both forgeable (a client
// can send any cookie it likes, `HttpOnly` or not) and far longer-lived than
// the 15s race it existed to cover.
let cache: SiteConfigCacheEntry | null = null
const TTL_MS = 15_000
const FETCH_TIMEOUT_MS = 750

function withConfigTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error("Site config lookup timed out")),
        FETCH_TIMEOUT_MS
      )
    }),
  ])
}

/**
 * Whether a cached entry may answer this request.
 *
 * Exported for tests: this predicate is the whole first-run gate. A cached
 * not-onboarded verdict is refused however fresh it is, so completing the
 * wizard is visible on the next request instead of up to `TTL_MS` later.
 */
export function canServeFromCache(
  entry: SiteConfigCacheEntry | null,
  now: number
): boolean {
  if (!entry) return false
  if (entry.expiresAt <= now) return false
  return entry.value.onboardingCompletedAt != null
}

// One in-flight read at a time. Without this, every concurrent request on a
// not-yet-onboarded deployment opens its own Convex query — and that is exactly
// the window when the site is publicly reachable but the cache can never
// answer, so a crawler or a burst turns N requests into N queries. Sharing the
// promise collapses a burst back to one round-trip without reintroducing a
// cache that could serve a stale not-onboarded verdict.
let cacheGeneration = 0
let inFlight: { generation: number; promise: Promise<SiteConfig> } | null = null

async function readSiteConfig(): Promise<SiteConfig> {
  // One retry: the read this bridges happens right after the wizard writes
  // `onboardingCompletedAt`, and a single cold-start timeout would otherwise
  // send the operator who just clicked Finish straight back to /setup.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withConfigTimeout(
        fetchQuery(api.cms.settings.getSiteConfig, {})
      )
    } catch (error) {
      if (attempt >= 1) throw error
    }
  }
}

export async function getSiteConfigState(): Promise<SiteConfigState> {
  const now = Date.now()
  if (cache && canServeFromCache(cache, now)) {
    return { status: "ready", value: cache.value }
  }

  const generation = cacheGeneration
  if (!inFlight || inFlight.generation !== generation) {
    const promise = readSiteConfig().finally(() => {
      if (inFlight?.promise === promise) inFlight = null
    })
    inFlight = { generation, promise }
  }

  try {
    const value = await inFlight.promise
    if (generation === cacheGeneration) {
      cache = { value, expiresAt: now + TTL_MS }
    }
    return { status: "ready", value }
  } catch {
    return unreachableSiteConfigState(cache)
  }
}

/**
 * Drop the proxy's module cache and perform one independent configuration
 * read. Used only after a language-version mismatch (or a disabled-locale
 * prefix) so a stale authority tuple can never be reused for the retry.
 */
export async function refreshSiteConfigState(): Promise<SiteConfigState> {
  cacheGeneration += 1
  const generation = cacheGeneration
  cache = null
  inFlight = null
  try {
    const value = await readSiteConfig()
    if (generation === cacheGeneration) {
      cache = { value, expiresAt: Date.now() + TTL_MS }
    }
    return { status: "ready", value }
  } catch {
    return { status: "unavailable", fallback: FALLBACK }
  }
}

/**
 * Locale consumers may use the conservative English fallback while Convex is
 * unavailable. Setup routing must call `getSiteConfigState` instead so an
 * unknown read is never mistaken for a fresh deployment.
 */
export async function getCachedSiteConfig(): Promise<SiteConfig> {
  const state = await getSiteConfigState()
  return state.status === "ready" ? state.value : state.fallback
}

/** Exported for the setup-gate regression tests. */
export function unreachableSiteConfigState(
  entry: SiteConfigCacheEntry | null
): SiteConfigState {
  if (entry && entry.value.onboardingCompletedAt != null) {
    return { status: "ready", value: entry.value }
  }
  return { status: "unavailable", fallback: FALLBACK }
}
