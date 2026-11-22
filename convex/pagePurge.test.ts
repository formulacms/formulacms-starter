/// <reference types="vite/client" />

import { blockProfile } from "@/test-utils/block-profile"
import migrationsTest from "@convex-dev/migrations/test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"
import {
  PAGE_KEYED_TABLES,
  PAGE_STRING_KEYED,
  pagePurgeTuning,
} from "./lib/publishing/pagePurge"
import { readCurrentSnapshotProjection } from "./lib/publishing/snapshots"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "page-purge-owner",
  tokenIdentifier: "page-purge-owner",
}
const block = (id: string, text: string) => ({
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

type Site = Awaited<ReturnType<typeof setup>>

async function setup() {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  migrationsTest.register(t)
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homeId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", blocks: [] } },
  })
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "Purge",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      homePageId: homeId,
      updatedAt: Date.now(),
    })
  )
  const site = { t, owner, homeId }
  await maintain(site, "backfill")
  return site
}

async function maintain(
  f: { t: Site["t"]; owner: Site["owner"] },
  mode: "backfill" | "verify",
  restart = false
) {
  await f.owner.mutation(
    api.lib.publishing.staging.startBlockOccurrenceUsageBackfill,
    { mode, restart }
  )
  await f.t.finishAllScheduledFunctions(vi.runAllTimers)
}

async function newPage(f: Site, slug: string, parentId?: Id<"pages">) {
  return f.owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug,
    title: slug,
    ...(parentId ? { parentId } : {}),
    content: {
      en: { title: `${slug} en`, blocks: [] },
      fr: { title: `${slug} fr`, blocks: [] },
    },
  })
}

async function gens(f: Site, pageId: Id<"pages">, locale: string) {
  return f.t.run(async (ctx) => ({
    locale: (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique())!,
    page: (await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!,
    shared: (await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!,
  }))
}

async function saveDraft(
  f: Site,
  pageId: Id<"pages">,
  locale: string,
  text: string,
  slug: string
) {
  const g = await gens(f, pageId, locale)
  return f.owner.mutation(api.cms.publication.saveEditorDraft, {
    pageId,
    expectedLifecycleGeneration: g.page.lifecycleGeneration,
    localized: {
      locale,
      slug: `${slug}-${locale}`,
      expectedGeneration: g.locale.draftGeneration,
      draft: {
        pageType: "landing-page",
        localized: { title: `T ${text}` },
        blocks: [block(`a-${text}`, text), block(`b-${text}`, `${text} two`)],
      },
    },
  })
}

async function publish(f: Site, pageId: Id<"pages">, locale: string) {
  const g = await gens(f, pageId, locale)
  return f.owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale,
    expectedDraftGeneration: g.locale.draftGeneration,
    expectedSharedDraftGeneration: g.shared.generation,
    expectedPublicGeneration: g.locale.publicGeneration,
    expectedReleaseGeneration: g.locale.releaseGeneration,
    expectedLifecycleGeneration: g.page.lifecycleGeneration,
  })
}

async function publishedPage(f: Site, slug: string, rounds = 3) {
  const pageId = await newPage(f, slug)
  for (let i = 0; i < rounds; i += 1)
    for (const locale of ["en", "fr"]) {
      await saveDraft(f, pageId, locale, `${slug}-${locale}-${i}`, slug)
      await publish(f, pageId, locale)
    }
  return pageId
}

async function trash(f: Site, pageId: Id<"pages">) {
  const g = await gens(f, pageId, "en")
  await f.owner.mutation(api.cms.publication.softDeletePage, {
    pageId,
    expectedLifecycleGeneration: g.page.lifecycleGeneration,
  })
  await completeIntents(f, pageId)
  return (await gens(f, pageId, "en")).page.lifecycleGeneration
}

/** The revalidation drain is a cron the harness does not run. */
async function completeIntents(f: Site, pageId: Id<"pages">) {
  await f.t.run(async (ctx) => {
    for (const row of await ctx.db
      .query("pagePublicationRevalidationIntents")
      .collect())
      if (row.pageId === pageId)
        await ctx.db.patch("pagePublicationRevalidationIntents", row._id, {
          status: "complete",
          phase: "complete",
        })
  })
}

type PurgeResult = {
  pageId: Id<"pages">
  status: "started" | "refused"
  reason?: string
  detail?: { count?: number; titles?: string[]; menus?: string[] }
}
/** Delete is a request only: it queues markers and starts no worker. */
const requestPurge = (
  f: Site,
  items: Array<{ pageId: Id<"pages">; generation: number }>
): Promise<PurgeResult[]> =>
  f.owner.mutation(api.cms.publication.purgeTrashedPages, {
    items: items.map((item) => ({
      pageId: item.pageId,
      expectedLifecycleGeneration: item.generation,
    })),
  })
/** The request followed by the daily batch start (what the cron does). */
const purge = async (
  f: Site,
  items: Array<{ pageId: Id<"pages">; generation: number }>
): Promise<PurgeResult[]> => {
  const out = await requestPurge(f, items)
  await f.t.mutation(internal.cms.publication.startQueuedPagePurges, {})
  return out
}

/** Rows of every owned table that still name the Page. */
async function leftovers(f: Site, pageId: Id<"pages">) {
  return f.t.run(async (ctx) => {
    const out: Record<string, number> = {}
    for (const [table, info] of Object.entries(PAGE_KEYED_TABLES)) {
      // Dual-role tables are checked on their own side (pageId / sourceId).
      if (info.role === "kept") continue
      if (table === "menus") continue
      const rows = (await ctx.db.query(table as never).collect()) as Array<
        Record<string, unknown>
      >
      const hits = rows.filter(
        (row) =>
          row.pageId === pageId ||
          row.sourceId === pageId ||
          row.toPageId === pageId ||
          row._id === pageId
      )
      if (hits.length > 0) out[table] = hits.length
    }
    return out
  })
}

/** Marks every queued marker as started (what the first worker step does). */
async function markStarted(f: Pick<Site, "t">) {
  await f.t.run(async (ctx) => {
    for (const marker of await ctx.db.query("pagePurges").collect())
      await ctx.db.patch("pagePurges", marker._id, { startedAt: Date.now() })
  })
}

async function counters(f: Site) {
  return f.t.run(async (ctx) =>
    (await ctx.db.query("blockOccurrenceCounts").collect())
      .map((row) => `${row.type}:${row.presentationId}=${row.count}`)
      .sort()
  )
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  pagePurgeTuning.maxSourcesPerBatch = 10
})

describe("schema closure", () => {
  test("every table with a Page id is classified in the purge module", () => {
    const found = new Map<string, string[]>()
    const walk = (node: unknown, path: string, table: string) => {
      if (!node || typeof node !== "object") return
      const json = node as Record<string, unknown>
      if (json.type === "id" && json.tableName === "pages") {
        found.set(table, [...(found.get(table) ?? []), path])
        return
      }
      for (const [key, child] of Object.entries(json))
        walk(child, `${path}.${key}`, table)
    }
    for (const [name, table] of Object.entries(schema.tables)) {
      walk(
        (table as unknown as { validator: { json: unknown } }).validator.json,
        name,
        name
      )
    }
    const unclassified = [...found.keys()].filter(
      (name) => !(name in PAGE_KEYED_TABLES)
    )
    expect(unclassified).toEqual([])
    // A classified table that no longer holds a Page id is a stale entry.
    const stale = Object.keys(PAGE_KEYED_TABLES).filter(
      (name) => !found.has(name) && name !== "pagePurges"
    )
    expect(stale).toEqual([])
    for (const [name, info] of Object.entries(PAGE_KEYED_TABLES))
      expect(info.reason, name).not.toEqual("")
  })

  test("Page ids stored as strings are declared by hand with a reason", () => {
    expect(PAGE_STRING_KEYED.length).toBeGreaterThanOrEqual(5)
    for (const entry of PAGE_STRING_KEYED) {
      expect(entry.where).not.toEqual("")
      expect(entry.safe).not.toEqual("")
    }
    // The string-typed fields exist where the declaration says they do.
    const usage = (
      schema.tables.blockOccurrenceUsage.validator as unknown as {
        json: { value: { pageId?: { fieldType: { type: string } } } }
      }
    ).json
    expect(usage.value.pageId?.fieldType.type).toBe("string")
  })
})

describe("permanent page purge", () => {
  test(
    "a two-language page published three times is removed from every owned table",
    blockProfile(["rich-text-body"]),
    async () => {
      const f = await setup()
      const baseline = await counters(f)
      const pageId = await publishedPage(f, "doomed")
      const otherId = await publishedPage(f, "bystander", 1)
      const withBoth = await counters(f)
      expect(withBoth).not.toEqual(baseline)
      const [snapshot] = await f.t.run((ctx) =>
        ctx.db
          .query("pagePublishedSnapshots")
          .withIndex("by_pageId_and_locale_and_generation", (q) =>
            q.eq("pageId", pageId)
          )
          .take(1)
      )
      await f.owner.mutation(api.cms.pages.touchPagePresence, { pageId })
      const otherBefore = await leftovers(f, otherId)
      // Rows the editor flows do not create here: a redirect, a historical
      // route, a search row and a soft-deleted menu that links the page.
      await f.t.run(async (ctx) => {
        const now = Date.now()
        await ctx.db.insert("redirects", {
          fromPath: "/old-doomed",
          toPageId: pageId,
          statusCode: 301,
          createdAt: now,
          updatedAt: now,
        })
        await ctx.db.insert("pageHistoricalLocaleRoutes", {
          pageId,
          locale: "en",
          fromPath: "/older",
          createdFromSnapshotId: snapshot!._id,
          createdAt: now,
        })
        await ctx.db.insert("pageSearch", {
          pageId,
          locale: "en",
          status: "draft",
          title: "t",
          slug: "s",
          text: "doomed text",
          updatedAt: now,
        })
        await ctx.db.insert("menus", {
          slug: "old-menu",
          nav: [
            {
              id: "x",
              label: { en: "Doomed" },
              target: { type: "internal", pageId },
              panel: {
                columns: 1,
                sections: [
                  {
                    id: "g",
                    kind: "linkGroup",
                    links: [
                      {
                        id: "l",
                        label: { en: "Link" },
                        target: { type: "internal", pageId },
                      },
                    ],
                  },
                ],
              },
            },
          ],
          updatedAt: now,
          deletedAt: now,
        })
      })
      const generation = await trash(f, pageId)
      const pilotBefore = await f.t.run((ctx) =>
        ctx.db.query("pilotEnvelope").first()
      )

      pagePurgeTuning.maxSourcesPerBatch = 1
      const [result] = await purge(f, [{ pageId, generation }])
      expect(result).toMatchObject({
        pageId,
        status: "started",
      })
      await f.t.finishAllScheduledFunctions(vi.runAllTimers)

      expect(await leftovers(f, pageId)).toEqual({})
      expect(
        await f.t.run((ctx) => ctx.db.query("pagePurges").collect())
      ).toEqual([])
      // Several steps ran (forced one source per batch).
      const steps = await f.t.run(
        async (ctx) =>
          (await ctx.db.system.query("_scheduled_functions").collect()).filter(
            (job) => job.name.includes("runPagePurgeStep")
          ).length
      )
      expect(steps).toBeGreaterThan(8)
      expect(await leftovers(f, otherId)).toEqual(otherBefore)
      const pilotAfter = await f.t.run((ctx) =>
        ctx.db.query("pilotEnvelope").first()
      )
      expect(pilotAfter!.totalPageCount).toBe(pilotBefore!.totalPageCount - 1)

      // The menu keeps its place and still restores and validates.
      const menu = await f.t.run((ctx) =>
        ctx.db
          .query("menus")
          .withIndex("by_slug", (q) => q.eq("slug", "old-menu"))
          .unique()
      )
      expect(JSON.stringify(menu!.nav)).not.toContain(pageId)
      await f.owner.mutation(api.cms.menus.restore, { id: menu!._id })

      // Block-occurrence counts equal a fresh recount, and the public reader
      // of a kept continuity row tolerates the missing page.
      const incremental = await counters(f)
      await maintain(f, "backfill", true)
      expect(await counters(f)).toEqual(incremental)
      // The existing verifier agrees: no invalid source, counters ready.
      await maintain(f, "verify")
      expect(
        await f.owner.query(
          api.cms.blockLibrary.getBlockPresentationUsageSummary,
          { type: "rich-text-body", presentationIds: ["default"] }
        )
      ).toMatchObject({ status: "ready" })
      const projection = await f.t.run((ctx) =>
        readCurrentSnapshotProjection(ctx, pageId, "en")
      )
      expect(projection).toBeNull()
    }
  )

  test("a parent and its child selected together are both removed, child first", async () => {
    const f = await setup()
    const parentId = await newPage(f, "parent")
    const childId = await newPage(f, "child", parentId)
    const parentGeneration = await trash(f, parentId)
    const childGeneration = await trash(f, childId)
    const results = await purge(f, [
      { pageId: parentId, generation: parentGeneration },
      { pageId: childId, generation: childGeneration },
    ])
    expect(results.map((entry) => entry.status)).toEqual(["started", "started"])
    const queue = await f.t.run((ctx) =>
      ctx.db.query("pagePurges").withIndex("by_requestedAt").collect()
    )
    expect(queue.map((row) => row.pageId)).toEqual([childId, parentId])
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await leftovers(f, parentId)).toEqual({})
    expect(await leftovers(f, childId)).toEqual({})
  })

  test(
    "two pages in one request drain one after the other and the counts match a recount",
    blockProfile(["rich-text-body"]),
    async () => {
      const f = await setup()
      const a = await publishedPage(f, "first", 2)
      const b = await publishedPage(f, "second", 2)
      const ga = await trash(f, a)
      const gb = await trash(f, b)
      pagePurgeTuning.maxSourcesPerBatch = 2
      await purge(f, [
        { pageId: a, generation: ga },
        { pageId: b, generation: gb },
      ])
      await f.t.finishAllScheduledFunctions(vi.runAllTimers)
      expect(await leftovers(f, a)).toEqual({})
      expect(await leftovers(f, b)).toEqual({})
      const incremental = await counters(f)
      await maintain(f, "backfill", true)
      expect(await counters(f)).toEqual(incremental)
    }
  )
})

describe("refusals", () => {
  async function trashed(f: Site, slug: string) {
    const pageId = await newPage(f, slug)
    return { pageId, generation: await trash(f, pageId) }
  }

  test("not trashed, stale generation and the home page", async () => {
    const f = await setup()
    const live = await newPage(f, "live")
    const { pageId, generation } = await trashed(f, "gone")
    const results = await purge(f, [
      { pageId: live, generation: 1 },
      { pageId, generation: generation + 5 },
      { pageId: f.homeId, generation: 1 },
    ])
    expect(results.map((entry) => entry.reason)).toEqual([
      "not_trashed",
      "stale",
      "not_trashed",
    ])
    // A trashed page that is also the settings home is refused as home.
    await f.t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", settings._id, { homePageId: pageId })
    })
    const [home] = await purge(f, [{ pageId, generation }])
    expect(home).toMatchObject({ status: "refused", reason: "home" })
  })

  test("a draft-only child refuses its parent", async () => {
    const f = await setup()
    const parent = await trashed(f, "has-child")
    // The child is created while the parent is active; trash the parent after.
    const live = await newPage(f, "p2")
    await newPage(f, "kid", live)
    const g = await trash(f, live)
    const [result] = await purge(f, [{ pageId: live, generation: g }])
    expect(result).toMatchObject({ status: "refused", reason: "children" })
    expect(result!.detail?.count).toBe(1)
    expect(parent.pageId).toBeTruthy()
  })

  test("an incoming link from another page refuses; selecting both is allowed", async () => {
    const f = await setup()
    const target = await newPage(f, "target")
    const source = await newPage(f, "source")
    await f.t.run(async (ctx) => {
      const shared = await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", source))
        .unique()
      await ctx.db.insert("pagePublicationDocumentReferences", {
        pageId: source,
        targetId: target,
        targetType: "landing-page",
        sourcePath: "shared.link",
        referenceKind: "shared-field",
        sourceKind: "shared_draft",
        sourceId: shared!._id,
        sourceGeneration: shared!.generation,
        createdAt: 1,
        updatedAt: 1,
      })
    })
    const tg = await trash(f, target)
    const sg = await trash(f, source)
    const [only] = await purge(f, [{ pageId: target, generation: tg }])
    expect(only).toMatchObject({ status: "refused", reason: "incoming_links" })
    expect(only!.detail?.count).toBe(1)
    const both = await purge(f, [
      { pageId: target, generation: tg },
      { pageId: source, generation: sg },
    ])
    expect(both.map((entry) => entry.status)).toEqual(["started", "started"])
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await leftovers(f, target)).toEqual({})
    expect(await leftovers(f, source)).toEqual({})
  })

  test("a live menu refuses", async () => {
    const f = await setup()
    const { pageId, generation } = await trashed(f, "menu-linked")
    await f.t.run(async (ctx) => {
      const menuId = await ctx.db.insert("menus", {
        slug: "primary",
        nav: [],
        updatedAt: 1,
      })
      await ctx.db.insert("menuReferences", {
        menuId,
        targetId: pageId,
        path: "nav/id:x/target",
        updatedAt: 1,
      })
    })
    const [result] = await purge(f, [{ pageId, generation }])
    expect(result).toMatchObject({ status: "refused", reason: "menus" })
    expect(result!.detail?.menus).toEqual(["primary"])
  })

  test("a pending revalidation intent does not refuse the start; the worker waits for it", async () => {
    const f = await setup()
    const pageId = await newPage(f, "intents")
    const g = await gens(f, pageId, "en")
    await f.owner.mutation(api.cms.publication.softDeletePage, {
      pageId,
      expectedLifecycleGeneration: g.page.lifecycleGeneration,
    })
    const generation = (await gens(f, pageId, "en")).page.lifecycleGeneration
    const pending = await f.t.run((ctx) =>
      ctx.db.query("pagePublicationRevalidationIntents").collect()
    )
    // Only published locales write intents; make one pending on purpose.
    if (pending.length === 0)
      await f.t.run((ctx) =>
        ctx.db.insert("pagePublicationRevalidationIntents", {
          operationId: "test-pending",
          operationKind: "soft_delete",
          pageId,
          locale: "en",
          oldPublicGeneration: 1,
          newPublicGeneration: 1,
          phase: "self",
          status: "pending",
          attempts: 0,
          createdAt: 1,
          updatedAt: 1,
        })
      )
    const [impact] = await f.owner.query(api.cms.publication.pagePurgeImpact, {
      pageIds: [pageId],
    })
    expect(impact).toMatchObject({ pageId, canPurge: true })
    const [started] = await purge(f, [{ pageId, generation }])
    expect(started!.status).toBe("started")
    const step = () =>
      f.t.mutation(internal.cms.publication.runPagePurgeStep, {})
    await step()
    const marker = await f.t.run((ctx) =>
      ctx.db
        .query("pagePurges")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
    )
    // Held at the intents phase, before anything the drain needs is removed.
    expect(marker!.phase).toBe("intents")
    expect(marker!.waitUntil).toBeGreaterThan(Date.now())
    expect(marker!.stalledAt).toBeUndefined()
    expect(await f.t.run((ctx) => ctx.db.get("pages", pageId))).not.toBeNull()
    // The drain fails it: a failed intent never blocks, and stays for the drain.
    await f.t.run(async (ctx) => {
      for (const row of await ctx.db
        .query("pagePublicationRevalidationIntents")
        .collect())
        await ctx.db.patch("pagePublicationRevalidationIntents", row._id, {
          status: "failed",
        })
    })
    vi.setSystemTime(Date.now() + 120_000)
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    // Failed intents stay for the existing drain; nothing else is left.
    expect(Object.keys(await leftovers(f, pageId))).toEqual([
      "pagePublicationRevalidationIntents",
    ])
    expect(await f.t.run((ctx) => ctx.db.get("pages", pageId))).toBeNull()
  })

  test("a bulk start accepts pages that have a running intent", async () => {
    const f = await setup()
    const pageId = await newPage(f, "bulk-intent")
    const g = await trash(f, pageId)
    await f.t.run((ctx) =>
      ctx.db.insert("pagePublicationRevalidationIntents", {
        operationId: "bulk-running",
        operationKind: "soft_delete",
        pageId,
        locale: "en",
        oldPublicGeneration: 1,
        newPublicGeneration: 1,
        phase: "self",
        status: "running",
        attempts: 1,
        createdAt: 1,
        updatedAt: 1,
      })
    )
    const [started] = await purge(f, [{ pageId, generation: g }])
    expect(started!.status).toBe("started")
  })

  test("an open language transition refuses, and a purge blocks starting one", async () => {
    const t = convexTest({
      schema,
      modules,
      ownerIdentity: OWNER,
      publicationAuthority: "missing",
    })
    const owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Language op",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const f = { t, owner } as unknown as Site
    const pageId = await newPage(f, "lang-op")
    const generation = await trash(f, pageId)
    const startTransition = async () => {
      const { settings, authority } = await t.run(async (ctx) => ({
        settings: await ctx.db.query("siteSettings").first(),
        authority: await ctx.db.query("siteLanguageAuthority").first(),
      }))
      return owner.mutation(api.cms.language.startLanguageTransition, {
        mode: "correct_label",
        sourceLocale: "en",
        targetLocale: "fr",
        expectedSettingsUpdatedAt: settings!.updatedAt,
        expectedAuthorityVersion: authority?.version ?? 0,
      })
    }
    await startTransition()
    const [refused] = await purge(f, [{ pageId, generation }])
    expect(refused).toMatchObject({
      status: "refused",
      reason: "language_operation",
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  })

  test("a started purge refuses to start a language transition", async () => {
    const t = convexTest({
      schema,
      modules,
      ownerIdentity: OWNER,
      publicationAuthority: "missing",
    })
    const owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Language op",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const f = { t, owner } as unknown as Site
    const pageId = await newPage(f, "queued")
    const generation = await trash(f, pageId)
    await purge(f, [{ pageId, generation }])
    await markStarted(f)
    const { settings, authority } = await t.run(async (ctx) => ({
      settings: await ctx.db.query("siteSettings").first(),
      authority: await ctx.db.query("siteLanguageAuthority").first(),
    }))
    await expect(
      owner.mutation(api.cms.language.startLanguageTransition, {
        mode: "correct_label",
        sourceLocale: "en",
        targetLocale: "fr",
        expectedSettingsUpdatedAt: settings!.updatedAt,
        expectedAuthorityVersion: authority?.version ?? 0,
      })
    ).rejects.toThrow("PAGE_PURGE_IN_PROGRESS")
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  })

  test("more than 25 items are refused outright", async () => {
    const f = await setup()
    const items = Array.from({ length: 26 }, () => ({
      pageId: f.homeId,
      generation: 1,
    }))
    // The same id repeated is de-duplicated, so use distinct ids.
    const ids = await Promise.all(
      Array.from({ length: 26 }, (_, index) => newPage(f, `bulk-${index}`))
    )
    void items
    await expect(
      purge(
        f,
        ids.map((pageId) => ({ pageId, generation: 1 }))
      )
    ).rejects.toThrow("PAGE_PURGE_BATCH_TOO_LARGE")
  })

  test("pagePurgeImpact shows the refusal and the redirect count before confirming", async () => {
    const f = await setup()
    const { pageId } = await trashed(f, "impact")
    await f.t.run((ctx) =>
      ctx.db.insert("redirects", {
        fromPath: "/impact-old",
        toPageId: pageId,
        statusCode: 301,
        createdAt: 1,
        updatedAt: 1,
      })
    )
    const live = await newPage(f, "impact-live")
    const impact = await f.owner.query(api.cms.publication.pagePurgeImpact, {
      pageIds: [pageId, live],
    })
    expect(impact).toEqual([
      { pageId, canPurge: true, redirects: 1 },
      { pageId: live, canPurge: false, reason: "not_trashed", redirects: 0 },
    ])
  })
})

describe("stale closure and failures", () => {
  test("writers refuse a page that has a purge marker", async () => {
    const f = await setup()
    const pageId = await newPage(f, "marked")
    const other = await newPage(f, "other")
    const g = await trash(f, pageId)
    await purge(f, [{ pageId, generation: g }]) // the worker has not run yet
    // Restore refused while purging.
    await expect(
      f.owner.mutation(api.cms.publication.restoreSoftDeletedPage, {
        pageId,
        expectedLifecycleGeneration: g,
      })
    ).rejects.toThrow("PAGE_PURGE_IN_PROGRESS")
    // A menu save may not link it.
    await expect(
      f.owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "en",
        nav: [
          {
            id: "n1",
            label: { en: "Marked" },
            target: { type: "internal", pageId },
          },
        ],
      })
    ).rejects.toThrow("PAGE_PURGE_IN_PROGRESS")
    // A draft may not take it as a parent.
    const og = await gens(f, other, "en")
    await expect(
      f.owner.mutation(api.cms.publication.saveSharedDraft, {
        pageId: other,
        expectedSharedDraftGeneration: og.shared.generation,
        expectedLifecycleGeneration: og.page.lifecycleGeneration,
        parentId: pageId,
      })
    ).rejects.toThrow("PAGE_PURGE_IN_PROGRESS")
    // A redirect may not point at it.
    await expect(
      f.owner.mutation(api.cms.redirects.create, {
        fromPath: "/to-marked",
        toPageId: pageId,
        statusCode: 301,
      })
    ).rejects.toThrow()
    // An accepted delete is no longer listed.
    const trashList = await f.owner.query(api.cms.publication.listAdminPages, {
      paginationOpts: { numItems: 10, cursor: null },
      scope: "trash",
    })
    expect(trashList.page.find((row) => row._id === pageId)).toBeUndefined()
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
  })

  test("a reference that appears between steps stops the final step and keeps the marker", async () => {
    const f = await setup()
    const target = await newPage(f, "late-target")
    const source = await newPage(f, "late-source")
    const g = await trash(f, target)
    await purge(f, [{ pageId: target, generation: g }])
    // After the start and before the worker: a draft of another page points at
    // the target (a writer race the markers cannot see, simulated directly).
    await f.t.run(async (ctx) => {
      const shared = await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", source))
        .unique()
      await ctx.db.insert("pagePublicationDocumentReferences", {
        pageId: source,
        targetId: target,
        targetType: "landing-page",
        sourcePath: "shared.late",
        referenceKind: "shared-field",
        sourceKind: "shared_draft",
        sourceId: shared!._id,
        sourceGeneration: shared!.generation,
        createdAt: 1,
        updatedAt: 1,
      })
    })
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    const marker = await f.t.run((ctx) =>
      ctx.db
        .query("pagePurges")
        .withIndex("by_pageId", (q) => q.eq("pageId", target))
        .unique()
    )
    expect(marker).toMatchObject({ lastError: "closure:incoming_links" })
    expect(marker!.stalledAt).toBeDefined()
    // The page row survives: nothing was deleted at the point of no return.
    expect(await f.t.run((ctx) => ctx.db.get("pages", target))).not.toBeNull()
  })

  test("a batch that throws keeps the marker with attempts and lastError", async () => {
    const f = await setup()
    const pageId = await newPage(f, "broken")
    const g = await trash(f, pageId)
    // 513 reference rows on one source exceed the per-source limit: every
    // batch fails the same way.
    await f.t.run(async (ctx) => {
      const shared = (await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique())!
      const storageId = await ctx.storage.store(new Blob(["x"]))
      const mediaId = await ctx.db.insert("media", {
        filename: "x.png",
        storageId,
        url: "https://example.test/x.png",
        size: 1,
        mimeType: "image/png",
        uploadedAt: 1,
      })
      for (let i = 0; i < 513; i += 1)
        await ctx.db.insert("pagePublicationMediaReferences", {
          pageId,
          mediaId,
          storageId,
          sourcePath: `p${i}`,
          referenceKind: "block-image",
          sourceKind: "shared_draft",
          sourceId: shared._id,
          sourceGeneration: shared.generation,
          createdAt: 1,
          updatedAt: 1,
        })
    })
    await purge(f, [{ pageId, generation: g }])
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    const marker = await f.t.run((ctx) =>
      ctx.db
        .query("pagePurges")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
    )
    expect(marker).toMatchObject({ attempts: 3 })
    expect(marker!.lastError).toContain("PUBLICATION_REFERENCE_LIMIT")
    expect(marker!.stalledAt).toBeDefined()
    // The failed batch rolled back: the page and its language states survive
    // even though the locale-state phase runs before the failing phase.
    expect(await f.t.run((ctx) => ctx.db.get("pages", pageId))).not.toBeNull()
    expect(
      await f.t.run(
        async (ctx) =>
          (await ctx.db.query("pageLocalePublicationStates").collect()).filter(
            (row) => row.pageId === pageId
          ).length
      )
    ).toBe(2)
    // A second request retries the stalled purge.
    await f.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("pagePublicationMediaReferences")
        .collect()
      for (const row of rows.slice(0, 5))
        await ctx.db.delete("pagePublicationMediaReferences", row._id)
    })
    const [retry] = await purge(f, [{ pageId, generation: g }])
    expect(retry!.status).toBe("started")
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await leftovers(f, pageId)).toEqual({})
  })

  test("the final step waits for revalidation that starts after the purge began", async () => {
    const f = await setup()
    const pageId = await newPage(f, "waiting")
    const g = await trash(f, pageId)
    await purge(f, [{ pageId, generation: g }])
    const step = () =>
      f.t.mutation(internal.cms.publication.runPagePurgeStep, {})
    await step() // every phase before the point of no return
    await f.t.run((ctx) =>
      ctx.db.insert("pagePublicationRevalidationIntents", {
        operationId: "late-intent",
        operationKind: "restore",
        pageId,
        locale: "en",
        oldPublicGeneration: 1,
        newPublicGeneration: 1,
        phase: "self",
        status: "running",
        attempts: 0,
        createdAt: 1,
        updatedAt: 1,
      })
    )
    await step()
    const waiting = await f.t.run((ctx) =>
      ctx.db
        .query("pagePurges")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
    )
    expect(waiting!.waitUntil).toBeGreaterThan(Date.now())
    expect(waiting!.stalledAt).toBeUndefined()
    expect(await f.t.run((ctx) => ctx.db.get("pages", pageId))).not.toBeNull()
    // Drained: the next step, after the wait, finishes the purge.
    await f.t.run(async (ctx) => {
      const intent = (
        await ctx.db.query("pagePublicationRevalidationIntents").collect()
      ).find((row) => row.operationId === "late-intent")!
      await ctx.db.patch("pagePublicationRevalidationIntents", intent._id, {
        status: "complete",
        phase: "complete",
      })
    })
    vi.setSystemTime(Date.now() + 120_000)
    await step()
    expect(await f.t.run((ctx) => ctx.db.get("pages", pageId))).toBeNull()
  })

  test("the Trash list hides an accepted delete and keeps a stalled one with its marker title", async () => {
    const f = await setup()
    const pageId = await newPage(f, "half-gone")
    const g = await trash(f, pageId)
    await purge(f, [{ pageId, generation: g }])
    await f.t.run(async (ctx) => {
      const shared = await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
      await ctx.db.delete("pageSharedDrafts", shared!._id)
    })
    const list = () =>
      f.owner.query(api.cms.publication.listAdminPages, {
        paginationOpts: { numItems: 10, cursor: null },
        scope: "trash",
      })
    // Accepted and running: not listed, and the list says it is complete.
    const running = await list()
    expect(running.page).toHaveLength(0)
    expect(running.isDone).toBe(true)
    // Stalled: listed again, with the title and address kept in the marker.
    await f.t.run(async (ctx) => {
      const marker = await ctx.db
        .query("pagePurges")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
      await ctx.db.patch("pagePurges", marker!._id, { stalledAt: Date.now() })
    })
    const stalled = await list()
    expect(stalled.page).toHaveLength(1)
    expect(stalled.page[0]).toMatchObject({
      _id: pageId,
      slug: "half-gone",
      purgeStalled: true,
      localizedTitles: { en: "half-gone en", fr: "half-gone fr" },
    })
    expect(stalled.page[0]!.purging).toBeUndefined()
  })

  test("a menu cannot be restored with a link to a page being purged", async () => {
    const f = await setup()
    const pageId = await newPage(f, "menu-restore")
    const g = await trash(f, pageId)
    const menuId = await f.t.run((ctx) =>
      ctx.db.insert("menus", {
        slug: "primary",
        nav: [
          { id: "n", label: { en: "X" }, target: { type: "internal", pageId } },
        ],
        updatedAt: 1,
        deletedAt: 1,
      })
    )
    await purge(f, [{ pageId, generation: g }])
    await expect(
      f.owner.mutation(api.cms.menus.restore, { id: menuId })
    ).rejects.toThrow("PAGE_PURGE_IN_PROGRESS")
  })

  test("an incoming link is found even behind many rows of a page that goes away too", async () => {
    const f = await setup()
    const target = await newPage(f, "scan-target")
    const together = await newPage(f, "scan-together")
    const blocker = await newPage(f, "scan-blocker")
    await f.t.run(async (ctx) => {
      const row = async (source: Id<"pages">, path: string) => {
        const draft = (await ctx.db
          .query("pageSharedDrafts")
          .withIndex("by_pageId", (q) => q.eq("pageId", source))
          .unique())!
        await ctx.db.insert("pagePublicationDocumentReferences", {
          pageId: source,
          targetId: target,
          targetType: "landing-page",
          sourcePath: path,
          referenceKind: "shared-field",
          sourceKind: "shared_draft",
          sourceId: draft._id,
          sourceGeneration: draft.generation,
          createdAt: 1,
          updatedAt: 1,
        })
      }
      // 513 rows from the page that is selected together come first in the
      // index; the blocking page's single row comes after them.
      for (let i = 0; i < 513; i += 1) await row(together, `many.${i}`)
      await row(blocker, "late.link")
    })
    const tg = await trash(f, target)
    const og = await trash(f, together)
    const results = await purge(f, [
      { pageId: target, generation: tg },
      { pageId: together, generation: og },
    ])
    expect(results[0]).toMatchObject({
      status: "refused",
      reason: "incoming_links",
    })
    expect(results[0]!.detail?.count).toBe(1)
  })

  test("readers and a rival claiming the address stay healthy after every step", async () => {
    const f = await setup()
    const pageId = await publishedPage(f, "reader", 2)
    const rival = await newPage(f, "rival")
    const generation = await trash(f, pageId)
    pagePurgeTuning.maxSourcesPerBatch = 1
    await purge(f, [{ pageId, generation }])
    const claim = async () => {
      const g = await gens(f, rival, "en")
      try {
        await f.owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId: rival,
          expectedLifecycleGeneration: g.page.lifecycleGeneration,
          localized: {
            locale: "en",
            slug: "reader-en",
            expectedGeneration: g.locale.draftGeneration,
            draft: {
              pageType: "landing-page",
              localized: { title: "Rival" },
              blocks: [],
            },
          },
        })
      } catch (error) {
        // Taken is fine while the page still holds the address; any other
        // failure (such as an invalid address state) is a broken step.
        const text = JSON.stringify(
          (error as { data?: unknown }).data ?? String(error)
        )
        expect(text).toContain("PAGE_ADDRESS_TAKEN")
      }
    }
    for (let step = 0; step < 300; step += 1) {
      for (const scope of ["trash", "content"] as const)
        await f.owner.query(api.cms.publication.listAdminPages, {
          paginationOpts: { numItems: 20, cursor: null },
          scope,
        })
      await f.owner
        .mutation(api.cms.pages.touchPagePresence, { pageId })
        .catch(() => undefined)
      await claim()
      if (!(await f.t.run((ctx) => ctx.db.get("pages", pageId)))) break
      await f.t.mutation(internal.cms.publication.runPagePurgeStep, {})
    }
    expect(await f.t.run((ctx) => ctx.db.get("pages", pageId))).toBeNull()
    expect(await leftovers(f, pageId)).toEqual({})
    await claim() // the address is free once the page is gone
  })

  test("only links the owner can fix block: old versions and legacy rows do not", async () => {
    const f = await setup()
    const target = await newPage(f, "fix-target")
    const other = await publishedPage(f, "fix-other", 1)
    const tg = await trash(f, target)
    const candidate = await f.t.run(async (ctx) => {
      const row = (await ctx.db
        .query("pageLocalePublicationCandidates")
        .withIndex("by_pageId_and_locale_and_createdAt", (q) =>
          q.eq("pageId", other)
        )
        .first())!
      await ctx.db.insert("pagePublicationDocumentReferences", {
        pageId: other,
        locale: "en",
        targetId: target,
        targetType: "landing-page",
        sourcePath: "old.link",
        referenceKind: "shared-field",
        sourceKind: "candidate",
        sourceId: row._id,
        candidateDigest: row.digest,
        createdAt: 1,
        updatedAt: 1,
      } as never)
      // A frozen legacy row of another page.
      await ctx.db.insert("documentReferences", {
        sourceId: other,
        targetId: target,
        targetType: "landing-page",
        path: "legacy.link",
        source: "shared-field",
        updatedAt: 1,
      })
      return row
    })
    // Old published version (its release is "published") and legacy row: no block.
    const pass = await f.owner.query(api.cms.publication.pagePurgeImpact, {
      pageIds: [target],
    })
    expect(pass[0]).toMatchObject({ canPurge: true })
    // The same candidate in a scheduled (pending) release blocks.
    const releaseId = await f.t.run(async (ctx) => {
      const release = (await ctx.db
        .query("pageLocalePublicationReleases")
        .withIndex("by_candidateId", (q) => q.eq("candidateId", candidate._id))
        .first())!
      await ctx.db.patch("pageLocalePublicationReleases", release._id, {
        status: "pending",
      })
      return release._id
    })
    const blocked = await f.owner.query(api.cms.publication.pagePurgeImpact, {
      pageIds: [target],
    })
    expect(blocked[0]).toMatchObject({
      canPurge: false,
      reason: "incoming_links",
    })
    expect(blocked[0]!.detail?.count).toBe(1)
    await f.t.run((ctx) =>
      ctx.db.patch("pageLocalePublicationReleases", releaseId, {
        status: "published",
      })
    )
    const [started] = await purge(f, [{ pageId: target, generation: tg }])
    expect(started!.status).toBe("started")
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await f.t.run((ctx) => ctx.db.get("pages", target))).toBeNull()
    // The other page keeps its old reference rows as history.
    expect(await f.t.run((ctx) => ctx.db.get("pages", other))).not.toBeNull()
  })

  test("a started purge blocks the module enable and the multilingual adoption", async () => {
    const t = convexTest({
      schema,
      modules,
      ownerIdentity: OWNER,
      publicationAuthority: "missing",
    })
    const owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Module op",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const f = { t, owner } as unknown as Site
    const version = async () =>
      (await t.run((ctx) => ctx.db.query("cmsModuleState").first()))
        ?.configurationVersion ?? 0
    const enable = async () =>
      owner.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: await version(),
        changes: [{ moduleId: "multilingual", enabled: true }],
      })
    const queuePurge = async (slug: string) => {
      const pageId = await newPage(f, slug)
      const generation = await trash(f, pageId)
      await purge(f, [{ pageId, generation }])
      await markStarted(f)
    }
    // Module off: enabling is refused while a purge is queued, then allowed.
    await queuePurge("module-op-a")
    await expect(enable()).rejects.toThrow("PAGE_PURGE_IN_PROGRESS")
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    await enable()
    // Module on: adoption and return are refused while a purge is queued.
    await queuePurge("module-op-b")
    await expect(
      owner.mutation(api.cms.multilingual.adoptMultilingualAuthority, {
        expectedSettingsUpdatedAt: 0,
        expectedModuleConfigurationVersion: await version(),
        expectedAuthorityVersion: null,
      })
    ).rejects.toThrow("PAGE_PURGE_IN_PROGRESS")
    await expect(
      owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
        expectedAuthorityVersion: 0,
      })
    ).rejects.toThrow("PAGE_PURGE_IN_PROGRESS")
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  })

  test("the daily batch restarts a lost chain", async () => {
    const f = await setup()
    const pageId = await newPage(f, "resumed")
    const g = await trash(f, pageId)
    await purge(f, [{ pageId, generation: g }])
    // Drop the scheduled step to simulate a lost chain.
    await f.t.run(async (ctx) => {
      for (const job of await ctx.db.system
        .query("_scheduled_functions")
        .collect())
        await ctx.scheduler.cancel(job._id)
    })
    expect(
      await f.t.mutation(internal.cms.publication.startQueuedPagePurges, {})
    ).toBe(true)
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await leftovers(f, pageId)).toEqual({})
    expect(
      await f.t.mutation(internal.cms.publication.startQueuedPagePurges, {})
    ).toBe(false)
  })
})

describe("review round 1 fixes", () => {
  const step = (f: Site) =>
    f.t.mutation(internal.cms.publication.runPagePurgeStep, {})
  const markerOf = (f: Site, pageId: Id<"pages">) =>
    f.t.run((ctx) =>
      ctx.db
        .query("pagePurges")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .first()
    )
  const intentRows = (f: Site, pageId: Id<"pages">) =>
    f.t.run(async (ctx) =>
      (
        await ctx.db.query("pagePublicationRevalidationIntents").collect()
      ).filter((row) => row.pageId === pageId)
    )

  test(
    "withdrawal is refused once the purge starts",
    blockProfile(["rich-text-body"]),
    async () => {
      const f = await setup()
      const pageId = await publishedPage(f, "withdrawn", 1)
      const generation = await trash(f, pageId)
      await purge(f, [{ pageId, generation }])
      const state = await gens(f, pageId, "en")
      await expect(
        f.owner.mutation(api.cms.publication.withdrawLocale, {
          pageId,
          locale: "en",
          expectedSnapshotId: state.locale.currentSnapshotId!,
          expectedPublicGeneration: state.locale.publicGeneration,
          expectedLifecycleGeneration: state.page.lifecycleGeneration,
        })
      ).rejects.toThrow("PAGE_PURGE_IN_PROGRESS")
      await f.t.finishAllScheduledFunctions(vi.runAllTimers)
      expect(await leftovers(f, pageId)).toEqual({})
    }
  )

  test(
    "snapshots and locale states stay while an intent is pending, and go once it completes",
    blockProfile(["rich-text-body"]),
    async () => {
      const f = await setup()
      const pageId = await publishedPage(f, "held-published", 1)
      const generation = await trash(f, pageId)
      const intentId = await f.t.run((ctx) =>
        ctx.db.insert("pagePublicationRevalidationIntents", {
          operationId: "held-pending",
          operationKind: "soft_delete",
          pageId,
          locale: "en",
          oldPublicGeneration: 1,
          newPublicGeneration: 1,
          phase: "self",
          status: "pending",
          attempts: 0,
          createdAt: 1,
          updatedAt: 1,
        })
      )
      const [started] = await purge(f, [{ pageId, generation }])
      expect(started!.status).toBe("started")
      const counts = () =>
        f.t.run(async (ctx) => ({
          snapshots: (
            await ctx.db
              .query("pagePublishedSnapshots")
              .withIndex("by_pageId_and_locale_and_generation", (q) =>
                q.eq("pageId", pageId)
              )
              .collect()
          ).length,
          states: (
            await ctx.db
              .query("pageLocalePublicationStates")
              .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
              .collect()
          ).length,
        }))
      const before = await counts()
      expect(before.snapshots).toBeGreaterThan(0)
      expect(before.states).toBeGreaterThan(0)
      // Several worker rounds, each after the 30 s wait: nothing is removed.
      for (let round = 0; round < 3; round += 1) {
        await step(f)
        vi.setSystemTime(Date.now() + 40_000)
      }
      expect(await counts()).toEqual(before)
      expect((await markerOf(f, pageId))?.phase).toBe("intents")
      expect(await f.t.run((ctx) => ctx.db.get("pages", pageId))).not.toBeNull()
      // The drain completes it; the worker then finishes.
      await f.t.run((ctx) =>
        ctx.db.patch("pagePublicationRevalidationIntents", intentId, {
          status: "complete",
          phase: "complete",
        })
      )
      await f.t.finishAllScheduledFunctions(vi.runAllTimers)
      expect(await f.t.run((ctx) => ctx.db.get("pages", pageId))).toBeNull()
      expect(await leftovers(f, pageId)).toEqual({})
    }
  )

  test("an intent that completes after the intents phase is removed with the page", async () => {
    const f = await setup()
    const pageId = await newPage(f, "late-intent")
    const generation = await trash(f, pageId)
    await purge(f, [{ pageId, generation }])
    await step(f) // every phase before final
    expect((await markerOf(f, pageId))?.phase).toBe("final")
    await f.t.run((ctx) =>
      ctx.db.insert("pagePublicationRevalidationIntents", {
        operationId: "late-complete",
        operationKind: "withdraw",
        pageId,
        locale: "en",
        oldPublicGeneration: 1,
        newPublicGeneration: 2,
        phase: "complete",
        status: "complete",
        attempts: 1,
        createdAt: 1,
        updatedAt: 1,
      })
    )
    await step(f)
    expect(await f.t.run((ctx) => ctx.db.get("pages", pageId))).toBeNull()
    expect(await intentRows(f, pageId)).toEqual([])
  })

  test("a failed intent that completes after the page is gone is deleted by the drain", async () => {
    const f = await setup()
    const pageId = await newPage(f, "failed-intent")
    const generation = await trash(f, pageId)
    const kept = await f.t.run((ctx) =>
      ctx.db.insert("pagePublicationRevalidationIntents", {
        operationId: "kept-failed",
        operationKind: "soft_delete",
        pageId,
        locale: "en",
        oldPublicGeneration: 1,
        newPublicGeneration: 1,
        phase: "self",
        status: "failed",
        attempts: 3,
        createdAt: 1,
        // Inside the retry delay, so the drain scheduled by the trash leaves it.
        updatedAt: Date.now(),
      })
    )
    await purge(f, [{ pageId, generation }])
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await f.t.run((ctx) => ctx.db.get("pages", pageId))).toBeNull()
    expect((await intentRows(f, pageId)).map((row) => row._id)).toEqual([kept])
    // The existing drain retries it, finishes it, and nothing is left behind.
    await f.t.run((ctx) =>
      ctx.db.patch("pagePublicationRevalidationIntents", kept, {
        status: "running",
        attempts: 4,
      })
    )
    await f.t.mutation(
      internal.cms.revalidate.advancePublicationRevalidationIntent,
      {
        intentId: kept,
        attempts: 4,
        fromPhase: "self",
        fromCursor: null,
        nextPhase: "complete",
        nextCursor: null,
        unconfigured: false,
      }
    )
    expect(await intentRows(f, pageId)).toEqual([])
  })

  test("25 pages with 650 redirects each start and drain in worker batches", async () => {
    const f = await setup()
    const targets: Array<{ pageId: Id<"pages">; generation: number }> = []
    for (let i = 0; i < 25; i += 1) {
      const pageId = await newPage(f, `redirect-heavy-${i}`)
      targets.push({ pageId, generation: await trash(f, pageId) })
    }
    await f.t.run(async (ctx) => {
      for (const { pageId } of targets)
        for (let n = 0; n < 650; n += 1)
          await ctx.db.insert("redirects", {
            fromPath: `/old-${pageId}-${n}`,
            toPageId: pageId,
            statusCode: 301,
            createdAt: 1,
            updatedAt: 1,
          })
    })
    const impact = await f.owner.query(api.cms.publication.pagePurgeImpact, {
      pageIds: targets.map((t) => t.pageId),
    })
    expect(impact.every((row) => row.redirects === 650)).toBe(true)
    const results = await purge(f, targets)
    expect(results.every((row) => row.status === "started")).toBe(true)
    // The start wrote markers only; no redirect was deleted in it.
    expect(
      await f.t.run(
        async (ctx) => (await ctx.db.query("redirects").collect()).length
      )
    ).toBe(25 * 650)
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(
      await f.t.run(
        async (ctx) => (await ctx.db.query("redirects").collect()).length
      )
    ).toBe(0)
    for (const { pageId } of targets)
      expect(await f.t.run((ctx) => ctx.db.get("pages", pageId))).toBeNull()
  })

  test("a parent selected in a later call than its child, and a target after its referrer", async () => {
    const f = await setup()
    const parent = await newPage(f, "later-parent")
    const child = await newPage(f, "later-child", parent)
    const target = await newPage(f, "later-target")
    const referrer = await newPage(f, "later-referrer")
    await f.t.run(async (ctx) => {
      const shared = (await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", referrer))
        .unique())!
      await ctx.db.insert("pagePublicationDocumentReferences", {
        pageId: referrer,
        targetId: target,
        targetType: "landing-page",
        sourcePath: "shared.link",
        referenceKind: "shared-field",
        sourceKind: "shared_draft",
        sourceId: shared._id,
        sourceGeneration: shared.generation,
        createdAt: 1,
        updatedAt: 1,
      })
    })
    const gp = await trash(f, parent)
    const gc = await trash(f, child)
    const gt = await trash(f, target)
    const gr = await trash(f, referrer)
    // Call 1 queues the child and the referrer; call 2 (later, not yet drained)
    // adds the parent and the target.
    expect(
      (
        await purge(f, [
          { pageId: child, generation: gc },
          { pageId: referrer, generation: gr },
        ])
      ).map((r) => r.status)
    ).toEqual(["started", "started"])
    expect(
      (
        await purge(f, [
          { pageId: parent, generation: gp },
          { pageId: target, generation: gt },
        ])
      ).map((r) => r.status)
    ).toEqual(["started", "started"])
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    for (const id of [parent, child, target, referrer]) {
      expect(await f.t.run((ctx) => ctx.db.get("pages", id))).toBeNull()
      expect(await leftovers(f, id)).toEqual({})
    }
  })

  test("a queued referrer's link rows are gone before its target is deleted", async () => {
    const f = await setup()
    const target = await newPage(f, "ordered-target")
    const referrer = await newPage(f, "ordered-referrer")
    await f.t.run(async (ctx) => {
      const shared = (await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", referrer))
        .unique())!
      await ctx.db.insert("pagePublicationDocumentReferences", {
        pageId: referrer,
        targetId: target,
        targetType: "landing-page",
        sourcePath: "shared.link",
        referenceKind: "shared-field",
        sourceKind: "shared_draft",
        sourceId: shared._id,
        sourceGeneration: shared.generation,
        createdAt: 1,
        updatedAt: 1,
      })
    })
    const gt = await trash(f, target)
    const gr = await trash(f, referrer)
    // The target is first in the queue; the referrer's rows are still there.
    await purge(f, [
      { pageId: target, generation: gt },
      { pageId: referrer, generation: gr },
    ])
    const linkRows = () =>
      f.t.run(
        async (ctx) =>
          (
            await ctx.db.query("pagePublicationDocumentReferences").collect()
          ).filter((row) => row.targetId === target).length
      )
    // The target reaches its last step first and waits for the link rows; the
    // referrer then drains. The target is still there while any row remains.
    for (let n = 0; n < 300; n += 1) {
      if (!(await f.t.run((ctx) => ctx.db.get("pages", referrer)))) break
      await step(f)
      if (await linkRows())
        expect(
          await f.t.run((ctx) => ctx.db.get("pages", target))
        ).not.toBeNull()
    }
    vi.setSystemTime(Date.now() + 40_000) // past the target's wait
    for (let n = 0; n < 5; n += 1) await step(f)
    expect(await f.t.run((ctx) => ctx.db.get("pages", target))).toBeNull()
    expect(await linkRows()).toBe(0)
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await f.t.run((ctx) => ctx.db.get("pages", referrer))).toBeNull()
  })

  test(
    "closure guard: after a late withdrawal and a stalled-then-retried step, no row references the purged ids",
    blockProfile(["rich-text-body"]),
    async () => {
      const f = await setup()
      const stored = await f.t.run(async (ctx) => {
        const storageId = await ctx.storage.store(new Blob(["pic"]))
        const url = "https://files.example.test/guard.png"
        const mediaId = await ctx.db.insert("media", {
          filename: "guard.png",
          storageId,
          url,
          size: 3,
          mimeType: "image/png",
          uploadedAt: 1,
        })
        return { storageId, url, mediaId }
      })
      const pageId = await newPage(f, "guarded")
      const g0 = await gens(f, pageId, "en")
      await f.owner.mutation(api.cms.publication.saveEditorDraft, {
        pageId,
        expectedLifecycleGeneration: g0.page.lifecycleGeneration,
        localized: {
          locale: "en",
          slug: "guarded-en",
          expectedGeneration: g0.locale.draftGeneration,
          draft: {
            pageType: "landing-page",
            localized: { title: "Guarded" },
            blocks: [
              {
                id: "body",
                type: "rich-text-body",
                enabled: true,
                primary: {
                  body: JSON.stringify({
                    type: "doc",
                    content: [
                      { type: "image", attrs: { src: stored.url, alt: "x" } },
                    ],
                  }),
                },
              },
            ],
          },
        },
      })
      await publish(f, pageId, "en")
      const generation = await trash(f, pageId)
      // Stall: a source with too many reference rows fails every batch.
      const filler = await f.t.run(async (ctx) => {
        const shared = (await ctx.db
          .query("pageSharedDrafts")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .unique())!
        const ids: Id<"pagePublicationMediaReferences">[] = []
        for (let i = 0; i < 513; i += 1)
          ids.push(
            await ctx.db.insert("pagePublicationMediaReferences", {
              pageId,
              mediaId: stored.mediaId,
              storageId: stored.storageId,
              sourcePath: `filler.${i}`,
              referenceKind: "block-image",
              sourceKind: "shared_draft",
              sourceId: shared._id,
              sourceGeneration: shared.generation,
              createdAt: 1,
              updatedAt: 1,
            })
          )
        return ids
      })
      await purge(f, [{ pageId, generation }])
      await f.t.finishAllScheduledFunctions(vi.runAllTimers)
      const stalled = await markerOf(f, pageId)
      expect(stalled?.stalledAt).toBeDefined()
      const listed = await f.owner.query(api.cms.publication.listAdminPages, {
        paginationOpts: { numItems: 10, cursor: null },
        scope: "trash",
      })
      expect(listed.page.find((row) => row._id === pageId)).toMatchObject({
        purgeStalled: true,
      })
      expect(
        listed.page.find((row) => row._id === pageId)?.purging
      ).toBeUndefined()
      // A late withdrawal is refused while the purge is stalled too.
      const state = await gens(f, pageId, "en")
      await expect(
        f.owner.mutation(api.cms.publication.withdrawLocale, {
          pageId,
          locale: "en",
          expectedSnapshotId: state.locale.currentSnapshotId!,
          expectedPublicGeneration: state.locale.publicGeneration,
          expectedLifecycleGeneration: state.page.lifecycleGeneration,
        })
      ).rejects.toThrow("PAGE_PURGE_IN_PROGRESS")
      // Fix the cause, retry through the same Delete call, and finish.
      await f.t.run(async (ctx) => {
        for (const id of filler)
          await ctx.db.delete("pagePublicationMediaReferences", id)
      })
      const [retry] = await purge(f, [{ pageId, generation }])
      expect(retry!.status).toBe("started")
      await f.t.finishAllScheduledFunctions(vi.runAllTimers)
      // The image is now unused: delete it for good too.
      await f.t.run((ctx) =>
        ctx.db.patch("media", stored.mediaId, { deletedAt: 5 })
      )
      const { finishMediaUsageBackfill } =
        await import("@/test-utils/media-usage-backfill")
      await finishMediaUsageBackfill(f.t)
      const [media] = await f.owner.mutation(api.cms.media.purgeTrashedMedia, {
        ids: [stored.mediaId],
      })
      expect(media).toMatchObject({ status: "purged" })
      // Scan every table: no row mentions the purged page, image or file.
      const needles = [pageId, stored.mediaId, stored.storageId]
      const hits = await f.t.run(async (ctx) => {
        const found: string[] = []
        for (const table of Object.keys(schema.tables)) {
          const rows = (await ctx.db.query(table as never).collect()) as Array<
            Record<string, unknown>
          >
          for (const row of rows) {
            const text = JSON.stringify(row)
            for (const needle of needles)
              if (text.includes(needle)) found.push(`${table}:${needle}`)
          }
        }
        return found
      })
      expect(hits).toEqual([])
      expect(Object.keys(schema.tables).length).toBeGreaterThan(80)
    }
  )
})

describe("delete is a request; the daily batch does the work", () => {
  const markerOf = (f: Site, pageId: Id<"pages">) =>
    f.t.run((ctx) =>
      ctx.db
        .query("pagePurges")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .first()
    )
  // Publication intents now schedule an instant-refresh drain; these tests count purge work only.
  const pendingJobs = (f: Site) =>
    f.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.state.kind === "pending" && job.name !== "cms/revalidate:drainPublicationRevalidationIntents"
      )
    )
  const trashList = (f: Site) =>
    f.owner.query(api.cms.publication.listAdminPages, {
      paginationOpts: { numItems: 50, cursor: null },
      scope: "trash",
    })

  test("a request queues the marker, starts no worker, and hides the row", async () => {
    const f = await setup()
    const pageId = await newPage(f, "queued")
    const g = await trash(f, pageId)
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await pendingJobs(f)).length).toBe(0)
    const [res] = await requestPurge(f, [{ pageId, generation: g }])
    expect(res).toMatchObject({ pageId, status: "started" })
    const marker = await markerOf(f, pageId)
    expect(marker).toMatchObject({ attempts: 0, slug: "queued" })
    expect(marker!.stalledAt).toBeUndefined()
    expect((await pendingJobs(f)).length).toBe(0)
    // Nothing was removed yet; the row is hidden from Trash.
    expect(await f.t.run((ctx) => ctx.db.get("pages", pageId))).not.toBeNull()
    const list = await trashList(f)
    expect(list.page.find((row) => row._id === pageId)).toBeUndefined()
    // Restore is refused for a queued page.
    await expect(
      f.owner.mutation(api.cms.publication.restoreSoftDeletedPage, {
        pageId,
        expectedLifecycleGeneration: g,
      })
    ).rejects.toThrow("PAGE_PURGE_IN_PROGRESS")
  })

  test("a second Delete on a queued page changes nothing", async () => {
    const f = await setup()
    const pageId = await newPage(f, "twice")
    const g = await trash(f, pageId)
    await requestPurge(f, [{ pageId, generation: g }])
    const before = await markerOf(f, pageId)
    const [again] = await requestPurge(f, [{ pageId, generation: g }])
    expect(again).toMatchObject({ pageId, status: "started" })
    expect(await markerOf(f, pageId)).toEqual(before)
    expect(
      await f.t.run((ctx) => ctx.db.query("pagePurges").collect())
    ).toHaveLength(1)
    expect((await pendingJobs(f)).length).toBe(0)
  })

  test("refusals stay immediate and queue nothing", async () => {
    const f = await setup()
    const g = await trash(f, f.homeId).catch(() => null)
    const pageId = await newPage(f, "not-trashed")
    const [notTrashed] = await requestPurge(f, [{ pageId, generation: 1 }])
    expect(notTrashed).toMatchObject({ status: "refused", reason: "not_trashed" })
    void g
    expect(
      await f.t.run((ctx) => ctx.db.query("pagePurges").collect())
    ).toHaveLength(0)
    expect((await pendingJobs(f)).length).toBe(0)
  })

  test("the daily batch removes more pages than one batch holds, across reschedules", async () => {
    const f = await setup()
    pagePurgeTuning.maxSourcesPerBatch = 1
    const targets: Array<{ pageId: Id<"pages">; generation: number }> = []
    for (let i = 0; i < 4; i += 1) {
      const pageId = await newPage(f, `batch-${i}`)
      targets.push({ pageId, generation: await trash(f, pageId) })
    }
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    await requestPurge(f, targets)
    expect((await pendingJobs(f)).length).toBe(0)
    expect(
      await f.t.run((ctx) => ctx.db.query("pagePurges").collect())
    ).toHaveLength(4)
    expect(
      await f.t.mutation(internal.cms.publication.startQueuedPagePurges, {})
    ).toBe(true)
    // One tick only: the chain has begun but is not finished in one step.
    await f.t.finishInProgressScheduledFunctions()
    await f.t.finishAllScheduledFunctions(vi.runAllTimers)
    for (const t of targets) {
      expect(await f.t.run((ctx) => ctx.db.get("pages", t.pageId))).toBeNull()
      expect(await leftovers(f, t.pageId)).toEqual({})
    }
    expect(
      await f.t.run((ctx) => ctx.db.query("pagePurges").collect())
    ).toHaveLength(0)
  })

  test("a stalled purge shows in Trash with its title; a second Delete re-queues it without a worker", async () => {
    const f = await setup()
    const pageId = await newPage(f, "stalled")
    const g = await trash(f, pageId)
    await requestPurge(f, [{ pageId, generation: g }])
    await f.t.run(async (ctx) => {
      const marker = await ctx.db
        .query("pagePurges")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .first()
      await ctx.db.patch("pagePurges", marker!._id, {
        stalledAt: Date.now(),
        attempts: 3,
        lastError: "boom",
      })
    })
    const stalled = (await trashList(f)).page.find((r) => r._id === pageId)
    expect(stalled).toMatchObject({ purgeStalled: true, slug: "stalled" })
    expect(
      await f.t.mutation(internal.cms.publication.startQueuedPagePurges, {})
    ).toBe(false)
    await requestPurge(f, [{ pageId, generation: g }])
    const marker = await markerOf(f, pageId)
    expect(marker!.stalledAt).toBeUndefined()
    expect(marker!.attempts).toBe(0)
    expect((await pendingJobs(f)).length).toBe(0)
    expect(
      (await trashList(f)).page.find((r) => r._id === pageId)
    ).toBeUndefined()
  })

  test("the trash list keeps loading: a filtered page still reports isDone and a cursor", async () => {
    const f = await setup()
    const ids: Id<"pages">[] = []
    for (let i = 0; i < 3; i += 1) {
      const pageId = await newPage(f, `list-${i}`)
      ids.push(pageId)
      await trash(f, pageId)
    }
    const gen = async (id: Id<"pages">) =>
      (await gens(f, id, "en")).page.lifecycleGeneration
    // Newest first: hide the two newest, so page 1 (size 2) is empty.
    await requestPurge(f, [
      { pageId: ids[2]!, generation: await gen(ids[2]!) },
      { pageId: ids[1]!, generation: await gen(ids[1]!) },
    ])
    const first = await f.owner.query(api.cms.publication.listAdminPages, {
      paginationOpts: { numItems: 2, cursor: null },
      scope: "trash",
    })
    expect(first.page).toHaveLength(0)
    expect(first.isDone).toBe(false)
    const second = await f.owner.query(api.cms.publication.listAdminPages, {
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
      scope: "trash",
    })
    expect(second.page.map((r) => r._id)).toEqual([ids[0]])
    expect(second.isDone).toBe(true)
  })

  describe("the address of a deleted page can be created again", () => {
    const TABLES = [
      "pageSharedDrafts",
      "pageLocaleDrafts",
      "pageLocalePublicationStates",
      "pagePublishedSnapshots",
      "pageLocalePublicationReleases",
      "pageHistoricalLocaleRoutes",
      "pagePublicationPageStates",
    ] as const
    const rowsOf = (f: Site, pageId: Id<"pages">) =>
      f.t.run(async (ctx) => {
        const out: Record<string, unknown[]> = {}
        for (const table of TABLES) {
          const rows = (await ctx.db.query(table as never).collect()) as Array<
            Record<string, unknown>
          >
          out[table] = rows.filter((row) => row.pageId === pageId)
        }
        return out
      })
    const resolve = (f: Site) =>
      f.t.query(api.cms.pages.resolveLocalizedPathQuery, {
        locale: "en",
        path: "/page-demo",
        languageVersion: 0,
      })
    const runBatchToEnd = async (f: Site) => {
      while (
        await f.t.mutation(internal.cms.publication.startQueuedPagePurges, {})
      ) {
        await f.t.finishAllScheduledFunctions(vi.runAllTimers)
        vi.setSystemTime(Date.now() + 120_000)
      }
    }
    const deletedOld = async (f: Site) => {
      const oldId = await newPage(f, "page-demo")
      await publish(f, oldId, "en")
      expect(await resolve(f)).toBe(oldId)
      const generation = await trash(f, oldId)
      await requestPurge(f, [{ pageId: oldId, generation }])
      return oldId
    }
    const createdNew = async (f: Site) => {
      const newId = await newPage(f, "page-demo")
      expect(
        (await f.owner.query(api.cms.pages.getForEdit, { id: newId }))?.page
          .slug
      ).toBe("page-demo")
      await publish(f, newId, "en")
      expect(await resolve(f)).toBe(newId)
      return newId
    }

    test("created while the delete is only queued, then the batch runs", async () => {
      const f = await setup()
      const oldId = await deletedOld(f)
      const newId = await createdNew(f)
      const before = await rowsOf(f, newId)
      await runBatchToEnd(f)
      expect(await f.t.run((ctx) => ctx.db.get("pages", oldId))).toBeNull()
      expect(await leftovers(f, oldId)).toEqual({})
      expect(await resolve(f)).toBe(newId)
      expect(await rowsOf(f, newId)).toEqual(before)
    })

    test("created after the batch ran", async () => {
      const f = await setup()
      const oldId = await deletedOld(f)
      await runBatchToEnd(f)
      expect(await f.t.run((ctx) => ctx.db.get("pages", oldId))).toBeNull()
      expect(await leftovers(f, oldId)).toEqual({})
      expect(await resolve(f)).toBeNull()
      const newId = await createdNew(f)
      const after = await rowsOf(f, newId)
      expect(after.pageLocalePublicationStates).toHaveLength(2)
      expect(await resolve(f)).toBe(newId)
    })
  })

  async function languageSite() {
    const t = convexTest({
      schema,
      modules,
      ownerIdentity: OWNER,
      publicationAuthority: "missing",
    })
    const owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Language op",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const f = { t, owner } as unknown as Site
    const start = async () => {
      const { settings, authority } = await t.run(async (ctx) => ({
        settings: await ctx.db.query("siteSettings").first(),
        authority: await ctx.db.query("siteLanguageAuthority").first(),
      }))
      return owner.mutation(api.cms.language.startLanguageTransition, {
        mode: "correct_label",
        sourceLocale: "en",
        targetLocale: "fr",
        expectedSettingsUpdatedAt: settings!.updatedAt,
        expectedAuthorityVersion: authority?.version ?? 0,
      })
    }
    return { f, t, owner, start }
  }

  test("a language operation may start while a purge is only queued", async () => {
    const { f, t, start } = await languageSite()
    const pageId = await newPage(f, "queued-only")
    const generation = await trash(f, pageId)
    await requestPurge(f, [{ pageId, generation }])
    await expect(start()).resolves.toBeDefined()
    // The queued marker still protects its page from new links.
    expect(
      await t.run((ctx) => ctx.db.query("pagePurges").collect())
    ).toHaveLength(1)
  })

  test("the batch waits for an open language operation, then finishes", async () => {
    const { f, t, owner, start } = await languageSite()
    const pageId = await newPage(f, "waits")
    const generation = await trash(f, pageId)
    await requestPurge(f, [{ pageId, generation }])
    const transitionId = await start()
    expect(
      await t.mutation(internal.cms.publication.startQueuedPagePurges, {})
    ).toBe(true)
    await t.mutation(internal.cms.publication.runPagePurgeStep, {})
    const waiting = await markerOf(f, pageId)
    expect(waiting!.startedAt).toBeUndefined()
    expect(waiting!.waitUntil).toBeGreaterThan(Date.now())
    expect(waiting!.attempts).toBe(0)
    expect(waiting!.stalledAt).toBeUndefined()
    expect(await t.run((ctx) => ctx.db.get("pages", pageId))).not.toBeNull()
    // A purge that has not started does not block the operation's own steps,
    // and a started one would; here the operation ends and the batch goes on.
    const transition = await t.run((ctx) =>
      ctx.db.get("siteLanguageTransitions", transitionId)
    )
    await owner.mutation(api.cms.language.cancelLanguageTransition, {
      transitionId,
      expectedGeneration: transition!.generation,
      discardTargetDrafts: true,
    })
    vi.setSystemTime(Date.now() + 120_000)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await t.run((ctx) => ctx.db.get("pages", pageId))).toBeNull()
    expect(await markerOf(f, pageId)).toBeNull()
  })

  test("once a purge has started, a language operation is refused", async () => {
    const { f, start } = await languageSite()
    const pageId = await newPage(f, "started")
    const generation = await trash(f, pageId)
    await requestPurge(f, [{ pageId, generation }])
    await f.t.mutation(internal.cms.publication.runPagePurgeStep, {})
    const marker = await markerOf(f, pageId)
    // One step may even finish a small page; only assert while it is open.
    if (marker) {
      expect(marker.startedAt).toBeDefined()
      await expect(start()).rejects.toThrow("PAGE_PURGE_IN_PROGRESS")
    }
  })
})
