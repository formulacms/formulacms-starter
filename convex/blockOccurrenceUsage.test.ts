import { createSampleBlock } from "@/convex/lib/blocks/sample"
import { blockProfile } from "@/test-utils/block-profile"
import { makeFunctionReference } from "convex/server"
/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest"
import migrationsTest from "@convex-dev/migrations/test"
import { api } from "./_generated/api"
import schema from "./schema"
import { convexTest } from "../convexTestWithExplicitAdmin"

import { readBlockPresentationCatalog } from "./lib/blocks/presentations"

const modules = import.meta.glob("./**/*.ts")
// History is source-only in the Community projection. Keep the real legacy
// tracer in source without leaving a typed API edge to an omitted capability.
const legacyHistoryInstalled = Object.hasOwn(modules, "./cms/pageHistory.ts")
const restoreLegacyRevision = makeFunctionReference<"mutation", {
  revisionId: import("./_generated/dataModel").Id<"pageRevisions">
}>("cms/pageHistory:restoreRevisionAsDraft")
const OWNER = {
  subject: "occurrence-owner",
  tokenIdentifier: "occurrence-owner",
}
function app() {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  migrationsTest.register(t)
  return { t, owner: t.withIdentity(OWNER) }
}
const hero = (id = "hero", presentationIdV1 = "centered") => ({
  ...createSampleBlock("hero-with-image"),
  id,
  type: "hero-with-image" as const,
  enabled: true,
  presentationIdV1,
  items: createSampleBlock("hero-with-image").items.map((row, index) => ({
    ...row,
    itemId: `occurrence-button-${index}`,
  })),
})
const article = (id = "article", text = "A normal article.") => ({
  id,
  type: "rich-text-body" as const,
  enabled: true,
  primary: {
    body: JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    }),
  },
})
type Fixture = Awaited<ReturnType<typeof fixture>>
async function fixture() {
  const result = app()
  await result.owner.mutation(api.cms.settings.bootstrapInstallation, {
    siteName: "Occurrence proof",
    timezone: "UTC",
    defaultLocale: "en",
  })
  const page = await result.t.run((ctx) => ctx.db.query("pages").first())
  return { ...result, pageId: page!._id }
}
async function generations(f: Fixture) {
  return f.t.run(async (ctx) => ({
    locale: (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", f.pageId).eq("locale", "en")
      )
      .unique())!,
    page: (await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", f.pageId))
      .unique())!,
    shared: (await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", f.pageId))
      .unique())!,
  }))
}
async function save(f: Fixture, blocks = [hero(), article()]) {
  const g = await generations(f)
  return f.owner.mutation(api.cms.publication.saveLocaleDraft, {
    pageId: f.pageId,
    locale: "en",
    expectedDraftGeneration: g.locale.draftGeneration,
    expectedLifecycleGeneration: g.page.lifecycleGeneration,
    slug: "home",
    expectedPresentationCatalogRevision: (await readBlockPresentationCatalog())
      .revision,
    draft: {
      pageType: "landing-page",
      localized: { title: "Occurrence proof" },
      blocks,
    },
  })
}
async function publish(f: Fixture) {
  const g = await generations(f)
  return f.owner.mutation(api.cms.publication.publishLocale, {
    pageId: f.pageId,
    locale: "en",
    expectedDraftGeneration: g.locale.draftGeneration,
    expectedSharedDraftGeneration: g.shared.generation,
    expectedPublicGeneration: g.locale.publicGeneration,
    expectedReleaseGeneration: g.locale.releaseGeneration,
    expectedLifecycleGeneration: g.page.lifecycleGeneration,
  })
}
function count(
  f: ReturnType<typeof app>,
  type = "hero-with-image",
  presentationIds = ["centered"]
) {
  return f.owner.query(api.cms.blockLibrary.getBlockPresentationUsageSummary, {
    type,
    presentationIds,
  })
}
async function maintain(
  f: ReturnType<typeof app>,
  mode: "backfill" | "verify" = "backfill",
  restart = false
) {
  await f.owner.mutation(
    api.lib.publishing.staging.startBlockOccurrenceUsageBackfill,
    {
      mode,
      restart,
    }
  )
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
}
afterEach(() => vi.useRealTimers())

describe("real retained occurrence totals", () => {
  test("fresh bootstrap initializes explicit zero and replay is idempotent", blockProfile([]), async () => {
    const f = await fixture()
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 0 } })
    await f.owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Occurrence proof",
      timezone: "UTC",
      defaultLocale: "en",
    })
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 0 } })
  })
  test("owner-only query and maintenance reject foreign identities without writes", blockProfile([]), async () => {
    const f = await fixture()
    const stranger = f.t.withIdentity({
      subject: "foreign",
      tokenIdentifier: "foreign",
    })
    const before = await f.t.run((ctx) =>
      ctx.db.query("blockOccurrenceCountState").collect()
    )
    await expect(
      stranger.query(api.cms.blockLibrary.getBlockPresentationUsageSummary, {
        type: "hero-with-image",
        presentationIds: ["centered"],
      })
    ).rejects.toThrow()
    await expect(
      stranger.mutation(
        api.lib.publishing.staging.startBlockOccurrenceUsageBackfill,
        {
          mode: "backfill",
        }
      )
    ).rejects.toThrow()
    expect(
      await f.t.run((ctx) =>
        ctx.db.query("blockOccurrenceCountState").collect()
      )
    ).toEqual(before)
  })
  test("saved draft, repeated publication, and new draft deduplicate the same K", blockProfile(["hero-with-image","rich-text-body"]), async () => {
    const f = await fixture()
    await save(f)
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 1 } })
    await publish(f)
    await save(f)
    await publish(f)
    await save(f)
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 1 } })
    const counter = await f.t.run((ctx) =>
      ctx.db
        .query("blockOccurrenceCounts")
        .withIndex("by_type_and_presentationId", (q) =>
          q.eq("type", "hero-with-image").eq("presentationId", "centered")
        )
        .unique()
    )
    expect(counter?.version).toBe(1)
  })
  test("same ID with a changed design occupies separate retained buckets; disabled counts", blockProfile(["hero-with-image","rich-text-body"]), async () => {
    const f = await fixture()
    await save(f)
    await publish(f)
    await save(f, [{ ...hero("hero", "default"), enabled: false }, article()])
    expect(await count(f, "hero-with-image", ["default", "centered"])).toEqual({
      status: "ready",
      counts: { default: 1, centered: 1 },
    })
  })
  test("Snapshot Restore changes draft membership without changing retained count or publication", blockProfile(["hero-with-image","rich-text-body"]), async () => {
    const f = await fixture()
    await save(f)
    const old = await publish(f)
    await save(f, [hero("new-id"), article()])
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 2 } })
    const g = await generations(f)
    await f.owner.mutation(api.cms.publication.restoreSnapshotAsDraft, {
      pageId: f.pageId,
      locale: "en",
      snapshotId: old.snapshotId,
      expectedDraftGeneration: g.locale.draftGeneration,
      expectedSharedDraftGeneration: g.shared.generation,
      expectedLifecycleGeneration: g.page.lifecycleGeneration,
      expectedPublicGeneration: g.locale.publicGeneration,
      expectedReleaseGeneration: g.locale.releaseGeneration,
    })
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 1 } })
    expect((await generations(f)).locale.currentSnapshotId).toBe(old.snapshotId)
  })
  test("missing counter/readiness never supplies an implicit zero", blockProfile([]), async () => {
    const f = await fixture()
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("blockOccurrenceCounts")
        .withIndex("by_type_and_presentationId", (q) =>
          q.eq("type", "hero-with-image").eq("presentationId", "centered")
        )
        .unique()
      await ctx.db.delete("blockOccurrenceCounts", row!._id)
    })
    expect(await count(f)).toEqual({ status: "unavailable" })
    expect(await count(app())).toEqual({ status: "unavailable" })
  })
  test("canonical pre-index data backfills; verify detects counter drift and backfill repairs derived data", blockProfile(["hero-with-image","rich-text-body"]), async () => {
    vi.useFakeTimers()
    const f = await fixture()
    await save(f)
    await f.t.run(async (ctx) => {
      const counter = await ctx.db
        .query("blockOccurrenceCounts")
        .withIndex("by_type_and_presentationId", (q) =>
          q.eq("type", "hero-with-image").eq("presentationId", "centered")
        )
        .unique()
      await ctx.db.patch("blockOccurrenceCounts", counter!._id, { count: 99 })
    })
    await maintain(f, "verify")
    expect(await count(f)).toEqual({ status: "unavailable" })
    await maintain(f, "backfill", true)
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 1 } })
  })
  test("corrupt/orphan retained reference refuses readiness instead of guessing zero", blockProfile(["hero-with-image","rich-text-body"]), async () => {
    vi.useFakeTimers()
    const f = await fixture()
    await save(f)
    const published = await publish(f)
    await f.t.run(async (ctx) => {
      const snapshot = await ctx.db.get("pagePublishedSnapshots", published.snapshotId)
      const candidateId = snapshot!.candidateId
      const candidate = await ctx.db.get("pageLocalePublicationCandidates", candidateId)
      await ctx.db.patch("pageLocalePublicationCandidates", candidateId, {
        payloadJson: candidate!.payloadJson + " ",
      })
    })
    await maintain(f)
    expect(await count(f)).toEqual({ status: "unavailable" })
  })
  test("clearing the final source decrements once and realistic rich text round-trips", blockProfile(["hero-with-image","rich-text-body"]), async () => {
    const f = await fixture()
    const rich = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [] },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: '{"literal":true} <p>plain</p> **text**',
              marks: [
                { type: "link", attrs: { href: "https://example.com/first" } },
                { type: "bold" },
              ],
            },
          ],
        },
        { type: "paragraph", content: [] },
      ],
    })
    const input = [hero(), { ...article(), primary: { body: rich } }]
    await save(f, input)
    const draft = await f.t.run((ctx) =>
      ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", f.pageId).eq("locale", "en")
        )
        .unique()
    )
    expect("blocks" in draft!.content && draft!.content.blocks).toEqual(input)
    await save(f, input)
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 1 } })
    const changed = input.map((row) =>
      row.type === "rich-text-body"
        ? { ...row, primary: { body: rich.replace("/first", "/changed") } }
        : row
    )
    await save(f, changed)
    const edited = await f.t.run((ctx) =>
      ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", f.pageId).eq("locale", "en")
        )
        .unique()
    )
    expect("blocks" in edited!.content && edited!.content.blocks).toEqual(
      changed
    )
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 1 } })
    await save(f, [])
    await save(f, [])
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 0 } })
  })
  test("same-generation competing saves admit one writer and one K crossing", blockProfile(["hero-with-image"]), async () => {
    const f = await fixture()
    const g = await generations(f)
    const args = {
      pageId: f.pageId,
      locale: "en",
      expectedDraftGeneration: g.locale.draftGeneration,
      expectedLifecycleGeneration: g.page.lifecycleGeneration,
      slug: "home",
      expectedPresentationCatalogRevision: (
        await readBlockPresentationCatalog()
      ).revision,
      draft: {
        pageType: "landing-page" as const,
        localized: { title: "Occurrence proof" },
        blocks: [hero()],
      },
    }
    const results = await Promise.allSettled([
      f.owner.mutation(api.cms.publication.saveLocaleDraft, args),
      f.owner.mutation(api.cms.publication.saveLocaleDraft, args),
    ])
    expect(
      results.filter((value) => value.status === "fulfilled")
    ).toHaveLength(1)
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 1 } })
  })
  test("trash retains occurrences and restore keeps the same total", blockProfile(["hero-with-image","rich-text-body"]), async () => {
    const f = await fixture()
    await save(f)
    await publish(f)
    // The bootstrap page is the home page, which can no longer be trashed.
    await f.t.run(async (ctx) => {
      const settings = await ctx.db.query("siteSettings").first()
      await ctx.db.patch("siteSettings", settings!._id, { homePageId: undefined })
    })
    const g = await generations(f)
    const trashed = await f.owner.mutation(api.cms.publication.softDeletePage, {
      pageId: f.pageId,
      expectedLifecycleGeneration: g.page.lifecycleGeneration,
    })
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 1 } })
    await f.owner.mutation(api.cms.publication.restoreSoftDeletedPage, {
      pageId: f.pageId,
      expectedLifecycleGeneration: trashed.lifecycleGeneration,
    })
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 1 } })
  })
  test("backfill restart plus a live save cannot expose partial readiness", blockProfile(["hero-with-image","rich-text-body"]), async () => {
    vi.useFakeTimers()
    const f = await fixture()
    await save(f)
    await f.owner.mutation(
      api.lib.publishing.staging.startBlockOccurrenceUsageBackfill,
      {
        mode: "backfill",
        restart: true,
      }
    )
    expect(await count(f)).toEqual({ status: "unavailable" })
    await save(f, [hero("changed-during-backfill"), article()])
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    // A concurrent change may invalidate this pass; an explicit restart is the
    // supported recovery and must produce the current canonical total.
    await maintain(f, "backfill", true)
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 1 } })
  })

  test.skipIf(!legacyHistoryInstalled)("legacy saved and staged sources count; archival revisions enter only on Restore", async () => {
    vi.useFakeTimers()
    const t = convexTest({ schema, modules, ownerIdentity: OWNER })
    migrationsTest.register(t)
    const owner = t.withIdentity(OWNER)
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      slug: "legacy-occurrence",
      status: "published",
      title: "Legacy",
      expectedPresentationCatalogRevision: (
        await readBlockPresentationCatalog()
      ).revision,
      content: { en: { title: "Legacy", blocks: [hero("saved")] } },
    })
    const revisionId = await t.run((ctx) =>
      ctx.db.insert("pageRevisions", {
        pageId,
        revisionNumber: 99,
        createdAt: Date.now(),
        reason: "publish",
        status: "published",
        slug: "legacy-occurrence",
        pageType: "landing-page",
        contentJson: JSON.stringify({
          en: { title: "Revision", blocks: [hero("revision-only")] },
        }),
        metadata: { title: "Revision", locales: ["en"], summary: [] },
      })
    )
    const f = { t, owner }
    await maintain(f)
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 1 } })
    await owner.mutation(restoreLegacyRevision, {
      revisionId,
    })
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 2 } })
    const staged = await t.run((ctx) =>
      ctx.db
        .query("pageStaging")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
    )
    expect(staged!.content?.en).toEqual({
      title: "Revision",
      blocks: [hero("revision-only")],
    })
  })
  test("valid retained candidate survives orphaned live Page sources", blockProfile(["hero-with-image","rich-text-body"]), async () => {
    vi.useFakeTimers()
    const f = await fixture()
    await save(f)
    const published = await publish(f)
    await f.t.run(async (ctx) => {
      const snapshot = await ctx.db.get("pagePublishedSnapshots", published.snapshotId)
      for (const ref of await ctx.db
        .query("pagePublicationBlockReferences")
        .collect())
        if (ref.sourceId !== snapshot!.candidateId) await ctx.db.delete("pagePublicationBlockReferences", ref._id)
      for (const table of [
        "pageLocaleDrafts",
        "pageSharedDrafts",
        "pagePublishedSnapshots",
        "pages",
      ] as const)
        for (const row of await ctx.db.query(table).collect())
          await ctx.db.delete(table, row._id)
    })
    await maintain(f)
    expect(await count(f)).toEqual({ status: "ready", counts: { centered: 1 } })
  })
  test("unchanged publish coalesces totals; an edited saved presentation is reflected after publish", blockProfile(["hero-with-image","rich-text-body"]), async () => {
    const f = await fixture()
    await save(f)
    await publish(f)
    expect(await count(f, "hero-with-image", ["default", "centered"])).toEqual({
      status: "ready",
      counts: { default: 0, centered: 1 },
    })
    await save(f)
    await publish(f)
    expect(await count(f, "hero-with-image", ["default", "centered"])).toEqual({
      status: "ready",
      counts: { default: 0, centered: 1 },
    })
    await save(f, [hero("hero", "default"), article()])
    const saved = await count(f, "hero-with-image", ["default", "centered"])
    expect(saved).toEqual({
      status: "ready",
      counts: { default: 1, centered: 1 },
    })
    await publish(f)
    expect(await count(f, "hero-with-image", ["default", "centered"])).toEqual(
      saved
    )
  })
})
