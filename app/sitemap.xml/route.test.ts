import * as robotsModule from "../robots"
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

function locs(body: string): string[] {
  return [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!)
}

describe("version-pinned sitemap index (M05 C5a)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("retries with fresh config and lists every child of the ready manifest", async () => {
    let configRead = 0
    mocks.fetchQuery.mockImplementation(async (reference, args) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/settings:getSiteConfig") {
        configRead += 1
        return config(configRead === 1 ? 1 : 2)
      }
      if ((args as { languageVersion?: number }).languageVersion === 1) {
        throw new ConvexError("SITE_LANGUAGE_VERSION_CHANGED")
      }
      if (name === "cms/pages:getSitemapIndex") {
        return {
          manifestVersion: 3,
          locales: [
            { locale: "en", partitions: 2 },
            { locale: "fr", partitions: 1 },
          ],
        }
      }
      throw new Error(`Unexpected query: ${name}`)
    })

    const response = await GET()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/xml")
    const body = await response.text()
    expect(body).toContain("<sitemapindex")
    expect(locs(body)).toEqual([
      "https://example.com/sitemaps/3/en/0.xml",
      "https://example.com/sitemaps/3/en/1.xml",
      "https://example.com/sitemaps/3/fr/0.xml",
    ])
    expect(configRead).toBe(2)
  })

  test("lists one version-0 child per enabled locale until a manifest is ready", async () => {
    mocks.fetchQuery.mockImplementation(async (reference) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/settings:getSiteConfig") return config(4)
      if (name === "cms/pages:getSitemapIndex") {
        return {
          manifestVersion: 0,
          locales: [
            { locale: "en", partitions: 1 },
            { locale: "fr", partitions: 1 },
          ],
        }
      }
      throw new Error(`Unexpected query: ${name}`)
    })

    const body = await (await GET()).text()

    expect(locs(body)).toEqual([
      "https://example.com/sitemaps/0/en/0.xml",
      "https://example.com/sitemaps/0/fr/0.xml",
    ])
    expect(mocks.fetchQuery).toHaveBeenCalledWith(expect.anything(), {
      languageVersion: 4,
    })
  })

  test("answers a second version mismatch with a no-store 503 and Retry-After", async () => {
    let configRead = 0
    mocks.fetchQuery.mockImplementation(async (reference) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/settings:getSiteConfig") {
        configRead += 1
        return config(2)
      }
      throw new ConvexError("SITE_LANGUAGE_VERSION_CHANGED")
    })

    const response = await GET()

    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBe("3")
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await response.text()
    expect(body).not.toContain("<sitemapindex")
    expect(configRead).toBe(2)
  })

  test("other failures are not disguised as a language-change 503", async () => {
    mocks.fetchQuery.mockRejectedValue(new Error("backend down"))

    await expect(GET()).rejects.toThrow("backend down")
  })
})


test("ED3 robots keeps force-dynamic output without a dead revalidation export", async () => {
  mocks.fetchQuery.mockResolvedValue(config(1))
  expect(Object.hasOwn(robotsModule, "revalidate")).toBe(false)
  expect(robotsModule.dynamic).toBe("force-dynamic")
  expect(await robotsModule.default()).toEqual({ rules: { userAgent: "*", allow: "/", disallow: ["/admin/", "/api/", "/sign-in"] }, sitemap: "https://example.com/sitemap.xml" })
})
