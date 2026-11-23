import { beforeEach, describe, expect, it, vi } from "vitest"
import { getFunctionName } from "convex/server"
import type { Block } from "@/convex/lib/blocks"
import type { Id } from "@/convex/_generated/dataModel"

const reads = vi.hoisted(() => ({
  publicQuery: vi.fn(),
  previewQuery: vi.fn(),
  cacheEntries: [] as { key: string[]; tags: readonly string[] }[],
}))
vi.mock("convex/nextjs", () => ({ fetchQuery: reads.publicQuery }))
vi.mock("@/lib/auth/server", () => ({ fetchAuthQuery: reads.previewQuery }))
vi.mock("@/lib/cms/cache", () => ({
  cachedCmsRead: (
    run: () => unknown,
    key: string[],
    _fallback: unknown,
    tags: readonly string[]
  ) => {
    reads.cacheEntries.push({ key, tags })
    return run()
  },
  CMS_TAGS: { pages: "pages" },
}))
vi.mock("@/convex/lib/blocks/presentations", () => ({
  readBlockPresentationCatalog: async () => undefined,
}))
// No shipped block has a relation field, so the relation-id collector is
// stubbed: the test proves the caller's grouping, not block collection.
const relations = vi.hoisted(() => ({ ids: [] as string[] }))
vi.mock("@/convex/lib/blocks/resolve", () => ({
  collectRelationIds: () => relations.ids,
}))

import { buildBlockRenderContext } from "./render-context"

// Link collection walks any block value, so no shipped block type is needed.
const linkedBlock = (index: number) =>
  ({
    id: `block-${index}`,
    type: "example-links",
    enabled: true,
    items: [
      {
        id: `link-${index}`,
        label: "Go",
        variant: "primary",
        withIcon: false,
        enabled: true,
        link: { type: "internal", pageId: `page_${index}` as Id<"pages"> },
      },
    ],
  }) as unknown as Block

/** Answers like the link-path batch read, refusing more than 50 ids. */
async function cappedPathRead(_reference: unknown, args: { ids: string[] }) {
  if (args.ids.length > 50) throw new Error("TOO_MANY_IDS")
  return Object.fromEntries(args.ids.map((id) => [id, `/path/${id}`]))
}

beforeEach(() => {
  relations.ids = []
  reads.cacheEntries.length = 0
  reads.publicQuery.mockReset().mockImplementation(cappedPathRead)
  reads.previewQuery.mockReset().mockImplementation(cappedPathRead)
})

/** Answers like the relation-card batch reads, refusing more than 50 ids. */
async function cappedCardRead(_reference: unknown, args: { ids: string[] }) {
  if (args.ids.length > 50) throw new Error("TOO_MANY_IDS")
  return Object.fromEntries(args.ids.map((id) => [id, { title: `Card ${id}` }]))
}

describe("buildBlockRenderContext relation cards (VISITOR-LIMITS)", () => {
  it.each([
    [false, "cms/pages:getPublicRelationCardsByIds"],
    [true, "cms/pages:getRelationCardsByIds"],
  ])(
    "reads 120 relation ids in three groups and keeps every card (preview %s)",
    async (isPreview, functionName) => {
      relations.ids = Array.from({ length: 120 }, (_, i) => `page_${i}`)
      reads.publicQuery.mockImplementation(cappedCardRead)
      reads.previewQuery.mockImplementation(cappedCardRead)
      const ctx = await buildBlockRenderContext({
        blocks: [],
        renderLocale: "fr",
        defaultLocale: "en",
        languageVersion: 4,
        isPreview,
      })
      const query = isPreview ? reads.previewQuery : reads.publicQuery
      expect(
        query.mock.calls.map(([reference, args]) => [
          getFunctionName(reference),
          args.ids.length,
          args.locale,
        ])
      ).toEqual([
        [functionName, 50, "fr"],
        [functionName, 50, "fr"],
        [functionName, 20, "fr"],
      ])
      const cards = ctx.relationCards ?? {}
      expect(Object.keys(cards)).toHaveLength(120)
      expect(cards.page_0).toEqual({ title: "Card page_0" })
      expect(cards.page_119).toEqual({ title: "Card page_119" })
      if (!isPreview) {
        // One cache entry for the whole page's cards.
        expect(reads.cacheEntries).toHaveLength(1)
        expect(reads.cacheEntries[0].key[0]).toBe("cms-relation-cards")
      }
    }
  )
})

describe("buildBlockRenderContext link paths (VISITOR-LIMITS)", () => {
  const blocks = Array.from({ length: 60 }, (_, i) => linkedBlock(i))
  const options = {
    blocks,
    renderLocale: "en",
    defaultLocale: "en",
    languageVersion: 3,
  }

  it.each([false, true])(
    "reads 60 link ids in two groups and merges them (preview %s)",
    async (isPreview) => {
      const ctx = await buildBlockRenderContext({ ...options, isPreview })
      const query = isPreview ? reads.previewQuery : reads.publicQuery
      const groups = query.mock.calls.map(([reference, args]) => [
        getFunctionName(reference),
        args.ids.length,
        args.locale,
        args.languageVersion,
      ])
      expect(groups).toEqual([
        ["cms/pages:getLocalizedPathsByIds", 50, "en", 3],
        ["cms/pages:getLocalizedPathsByIds", 10, "en", 3],
      ])
      expect(Object.keys(ctx.pagePaths)).toHaveLength(60)
      expect(ctx.pagePaths.page_0).toBe("/path/page_0")
      expect(ctx.pagePaths.page_59).toBe("/path/page_59")
      if (isPreview) {
        expect(reads.publicQuery).not.toHaveBeenCalled()
        expect(reads.cacheEntries).toEqual([])
      } else {
        // One cache entry for the whole page, keyed by every id.
        expect(reads.cacheEntries).toHaveLength(1)
        expect(reads.cacheEntries[0].key.slice(0, 3)).toEqual([
          "cms-link-paths",
          "en",
          "3",
        ])
        expect(reads.cacheEntries[0].key).toHaveLength(63)
        expect(reads.cacheEntries[0].tags).toEqual(["pages"])
      }
    }
  )
})
