import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { DEFAULT_HOME_SLUGS } from "../../../lib/pages/home-aliases"
import { isActiveContentType } from "../contentTypes"

export async function findPublishedLandingPageBySlug(
  ctx: QueryCtx | MutationCtx,
  slug: string
): Promise<Doc<"pages"> | null> {
  const matches = await ctx.db
    .query("pages")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .take(10)
  return (
    matches.find(
      (page) =>
        page.deletedAt === undefined &&
        page.pageType === "landing-page" &&
        isActiveContentType(page.pageType) &&
        page.status === "published"
    ) ?? null
  )
}

/**
 * Resolve the single effective Home Page identity shared by public Settings,
 * Page routing, and canonical menu links. A missing or invalid configured ID
 * falls back through the supported legacy aliases in priority order.
 */
export async function resolveEffectiveHomePageId(
  ctx: QueryCtx | MutationCtx,
  configuredHomePageId: Id<"pages"> | undefined
): Promise<Id<"pages"> | null> {
  if (configuredHomePageId) {
    const configured = await ctx.db.get(configuredHomePageId)
    if (
      configured &&
      configured.deletedAt === undefined &&
      configured.pageType === "landing-page" &&
      isActiveContentType(configured.pageType) &&
      configured.status === "published"
    ) {
      return configured._id
    }
  }

  for (const slug of DEFAULT_HOME_SLUGS) {
    const page = await findPublishedLandingPageBySlug(ctx, slug)
    if (page) return page._id
  }

  return null
}
