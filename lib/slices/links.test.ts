import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test, vi } from "vitest"
import { getFunctionName } from "convex/server"
import { buildSliceRenderContext } from "./render-context"
import { sliceDefs } from "@/convex/lib/slices"
import { group, relation } from "@/convex/lib/slices/primitives"
import { collectPageIds, composeRel, linkToHref } from "./links"
import type { Slice } from "@/convex/lib/slices"
import type { Id } from "@/convex/_generated/dataModel"

const ctx = {
  locale: "fr",
  defaultLocale: "en",
  // Full, locale-prefixed canonical paths, as built by getLocalizedPathsByIds.
  pagePaths: {
    p1: "/fr/about",
    p2: "/fr/mes-produits/produit-1",
  } as Record<string, string>,
}

describe("composeRel", () => {
  test("no flags → undefined", () => {
    expect(composeRel({})).toBeUndefined()
  })

  test("openInNewTab → noopener noreferrer", () => {
    expect(composeRel({ openInNewTab: true })).toBe("noopener noreferrer")
  })

  test("noFollow only", () => {
    expect(composeRel({ noFollow: true })).toBe("nofollow")
  })

  test("all flags compose in security → SEO order", () => {
    expect(
      composeRel({
        openInNewTab: true,
        noFollow: true,
        sponsored: true,
        ugc: true,
      })
    ).toBe("noopener noreferrer nofollow sponsored ugc")
  })
})

describe("linkToHref", () => {
  test("internal resolves to the pre-built full localized path", () => {
    expect(
      linkToHref({ type: "internal", pageId: "p1" as Id<"pages"> }, ctx)
    ).toBe("/fr/about")
  })

  test("internal resolves a nested localized path verbatim", () => {
    expect(
      linkToHref({ type: "internal", pageId: "p2" as Id<"pages"> }, ctx)
    ).toBe("/fr/mes-produits/produit-1")
  })

  test("internal with missing path → undefined", () => {
    expect(
      linkToHref({ type: "internal", pageId: "missing" as Id<"pages"> }, ctx)
    ).toBeUndefined()
  })

  test.each(["http://example.com", "https://example.com"])(
    "external preserves supported HTTP(S) URL %s",
    (url) => {
      expect(linkToHref({ type: "external", url }, ctx)).toBe(url)
    }
  )

  test.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.com/file",
    "//example.com/file",
    "java\nscript:alert(1)",
    "java\u0000script:alert(1)",
    "javascript :alert(1)",
    "mailto:javascript:alert(1)",
    "mailto:team@example.com?body=%0d%0aBcc:attacker@example.com",
    "tel:javascript:alert(1)",
  ])("external refuses unsafe or obfuscated URL %j", (url) => {
    expect(linkToHref({ type: "external", url }, ctx)).toBeUndefined()
  })

  test.each([
    "mailto:team@example.com",
    "mailto:?subject=Hello",
    "tel:+1 (555) 123-4567",
    "tel:+15551234567;ext=9",
  ])("external preserves supported contact URL %s", (url) => {
    expect(linkToHref({ type: "external", url }, ctx)).toBe(url)
  })

  test("media returns stored file url", () => {
    expect(
      linkToHref(
        { type: "media", url: "https://cdn.example.com/file.pdf" },
        ctx
      )
    ).toBe("https://cdn.example.com/file.pdf")
  })

  test.each([
    "/announcement.pdf",
    "./files/report.pdf",
    "../uploads/report.pdf",
    "report.pdf",
    "/%2f%2fcdn.example.com/report.pdf",
  ])("media preserves safe relative URL %s", (url) => {
    expect(linkToHref({ type: "media", url }, ctx)).toBe(url)
  })

  test.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///private/document.pdf",
    "ftp://cdn.example.com/report.pdf",
    "//cdn.example.com/report.pdf",
    "///cdn.example.com/report.pdf",
    "\\\\cdn.example.com\\report.pdf",
    "https:\\\\cdn.example.com\\report.pdf",
    "https:%2f%2fcdn.example.com/report.pdf",
    "https:%5c%5ccdn.example.com/report.pdf",
    "report\u0000.pdf",
  ])("media refuses unsafe URL %j", (url) => {
    expect(linkToHref({ type: "media", url }, ctx)).toBeUndefined()
  })

  test("anchor links strip one leading hash and reject control characters", () => {
    expect(linkToHref({ type: "anchor", anchor: "##pricing" }, ctx)).toBe(
      "##pricing"
    )
    expect(
      linkToHref({ type: "anchor", anchor: "pricing\u0000" }, ctx)
    ).toBeUndefined()
  })

  test("internal rejects malformed paths while keeping localized page paths", () => {
    expect(
      linkToHref(
        { type: "internal", pageId: "bad" as Id<"pages"> },
        { ...ctx, pagePaths: { bad: "javascript:alert(1)" } }
      )
    ).toBeUndefined()
    expect(
      linkToHref(
        { type: "internal", pageId: "bad" as Id<"pages"> },
        { ...ctx, pagePaths: { bad: "//attacker.example/path" } }
      )
    ).toBeUndefined()
  })
})

describe("collectPageIds", () => {
  test("walks structured button-link fields", () => {
    const slices = [
      {
        id: "1",
        type: "hero",
        enabled: true,
        primary: { title: "x" },
        items: [
          {
            label: "A",
            link: { type: "internal", pageId: "p1" as Id<"pages"> },
            enabled: true,
          },
          {
            label: "B",
            link: { type: "internal", pageId: "p2" as Id<"pages"> },
            enabled: true,
          },
          {
            label: "C",
            link: { type: "external", url: "https://x" },
            enabled: true,
          },
        ],
      },
    ] as unknown as Slice[]
    expect(collectPageIds(slices).sort()).toEqual(["p1", "p2"])
  })

  test("walks hero subtitle link marks with pageId in PM-JSON", () => {
    const richText = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Read more",
              marks: [
                {
                  type: "link",
                  attrs: { href: "/cached", pageId: "p2" },
                },
              ],
            },
          ],
        },
      ],
    })
    const slices = [
      {
        id: "rt1",
        type: "hero",
        enabled: true,
        primary: { title: "x", subtitle: richText },
        items: [],
      },
    ] as unknown as Slice[]
    expect(collectPageIds(slices)).toEqual(["p2"])
  })

  test("dedupes ids found across button items and rich text", () => {
    const richText = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "x",
              marks: [{ type: "link", attrs: { pageId: "p1" } }],
            },
          ],
        },
      ],
    })
    const slices = [
      {
        id: "1",
        type: "hero",
        enabled: true,
        primary: { title: "x", subtitle: richText },
        items: [
          {
            label: "A",
            link: { type: "internal", pageId: "p1" as Id<"pages"> },
            enabled: true,
          },
        ],
      },
    ] as unknown as Slice[]
    expect(collectPageIds(slices)).toEqual(["p1"])
  })

  test("non-JSON strings are ignored", () => {
    const slices = [
      {
        id: "1",
        type: "hero",
        enabled: true,
        primary: { title: "x", subtitle: "<p>legacy html</p>" },
        items: [],
      },
    ] as unknown as Slice[]
    expect(collectPageIds(slices)).toEqual([])
  })
})

const contextQueries = vi.hoisted(() => ({
  fetchQuery: vi.fn(),
  fetchAuthQuery: vi.fn(),
  cachedCmsRead: vi.fn(),
}))
vi.mock("@/lib/auth-server", () => ({
  fetchAuthQuery: contextQueries.fetchAuthQuery,
}))
vi.mock("convex/nextjs", () => ({ fetchQuery: contextQueries.fetchQuery }))
vi.mock("@/lib/cms/cache", () => ({
  cachedCmsRead: contextQueries.cachedCmsRead,
  CMS_TAGS: { pages: "pages" },
}))

describe("presentation locale render context", () => {
  test.each([true, false])(
    "keeps English content queries with French presentation (preview=%s)", sliceProfile([]),
    async (isPreview) => {
      contextQueries.fetchQuery.mockReset()
      contextQueries.fetchAuthQuery.mockReset()
      contextQueries.cachedCmsRead
        .mockReset()
        .mockImplementation((run: () => unknown) => run())
      const paths = { target: "/english-target" }
      const cards = {
        related: {
          pageId: "related",
          pageType: "post",
          title: "Owner related title",
        },
      }
      contextQueries.fetchQuery.mockImplementation(async (reference) =>
        getFunctionName(reference).endsWith("getLocalizedPathsByIds")
          ? paths
          : cards
      )
      contextQueries.fetchAuthQuery.mockImplementation(
        contextQueries.fetchQuery
      )
      // The shipped slice catalogue currently has no relation field. A temporary
      // real descriptor exercises collection and both query branches without
      // replacing collectRelationIds; the production registry is restored below.
      const registry = sliceDefs as {
        -readonly [Key in keyof typeof sliceDefs]: (typeof sliceDefs)[Key]
      }
      const original = registry["hero-agency"]
      registry["hero-agency"] = {
        ...original,
        primary: group({ related: relation({ pageTypes: ["post"] }) }),
      } as unknown as typeof original
      try {
        const options = {
          slices: [
            {
              id: "context",
              type: "hero-agency",
              enabled: true,
              primary: { related: { pageId: "related" } },
              items: [{ link: { type: "internal", pageId: "target" } }],
            },
          ] as unknown as Slice[],
          renderLocale: "en",
          presentationLocale: "fr",
          defaultLocale: "en",
          isPreview,
          languageVersion: 7,
        }
        const result = await buildSliceRenderContext(options)
        expect(result.locale).toBe("en")
        expect(result.defaultLocale).toBe("en")
        expect(result.languageVersion).toBe(7)
        expect(result.pagePaths).toBe(paths)
        expect(result.relationCards).toBe(cards)
        expect(
          linkToHref(
            { type: "internal", pageId: "target" as Id<"pages"> },
            result
          )
        ).toBe("/english-target")
        expect(
          (isPreview
            ? contextQueries.fetchAuthQuery
            : contextQueries.fetchQuery
          ).mock.calls.map(([reference, args]) => [
            getFunctionName(reference),
            args,
          ])
        ).toEqual([
          [
            "cms/pages:getLocalizedPathsByIds",
            { ids: ["target"], locale: "en", languageVersion: 7 },
          ],
          [
            isPreview
              ? "cms/pages:getRelationCardsByIds"
              : "cms/pages:getPublicRelationCardsByIds",
            isPreview
              ? { ids: ["related"], locale: "en", includeDrafts: true }
              : { ids: ["related"], locale: "en", languageVersion: 7 },
          ],
        ])
        expect(
          contextQueries.cachedCmsRead.mock.calls.map((call) => call[1])
        ).toEqual(
          isPreview
            ? []
            : [
                ["cms-link-paths", "en", "7", "target"],
                ["cms-relation-cards", "en", "7", "related"],
              ]
        )
        expect(result.presentationLocale).toBe("fr")
      } finally {
        registry["hero-agency"] = original
      }
    }
  )
  test("defaults presentation to the content locale for legacy context callers", async () => {
    const result = await buildSliceRenderContext({
      slices: [],
      renderLocale: "en",
      defaultLocale: "en",
      isPreview: false,
      languageVersion: 7,
    })
    expect(result.locale).toBe("en")
    expect(result.presentationLocale).toBe("en")
  })
})

test("no-reference preview context does not invoke authenticated queries", async () => {
  contextQueries.fetchAuthQuery.mockClear()
  await buildSliceRenderContext({
    slices: [],
    renderLocale: "en",
    defaultLocale: "en",
    isPreview: true,
    languageVersion: 7,
  })
  expect(contextQueries.fetchAuthQuery).not.toHaveBeenCalled()
})
