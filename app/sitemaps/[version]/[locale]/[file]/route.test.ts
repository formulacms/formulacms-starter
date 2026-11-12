import { ConvexError } from "convex/values"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ fetchQuery: vi.fn() }))

vi.mock("convex/nextjs", () => ({ fetchQuery: mocks.fetchQuery }))
vi.mock("@/lib/cms/cache", () => ({
  cachedCmsRead: (run: () => unknown) => run(),
  isSiteLanguageVersionChanged: (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    error.data === "SITE_LANGUAGE_VERSION_CHANGED",
  CMS_TAGS: { pages: "pages", settings: "settings" },
}))

import { GET } from "./route"

const LAST_MODIFIED = 1_800_000_000_000

function config(languageVersion: number) {
  return {
    onboardingCompletedAt: 1,
    defaultLocale: "en",
    enabledLocales: ["en", "fr"],
    homePageId: null,
    siteUrl: "https://example.com",
    timezone: "UTC",
    languageVersion,
  }
}

function request(version: string, locale: string, file: string) {
  return GET(new Request("https://example.com/sitemaps"), {
    params: Promise.resolve({ version, locale, file }),
  })
}

function answer(child: unknown) {
  mocks.fetchQuery.mockImplementation(async (reference) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/settings:getSiteConfig") return config(5)
    if (name === "cms/pages:getSitemapChild") return child
    throw new Error(`Unexpected query: ${name}`)
  })
}

describe("version-pinned sitemap child (M05 C5a)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("serves the partition's entries with their SEO alternates", async () => {
    answer({
      status: "ok",
      entries: [
        {
          url: "/fr/bonjour",
          lastModified: LAST_MODIFIED,
          priority: 0.5,
          alternates: [
            { locale: "en", url: "/hello" },
            { locale: "fr", url: "/fr/bonjour" },
          ],
        },
        {
          url: "/fr/seul",
          lastModified: LAST_MODIFIED,
          priority: 0.5,
          alternates: [],
        },
      ],
    })

    const response = await request("3", "fr", "2.xml")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/xml")
    const body = await response.text()
    expect(body).toContain("<loc>https://example.com/fr/bonjour</loc>")
    expect(body).toContain("<loc>https://example.com/fr/seul</loc>")
    expect(body).toContain(
      `<lastmod>${new Date(LAST_MODIFIED).toISOString()}</lastmod>`
    )
    expect(body).toContain('hreflang="en"')
    expect(body).toContain('href="https://example.com/hello"')
    expect(body.match(/xhtml:link/g)).toHaveLength(3)
    expect(mocks.fetchQuery).toHaveBeenCalledWith(expect.anything(), {
      languageVersion: 5,
      manifestVersion: 3,
      locale: "fr",
      ordinal: 2,
    })
  })

  function links(body: string) {
    return [...body.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map(
      (match) => [match[1], match[2]]
    )
  }

  test("emits x-default = the default language's URL when the default alternate is listed, reciprocally and absolutely", async () => {
    answer({
      status: "ok",
      entries: [
        {
          url: "/fr/a-propos",
          lastModified: LAST_MODIFIED,
          priority: 0.5,
          alternates: [
            { locale: "en", url: "/about" },
            { locale: "fr", url: "/fr/a-propos" },
          ],
        },
      ],
    })

    const french = links(await (await request("3", "fr", "0.xml")).text())
    expect(french).toEqual([
      ["en", "https://example.com/about"],
      ["fr", "https://example.com/fr/a-propos"],
      ["x-default", "https://example.com/about"],
    ])

    answer({
      status: "ok",
      entries: [
        {
          url: "/about",
          lastModified: LAST_MODIFIED,
          priority: 0.5,
          alternates: [
            { locale: "en", url: "/about" },
            { locale: "fr", url: "/fr/a-propos" },
          ],
        },
      ],
    })
    const english = links(await (await request("3", "en", "0.xml")).text())
    expect(
      new Set(english.map(([hreflang, href]) => `${hreflang} ${href}`))
    ).toEqual(new Set(french.map(([hreflang, href]) => `${hreflang} ${href}`)))
  })

  test("emits no x-default when the default language is not among the alternates", async () => {
    answer({
      status: "ok",
      entries: [
        {
          url: "/fr/a-propos",
          lastModified: LAST_MODIFIED,
          priority: 0.5,
          alternates: [
            { locale: "fr", url: "/fr/a-propos" },
            { locale: "es", url: "/es/acerca" },
          ],
        },
      ],
    })

    const body = await (await request("3", "fr", "0.xml")).text()
    expect(body).not.toContain("x-default")
    expect(links(body).map(([hreflang]) => hreflang)).toEqual(["fr", "es"])
  })

  test("translated ancestry keeps its own absolute URLs and points x-default at the default", async () => {
    answer({
      status: "ok",
      entries: [
        {
          url: "/fr/services/conseil",
          lastModified: LAST_MODIFIED,
          priority: 0.5,
          alternates: [
            { locale: "en", url: "/services/consulting" },
            { locale: "fr", url: "/fr/services/conseil" },
          ],
        },
      ],
    })

    expect(
      links(await (await request("3", "fr", "0.xml")).text())
    ).toContainEqual(["x-default", "https://example.com/services/consulting"])
  })

  test("after a default-language change x-default follows the pinned default", async () => {
    mocks.fetchQuery.mockImplementation(async (reference) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/settings:getSiteConfig") {
        return { ...config(6), defaultLocale: "fr" }
      }
      return {
        status: "ok",
        entries: [
          {
            url: "/a-propos",
            lastModified: LAST_MODIFIED,
            priority: 0.5,
            alternates: [
              { locale: "fr", url: "/a-propos" },
              { locale: "en", url: "/en/about" },
            ],
          },
        ],
      }
    })

    const body = await (await request("3", "fr", "0.xml")).text()
    expect(links(body)).toContainEqual([
      "x-default",
      "https://example.com/a-propos",
    ])
    expect(links(body)).not.toContainEqual([
      "x-default",
      "https://example.com/en/about",
    ])
  })

  test("an unknown manifest, locale or partition is a no-store 404", async () => {
    answer({ status: "not_found" })

    const response = await request("9", "fr", "0.xml")

    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("an overflow, oversized partition or read budget is a no-store 503", async () => {
    for (const reason of ["overflow", "oversized", "read_budget"]) {
      answer({ status: "unavailable", reason })

      const response = await request("1", "en", "0.xml")

      expect(response.status).toBe(503)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("retry-after")).toBe("3")
    }
  })

  test("malformed segments are a no-store 404 without a backend read", async () => {
    for (const [version, file] of [
      ["x", "0.xml"],
      ["1", "0.json"],
      ["1", "-1.xml"],
      ["01", "0.xml"],
      ["1", "1.5.xml"],
    ] as const) {
      const response = await request(version, "en", file)
      expect(response.status).toBe(404)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
    expect(mocks.fetchQuery).not.toHaveBeenCalled()
  })

  test("retries once with fresh config, then answers a second mismatch with a no-store 503", async () => {
    let configRead = 0
    mocks.fetchQuery.mockImplementation(async (reference, args) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/settings:getSiteConfig") {
        configRead += 1
        return config(configRead === 1 ? 1 : 2)
      }
      if ((args as { languageVersion: number }).languageVersion === 1) {
        throw new ConvexError("SITE_LANGUAGE_VERSION_CHANGED")
      }
      return { status: "ok", entries: [] }
    })
    expect((await request("1", "en", "0.xml")).status).toBe(200)
    expect(configRead).toBe(2)

    mocks.fetchQuery.mockImplementation(async (reference) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/settings:getSiteConfig") return config(2)
      throw new ConvexError("SITE_LANGUAGE_VERSION_CHANGED")
    })
    const response = await request("1", "en", "0.xml")
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("retry-after")).toBe("3")
  })

  test("other failures are not disguised as a 503", async () => {
    mocks.fetchQuery.mockRejectedValue(new Error("backend down"))

    await expect(request("1", "en", "0.xml")).rejects.toThrow("backend down")
  })
})
