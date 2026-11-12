import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { fetchQuery } from "convex/nextjs"
import type { FunctionReturnType } from "convex/server"
import { api } from "@/convex/_generated/api"
import {
  getSiteConfigState,
  refreshSiteConfigState,
} from "@/lib/i18n/site-config"
import { isSiteLanguageVersionChanged } from "@/lib/cms/cache"
import {
  getCachedRedirectKeySet,
  hasRedirectKey,
} from "@/lib/i18n/redirect-keys"
import { reportContainedModuleFailure } from "@/lib/modules/containment"
import { isHomeAliasPath } from "@/lib/pages/home-aliases"
import { SUPPORTED_LOCALES } from "@/lib/i18n/config"
import { SLICE_SIMULATOR_ROUTE } from "@/config/slice-simulator"
import createMiddleware from "next-intl/middleware"

// Onboarding state has exactly one source of truth: the Convex deployment,
// read through `getSiteConfigState`, which never serves a cached not-onboarded
// verdict and distinguishes an unavailable read from a fresh deployment. No
// cookie participates in the decision.
//
// A cookie used to. The wizard wrote `nextcms-onboarded=1` from the browser
// with a one-year max-age and the gate OR'd it with the database, which made
// it a second, client-authored source of truth: any visitor could set it to
// walk past the first-run gate, and a browser that onboarded once kept walking
// past it forever — including against a deployment whose settings were wiped.
// `HttpOnly` would not have fixed that; it stops scripts from writing a
// cookie, not clients from sending one.
const LEGACY_ONBOARDED_COOKIE = "nextcms-onboarded"

type PublicationRouteResult = FunctionReturnType<
  typeof api.cms.pages.resolveHistoricalPublishedPath
>

// Split a URL pathname into `(locale, locale-stripped path)`. The default
// locale is unprefixed (per i18nRouter's `prefixDefault: false`), so "/about"
// resolves to (defaultLocale, "/about") and "/fr/about" to ("fr", "/about").
function splitLocale(
  pathname: string,
  enabledLocales: string[],
  defaultLocale: string
): { locale: string; path: string } {
  const segments = pathname.split("/").filter((s) => s.length > 0)
  if (segments.length > 0 && enabledLocales.includes(segments[0])) {
    const rest = segments.slice(1).join("/")
    return { locale: segments[0], path: rest ? `/${rest}` : "/" }
  }
  return { locale: defaultLocale, path: pathname || "/" }
}

// Paths that must never receive a locale prefix / locale routing. `/slice-sim`
// is the dev-only slice simulator (ADR-0016), an internal non-localized route in
// its own root layout — without this it'd be rewritten into the public locale
// tree and 404 in the catch-all.
const I18N_EXCLUDED = [
  "/admin",
  "/setup",
  "/sign-in",
  "/forgot-password",
  "/reset-password",
  ...(SLICE_SIMULATOR_ROUTE === null ? [] : [SLICE_SIMULATOR_ROUTE]),
]

/** Evict the forgeable predecessor cookie from browsers still carrying it. */
function clearLegacyCookie(
  response: NextResponse,
  present: boolean
): NextResponse {
  if (present) response.cookies.delete(LEGACY_ONBOARDED_COOKIE)
  return response
}

function setupStatusUnavailableResponse(): NextResponse {
  return new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>formulacms is reconnecting</title>
    <style>
      :root { font-family: ui-sans-serif, system-ui, sans-serif; color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { min-height: 100svh; margin: 0; display: grid; place-items: center; padding: 1.5rem; background: Canvas; color: CanvasText; }
      main { width: min(100%, 32rem); border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 1rem; padding: clamp(1.5rem, 5vw, 2.5rem); box-shadow: 0 1.25rem 3rem color-mix(in srgb, CanvasText 10%, transparent); }
      h1 { margin: 0; font-size: clamp(1.5rem, 5vw, 2rem); line-height: 1.15; text-wrap: balance; }
      p { line-height: 1.6; }
      a { display: inline-flex; min-height: 2.75rem; align-items: center; justify-content: center; margin-top: .5rem; border-radius: .625rem; padding: 0 1rem; background: CanvasText; color: Canvas; font-weight: 650; text-decoration: none; touch-action: manipulation; }
      a:hover { opacity: .84; }
      a:focus-visible { outline: 3px solid Highlight; outline-offset: 3px; }
      details { margin-top: 1.5rem; color: color-mix(in srgb, CanvasText 72%, transparent); }
      summary { cursor: pointer; }
      code { font-size: .9em; }
    </style>
  </head>
  <body>
    <main>
      <h1>We can’t verify this site right now</h1>
      <p>formulacms couldn’t reach its backend, so setup and sign-in are paused to protect your account. Nothing has been reset or changed.</p>
      <p>Try again in a moment.</p>
      <a href="">Try again</a>
      <details>
        <summary>For the site operator</summary>
        <p>Check that the Convex deployment is running and that <code>NEXT_PUBLIC_CONVEX_URL</code> points to it.</p>
      </details>
    </main>
  </body>
</html>`,
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "retry-after": "3",
      },
    }
  )
}

type SiteConfigValue = Extract<
  Awaited<ReturnType<typeof getSiteConfigState>>,
  { status: "ready" }
>["value"]

/**
 * next-intl, built per request from the current site config. The URL alone
 * picks the language: an unprefixed address is always the site default
 * language, whatever the browser sends. No negotiation, no locale cookie (an
 * old `NEXT_LOCALE` cookie is ignored), so nothing here varies by visitor.
 */
function createIntlMiddleware(config: SiteConfigValue) {
  return createMiddleware({
    locales: [...config.enabledLocales],
    defaultLocale: config.defaultLocale,
    localePrefix: "as-needed",
    alternateLinks: false,
    localeDetection: false,
    localeCookie: false,
  })
}

function isExcluded(pathname: string): boolean {
  return I18N_EXCLUDED.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  )
}

async function handleProxy(request: NextRequest, mayRefreshVersion: boolean) {
  const { pathname } = request.nextUrl
  const hasLegacyCookie = request.cookies.has(LEGACY_ONBOARDED_COOKIE)
  const siteConfigState = await getSiteConfigState()
  if (siteConfigState.status === "unavailable") {
    return clearLegacyCookie(setupStatusUnavailableResponse(), hasLegacyCookie)
  }

  const config = siteConfigState.value
  const onboarded = config.onboardingCompletedAt != null
  const ownerRecovery =
    pathname === "/setup" &&
    request.nextUrl.searchParams.get("recover-owner") === "1"

  // The slice simulator renders sample content through the public pipeline and
  // reads no site configuration, so first-run setup has nothing to say about
  // it. Without this a deployment that has not been set up yet — a fresh CI
  // checkout, or a clone before its first run — answers every simulator URL
  // with a redirect to /setup, and anything photographing the simulator gets
  // the setup wizard. It stays dev-only regardless: the page itself 404s under
  // NODE_ENV=production.
  const isSimulator =
    SLICE_SIMULATOR_ROUTE !== null &&
    (pathname === SLICE_SIMULATOR_ROUTE ||
      pathname.startsWith(`${SLICE_SIMULATOR_ROUTE}/`))

  // First-run gate: until onboarding completes, funnel everything to /setup.
  if (!onboarded && !isSimulator) {
    if (pathname === "/setup" || pathname.startsWith("/setup/")) {
      return clearLegacyCookie(NextResponse.next(), hasLegacyCookie)
    }
    const url = request.nextUrl.clone()
    url.pathname = "/setup"
    url.search = ""
    return clearLegacyCookie(NextResponse.redirect(url), hasLegacyCookie)
  }

  // Onboarded: the wizard is one-way.
  if (
    (pathname === "/setup" || pathname.startsWith("/setup/")) &&
    !ownerRecovery
  ) {
    const url = request.nextUrl.clone()
    url.pathname = "/admin"
    return NextResponse.redirect(url)
  }

  // Admin / auth pages are not localized.
  if (isExcluded(pathname)) {
    return NextResponse.next()
  }

  const segments = pathname.split("/").filter(Boolean)
  const firstSegment = segments[0]
  const isKnownDisabledLocale =
    firstSegment !== undefined &&
    (SUPPORTED_LOCALES as readonly string[]).includes(firstSegment) &&
    !config.enabledLocales.includes(firstSegment)

  // Preserve the locale segment so the localized route can return its normal
  // not-found response. Rewriting it under the sole/default locale would let a
  // disabled-locale URL resolve by leaf slug and redirect to default content.
  if (isKnownDisabledLocale) {
    if (mayRefreshVersion) {
      const refreshed = await refreshSiteConfigState()
      if (refreshed.status === "unavailable") {
        return clearLegacyCookie(
          setupStatusUnavailableResponse(),
          hasLegacyCookie
        )
      }
      return handleProxy(request, false)
    }
    return NextResponse.next()
  }

  // CMS-managed redirects: resolved BEFORE locale routing so the response is a
  // true 301/302 (NextResponse.redirect honors the status, unlike RSC
  // `redirect()` which is locked to 307/308) and we skip the page render
  // entirely for the original URL. `fromPath` is stored locale-stripped, so
  // peel the locale off before lookup.
  const { locale: currentLocale, path: lookupPath } = splitLocale(
    pathname,
    config.enabledLocales,
    config.defaultLocale
  )

  // One locale decision for CMS lookups and rendering: next-intl runs first on
  // every public request (prefix, else the site default language). Its
  // response is held, never rebuilt: pass-through and rewrite responses go out
  // intact.
  const first = createIntlMiddleware(config)(request) as NextResponse
  const redirectTo = (target: URL, status: number) =>
    NextResponse.redirect(target, status)
  const pageUrl = (locale: string, destinationPath: string) => {
    const url = request.nextUrl.clone()
    url.pathname =
      locale === config.defaultLocale
        ? destinationPath
        : `/${locale}${destinationPath}`
    return url
  }

  // Publication route ownership is mandatory and is checked before optional
  // Redirects/cache state. A retained historical reservation is never
  // shadowed by a manual rule; an unavailable reservation remains unclaimed
  // only to the public route (which will fail closed), not to Redirects.
  let publicationRoute: PublicationRouteResult
  try {
    publicationRoute = await fetchQuery(
      api.cms.pages.resolveHistoricalPublishedPath,
      {
        path: lookupPath,
        locale: currentLocale,
        languageVersion: config.languageVersion,
      }
    )
  } catch (error) {
    if (isSiteLanguageVersionChanged(error)) {
      if (mayRefreshVersion) {
        const refreshed = await refreshSiteConfigState()
        if (refreshed.status === "ready") {
          return handleProxy(request, false)
        }
      }
      return setupStatusUnavailableResponse()
    }
    publicationRoute = {
      authority: "snapshot_active",
      disposition: "historical_unavailable",
    } as const
  }
  if (publicationRoute.authority === "snapshot_active") {
    if (publicationRoute.disposition === "historical_redirect") {
      // The prefix comes from the destination's language: an M05 continuity row
      // in the default URL space can name another language (M11). F08 history
      // and F09 continuity return the request locale, so their URLs are as
      // before.
      return redirectTo(
        pageUrl(publicationRoute.locale, publicationRoute.destinationPath),
        publicationRoute.statusCode
      )
    }
    if (publicationRoute.disposition === "current") {
      // The page is served as requested: next-intl's own response, intact.
      return first
    }
  }
  const legacy = publicationRoute.authority === "legacy"
  const mayUseManualRedirects =
    publicationRoute.authority === "legacy" ||
    publicationRoute.disposition === "unclaimed"
  // Gate the (per-request) `resolve` round-trip behind a short-lived cached key
  // set: on the common no-redirect path we skip `resolve` entirely and collapse
  // one Convex query per request into one per TTL window. A `null` key set means
  // the index is unknown (fetch failed / capped) -> fail open and always call
  // `resolve`, so the optimization can never break a redirect.
  let redirectKeys: Set<string> | null = null
  if (mayUseManualRedirects) {
    try {
      redirectKeys = await getCachedRedirectKeySet(config.languageVersion)
    } catch (error) {
      if (isSiteLanguageVersionChanged(error)) {
        if (mayRefreshVersion) {
          const refreshed = await refreshSiteConfigState()
          if (refreshed.status === "ready") {
            return handleProxy(request, false)
          }
        }
        return setupStatusUnavailableResponse()
      }
      throw error
    }
  }
  const mightRedirect =
    mayUseManualRedirects &&
    (redirectKeys === null ||
      hasRedirectKey(redirectKeys, lookupPath, currentLocale))
  // A contained lookup failure is not a miss: self-heal then stays off and
  // the request falls through to next-intl as before U3.
  let redirectsFailed = false
  if (mightRedirect) {
    try {
      const hit = await fetchQuery(api.cms.redirects.resolve, {
        path: lookupPath,
        locale: currentLocale,
        languageVersion: config.languageVersion,
      })
      if (hit) {
        const target = /^https?:\/\//i.test(hit.destination)
          ? new URL(hit.destination)
          : new URL(hit.destination, request.url)
        return redirectTo(target, hit.statusCode)
      }
    } catch (error) {
      if (isSiteLanguageVersionChanged(error)) {
        if (mayRefreshVersion) {
          const refreshed = await refreshSiteConfigState()
          if (refreshed.status === "ready") {
            return handleProxy(request, false)
          }
        }
        return setupStatusUnavailableResponse()
      }
      // Contained Redirects participation (recovery design B3, RG8): serve this
      // request through normal routing rather than a 5xx, and signal the
      // failure so an error is never indistinguishable from "no matching rule".
      // A disabled module is not a failure: `resolve` returns null instead.
      redirectsFailed = true
      reportContainedModuleFailure("redirects", "proxy.resolve", error)
    }
  }

  // Self-heal: a deferred candidate, used only after the manual lookup missed.
  if (
    !redirectsFailed &&
    publicationRoute.authority === "snapshot_active" &&
    publicationRoute.disposition === "unclaimed" &&
    publicationRoute.selfHeal
  ) {
    const heal = publicationRoute.selfHeal
    return redirectTo(pageUrl(heal.locale, heal.destinationPath), 307)
  }

  // Home aliases are an engine-level compatibility contract, not CMS redirect
  // records. Resolve them at the request boundary so static/streaming renders
  // cannot turn the permanent redirect into a 200 response with a meta tag.
  if (
    legacy &&
    isHomeAliasPath(lookupPath, currentLocale, config.defaultLocale)
  ) {
    const url = request.nextUrl.clone()
    url.pathname =
      currentLocale === config.defaultLocale ? "/" : `/${currentLocale}`
    return NextResponse.redirect(url, 308)
  }

  // Nothing resolved (or legacy authority, which returns no page identity):
  // the request is served as asked, in the language its URL names.
  return first
}

export async function proxy(request: NextRequest) {
  return handleProxy(request, true)
}

export const config = {
  // Run on everything except API routes, Next internals, and static files.
  matcher: ["/((?!api(?:/|$)|_next|.*\\..*).*)"],
}
