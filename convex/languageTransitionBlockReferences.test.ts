import { createSampleBlock } from "@/convex/lib/blocks/sample"
import { blockProfile } from "@/test-utils/block-profile"
/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import migrationsTest from "@convex-dev/migrations/test"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import schema from "./schema"
import { convexTest } from "../convexTestWithExplicitAdmin"

import { readBlockPresentationCatalog } from "./lib/blocks/presentations"

const modules = import.meta.glob("./**/*.ts")
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

type T = Fixture["t"]
const PROFILE = blockProfile(["hero-with-image", "rich-text-body"])

async function transitionRow(
  t: T,
  transitionId: Id<"siteLanguageTransitions">,
  pageId: Id<"pages">
) {
  return (await t.run((ctx) =>
    ctx.db
      .query("siteLanguageTransitionPages")
      .withIndex("by_transitionId_and_pageId", (q) =>
        q.eq("transitionId", transitionId).eq("pageId", pageId)
      )
      .unique()
  ))!
}
async function tokens(t: T, pageId: Id<"pages">, locale = "en") {
  return t.run(async (ctx) => {
    const state = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique()
    const shared = await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique()
    const page = await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique()
    return {
      expectedDraftGeneration: state?.draftGeneration ?? 0,
      expectedSharedDraftGeneration: shared!.generation,
      expectedLifecycleGeneration: page!.lifecycleGeneration,
    }
  })
}
async function start(f: Fixture, mode: "replace_content" | "correct_label" = "replace_content") {
  const { settings, authority } = await f.t.run(async (ctx) => ({
    settings: await ctx.db.query("siteSettings").unique(),
    authority: await ctx.db.query("siteLanguageAuthority").unique(),
  }))
  const transitionId = await f.owner.mutation(
    api.cms.language.startLanguageTransition,
    {
      mode,
      sourceLocale: "en",
      targetLocale: "fr",
      expectedSettingsUpdatedAt: settings!.updatedAt,
      expectedAuthorityVersion: authority!.version,
    }
  )
  for (let n = 0; n < 40; n++) {
    const transition = (await f.t.run((ctx) =>
      ctx.db.get("siteLanguageTransitions", transitionId)
    ))!
    if (transition.phase === "preparing" && transition.cursorPhase === undefined)
      return transitionId
    await f.t.mutation(internal.cms.language.stepLanguageTransition, {
      transitionId,
      generation: transition.generation,
    })
  }
  throw new Error("transition did not prepare")
}
/** Block-reference rows and occurrence-source members of one source. */
async function sourceState(
  f: Fixture,
  sourceKind: "locale_draft" | "current_public",
  locale: string
) {
  return f.t.run(async (ctx) => {
    const sourceTable =
      sourceKind === "locale_draft" ? "pageLocaleDrafts" : "pagePublishedSnapshots"
    let sourceId: string | undefined
    if (sourceKind === "locale_draft") {
      sourceId = (
        await ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", f.pageId).eq("locale", locale)
          )
          .unique()
      )?._id
    } else {
      sourceId = (
        await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", f.pageId).eq("locale", locale)
          )
          .unique()
      )?.currentSnapshotId
    }
    const refs = await ctx.db
      .query("pagePublicationBlockReferences")
      .withIndex("by_pageId_and_locale_and_sourceKind", (q) =>
        q.eq("pageId", f.pageId).eq("locale", locale).eq("sourceKind", sourceKind)
      )
      .collect()
    const source = sourceId
      ? await ctx.db
          .query("blockOccurrenceSources")
          .withIndex("by_key", (q) => q.eq("key", `${sourceTable}:${sourceId}`))
          .unique()
      : null
    const members = source
      ? await ctx.db
          .query("blockOccurrenceSourceMembers")
          .withIndex("by_sourceId_and_occurrenceId", (q) =>
            q.eq("sourceId", source._id)
          )
          .collect()
      : []
    return {
      sourceId,
      refTypes: refs.map((row) => row.blockType).sort(),
      refCount: refs.length,
      sourceExists: source !== null,
      memberCount: members.length,
    }
  })
}
/** Publishes an en page with the given blocks and checks the starting counts. */
async function seed(f: Fixture, blocks: Parameters<typeof save>[1]) {
  await save(f, blocks)
  await publish(f)
  // Baseline: two heroes in the one published en snapshot (plus one article).
  expect(await count(f)).toEqual({ status: "ready", counts: { centered: 2 } })
}
/** Drives an en -> fr replace_content change up to, not including, prepareTargetPage. */
async function toPrepare(f: Fixture, blocks: Parameters<typeof save>[1]) {
  await seed(f, blocks)
  const transitionId = await start(f)
  const { t, owner, pageId } = f
  let row = await transitionRow(t, transitionId, pageId)
  await owner.mutation(api.cms.language.setPageDisposition, {
    transitionId,
    pageId,
    disposition: "target",
    expectedPageGeneration: row.generation,
  })
  const source = await tokens(t, pageId)
  await owner.mutation(api.cms.language.copySourceToTargetDraft, {
    transitionId,
    pageId,
    expectedSourceDraftGeneration: source.expectedDraftGeneration,
    expectedLifecycleGeneration: source.expectedLifecycleGeneration,
  })
  row = await transitionRow(t, transitionId, pageId)
  const target = await tokens(t, pageId, "fr")
  await owner.mutation(api.cms.language.confirmTargetContent, {
    transitionId,
    pageId,
    expectedTargetDraftGeneration: target.expectedDraftGeneration,
    expectedSharedDraftGeneration: target.expectedSharedDraftGeneration,
    expectedPageGeneration: row.generation,
  })
  return transitionId
}
async function prepare(f: Fixture, transitionId: Id<"siteLanguageTransitions">) {
  const row = await transitionRow(f.t, transitionId, f.pageId)
  return f.owner.mutation(api.cms.language.prepareTargetPage, {
    transitionId,
    pageId: f.pageId,
    expectedPageGeneration: row.generation,
  })
}
async function withdraw(f: Fixture, transitionId: Id<"siteLanguageTransitions">) {
  const row = await transitionRow(f.t, transitionId, f.pageId)
  return f.owner.mutation(api.cms.language.setPageDisposition, {
    transitionId,
    pageId: f.pageId,
    disposition: "withdraw",
    expectedPageGeneration: row.generation,
  })
}
// Expected total after a transition: the en snapshot (2 heroes) plus the
// retained fr snapshot copy (2 heroes) = 4, even after the fr withdrawal.
async function expectOracleReady(f: Fixture, heroCount: number) {
  // The live counters must agree with the oracle's own recount.
  const live = await count(f)
  await maintain(f, "verify")
  expect(await count(f)).toEqual(live)
  expect(await count(f)).toEqual({
    status: "ready",
    counts: { centered: heroCount },
  })
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("a language change on a page with several block types", () => {
  test("prepares the target page and clears the target draft block references", PROFILE, async () => {
    const f = await fixture()
    const transitionId = await toPrepare(f, [hero(), hero("hero-2"), article()])
    const pre = await sourceState(f, "locale_draft", "fr")
    // Precondition: without these the run proves nothing.
    expect(pre.refCount).toBeGreaterThanOrEqual(2)
    expect(pre.refTypes).toEqual(["hero-with-image", "rich-text-body"])
    expect(pre.memberCount).toBeGreaterThanOrEqual(1)
    await expect(prepare(f, transitionId)).resolves.toBeDefined()
    expect((await sourceState(f, "locale_draft", "fr")).refCount).toBe(0)
    await expectOracleReady(f, 4)
  })
  test("withdraws a prepared target and clears its published block references", PROFILE, async () => {
    // correct_label prepares fr without a fr draft, so the draft clear does not
    // run first and the published-reference clear is seen alone.
    const f = await fixture()
    await seed(f, [hero(), hero("hero-2"), article()])
    const transitionId = await start(f, "correct_label")
    await prepare(f, transitionId)
    const pre = await sourceState(f, "current_public", "fr")
    // Precondition: the published fr snapshot holds both block types.
    expect(pre.refCount).toBeGreaterThanOrEqual(2)
    expect(pre.refTypes).toEqual(["hero-with-image", "rich-text-body"])
    await withdraw(f, transitionId)
    expect((await sourceState(f, "current_public", "fr")).refCount).toBe(0)
    await expectOracleReady(f, 4)
  })
  test("prepares the target page, then withdraws it, keeping the use counts right", PROFILE, async () => {
    const f = await fixture()
    const transitionId = await toPrepare(f, [hero(), hero("hero-2"), article()])
    await prepare(f, transitionId)
    const pre = await sourceState(f, "current_public", "fr")
    expect(pre.refCount).toBeGreaterThanOrEqual(2)
    await withdraw(f, transitionId)
    expect((await sourceState(f, "current_public", "fr")).refCount).toBe(0)
    await expectOracleReady(f, 4)
  })
  test("does the same with two occurrences of one block type", PROFILE, async () => {
    const f = await fixture()
    const transitionId = await toPrepare(f, [hero(), hero("hero-2")])
    const draftBefore = await sourceState(f, "locale_draft", "fr")
    expect(draftBefore.refCount).toBe(1)
    expect(draftBefore.memberCount).toBeGreaterThanOrEqual(1)
    await prepare(f, transitionId)
    expect((await sourceState(f, "locale_draft", "fr")).refCount).toBe(0)
    const currentBefore = await sourceState(f, "current_public", "fr")
    expect(currentBefore.refCount).toBe(1)
    await withdraw(f, transitionId)
    expect((await sourceState(f, "current_public", "fr")).refCount).toBe(0)
    await expectOracleReady(f, 4)
  })
})
