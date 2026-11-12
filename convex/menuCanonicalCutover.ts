import { v } from "convex/values"
import { internalQuery } from "./_generated/server"
import { validateCanonicalMenu } from "./lib/menu/validate"

const SAMPLE_LIMIT = 20

const countAndSamplesValidator = v.object({
  count: v.number(),
  slugSamples: v.array(v.string()),
})

function result(slugs: Set<string>, count = slugs.size) {
  return {
    count,
    slugSamples: [...slugs].sort().slice(0, SAMPLE_LIMIT),
  }
}

/**
 * Final Plan 035 C3 data gate. The narrowed schema proves that every menu has
 * canonical `nav`; this query additionally proves slug uniqueness and the
 * semantic save invariants that schema validation cannot express.
 */
export const verifyNarrowed = internalQuery({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    rowCount: v.number(),
    slugCount: v.number(),
    duplicateSlugs: countAndSamplesValidator,
    invalidCanonical: countAndSamplesValidator,
  }),
  handler: async (ctx) => {
    const counts = new Map<string, number>()
    const invalidSlugs = new Set<string>()
    let invalidCount = 0
    let rowCount = 0

    for await (const menu of ctx.db.query("menus").withIndex("by_slug")) {
      rowCount += 1
      counts.set(menu.slug, (counts.get(menu.slug) ?? 0) + 1)
      try {
        validateCanonicalMenu(menu.nav)
      } catch {
        invalidCount += 1
        invalidSlugs.add(menu.slug)
      }
    }

    const duplicateSlugs = new Set<string>()
    let duplicateCount = 0
    for (const [slug, count] of counts) {
      if (count < 2) continue
      duplicateSlugs.add(slug)
      duplicateCount += count - 1
    }

    return {
      ok: duplicateCount === 0 && invalidCount === 0,
      rowCount,
      slugCount: counts.size,
      duplicateSlugs: result(duplicateSlugs, duplicateCount),
      invalidCanonical: result(invalidSlugs, invalidCount),
    }
  },
})
