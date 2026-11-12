import type { Doc } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"

type MenuReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">

export async function getMenuBySlug(
  ctx: MenuReadCtx,
  slug: string
): Promise<Doc<"menus"> | null> {
  return await ctx.db
    .query("menus")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique()
}
