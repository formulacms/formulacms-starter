/// <reference types="vite/client" />

import { describe, expect, test } from "vitest"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { STAGING_ABANDONED_TTL_MS } from "./lib/domains/contentEditing"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const SUCCESSOR_PHASES = ["preparing", "ready", "snapshot_active"] as const

type App = ReturnType<typeof convexTest>
type CutoverPhase = Doc<"pagePublicationCutover">["phase"]

function app() {
  return convexTest({ schema, modules, publicationAuthority: "missing" })
}

async function seedLegacyCronTargets(t: App, phase?: CutoverPhase) {
  return t.run(async (ctx) => {
    const now = Date.now()
    if (phase !== undefined) {
      await ctx.db.insert("pagePublicationCutover", {
        key: "published-snapshot-v1",
        phase,
        revision: 1,
        updatedAt: now,
      })
    }
    const pageId = await ctx.db.insert("pages", {
      slug: `legacy-cron-${phase ?? "missing"}`,
      pageType: "landing-page",
      status: "published",
      createdAt: now - STAGING_ABANDONED_TTL_MS - 2_000,
      updatedAt: now - STAGING_ABANDONED_TTL_MS - 2_000,
      publishedAt: now - STAGING_ABANDONED_TTL_MS - 2_000,
      expiresAt: now - 1_000,
      content: {
        en: { title: "Legacy cron target", slices: [] },
      },
    })
    const stagingId = await ctx.db.insert("pageStaging", {
      pageId,
      pageType: "landing-page",
      updatedAt: now - STAGING_ABANDONED_TTL_MS - 1_000,
      effectiveTitles: { en: "Abandoned legacy staging" },
    })
    return { pageId, stagingId }
  })
}

async function dumpLegacyCronState(t: App) {
  return t.run(async (ctx) => ({
    cutover: await ctx.db.query("pagePublicationCutover").collect(),
    pages: await ctx.db.query("pages").collect(),
    staging: await ctx.db.query("pageStaging").collect(),
    revisions: await ctx.db.query("pageRevisions").collect(),
    search: await ctx.db.query("pageSearch").collect(),
    pilotEnvelope: await ctx.db.query("pilotEnvelope").collect(),
    webhookDeliveries: await ctx.db.query("webhookDeliveries").collect(),
    scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
  }))
}

async function expectBothCronsToNoOp(t: App) {
  const before = await dumpLegacyCronState(t)
  await expect(
    t.mutation(internal.cms.pages.processScheduledTransitions, {})
  ).resolves.toEqual({ published: 0, expired: 0, hasMore: false })
  await expect(
    t.mutation(internal.cms.pages.sweepAbandonedStaging, {})
  ).resolves.toEqual({ scanned: 0, deleted: 0, hasMore: false })
  expect(await dumpLegacyCronState(t)).toEqual(before)
}

describe("legacy Page crons across publication cutover phases", () => {
  test("missing authority returns zero results without writes or scheduling", async () => {
    const t = app()
    await seedLegacyCronTargets(t)
    await expectBothCronsToNoOp(t)
  })

  test.each(SUCCESSOR_PHASES)(
    "%s authority returns zero results without writes or scheduling",
    async (phase) => {
      const t = app()
      await seedLegacyCronTargets(t, phase)
      await expectBothCronsToNoOp(t)
    }
  )

  test("duplicate authority remains an integrity error for both crons", async () => {
    const t = app()
    await seedLegacyCronTargets(t, "legacy")
    await t.run((ctx) =>
      ctx.db.insert("pagePublicationCutover", {
        key: "published-snapshot-v1",
        phase: "legacy",
        revision: 2,
        updatedAt: Date.now(),
      })
    )
    const before = await dumpLegacyCronState(t)

    await expect(
      t.mutation(internal.cms.pages.processScheduledTransitions, {})
    ).rejects.toThrow("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    await expect(
      t.mutation(internal.cms.pages.sweepAbandonedStaging, {})
    ).rejects.toThrow("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    expect(await dumpLegacyCronState(t)).toEqual(before)
  })

  test("legacy authority retains scheduled transition and staging sweep behavior", async () => {
    const t = app()
    const { pageId, stagingId } = await seedLegacyCronTargets(t, "legacy")

    await expect(
      t.mutation(internal.cms.pages.processScheduledTransitions, {})
    ).resolves.toEqual({ published: 0, expired: 1, hasMore: true })
    const expiredPage = await t.run((ctx) => ctx.db.get(pageId))
    expect(expiredPage?.status).toBe("archived")
    expect(expiredPage?.expiresAt).toBeUndefined()
    await expect(
      t.mutation(internal.cms.pages.sweepAbandonedStaging, {})
    ).resolves.toEqual({ scanned: 1, deleted: 1, hasMore: false })
    await expect(t.run((ctx) => ctx.db.get(stagingId))).resolves.toBeNull()
  })
})
