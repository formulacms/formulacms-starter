import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { SUPPORTED_LOCALES } from "@/lib/i18n/config"
import {
  getPublicPreviewFallback,
  PUBLIC_MESSAGES,
  PUBLIC_PREVIEW_FALLBACK,
} from "@/lib/i18n/public-messages"

const ROOT = process.cwd()
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8")

// FR2e (D-7): Search's `searchPublishedPages` is checked in
// convex/search.boundaries.test.ts, which ships only with Search.
const REGISTERED_PUBLIC_READERS = [
  ["convex/cms/pages.ts", "getPublicPageById"],
  ["convex/cms/pages.ts", "getPublicByline"],
  ["convex/cms/pages.ts", "getSitemapIndex"],
  ["convex/cms/pages.ts", "getSitemapChild"],
  ["convex/cms/pages.ts", "getLocalizedPathsByIds"],
  ["convex/cms/pages.ts", "getPublicRelationCardsByIds"],
  ["convex/cms/pages.ts", "listRecentPublicRelationCards"],
  ["convex/cms/pages.ts", "getLocalizedBreadcrumb"],
  ["convex/cms/pages.ts", "getPublicLocaleAlternates"],
  ["convex/cms/pages.ts", "getPublicHomeLocaleAlternates"],
  ["convex/cms/pages.ts", "getAllLocalizedPageUrls"],
  ["convex/cms/pages.ts", "resolveHistoricalPublishedPath"],
  ["convex/cms/pages.ts", "resolveLocalizedPathQuery"],
  ["convex/cms/menus.ts", "getWithResolvedLinks"],
  ["convex/cms/redirects.ts", "resolve"],
  ["convex/cms/redirects.ts", "listActiveKeys"],
] as const

function exportBlock(source: string, name: string) {
  const start = source.indexOf(`export const ${name} = query({`)
  expect(
    start,
    `${name} must remain a registered query`
  ).toBeGreaterThanOrEqual(0)
  const next = source.indexOf("\nexport const ", start + 1)
  return source.slice(start, next === -1 ? undefined : next)
}

describe("F09c public language consumer closure", () => {
  test.each(REGISTERED_PUBLIC_READERS)(
    "%s:%s requires and asserts the request language version",
    (path, name) => {
      const block = exportBlock(read(path), name)
      expect(block).toContain("languageVersion: v.number()")
      expect(block).toContain("assertPublicLanguageVersion")
    }
  )

  test("request boundaries use the one-retry version coordinator", () => {
    expect(read("app/(public)/[locale]/[[...path]]/page.tsx")).toContain(
      "withVersionPinnedConfig"
    )
    expect(read("app/(public)/[locale]/layout.tsx")).toContain(
      "withVersionPinnedConfig"
    )
    // M05 C5a: the sitemap index and every child share one coordinator.
    const sitemapBoundary = read("lib/seo/sitemap.ts")
    expect(sitemapBoundary).toContain("withVersionPinnedConfig")
    expect(sitemapBoundary).toContain("PublicLanguageVersionUnavailableError")
    for (const route of [
      "app/sitemap.xml/route.ts",
      "app/sitemaps/[version]/[locale]/[file]/route.ts",
    ]) {
      const source = read(route)
      expect(source, route).toContain("withPinnedSitemapConfig")
      expect(source, route).toContain("answerSitemap")
    }
    expect(read("proxy.ts")).toContain("refreshSiteConfigState")
  })

  // Convex's fetchQuery is always no-store. A bare call inside these ISR
  // renders fails the request with DYNAMIC_SERVER_USAGE on `next start`,
  // which mocked render tests cannot observe.
  test("ISR request boundaries keep the fresh config read in the Data Cache", () => {
    expect(read("app/(public)/[locale]/[[...path]]/page.tsx")).toMatch(
      /const loadFreshConfig = cache\(\(staleVersion: number\) =>\s*readFreshConfig\(/
    )
    expect(read("app/(public)/[locale]/layout.tsx")).toMatch(
      /loadFreshConfig: \(staleVersion\) =>\s*readFreshConfig\(/
    )
  })
})

// M05 M20 Option A: the public chrome has copy for every supported locale, so
// a response is always presented in one language.
describe("M05 M20 public copy for every supported locale", () => {
  function shape(value: unknown): unknown {
    return typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key, shape(child)])
        )
      : typeof value
  }

  function strings(value: unknown): string[] {
    return typeof value === "string"
      ? [value]
      : Object.values(value as object).flatMap(strings)
  }

  test("the dictionary covers exactly the supported locales", () => {
    expect(Object.keys(PUBLIC_MESSAGES).toSorted()).toEqual(
      [...SUPPORTED_LOCALES].toSorted()
    )
    expect(SUPPORTED_LOCALES).toHaveLength(15)
    expect(SUPPORTED_LOCALES).not.toContain("de")
    expect(PUBLIC_MESSAGES).not.toHaveProperty("de")
  })

  test.each(SUPPORTED_LOCALES)("%s has every string, none empty", (locale) => {
    const messages = PUBLIC_MESSAGES[locale]
    expect(shape(messages)).toEqual(shape(PUBLIC_MESSAGES.en))
    for (const text of strings(messages)) expect(text.trim()).not.toBe("")
  })

  test("preview fallback copy covers every locale and names both languages", () => {
    expect(Object.keys(PUBLIC_PREVIEW_FALLBACK).toSorted()).toEqual(
      [...SUPPORTED_LOCALES].toSorted()
    )

    for (const locale of SUPPORTED_LOCALES) {
      const body = PUBLIC_PREVIEW_FALLBACK[locale].body
      expect(body).toContain("{locale}")
      expect(body).toContain("{defaultLocale}")
      expect(getPublicPreviewFallback(locale, "en")).not.toMatch(/\{[^}]+\}/)
    }
  })

  test("public screens take the layout's presentation language, never the pathname", () => {
    expect(read("app/(public)/[locale]/layout.tsx")).toContain(
      "resolvePresentationLocale("
    )
    for (const path of [
      "app/(public)/[locale]/not-found.tsx",
      "app/(public)/[locale]/error.tsx",
      "app/(public)/[locale]/loading.tsx",
    ]) {
      const source = read(path)
      expect(source, path).toContain("usePresentationLocale()")
      expect(source, path).not.toContain("usePathname")
      expect(source, path).not.toMatch(/["'`]\/(?:en|fr)\b/)
    }
  })
})
