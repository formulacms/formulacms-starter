import { readBlock } from "@/convex/lib/blocks/identity"
import type { Doc, Id } from "../../_generated/dataModel"
import type { QueryCtx } from "../../_generated/server"
import { blockDefs, type Block } from "./index"
import type { Primitive } from "./primitives"
import { walkValue } from "./walk"
import type { PageType } from "../pages/types"

export type RelationCard = {
  pageId: Id<"pages">
  pageType: PageType
  title: string
  excerpt?: string
  image?: { url: string }
  href?: string
}

type BlockRegistry = Partial<
  Record<Block["type"], { primary: Primitive; items?: Primitive }>
>

export function collectRelationIds(
  blocks: readonly Block[],
  registry: BlockRegistry = blockDefs
): Id<"pages">[] {
  const registryReads: Readonly<
    Partial<Record<string, { primary: Primitive; items?: Primitive }>>
  > = registry
  const ids = new Set<string>()
  for (const block of blocks) {
    const def = registryReads[readBlock(block).type]
    if (!def) continue
    collectRelationIdsFromValue(
      def.primary,
      (block as { primary?: unknown }).primary,
      ids
    )
    if (def.items) {
      collectRelationIdsFromValue(
        def.items,
        (block as { items?: unknown }).items,
        ids
      )
    }
  }
  return [...ids] as Id<"pages">[]
}

function collectRelationIdsFromValue(
  def: Primitive,
  value: unknown,
  out: Set<string>
): void {
  walkValue(def, value, (leaf) => {
    if (leaf.def.kind !== "relation") return
    const pageId =
      leaf.value && typeof leaf.value === "object"
        ? (leaf.value as { pageId?: unknown }).pageId
        : undefined
    if (typeof pageId === "string" && pageId.length > 0) out.add(pageId)
  })
}

export async function resolveRelations(
  ctx: QueryCtx,
  ids: readonly Id<"pages">[],
  {
    includeDrafts,
    locale,
    defaultLocale,
  }: {
    includeDrafts: boolean
    locale: string
    defaultLocale: string
  }
): Promise<Record<string, RelationCard | null>> {
  const uniqueIds = [...new Set(ids)]
  const pages = await Promise.all(uniqueIds.map((id) => ctx.db.get("pages", id)))

  // Batch-resolve cardImageMediaId → media.url in one pass so we don't
  // round-trip per page.
  const mediaIds = [
    ...new Set(
      pages
        .map((p) => p?.cardImageMediaId)
        .filter((id): id is Id<"media"> => Boolean(id))
    ),
  ]
  const mediaUrlById = new Map<string, string>()
  if (mediaIds.length > 0) {
    const mediaRows = await Promise.all(mediaIds.map((id) => ctx.db.get("media", id)))
    for (const m of mediaRows) {
      if (m && m.deletedAt === undefined) mediaUrlById.set(m._id, m.url)
    }
  }

  // ADR-0041 Deploy 2 PR B item 3 — drafts carry their working copy on
  // `pageStaging`. Only the draft-preview branch (`includeDrafts=true`)
  // walks non-published pages; public callers never see drafts, so
  // avoid the extra lookups for them.
  const stagingByPageId = new Map<
    string,
    {
      content?: Record<string, unknown>
      effectiveTitles?: Record<string, string>
    } | null
  >()
  if (includeDrafts) {
    const draftPages = pages.filter(
      (page): page is NonNullable<typeof page> =>
        !!page && page.status !== "published"
    )
    const stagingRows = await Promise.all(
      draftPages.map((page) =>
        ctx.db
          .query("pageStaging")
          .withIndex("by_pageId", (q) => q.eq("pageId", page._id))
          .first()
      )
    )
    draftPages.forEach((page, i) => {
      stagingByPageId.set(page._id, stagingRows[i] ?? null)
    })
  }

  const result: Record<string, RelationCard | null> = {}
  for (let i = 0; i < uniqueIds.length; i++) {
    const id = uniqueIds[i]
    result[id] = projectRelationCard(pages[i], mediaUrlById, {
      includeDrafts,
      locale,
      defaultLocale,
      staging: pages[i] ? (stagingByPageId.get(pages[i]!._id) ?? null) : null,
    })
  }
  return result
}

function cardExcerptFor(
  page: Doc<"pages">,
  staging: { content?: Record<string, unknown> } | null,
  locale: string
): string | undefined {
  const own = (
    (staging?.content?.[locale] ?? page.content?.[locale]) as
      | { cardExcerpt?: string }
      | undefined
  )?.cardExcerpt
  return own || undefined
}

function projectRelationCard(
  page: Doc<"pages"> | null,
  mediaUrlById: Map<string, string>,
  {
    includeDrafts,
    locale,
    defaultLocale,
    staging,
  }: {
    includeDrafts: boolean
    locale: string
    defaultLocale: string
    staging: {
      content?: Record<string, unknown>
      effectiveTitles?: Record<string, string>
    } | null
  }
): RelationCard | null {
  if (!page || page.deletedAt !== undefined) return null
  if (!includeDrafts && page.status !== "published") return null

  // For drafts, staging holds the working copy per ADR-0041 Deploy 2
  // PR B item 3. Prefer the staged locale bag when present, then fall
  // back to page.content, then the denormalized effectiveTitles.
  const stagingContent = staging?.content as
    Record<string, { title?: string } | undefined> | undefined
  const localizedContent =
    stagingContent?.[locale] ??
    stagingContent?.[defaultLocale] ??
    Object.values(stagingContent ?? {})[0] ??
    page.content?.[locale] ??
    page.content?.[defaultLocale] ??
    Object.values(page.content ?? {})[0] ??
    (staging?.effectiveTitles?.[locale]
      ? { title: staging.effectiveTitles[locale] }
      : undefined) ??
    (staging?.effectiveTitles?.[defaultLocale]
      ? { title: staging.effectiveTitles[defaultLocale] }
      : undefined)

  const cardImage = page.cardImageMediaId
    ? mediaUrlById.get(page.cardImageMediaId)
    : undefined

  return {
    pageId: page._id,
    pageType: page.pageType,
    title: localizedContent?.title ?? page.slug,
    // The card excerpt is written in each language; never another language's.
    ...(cardExcerptFor(page, staging, locale)
      ? { excerpt: cardExcerptFor(page, staging, locale) }
      : {}),
    ...(cardImage ? { image: { url: cardImage } } : {}),
  }
}
