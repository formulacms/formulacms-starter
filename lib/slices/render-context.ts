import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import type { Slice } from "@/convex/lib/slices"
import { collectRelationIds } from "@/convex/lib/slices/resolve"
import { cachedCmsRead, CMS_TAGS } from "@/lib/cms/cache"
import { collectPageIds, type SliceRenderContext } from "@/lib/slices/links"
import { readSlicePresentationCatalog } from "@/convex/lib/slices/presentations"

/**
 * Assemble the {@link SliceRenderContext} for a published page's slice set:
 * batch-resolve every internal-link target to a canonical localized path and
 * every relation to a depth-1 card, in the fewest queries (one per kind, and
 * none when a kind isn't referenced). The public route just renders the result.
 *
 * `isPreview` switches relation-card resolution to include drafts and bypass the
 * Data Cache. Preview link paths also use fresh authenticated reads, including
 * readable draft targets. Public reads retain their version-pinned cache.
 */
export async function buildSliceRenderContext(opts: {
  slices: Slice[]
  renderLocale: string
  presentationLocale?: string
  defaultLocale: string
  isPreview: boolean
  languageVersion: number
}): Promise<SliceRenderContext> {
  const { slices, renderLocale, defaultLocale, isPreview, languageVersion } =
    opts

  // Batch-resolve internal-link targets to full localized paths so the slice
  // renderers emit canonical hrefs directly (no 308 hop).
  const pageIds = collectPageIds(slices)
  const relationIds = collectRelationIds(slices)
  const fetchPreviewQuery =
    isPreview && (pageIds.length > 0 || relationIds.length > 0)
      ? (await import("@/lib/auth-server")).fetchAuthQuery
      : null
  const pagePaths =
    pageIds.length > 0
      ? isPreview
        ? await fetchPreviewQuery!(api.cms.pages.getLocalizedPathsByIds, {
            ids: pageIds,
            locale: renderLocale,
            languageVersion,
          })
        : await cachedCmsRead(
            () =>
              fetchQuery(api.cms.pages.getLocalizedPathsByIds, {
                ids: pageIds,
                locale: renderLocale,
                languageVersion,
              }),
            [
              "cms-link-paths",
              renderLocale,
              String(languageVersion),
              ...pageIds.toSorted(),
            ],
            {} as Record<string, string>,
            [CMS_TAGS.pages]
          )
      : {}

  const relationCards =
    relationIds.length > 0
      ? isPreview
        ? await fetchPreviewQuery!(api.cms.pages.getRelationCardsByIds, {
            ids: relationIds,
            locale: renderLocale,
            includeDrafts: true,
          })
        : await cachedCmsRead(
            () =>
              fetchQuery(api.cms.pages.getPublicRelationCardsByIds, {
                ids: relationIds,
                locale: renderLocale,
                languageVersion,
              }),
            [
              "cms-relation-cards",
              renderLocale,
              String(languageVersion),
              ...relationIds.toSorted(),
            ],
            {} as Record<string, null>,
            [CMS_TAGS.pages]
          )
      : {}

  return {
    locale: renderLocale,
    presentationLocale: opts.presentationLocale ?? renderLocale,
    defaultLocale,
    languageVersion,
    pagePaths,
    relationCards,
    presentationCatalog: await readSlicePresentationCatalog(),
  }
}
