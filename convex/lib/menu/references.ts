import type { MutationCtx } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { walkCanonicalMenuTargets, type MenuReferenceTarget } from "../menu"

function referenceKey(targetId: Id<"pages">, path: string): string {
  return `${targetId}\0${path}`
}

export type MenuReferenceRefreshResult = {
  inserted: number
  deleted: number
}

async function reconcileMenuReferences(
  ctx: MutationCtx,
  menuId: Id<"menus">,
  targets: readonly MenuReferenceTarget[]
): Promise<MenuReferenceRefreshResult> {
  const existing = await ctx.db
    .query("menuReferences")
    .withIndex("by_menu", (q) => q.eq("menuId", menuId))
    .collect()
  const expectedKeys = new Set(
    targets.map((target) => referenceKey(target.targetId, target.path))
  )
  const existingKeys = new Set<string>()
  let deleted = 0
  const stableExisting = [...existing].sort(
    (a, b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id)
  )
  for (const row of stableExisting) {
    const key = referenceKey(row.targetId, row.path)
    if (!expectedKeys.has(key) || existingKeys.has(key)) {
      await ctx.db.delete(row._id)
      deleted += 1
      continue
    }
    existingKeys.add(key)
  }
  const now = Date.now()
  let inserted = 0
  for (const target of targets) {
    const key = referenceKey(target.targetId, target.path)
    if (existingKeys.has(key)) continue
    await ctx.db.insert("menuReferences", {
      menuId,
      targetId: target.targetId,
      path: target.path,
      updatedAt: now,
    })
    inserted += 1
    existingKeys.add(key)
  }
  return { inserted, deleted }
}

export async function refreshMenuReferences(
  ctx: MutationCtx,
  menu: Pick<Doc<"menus">, "_id" | "nav" | "deletedAt">
): Promise<MenuReferenceRefreshResult> {
  const targets =
    menu.deletedAt === undefined ? walkCanonicalMenuTargets(menu.nav) : []
  return await reconcileMenuReferences(ctx, menu._id, targets)
}

export async function clearMenuReferences(
  ctx: MutationCtx,
  menuId: Id<"menus">
): Promise<MenuReferenceRefreshResult> {
  return await reconcileMenuReferences(ctx, menuId, [])
}
