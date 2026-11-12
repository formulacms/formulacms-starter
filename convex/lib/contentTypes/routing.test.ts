import { describe, expect, test } from "vitest"
import { v } from "convex/values"
import type { ContentTypeDescriptor } from "./types"
import {
  buildLocaleRelativePath,
  isRoutableContentType,
  pathPrefixForContentType,
  resolveContentTypeByPath,
  routableContentTypes,
  seoTypesForContentType,
  slugFallbackForTitle,
  withSlugFallback,
} from "./routing"

// Synthetic descriptors exercise both branches that no shipped descriptor
// hits today: a non-empty pathPrefix (proves the flat `/<prefix>/<slug>` URL
// build + the segment-based type resolution) and a non-routable type (proves
// the "no URL, no sitemap, no route" contract). Advisor's note: this is the
// discriminator between "wired" and "wired correctly" — the gates alone
// can't tell them apart on the empty-prefix descriptors.
function stubDescriptor(overrides: {
  type: string
  routing?: { pathPrefix: string }
  seo?: { schemaOrgType?: string; ogType?: "website" | "article" | "profile" }
}): ContentTypeDescriptor {
  return {
    type: overrides.type,
    label: { singular: overrides.type, plural: `${overrides.type}s` },
    sharedFields: {},
    localizedFields: {},
    sharedValidator: v.object({}),
    localizedValidator: v.object({}),
    routing: overrides.routing,
    seo: overrides.seo,
    capabilities: {
      sliceBody: false,
      revisions: false,
      scheduling: false,
      presence: false,
      requiresBodyContent: false,
    },
    referenceCard: (doc) => ({
      id: doc._id,
      type: overrides.type,
      title: overrides.type,
    }),
  }
}

const rootPage = stubDescriptor({ type: "page", routing: { pathPrefix: "" } })
const rootPost = stubDescriptor({
  type: "post",
  routing: { pathPrefix: "" },
  seo: { schemaOrgType: "Article", ogType: "article" },
})
const prefixAuthor = stubDescriptor({
  type: "author",
  routing: { pathPrefix: "authors" },
})
const nonRoutableFaq = stubDescriptor({ type: "faq-item" })

const defs = {
  page: rootPage,
  post: rootPost,
  author: prefixAuthor,
  "faq-item": nonRoutableFaq,
}

describe("routableContentTypes / isRoutableContentType / pathPrefixForContentType", () => {
  test("routableContentTypes returns only descriptors with routing", () => {
    const routable = routableContentTypes(defs).map((d) => d.type).toSorted()
    expect(routable).toEqual(["author", "page", "post"])
  })

  test("isRoutableContentType", () => {
    expect(isRoutableContentType("page", defs)).toBe(true)
    expect(isRoutableContentType("author", defs)).toBe(true)
    expect(isRoutableContentType("faq-item", defs)).toBe(false)
    expect(isRoutableContentType("unknown", defs)).toBe(false)
  })

  test("pathPrefixForContentType returns null for non-routable, string for routable", () => {
    expect(pathPrefixForContentType("page", defs)).toBe("")
    expect(pathPrefixForContentType("author", defs)).toBe("authors")
    expect(pathPrefixForContentType("faq-item", defs)).toBeNull()
    expect(pathPrefixForContentType("unknown", defs)).toBeNull()
  })
})

describe("buildLocaleRelativePath", () => {
  test("empty prefix honors ancestry (today's page/landing-page/post shape)", () => {
    expect(
      buildLocaleRelativePath(
        { pageType: "page", slug: "leadership", ancestry: "/company" },
        defs,
      ),
    ).toBe("/company/leadership")
    expect(
      buildLocaleRelativePath({ pageType: "page", slug: "about" }, defs),
    ).toBe("/about")
  })

  test("non-empty prefix is flat: /<prefix>/<slug>, ignoring ancestry", () => {
    // Plan 028 decision #6: non-empty prefix acts as a virtual root, so this
    // type opts OUT of parentId hierarchy. Any ancestry passed in is dropped.
    expect(
      buildLocaleRelativePath(
        { pageType: "author", slug: "jane", ancestry: "/team" },
        defs,
      ),
    ).toBe("/authors/jane")
    expect(
      buildLocaleRelativePath({ pageType: "author", slug: "jane" }, defs),
    ).toBe("/authors/jane")
  })

  test("non-routable type returns null (caller skips URL emission)", () => {
    expect(
      buildLocaleRelativePath({ pageType: "faq-item", slug: "shipping" }, defs),
    ).toBeNull()
  })

  test("unknown type returns null (defensive against orphan descriptors)", () => {
    expect(
      buildLocaleRelativePath({ pageType: "gone-type", slug: "x" }, defs),
    ).toBeNull()
  })
})

describe("resolveContentTypeByPath", () => {
  test("non-empty prefix match returns the descriptor + slug", () => {
    const routed = resolveContentTypeByPath(["authors", "jane"], defs)
    expect(routed?.descriptor.type).toBe("author")
    expect(routed?.slug).toBe("jane")
    expect(routed?.remainingSegments).toEqual(["jane"])
  })

  test("bare non-empty prefix (no slug) returns null — /authors alone doesn't route", () => {
    expect(resolveContentTypeByPath(["authors"], defs)).toBeNull()
  })

  test("flat mount: extra segments after prefix return null (no /authors/foo/bar bleed)", () => {
    // Plan 028 decision #6 fixes flat mount `/<prefix>/<slug>` — deeper URLs
    // must NOT resolve to the last segment as a slug (canonical guard would
    // otherwise 308-mask a malformed URL as a synonym for a real page).
    expect(resolveContentTypeByPath(["authors", "foo", "bar"], defs)).toBeNull()
    expect(
      resolveContentTypeByPath(["authors", "team", "jane"], defs),
    ).toBeNull()
  })

  test("no non-empty prefix match returns null — caller falls through to root slug lookup", () => {
    // page/landing-page/post all share `""` today, so the URL alone cannot
    // identify the type — the caller's global slug lookup does.
    expect(resolveContentTypeByPath(["about"], defs)).toBeNull()
    expect(resolveContentTypeByPath(["company", "leadership"], defs)).toBeNull()
  })

  test("empty segments returns null", () => {
    expect(resolveContentTypeByPath([], defs)).toBeNull()
  })
})

describe("seoTypesForContentType", () => {
  test("defaults are WebPage / website", () => {
    expect(seoTypesForContentType("page", defs)).toEqual({
      schemaOrgType: "WebPage",
      ogType: "website",
    })
  })

  test("post opts in to Article / article", () => {
    expect(seoTypesForContentType("post", defs)).toEqual({
      schemaOrgType: "Article",
      ogType: "article",
    })
  })

  test("unknown type falls back to WebPage / website", () => {
    expect(seoTypesForContentType("gone-type", defs)).toEqual({
      schemaOrgType: "WebPage",
      ogType: "website",
    })
  })
})

describe("slugFallbackForTitle", () => {
  test.each([
    ["Иван", "page-114d4170"],
    ["東京", "page-06271ed0"],
    ["서울", "page-f1ca7419"],
    ["नमस्ते", "page-a4718a3d"],
    ["!!!", "page-2d53a722"],
  ])("%s gets the stable address %s", (title, expected) => {
    expect(slugFallbackForTitle(title)).toBe(expected)
  })

  test("is deterministic and ignores surrounding whitespace", () => {
    expect(slugFallbackForTitle("  Иван \n")).toBe(slugFallbackForTitle("Иван"))
  })

  test("hashes the NFC form, so composed and decomposed Hangul agree", () => {
    const composed = "\uC11C\uC6B8"
    const decomposed = composed.normalize("NFD")
    expect(decomposed).not.toBe(composed)
    expect(slugFallbackForTitle(decomposed)).toBe(slugFallbackForTitle(composed))
  })

  test("returns an empty string for a blank title", () => {
    expect(slugFallbackForTitle("")).toBe("")
    expect(slugFallbackForTitle("   \t ")).toBe("")
  })

  test("always produces a lowercase ASCII address", () => {
    expect(slugFallbackForTitle("Иван")).toMatch(/^page-[0-9a-f]{8}$/)
  })
})

describe("withSlugFallback", () => {
  test("keeps a generated slug, including for mixed titles", () => {
    expect(withSlugFallback("Hello World", "hello-world")).toBe("hello-world")
    expect(withSlugFallback("Иван 2", "2")).toBe("2")
  })

  test("falls back only when the generator yielded nothing for a real title", () => {
    expect(withSlugFallback("Иван", "")).toBe("page-114d4170")
    expect(withSlugFallback("", "")).toBe("")
    expect(withSlugFallback("   ", "")).toBe("")
  })
})
