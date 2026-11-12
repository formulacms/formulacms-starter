import { NextRequest } from "next/server"
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server"
import { ConvexError } from "convex/values"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getCachedSiteConfig: vi.fn(),
  getSiteConfigState: vi.fn(),
  refreshSiteConfigState: vi.fn(),
  getCachedRedirectKeySet: vi.fn(),
  fetchQuery: vi.fn(),
  upstreamVary: { value: null as string | null },
  intlOptions: [] as Array<{
    localeCookie?: unknown
    localeDetection?: unknown
  }>,
}))

vi.mock("@/lib/i18n/site-config", () => ({
  getCachedSiteConfig: mocks.getCachedSiteConfig,
  getSiteConfigState: mocks.getSiteConfigState,
  refreshSiteConfigState: mocks.refreshSiteConfigState,
}))
vi.mock("@/lib/i18n/redirect-keys", () => ({
  getCachedRedirectKeySet: mocks.getCachedRedirectKeySet,
  hasRedirectKey: vi.fn(() => false),
}))
vi.mock("convex/nextjs", () => ({ fetchQuery: mocks.fetchQuery }))
// Seam: the REAL next-intl middleware, optionally with an upstream `Vary`
// already on its response (used to prove proxy.ts keeps it when it appends).
vi.mock("next-intl/middleware", async (importOriginal) => {
  const original = await importOriginal<typeof import("next-intl/middleware")>()
  return {
    ...original,
    default: ((options: Parameters<typeof original.default>[0]) => {
      mocks.intlOptions.push(options)
      const middleware = original.default(options)
      return (request: Parameters<typeof middleware>[0]) => {
        const response = middleware(request)
        if (mocks.upstreamVary.value) {
          response.headers.set("vary", mocks.upstreamVary.value)
        }
        return response
      }
    }) as typeof original.default,
  }
})
// The starter ships no slice simulator: its overlay twin of this seam is null
// (FR2.0 rev3 S-j). Source-only simulator cases live in
// proxy.slice-simulator.test.ts.
vi.mock("@/config/slice-simulator", () => ({ SLICE_SIMULATOR_ROUTE: null }))
vi.mock("@/convex/_generated/api", () => ({
  api: {
    cms: {
      pages: { resolveHistoricalPublishedPath: "publication-route" },
      redirects: { resolve: "manual-redirect" },
    },
  },
}))

import { config, proxy } from "./proxy"

describe("public locale proxy", () => {
  beforeEach(() => {
    mocks.getCachedRedirectKeySet.mockClear()
    mocks.fetchQuery.mockClear()
    mocks.refreshSiteConfigState.mockClear()
    mocks.getCachedSiteConfig.mockResolvedValue({
      onboardingCompletedAt: Date.now(),
      enabledLocales: ["en", "fr"],
      defaultLocale: "en",
      languageVersion: 1,
    })
    mocks.getSiteConfigState.mockImplementation(async () => ({
      status: "ready",
      value: await mocks.getCachedSiteConfig(),
    }))
    mocks.getCachedRedirectKeySet.mockResolvedValue(new Set())
    mocks.fetchQuery.mockResolvedValue({ authority: "legacy" })
    mocks.refreshSiteConfigState.mockImplementation(async () => ({
      status: "ready",
      value: await mocks.getCachedSiteConfig(),
    }))
  })

  test.each([
    "/api",
    "/api/",
    "/api/x",
    "/_next/static/chunk.js",
    "/_next/image",
    "/favicon.ico",
    "/docs/file.pdf",
  ])("exported matcher excludes %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false)
  })

  test.each(["/api-reference", "/api-reference/child", "/apiary", "/apix/y"])(
    "exported matcher admits %s for the default-language rewrite",
    async (path) => {
      expect(unstable_doesMiddlewareMatch({ config, url: path })).toBe(true)
      const response = await proxy(
        new NextRequest(`https://example.test${path}`)
      )
      expect(response.headers.get("x-middleware-rewrite")).toBe(
        `https://example.test/en${path}`
      )
    }
  )

  test("refetches config once and re-splits the path after a version mismatch", async () => {
    const stale = {
      onboardingCompletedAt: Date.now(),
      enabledLocales: ["en"],
      defaultLocale: "en",
      languageVersion: 1,
    }
    const fresh = {
      ...stale,
      enabledLocales: ["fr"],
      defaultLocale: "fr",
      languageVersion: 2,
    }
    mocks.getSiteConfigState
      .mockResolvedValueOnce({ status: "ready", value: stale })
      .mockResolvedValueOnce({ status: "ready", value: fresh })
    mocks.refreshSiteConfigState.mockResolvedValue({
      status: "ready",
      value: fresh,
    })
    mocks.fetchQuery
      .mockRejectedValueOnce(new ConvexError("SITE_LANGUAGE_VERSION_CHANGED"))
      .mockResolvedValueOnce({ authority: "legacy" })

    const response = await proxy(
      new NextRequest("http://localhost:3000/services")
    )

    expect(mocks.refreshSiteConfigState).toHaveBeenCalledTimes(1)
    expect(mocks.fetchQuery).toHaveBeenNthCalledWith(
      1,
      "publication-route",
      expect.objectContaining({ locale: "en", languageVersion: 1 })
    )
    expect(mocks.fetchQuery).toHaveBeenNthCalledWith(
      2,
      "publication-route",
      expect.objectContaining({ locale: "fr", languageVersion: 2 })
    )
    expect(response.headers.get("x-middleware-rewrite")).toBe(
      "http://localhost:3000/fr/services"
    )
  })

  test("returns a no-store 503 when the fresh resolver still mismatches", async () => {
    const config = {
      onboardingCompletedAt: Date.now(),
      enabledLocales: ["en"],
      defaultLocale: "en",
      languageVersion: 1,
    }
    mocks.getSiteConfigState.mockResolvedValue({
      status: "ready",
      value: config,
    })
    mocks.refreshSiteConfigState.mockResolvedValue({
      status: "ready",
      value: config,
    })
    mocks.fetchQuery.mockRejectedValue(
      new ConvexError("SITE_LANGUAGE_VERSION_CHANGED")
    )

    const response = await proxy(
      new NextRequest("http://localhost:3000/services")
    )

    expect(mocks.refreshSiteConfigState).toHaveBeenCalledTimes(1)
    expect(mocks.fetchQuery).toHaveBeenCalledTimes(2)
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("retry-after")).toBe("3")
  })

  test("keeps standalone sign-in behind the first-run setup gate", async () => {
    mocks.getCachedSiteConfig.mockResolvedValue({
      onboardingCompletedAt: null,
      enabledLocales: ["en"],
      defaultLocale: "en",
      languageVersion: 1,
    })

    const response = await proxy(
      new NextRequest("http://localhost:3000/sign-in?next=%2Fadmin")
    )

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("http://localhost:3000/setup")
  })

  test("returns a retryable unavailable response when setup state cannot be read", async () => {
    mocks.getSiteConfigState.mockResolvedValueOnce({
      status: "unavailable",
      fallback: {
        onboardingCompletedAt: null,
        enabledLocales: ["en"],
        defaultLocale: "en",
        languageVersion: 1,
      },
    })

    const response = await proxy(new NextRequest("http://localhost:3000/admin"))

    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("retry-after")).toBe("3")
    await expect(response.text()).resolves.toMatch(
      /formulacms is reconnecting[\s\S]*formulacms couldn’t reach its backend[\s\S]*Nothing has been reset/
    )
  })

  describe("first-run gate", () => {
    function notOnboarded() {
      mocks.getCachedSiteConfig.mockResolvedValue({
        onboardingCompletedAt: null,
        enabledLocales: ["en", "fr"],
        defaultLocale: "en",
        languageVersion: 1,
      })
    }

    function requestWithCookies(url: string, cookies: Record<string, string>) {
      const request = new NextRequest(url)
      for (const [name, value] of Object.entries(cookies)) {
        request.cookies.set(name, value)
      }
      return request
    }

    test.each(["/", "/en", "/fr", "/sign-in", "/admin"])(
      "redirects %s to /setup when onboarding has not completed",
      async (pathname) => {
        notOnboarded()

        const response = await proxy(
          new NextRequest(`http://localhost:3000${pathname}`)
        )

        expect(response.status).toBe(307)
        expect(response.headers.get("location")).toBe(
          "http://localhost:3000/setup"
        )
      }
    )

    // Without a simulator the setup gate covers its old path like any other.
    test.each(["/slice-sim", "/slice-sim/x"])(
      "sends %s to /setup before onboarding completes when no simulator ships",
      async (pathname) => {
        notOnboarded()

        const response = await proxy(
          new NextRequest(`http://localhost:3000${pathname}`)
        )

        expect(response.status).toBe(307)
        expect(response.headers.get("location")).toBe(
          "http://localhost:3000/setup"
        )
      }
    )

    test("still sends /admin to /setup before onboarding completes", async () => {
      notOnboarded()

      const response = await proxy(
        new NextRequest("http://localhost:3000/admin")
      )

      expect(response.status).toBe(307)
    })

    // The defect this suite exists for: the wizard used to write
    // `nextcms-onboarded=1` from the browser with a one-year max-age, so any
    // visitor could forge it and any browser that onboarded once kept walking
    // past the gate — even against a deployment whose settings were wiped.
    test("ignores the forgeable legacy cookie and clears it", async () => {
      notOnboarded()

      const response = await proxy(
        requestWithCookies("http://localhost:3000/", {
          "nextcms-onboarded": "1",
        })
      )

      expect(response.status).toBe(307)
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/setup"
      )
      expect(response.cookies.get("nextcms-onboarded")?.value).toBe("")
    })

    // `HttpOnly` would not have saved a cookie-based gate: it stops scripts
    // from writing cookies, not clients from sending them. So no cookie name
    // may open the gate, however it was minted.
    test("no cookie can open the gate", async () => {
      notOnboarded()

      const response = await proxy(
        requestWithCookies("http://localhost:3000/", {
          "nextcms-onboarded": "1",
          "formulacms-setup-complete": "1",
          onboarded: "1",
        })
      )

      expect(response.status).toBe(307)
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/setup"
      )
    })

    test("sends /setup to /admin once onboarding has completed", async () => {
      const response = await proxy(
        new NextRequest("http://localhost:3000/setup")
      )

      expect(response.status).toBe(307)
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/admin"
      )
    })

    test("allows the claim-gated owner recovery path after onboarding", async () => {
      const response = await proxy(
        new NextRequest("http://localhost:3000/setup?recover-owner=1")
      )

      expect(response.status).toBe(200)
      expect(response.headers.get("location")).toBeNull()
    })
  })

  test("removes the default-locale URL prefix with a temporary redirect", async () => {
    const response = await proxy(
      new NextRequest("http://localhost:3000/en/services")
    )

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/services"
    )
  })

  test("gives snapshot historical routes precedence over optional Redirects", async () => {
    mocks.fetchQuery.mockResolvedValueOnce({
      authority: "snapshot_active",
      disposition: "historical_redirect",
      pageId: "ignored",
      locale: "en",
      snapshotId: "ignored",
      publicGeneration: 2,
      destinationPath: "/new-path",
      statusCode: 307,
    })
    const response = await proxy(
      new NextRequest("http://localhost:3000/old-path")
    )
    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/new-path"
    )
    expect(mocks.getCachedRedirectKeySet).not.toHaveBeenCalled()
  })

  describe("historical redirect prefix (M05 M11: the returned locale)", () => {
    function historicalRedirect(locale: string, destinationPath: string) {
      mocks.fetchQuery.mockResolvedValueOnce({
        authority: "snapshot_active",
        disposition: "historical_redirect",
        pageId: "ignored",
        locale,
        snapshotId: "ignored",
        publicGeneration: 2,
        destinationPath,
        statusCode: 307,
      })
    }

    function defaultLocale(locale: string) {
      mocks.getCachedSiteConfig.mockResolvedValue({
        onboardingCompletedAt: Date.now(),
        enabledLocales: ["en", "fr"],
        defaultLocale: locale,
        languageVersion: 1,
      })
    }

    test.each([
      // Continuity after a default change: the old default's page keeps its
      // language, so its URL takes that language's prefix.
      ["en", "/contact", "fr", "/contact", "/fr/contact"],
      ["fr", "/contact", "en", "/contact", "/en/contact"],
      // A destination in the default language is unprefixed.
      ["fr", "/a-propos-old", "fr", "/a-propos", "/a-propos"],
      // Same-locale F08 history under a prefix keeps its prefix.
      ["en", "/fr/old-path", "fr", "/new-path", "/fr/new-path"],
      // A home destination: `NextURL` drops the trailing slash of `/<locale>/`
      // when it formats the location, so it is one redirect to `/<locale>`.
      ["en", "/fr/accueil-old", "fr", "/", "/fr"],
      ["fr", "/home-old", "en", "/", "/en"],
    ])(
      "default %s: %s returned in %s at %s redirects to %s",
      async (defaultCode, requestPath, locale, destinationPath, location) => {
        defaultLocale(defaultCode)
        historicalRedirect(locale, destinationPath)

        const response = await proxy(
          new NextRequest(`http://localhost:3000${requestPath}`)
        )

        expect(response.status).toBe(307)
        expect(response.headers.get("location")).toBe(
          `http://localhost:3000${location}`
        )
        expect(mocks.getCachedRedirectKeySet).not.toHaveBeenCalled()
      }
    )
  })

  test("does not run optional redirects or legacy home aliases for an unavailable snapshot reservation", async () => {
    mocks.fetchQuery.mockResolvedValueOnce({
      authority: "snapshot_active",
      disposition: "historical_unavailable",
    })
    const response = await proxy(new NextRequest("http://localhost:3000/home"))
    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("x-middleware-rewrite")).toBe(
      "http://localhost:3000/en/home"
    )
    expect(mocks.getCachedRedirectKeySet).not.toHaveBeenCalled()
  })

  test.each([
    ["/homepage", "/"],
    ["/home", "/"],
    ["/fr/homepage", "/fr"],
    ["/fr/home", "/fr"],
    ["/fr/accueil", "/fr"],
    ["/fr/accuiel", "/fr"],
    ["/en/homepage", "/"],
    ["/en/home", "/"],
  ])(
    "returns a native permanent response for Home alias %s",
    async (source, target) => {
      const response = await proxy(
        new NextRequest(`http://localhost:3000${source}`)
      )

      expect(response.status).toBe(308)
      expect(response.headers.get("location")).toBe(
        `http://localhost:3000${target}`
      )
      expect(response.headers.get("x-middleware-rewrite")).toBeNull()
    }
  )

  test.each(["/fr/home", "/fr/accueil"])(
    "keeps disabled-locale Home alias %s fail-closed",
    async (source) => {
      mocks.getCachedSiteConfig.mockResolvedValue({
        onboardingCompletedAt: Date.now(),
        enabledLocales: ["en"],
        defaultLocale: "en",
        languageVersion: 1,
      })

      const response = await proxy(
        new NextRequest(`http://localhost:3000${source}`)
      )

      expect(response.headers.get("location")).toBeNull()
      expect(response.headers.get("x-middleware-rewrite")).toBeNull()
      expect(response.headers.get("x-middleware-next")).toBe("1")
    }
  )

  test("does not reinterpret a disabled locale prefix as the sole default locale", async () => {
    mocks.getCachedSiteConfig.mockResolvedValue({
      onboardingCompletedAt: Date.now(),
      enabledLocales: ["en"],
      defaultLocale: "en",
      languageVersion: 1,
    })

    const response = await proxy(
      new NextRequest("http://localhost:3000/fr/services")
    )

    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("x-middleware-rewrite")).toBeNull()
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })

  test("an enabled locale prefix owns the first segment before publication lookup", async () => {
    mocks.getCachedSiteConfig.mockResolvedValue({
      onboardingCompletedAt: Date.now(),
      enabledLocales: ["en", "fr", "de"],
      defaultLocale: "en",
      languageVersion: 2,
    })
    mocks.fetchQuery.mockResolvedValue({
      authority: "snapshot_active",
      disposition: "unclaimed",
    })

    await proxy(new NextRequest("http://localhost:3000/de/contact"))

    expect(mocks.fetchQuery).toHaveBeenCalledWith("publication-route", {
      locale: "de",
      path: "/contact",
      languageVersion: 2,
    })
  })

  test("keeps a sole non-English default locale canonical and unprefixed", async () => {
    mocks.getCachedSiteConfig.mockResolvedValue({
      onboardingCompletedAt: Date.now(),
      enabledLocales: ["fr"],
      defaultLocale: "fr",
      languageVersion: 1,
    })

    const prefixed = await proxy(
      new NextRequest("http://localhost:3000/fr/services")
    )
    const unprefixed = await proxy(
      new NextRequest("http://localhost:3000/services")
    )

    expect(prefixed.status).toBe(307)
    expect(prefixed.headers.get("location")).toBe(
      "http://localhost:3000/services"
    )
    expect(unprefixed.headers.get("x-middleware-rewrite")).toBe(
      "http://localhost:3000/fr/services"
    )
  })
})

// Routing: the URL alone picks the language. Unprefixed addresses always use
// the site default language, whatever the browser sends. The REAL
// `next-intl/middleware` runs; only Convex is mocked.
describe("public proxy on next-intl (default language wins)", () => {
  const CURRENT = {
    authority: "snapshot_active",
    disposition: "current",
    pageId: "p",
    locale: "en",
    snapshotId: "s",
    publicGeneration: 1,
  }
  const UNCLAIMED = { authority: "snapshot_active", disposition: "unclaimed" }
  const BROWSERS: Array<[string, { cookie?: string; acceptLanguage?: string }]> =
    [
      ["no browser hints", {}],
      ["Accept-Language fr", { acceptLanguage: "fr-FR,fr;q=0.9" }],
      ["Accept-Language de", { acceptLanguage: "de" }],
      ["an old NEXT_LOCALE=fr cookie", { cookie: "NEXT_LOCALE=fr" }],
      [
        "an old NEXT_LOCALE=es cookie and Accept-Language fr",
        { cookie: "NEXT_LOCALE=es", acceptLanguage: "fr" },
      ],
    ]

  function request(
    path: string,
    init: { cookie?: string; acceptLanguage?: string } = {}
  ) {
    const headers = new Headers()
    if (init.cookie) headers.set("cookie", init.cookie)
    if (init.acceptLanguage) headers.set("accept-language", init.acceptLanguage)
    return new NextRequest(`http://localhost:3000${path}`, { headers })
  }

  /** Publication answers by `(locale, path)`; manual rules by a given map. */
  function backend(
    publication: (args: Record<string, unknown>) => unknown,
    manual: unknown = null
  ) {
    mocks.fetchQuery.mockImplementation(async (ref: string, args) =>
      ref === "publication-route"
        ? publication(args as Record<string, unknown>)
        : manual
    )
  }

  const setCookies = (response: Response) => response.headers.getSetCookie()
  const publicationCalls = () =>
    mocks.fetchQuery.mock.calls.filter(([ref]) => ref === "publication-route")
  const heal = (locale: string, destinationPath = "/") => ({
    ...UNCLAIMED,
    selfHeal: {
      pageId: "p",
      locale,
      destinationPath,
      snapshotId: "s",
      publicGeneration: 1,
    },
  })

  beforeEach(() => {
    mocks.fetchQuery.mockReset()
    mocks.upstreamVary.value = null
    mocks.getCachedRedirectKeySet.mockResolvedValue(new Set())
    mocks.getCachedSiteConfig.mockResolvedValue({
      onboardingCompletedAt: Date.now(),
      enabledLocales: ["en", "fr", "es"],
      defaultLocale: "en",
      languageVersion: 1,
    })
  })

  test.each(["/", "/about"])(
    "%s gives the identical default-language response whatever the browser sends",
    async (path) => {
      backend(() => CURRENT)
      const rewrite = `http://localhost:3000/en${path === "/" ? "" : path}`
      for (const [, init] of BROWSERS) {
        const response = await proxy(request(path, init))
        expect(response.status).toBe(200)
        expect(response.headers.get("x-middleware-rewrite")).toBe(rewrite)
        expect(response.headers.get("location")).toBeNull()
        expect(setCookies(response)).toEqual([])
        expect(response.headers.get("vary") ?? "").not.toMatch(
          /Accept-Language|Cookie/i
        )
      }
      for (const [, args] of publicationCalls()) {
        expect(args).toEqual({
          path,
          locale: "en",
          languageVersion: 1,
        })
      }
    }
  )

  test.each(BROWSERS)(
    "unclaimed / and unknown paths are served in the default language with %s",
    async (_name, init) => {
      backend(() => UNCLAIMED)
      for (const path of ["/", "/unknown/path"]) {
        const response = await proxy(request(path, init))
        expect(response.headers.get("location")).toBeNull()
        expect(response.headers.get("x-middleware-rewrite")).toBe(
          `http://localhost:3000/en${path === "/" ? "" : path}`
        )
        expect(setCookies(response)).toEqual([])
      }
    }
  )

  test("hands next-intl detection off and the locale cookie off", async () => {
    backend(() => CURRENT)
    mocks.intlOptions.length = 0

    await proxy(request("/about"))

    expect(mocks.intlOptions.length).toBeGreaterThan(0)
    for (const options of mocks.intlOptions) {
      expect(options.localeDetection).toBe(false)
      expect(options.localeCookie).toBe(false)
    }
  })

  test("an explicit French URL serves French and writes no cookie", async () => {
    backend((args) => ({ ...CURRENT, locale: args.locale }))

    const response = await proxy(
      request("/fr/a-propos", { cookie: "NEXT_LOCALE=en", acceptLanguage: "de" })
    )

    expect(publicationCalls()[0]![1]).toEqual({
      path: "/a-propos",
      locale: "fr",
      languageVersion: 1,
    })
    expect(response.headers.get("x-middleware-next")).toBe("1")
    expect(response.headers.get("x-middleware-override-headers")).toMatch(
      /x-next-intl-locale/i
    )
    expect(response.headers.get("x-middleware-rewrite")).toBeNull()
    expect(setCookies(response)).toEqual([])
    expect(response.headers.get("vary") ?? "").not.toMatch(
      /Accept-Language|Cookie/i
    )
  })

  test.each([
    ["/en", "http://localhost:3000/"],
    ["/en/about", "http://localhost:3000/about"],
  ])(
    "the default-language prefix %s is stripped with a temporary redirect and no cookie",
    async (path, location) => {
      backend(() => CURRENT)

      for (const [, init] of BROWSERS) {
        const response = await proxy(request(path, init))
        expect(response.status).toBe(307)
        expect(response.headers.get("location")).toBe(location)
        expect(setCookies(response)).toEqual([])
      }
    }
  )

  test("an upstream Vary value is left untouched", async () => {
    backend(() => CURRENT)
    mocks.upstreamVary.value = "Accept-Encoding"

    const response = await proxy(request("/about", { acceptLanguage: "fr" }))

    expect(response.headers.get("vary")).toBe("Accept-Encoding")
  })

  test("a historical redirect ends on the destination language with no cookie", async () => {
    backend(() => ({
      authority: "snapshot_active",
      disposition: "historical_redirect",
      pageId: "p",
      locale: "en",
      snapshotId: "s",
      publicGeneration: 1,
      destinationPath: "/new",
      statusCode: 307,
    }))

    const response = await proxy(
      request("/en/old", { cookie: "NEXT_LOCALE=fr", acceptLanguage: "fr" })
    )

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("http://localhost:3000/new")
    expect(setCookies(response)).toEqual([])
  })

  test("legacy authority serves the default language and ignores browser hints", async () => {
    backend(() => ({ authority: "legacy" }))

    const response = await proxy(
      request("/about", { cookie: "NEXT_LOCALE=fr", acceptLanguage: "fr" })
    )

    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("x-middleware-rewrite")).toBe(
      "http://localhost:3000/en/about"
    )
    expect(setCookies(response)).toEqual([])
  })

  test("legacy Home alias stays a 308 without a cookie write", async () => {
    backend(() => ({ authority: "legacy" }))

    const response = await proxy(
      request("/homepage", { cookie: "NEXT_LOCALE=fr", acceptLanguage: "fr" })
    )

    expect(response.status).toBe(308)
    expect(setCookies(response)).toEqual([])
  })

  test("publication precedence: a manual rule beats the self-heal candidate; self-heal answers when the rule misses", async () => {
    mocks.getCachedRedirectKeySet.mockResolvedValue(null)

    backend(() => heal("en", "/about"), {
      destination: "/manual-target",
      statusCode: 301,
    })
    const manual = await proxy(request("/a-propos"))
    expect(manual.status).toBe(301)
    expect(manual.headers.get("location")).toBe(
      "http://localhost:3000/manual-target"
    )

    backend(() => heal("en", "/about"), null)
    const healed = await proxy(request("/a-propos"))
    expect(healed.status).toBe(307)
    expect(healed.headers.get("location")).toBe("http://localhost:3000/about")
  })

  test("a contained Redirects lookup failure skips self-heal and falls through to normal routing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.getCachedRedirectKeySet.mockResolvedValue(null)
    mocks.fetchQuery.mockImplementation(async (ref: string) => {
      if (ref === "publication-route") return heal("en", "/about")
      throw new Error("fetch failed")
    })

    const response = await proxy(request("/a-propos"))

    expect(response.headers.get("location")).toBeNull()
    expect(response.status).toBeLessThan(500)
    consoleError.mockRestore()
  })

  test("self-heal: with the default home unpublished, / goes to the published home in another language whatever the browser sends", async () => {
    backend(() => heal("fr"))

    for (const [, init] of BROWSERS) {
      const response = await proxy(request("/", init))
      expect(response.status).toBe(307)
      expect(response.headers.get("location")).toBe("http://localhost:3000/fr")
      expect(setCookies(response)).toEqual([])
      expect(response.headers.get("vary") ?? "").not.toMatch(
        /Accept-Language|Cookie/i
      )
    }
  })

  test("self-heal toward the default language drops the prefix", async () => {
    backend(() => heal("en", "/x"))

    const response = await proxy(request("/y", { acceptLanguage: "fr" }))

    expect(response.headers.get("location")).toBe("http://localhost:3000/x")
    expect(setCookies(response)).toEqual([])
  })

  test("an unavailable reservation is terminal: no manual rule, no self-heal", async () => {
    mocks.getCachedRedirectKeySet.mockResolvedValue(null)
    backend(
      () => ({
        authority: "snapshot_active",
        disposition: "historical_unavailable",
      }),
      { destination: "/manual-target", statusCode: 301 }
    )

    const response = await proxy(request("/a-propos"))

    expect(response.headers.get("location")).toBeNull()
    expect(mocks.fetchQuery).toHaveBeenCalledTimes(1)
  })

  test("a version mismatch on the lookup refreshes once and retries without browser hints", async () => {
    mocks.fetchQuery
      .mockRejectedValueOnce(new ConvexError("SITE_LANGUAGE_VERSION_CHANGED"))
      .mockResolvedValueOnce(CURRENT)

    const response = await proxy(request("/about", { acceptLanguage: "fr" }))

    expect(mocks.refreshSiteConfigState).toHaveBeenCalledTimes(1)
    expect(mocks.fetchQuery).toHaveBeenCalledTimes(2)
    expect(mocks.fetchQuery.mock.calls[1]![1]).not.toHaveProperty(
      "preferredLocale"
    )
    expect(response.headers.get("x-middleware-rewrite")).toBe(
      "http://localhost:3000/en/about"
    )
  })

  test("excluded paths never reach next-intl or Convex", async () => {
    for (const path of ["/admin", "/admin/pages", "/sign-in"]) {
      const response = await proxy(
        request(path, { cookie: "NEXT_LOCALE=fr", acceptLanguage: "fr" })
      )
      expect(response.headers.get("x-middleware-next")).toBe("1")
      expect(setCookies(response)).toEqual([])
      expect(response.headers.get("vary") ?? "").not.toMatch(/Accept-Language/)
    }
    expect(mocks.fetchQuery).not.toHaveBeenCalled()
  })
})
