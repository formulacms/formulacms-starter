import type { Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"

/** Most rule identities one blocker lists; more rows set `moreRules`. */
export const REDIRECTS_BLOCKER_RULE_LIMIT = 100

export type RedirectRuleIdentity = Readonly<{
  ruleId: Id<"redirects">
  fromPath: string
  locale?: string
}>

export type RedirectRulesBlocker = Readonly<{
  code: "REDIRECT_RULES_PRESENT"
  moduleId: "redirects"
  ruleCount: number
  moreRules: boolean
  rules: readonly RedirectRuleIdentity[]
}>

/**
 * Redirects disable blocker (M01 recovery design RG11, §M01d). Every
 * `redirects` row is an active manual rule: it is exactly the set the guarded
 * entries serve when enabled and withhold when disabled (RG9). The read
 * evaluates no destination, publication state, or provenance, and writes
 * nothing. It has no catch, so a failed read fails the preview or commit and
 * never means "no blockers" (RG4 case 4).
 *
 * `cms/modules` calls it directly, and only for a computed Redirects disable.
 */
export async function readRedirectsDisableBlockers(
  ctx: QueryCtx | MutationCtx
): Promise<RedirectRulesBlocker[]> {
  const rows = await ctx.db
    .query("redirects")
    .withIndex("by_fromPath")
    .take(REDIRECTS_BLOCKER_RULE_LIMIT + 1)
  if (rows.length === 0) return []

  const listed = rows.slice(0, REDIRECTS_BLOCKER_RULE_LIMIT)
  return [
    {
      code: "REDIRECT_RULES_PRESENT",
      moduleId: "redirects",
      // Exact when `moreRules` is false; otherwise a lower bound (at least
      // `ruleCount` rows exist, and `rules` lists the first 100).
      ruleCount: rows.length,
      moreRules: rows.length > REDIRECTS_BLOCKER_RULE_LIMIT,
      rules: listed.map((row) =>
        row.locale === undefined
          ? { ruleId: row._id, fromPath: row.fromPath }
          : { ruleId: row._id, fromPath: row.fromPath, locale: row.locale }
      ),
    },
  ]
}
