import { v } from "convex/values"
import { internalQuery } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { walkCanonicalMenuTargets } from "./lib/menu"

const SAMPLE_LIMIT = 20

const mismatchSampleValidator = v.object({
  menuId: v.id("menus"),
  targetId: v.id("pages"),
  path: v.string(),
})

type MismatchSample = {
  menuId: Id<"menus">
  targetId: Id<"pages">
  path: string
}

function referenceKey(sample: MismatchSample): string {
  return `${sample.menuId}\0${sample.targetId}\0${sample.path}`
}

function boundedSamples(samples: MismatchSample[]): MismatchSample[] {
  return samples
    .sort((a, b) => referenceKey(a).localeCompare(referenceKey(b)))
    .slice(0, SAMPLE_LIMIT)
}

/**
 * Compare every live canonical menu's syntactic targets with every materialized row.
 * Counts cover the complete graph; samples are deterministic and bounded and
 * intentionally expose IDs/paths only (never labels, URLs, or menu content).
 */
export const verifyExact = internalQuery({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    expectedCount: v.number(),
    actualCount: v.number(),
    missingCount: v.number(),
    staleCount: v.number(),
    duplicateCount: v.number(),
    missingSamples: v.array(mismatchSampleValidator),
    staleSamples: v.array(mismatchSampleValidator),
    duplicateSamples: v.array(mismatchSampleValidator),
  }),
  handler: async (ctx) => {
    const expected = new Map<string, MismatchSample>()
    for await (const menu of ctx.db.query("menus")) {
      if (menu.deletedAt !== undefined) continue
      for (const target of walkCanonicalMenuTargets(menu.nav)) {
        const sample = {
          menuId: menu._id,
          targetId: target.targetId,
          path: target.path,
        }
        expected.set(referenceKey(sample), sample)
      }
    }

    const actual = new Map<string, { sample: MismatchSample; count: number }>()
    let actualCount = 0
    for await (const row of ctx.db.query("menuReferences")) {
      actualCount += 1
      const sample = {
        menuId: row.menuId,
        targetId: row.targetId,
        path: row.path,
      }
      const key = referenceKey(sample)
      const group = actual.get(key)
      if (group) group.count += 1
      else actual.set(key, { sample, count: 1 })
    }

    const missingSamples: MismatchSample[] = []
    for (const [key, sample] of expected) {
      if (!actual.has(key)) missingSamples.push(sample)
    }

    let staleCount = 0
    let duplicateCount = 0
    const staleSamples: MismatchSample[] = []
    const duplicateSamples: MismatchSample[] = []
    for (const [key, group] of actual) {
      if (!expected.has(key)) {
        staleCount += group.count
        staleSamples.push(group.sample)
        continue
      }
      if (group.count > 1) {
        duplicateCount += group.count - 1
        duplicateSamples.push(group.sample)
      }
    }

    const missingCount = missingSamples.length
    return {
      ok: missingCount === 0 && staleCount === 0 && duplicateCount === 0,
      expectedCount: expected.size,
      actualCount,
      missingCount,
      staleCount,
      duplicateCount,
      missingSamples: boundedSamples(missingSamples),
      staleSamples: boundedSamples(staleSamples),
      duplicateSamples: boundedSamples(duplicateSamples),
    }
  },
})
