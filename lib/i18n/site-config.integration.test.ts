import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const transport = vi.hoisted(() => ({ fetchQuery: vi.fn() }))

// Only the transport is synthetic: generated references, cache generations,
// refresh, version classification and Next request/response handling stay real.
vi.mock("convex/nextjs", () => ({ fetchQuery: transport.fetchQuery }))

const STALE = {
  onboardingCompletedAt: 1,
  defaultLocale: "en",
  enabledLocales: ["en"],
  languageVersion: 1,
}
const FRESH = {
  ...STALE,
  defaultLocale: "fr",
  enabledLocales: ["fr"],
  languageVersion: 2,
}

type QueryStep = {
  name: string
  args: Record<string, unknown>
} & ({ value: unknown } | { error: Error })

async function loadRealBoundary() {
  const { getFunctionName } = await import("convex/server")
  const { ConvexError } = await import("convex/values")
  const { NextRequest, NextResponse } = await import("next/server")
  const { api } = await import("@/convex/_generated/api")
  const siteConfig = await import("./site-config")
  const { proxy } = await import("@/proxy")
  return {
    getFunctionName,
    ConvexError,
    NextRequest,
    NextResponse,
    api,
    siteConfig,
    proxy,
  }
}

function scriptQueries(
  getFunctionName: Awaited<ReturnType<typeof loadRealBoundary>>["getFunctionName"],
  steps: QueryStep[]
) {
  const observed: { name: string; args: Record<string, unknown> }[] = []
  transport.fetchQuery.mockImplementation(async (reference, args) => {
    const call = { name: getFunctionName(reference), args }
    const step = steps[observed.length]
    observed.push(call)
    expect(step, "unexpected transport query").toBeDefined()
    expect(call).toEqual({ name: step.name, args: step.args })
    if ("error" in step) throw step.error
    return step.value
  })
  return observed
}

describe("real proxy and site-config refresh integration", () => {
  beforeEach(() => {
    vi.resetModules()
    transport.fetchQuery.mockReset()
    // Leave promise microtasks and the runner's clocks real. Control only the
    // application timeout/TTL clock before importing stateful application code.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    vi.setSystemTime(1_800_000_000_000)
  })

  afterEach(async () => {
    try {
      // Successful config reads leave the losing 750ms Promise.race timers.
      // Drain their real callbacks under the controlled clock before restoring.
      await vi.runOnlyPendingTimersAsync()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
      transport.fetchQuery.mockReset()
      vi.resetModules()
    }
  })

  test.each([
    { label: "cold cache", prime: false },
    { label: "primed cache", prime: true },
  ])("refreshes authority and re-splits the request with $label", async ({ prime }) => {
    const boundary = await loadRealBoundary()
    const { api, getFunctionName, siteConfig, proxy, NextRequest, NextResponse } =
      boundary
    const configName = getFunctionName(api.cms.settings.getSiteConfig)
    const routeName = getFunctionName(api.cms.pages.resolveHistoricalPublishedPath)
    const steps: QueryStep[] = [
      { name: configName, args: {}, value: STALE },
      {
        name: routeName,
        args: { path: "/services", locale: "en", languageVersion: 1 },
        error: new boundary.ConvexError("SITE_LANGUAGE_VERSION_CHANGED"),
      },
      { name: configName, args: {}, value: FRESH },
      {
        name: routeName,
        args: { path: "/services", locale: "fr", languageVersion: 2 },
        // A claimed snapshot route avoids unrelated optional Redirects queries.
        value: {
          authority: "snapshot_active",
          disposition: "current",
          pageId: "synthetic-page",
          locale: "fr",
          snapshotId: "synthetic-snapshot",
          publicGeneration: 1,
        },
      },
    ]
    const observed = scriptQueries(getFunctionName, steps)
    if (prime) {
      await expect(siteConfig.getSiteConfigState()).resolves.toEqual({
        status: "ready",
        value: STALE,
      })
      // Demonstrate admission of the stale entry without another query, before
      // the version-mismatch path must independently refresh that same cache.
      await expect(siteConfig.getSiteConfigState()).resolves.toEqual({
        status: "ready",
        value: STALE,
      })
      expect(transport.fetchQuery).toHaveBeenCalledTimes(1)
    }

    const request = new NextRequest("http://localhost:3000/services?from=proof")
    const response = await proxy(request)

    expect(response).toBeInstanceOf(NextResponse)
    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-rewrite")).toBe(
      "http://localhost:3000/fr/services?from=proof"
    )
    expect(response.headers.get("location")).toBeNull()
    expect(request.nextUrl.pathname).toBe("/services")
    expect(observed).toEqual(steps.map(({ name, args }) => ({ name, args })))
    expect(transport.fetchQuery).toHaveBeenCalledTimes(4)
    await expect(siteConfig.getSiteConfigState()).resolves.toEqual({
      status: "ready",
      value: FRESH,
    })
    expect(transport.fetchQuery).toHaveBeenCalledTimes(4)
  })

  test("stops after a second version mismatch with a no-store retryable 503", async () => {
    const boundary = await loadRealBoundary()
    const { api, getFunctionName, siteConfig, proxy, NextRequest, NextResponse } =
      boundary
    const configName = getFunctionName(api.cms.settings.getSiteConfig)
    const routeName = getFunctionName(api.cms.pages.resolveHistoricalPublishedPath)
    const steps: QueryStep[] = [
      { name: configName, args: {}, value: STALE },
      {
        name: routeName,
        args: { path: "/services", locale: "en", languageVersion: 1 },
        error: new boundary.ConvexError("SITE_LANGUAGE_VERSION_CHANGED"),
      },
      { name: configName, args: {}, value: FRESH },
      {
        name: routeName,
        args: { path: "/services", locale: "fr", languageVersion: 2 },
        error: new boundary.ConvexError("SITE_LANGUAGE_VERSION_CHANGED"),
      },
    ]
    const observed = scriptQueries(getFunctionName, steps)
    await expect(siteConfig.getSiteConfigState()).resolves.toEqual({
      status: "ready",
      value: STALE,
    })

    const response = await proxy(
      new NextRequest("http://localhost:3000/services")
    )

    expect(response).toBeInstanceOf(NextResponse)
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("retry-after")).toBe("3")
    expect(response.headers.get("x-middleware-rewrite")).toBeNull()
    expect(response.headers.get("location")).toBeNull()
    expect(observed).toEqual(steps.map(({ name, args }) => ({ name, args })))
    expect(transport.fetchQuery).toHaveBeenCalledTimes(4)
    await expect(siteConfig.getSiteConfigState()).resolves.toEqual({
      status: "ready",
      value: FRESH,
    })
    expect(transport.fetchQuery).toHaveBeenCalledTimes(4)
  })

  test("returns a no-store 503 when both fresh config attempts fail", async () => {
    const boundary = await loadRealBoundary()
    const { api, getFunctionName, siteConfig, proxy, NextRequest, NextResponse } =
      boundary
    const configName = getFunctionName(api.cms.settings.getSiteConfig)
    const routeName = getFunctionName(api.cms.pages.resolveHistoricalPublishedPath)
    const steps: QueryStep[] = [
      { name: configName, args: {}, value: STALE },
      {
        name: routeName,
        args: { path: "/services", locale: "en", languageVersion: 1 },
        error: new boundary.ConvexError("SITE_LANGUAGE_VERSION_CHANGED"),
      },
      {
        name: configName,
        args: {},
        error: new Error("synthetic fresh config failure"),
      },
      {
        name: configName,
        args: {},
        error: new Error("synthetic fresh config retry failure"),
      },
    ]
    const observed = scriptQueries(getFunctionName, steps)
    await expect(siteConfig.getSiteConfigState()).resolves.toEqual({
      status: "ready",
      value: STALE,
    })
    await expect(siteConfig.getSiteConfigState()).resolves.toEqual({
      status: "ready",
      value: STALE,
    })
    expect(transport.fetchQuery).toHaveBeenCalledTimes(1)

    const response = await proxy(
      new NextRequest("http://localhost:3000/services")
    )

    expect(response).toBeInstanceOf(NextResponse)
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("retry-after")).toBe("3")
    expect(response.headers.get("x-middleware-rewrite")).toBeNull()
    expect(response.headers.get("location")).toBeNull()
    expect(observed).toEqual(steps.map(({ name, args }) => ({ name, args })))
    expect(transport.fetchQuery).toHaveBeenCalledTimes(4)
  })

  // Order 12 P2 stored-D row "invalid stored Settings/backend result": when the
  // backend refuses stored language authority as invalid, a cold proxy fails
  // closed. It must not treat the refusal as a fresh deployment and hand the
  // visitor the first-run /setup wizard.
  test.each(["/", "/setup", "/admin"])(
    "a cold proxy answers %s with a no-store 503 when stored language authority is invalid",
    async (path) => {
      const boundary = await loadRealBoundary()
      const { api, getFunctionName, proxy, NextRequest, NextResponse } =
        boundary
      const configName = getFunctionName(api.cms.settings.getSiteConfig)
      const steps: QueryStep[] = [
        {
          name: configName,
          args: {},
          error: new boundary.ConvexError("SITE_LANGUAGE_AUTHORITY_INVALID"),
        },
        {
          name: configName,
          args: {},
          error: new boundary.ConvexError("SITE_LANGUAGE_AUTHORITY_INVALID"),
        },
      ]
      const observed = scriptQueries(getFunctionName, steps)

      const response = await proxy(
        new NextRequest(`http://localhost:3000${path}`)
      )

      expect(response).toBeInstanceOf(NextResponse)
      expect(response.status).toBe(503)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("location")).toBeNull()
      expect(response.headers.get("x-middleware-rewrite")).toBeNull()
      expect(observed).toEqual(steps.map(({ name, args }) => ({ name, args })))
    }
  )
})
