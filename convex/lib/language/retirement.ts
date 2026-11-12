import type { Doc } from "../../_generated/dataModel"
import type { MutationCtx } from "../../_generated/server"

type RetirementReason = NonNullable<
  Doc<"siteDefaultLanguageRoutes">["retiredReason"]
>

/**
 * M05 M24's only write seam for durable continuity retirement.
 *
 * The caller supplies the authority rows already read by its recording seam,
 * so a pointerless or non-default-locale claim adds no database read. A
 * qualifying claim performs one pointed-path read and patches at most one
 * still-served row.
 */
export async function retireContinuityRowForClaim(
  ctx: MutationCtx,
  authorityRows: readonly Doc<"siteLanguageAuthority">[],
  claim: Readonly<{
    locale: string
    path: string
    retiredAt: number
    retiredReason: RetirementReason
  }>
): Promise<void> {
  if (authorityRows.length !== 1) return
  const authority = authorityRows[0]!
  const pointer = authority.continuityPointer
  if (!pointer || claim.locale !== authority.currentLocale) return

  const rows = await ctx.db
    .query("siteDefaultLanguageRoutes")
    .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
      q
        .eq("migrationId", pointer.migrationId)
        .eq("generation", pointer.generation)
        .eq("fromPath", claim.path)
    )
    .take(2)
  if (rows.length !== 1 || rows[0]!.shadow || rows[0]!.retiredAt !== undefined)
    return

  await ctx.db.patch(rows[0]!._id, {
    retiredAt: claim.retiredAt,
    retiredReason: claim.retiredReason,
  })
}
