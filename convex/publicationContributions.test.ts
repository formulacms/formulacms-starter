/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import { convexTest } from "../convexTestWithExplicitAdmin"
import type { Id } from "./_generated/dataModel"
import type { MutationCtx } from "./_generated/server"
import schema from "./schema"
import type { ModuleDescriptorV1 } from "../lib/modules/types"
import type {
  PublicationContributionEvent,
  PublicationContributionParticipant,
} from "./lib/publishing/publicationContributions"
import publicationSource from "./cms/publication.ts?raw"
import seamSource from "./lib/publishing/publicationContributions.ts?raw"

type ContributionRun = (
  ctx: MutationCtx,
  event: PublicationContributionEvent
) => Promise<void>

// The shipped installed profile is empty (no History or Search module exists).
// These tests fill its two slots through the real registered commands so the
// rollback proof crosses the actual transaction boundary.
const slots = vi.hoisted(() => ({
  history: null as ContributionRun | null,
  index: null as ContributionRun | null,
}))

vi.mock("./lib/publishing/publicationContributions", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./lib/publishing/publicationContributions")
    >()
  return {
    ...actual,
    INSTALLED_PUBLICATION_CONTRIBUTIONS: {
      get "publication.history"() {
        return slots.history
          ? {
              moduleId: "history",
              contribution: "publication.history",
              run: slots.history,
            }
          : null
      },
      get "publication.index"() {
        return slots.index
          ? {
              moduleId: "search",
              contribution: "publication.index",
              run: slots.index,
            }
          : null
      },
    },
  }
})

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "f08b-owner",
  tokenIdentifier: "https://convex.test|f08b-owner",
}

function app() {
  return convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
}

type TestApp = ReturnType<typeof app>
type Owner = ReturnType<TestApp["withIdentity"]>

const DUMPED_TABLES = [
  "pages",
  "siteSettings",
  "pagePublicationCutover",
  "pagePublicationPageStates",
  "pageSharedDrafts",
  "pageLocaleDrafts",
  "pageLocalePublicationStates",
  "pageLocalePublicationCandidates",
  "pageLocalePublicationReleases",
  "pagePublishedSnapshots",
  "pagePublicationDocumentReferences",
  "pagePublicationMediaReferences",
  "pagePublicationSliceReferences",
  "pageHistoricalLocaleRoutes",
  "pagePublicationRevalidationIntents",
  "pagePublicationMigrationPages",
  "pageRevisions",
  "pageSearch",
] as const

function dumpState(t: TestApp) {
  return t.run(async (ctx) => {
    const dump: Record<string, unknown[]> = {}
    for (const table of DUMPED_TABLES)
      dump[table] = await ctx.db.query(table).collect()
    return dump
  })
}

async function activeFixture() {
  const t = app()
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homeId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", slices: [] } },
  })
  const pageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "cafe",
    title: "Café",
    content: {
      en: { title: "Café", slices: [] },
      fr: { title: "Café français", slices: [] },
    },
  })
  await t.run(async (ctx) => {
    await ctx.db.insert("siteSettings", {
      siteName: "Contributions",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      homePageId: homeId,
      updatedAt: Date.now(),
    })
  })
  return { t, owner, pageId }
}

/** Current expected generations, read rather than assumed per command. */
function generations(t: TestApp, pageId: Id<"pages">, locale = "en") {
  return t.run(async (ctx) => {
    const [shared, localeState, pageState] = await Promise.all([
      ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique(),
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", locale)
        )
        .unique(),
      ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique(),
    ])
    if (!shared || !localeState || !pageState)
      throw new Error("publication fixture missing")
    return {
      expectedDraftGeneration: localeState.draftGeneration,
      expectedSharedDraftGeneration: shared.generation,
      expectedPublicGeneration: localeState.publicGeneration,
      expectedLifecycleGeneration: pageState.lifecycleGeneration,
      expectedReleaseGeneration: localeState.releaseGeneration,
    }
  })
}

async function publishEn(t: TestApp, owner: Owner, pageId: Id<"pages">) {
  return owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale: "en",
    ...(await generations(t, pageId)),
  })
}

function revisionRow(pageId: Id<"pages">) {
  return {
    pageId,
    revisionNumber: 1,
    createdAt: Date.now(),
    reason: "publish" as const,
    status: "published" as const,
    slug: "cafe",
    pageType: "landing-page" as const,
    metadata: { title: "Café", locales: ["en"], summary: [] },
  }
}

function descriptor(
  id: string,
  required: boolean,
  contributions: ModuleDescriptorV1["contributions"]
): ModuleDescriptorV1 {
  return {
    id,
    name: id,
    summary: id,
    descriptorVersion: 1,
    configVersion: 1,
    required,
    dependencies: [],
    environments: ["server"],
    contributions,
  }
}

beforeEach(() => {
  slots.history = null
  slots.index = null
})

describe("F08b publication contribution composition", () => {
  test("the installed Community profile has no History or Search participant", async () => {
    const actual = await vi.importActual<
      typeof import("./lib/publishing/publicationContributions")
    >("./lib/publishing/publicationContributions")
    expect(actual.INSTALLED_PUBLICATION_CONTRIBUTIONS).toEqual({
      "publication.history": null,
      "publication.index": null,
    })
    expect(Object.isFrozen(actual.INSTALLED_PUBLICATION_CONTRIBUTIONS)).toBe(
      true
    )
  })

  test("only one optional module that declares a slot may own its participant", async () => {
    const { composePublicationContributions } = await vi.importActual<
      typeof import("./lib/publishing/publicationContributions")
    >("./lib/publishing/publicationContributions")
    const run: ContributionRun = async () => {}
    const catalog = [
      descriptor("publication", true, []),
      descriptor("history", false, ["publication.history"]),
      descriptor("search", false, ["publication.index"]),
      descriptor("redirects", false, ["admin.navigation", "public.routing"]),
    ]
    const history = {
      moduleId: "history",
      contribution: "publication.history",
      run,
    } as const
    const search = {
      moduleId: "search",
      contribution: "publication.index",
      run,
    } as const

    const profile = composePublicationContributions([history, search], catalog)
    expect(profile["publication.history"]).toMatchObject({
      moduleId: "history",
    })
    expect(profile["publication.index"]).toMatchObject({ moduleId: "search" })
    expect(Object.isFrozen(profile)).toBe(true)

    for (const invalid of [
      { moduleId: "unknown", contribution: "publication.history", run },
      { moduleId: "publication", contribution: "publication.history", run },
      { moduleId: "redirects", contribution: "publication.index", run },
      { moduleId: "search", contribution: "publication.history", run },
      { moduleId: "history", contribution: "publication.policy", run },
    ]) {
      expect(() =>
        composePublicationContributions(
          [invalid as unknown as PublicationContributionParticipant],
          catalog
        )
      ).toThrow("cannot contribute")
    }
    expect(() =>
      composePublicationContributions([history, history], catalog)
    ).toThrow("already has a participant")
  })
})

describe("F08b publication contribution transaction boundary", () => {
  test("with zero participants every successor transition succeeds and writes no History or Search row", async () => {
    const { t, owner, pageId } = await activeFixture()
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId,
      locale: "en",
      slug: "cafe",
      draft: {
        pageType: "landing-page",
        localized: { title: "Edited" },
        slices: [],
      },
      expectedDraftGeneration: 1,
      expectedLifecycleGeneration: 1,
    })
    const afterLocaleSave = await generations(t, pageId)
    await owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId,
      expectedSharedDraftGeneration:
        afterLocaleSave.expectedSharedDraftGeneration,
      expectedLifecycleGeneration: 1,
      siblingOrder: 3,
    })
    const afterSharedSave = await generations(t, pageId)
    await owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: 1,
      localized: {
        locale: "en",
        slug: "cafe",
        draft: {
          pageType: "landing-page",
          localized: { title: "Edited again" },
          slices: [],
        },
        expectedGeneration: afterSharedSave.expectedDraftGeneration,
      },
    })
    await owner.mutation(api.cms.publication.discardLocaleDraft, {
      pageId,
      locale: "fr",
      expectedDraftGeneration: (await generations(t, pageId, "fr"))
        .expectedDraftGeneration,
      expectedLifecycleGeneration: 1,
    })
    const rows = () =>
      t.run(async (ctx) => ({
        pageRevisions: await ctx.db.query("pageRevisions").collect(),
        pageSearch: await ctx.db.query("pageSearch").collect(),
      }))
    expect(await rows()).toEqual({ pageRevisions: [], pageSearch: [] })

    const published = await publishEn(t, owner, pageId)
    await owner.mutation(api.cms.publication.withdrawLocale, {
      pageId,
      locale: "en",
      expectedSnapshotId: published.snapshotId,
      expectedPublicGeneration: published.publicGeneration,
      expectedLifecycleGeneration: 1,
    })
    const archived = await owner.mutation(api.cms.publication.archivePage, {
      pageId,
      expectedLifecycleGeneration: 1,
    })
    const restored = await owner.mutation(api.cms.publication.restorePage, {
      pageId,
      expectedLifecycleGeneration: archived.lifecycleGeneration,
    })
    const trashed = await owner.mutation(api.cms.publication.softDeletePage, {
      pageId,
      expectedLifecycleGeneration: restored.lifecycleGeneration,
    })
    const untrashed = await owner.mutation(
      api.cms.publication.restoreSoftDeletedPage,
      { pageId, expectedLifecycleGeneration: trashed.lifecycleGeneration }
    )
    expect(untrashed.lifecycleGeneration).toBe(5)
    expect(await rows()).toEqual({ pageRevisions: [], pageSearch: [] })
  })

  test("a History failure rolls back the whole publication before Search runs", async () => {
    const { t, owner, pageId } = await activeFixture()
    const calls: string[] = []
    slots.history = async (ctx, event) => {
      calls.push(`history:${event.kind}`)
      await ctx.db.insert("pageRevisions", revisionRow(event.pageId))
      throw new Error("HISTORY_PARTICIPANT_FAILED")
    }
    slots.index = async () => {
      calls.push("index")
    }
    const before = await dumpState(t)

    await expect(publishEn(t, owner, pageId)).rejects.toThrow(
      "HISTORY_PARTICIPANT_FAILED"
    )
    expect(calls).toEqual(["history:publish"])
    expect(await dumpState(t)).toEqual(before)

    slots.history = null
    slots.index = null
    await expect(publishEn(t, owner, pageId)).resolves.toMatchObject({ publicGeneration: 1 })
    const selected = await t.run((ctx) => ctx.db.query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId).eq("locale", "en")).unique())
    expect(selected).toMatchObject({ pageType: "landing-page", publicSince: selected!.currentPublishedAt })
  })

  test("a Search failure rolls back History's row and the whole publication", async () => {
    const { t, owner, pageId } = await activeFixture()
    const calls: string[] = []
    slots.history = async (ctx, event) => {
      calls.push("history")
      await ctx.db.insert("pageRevisions", revisionRow(event.pageId))
    }
    slots.index = async (ctx, event) => {
      calls.push("index")
      await ctx.db.insert("pageSearch", {
        pageId: event.pageId,
        locale: "en",
        status: "published",
        title: "Café",
        slug: "cafe",
        text: "Café",
        updatedAt: Date.now(),
      })
      throw new Error("SEARCH_PARTICIPANT_FAILED")
    }
    const before = await dumpState(t)

    await expect(publishEn(t, owner, pageId)).rejects.toThrow(
      "SEARCH_PARTICIPANT_FAILED"
    )
    expect(calls).toEqual(["history", "index"])
    expect(await dumpState(t)).toEqual(before)
  })

  test("withdrawal and lifecycle transitions roll back on a participant failure", async () => {
    const { t, owner, pageId } = await activeFixture()
    const published = await publishEn(t, owner, pageId)

    slots.index = async (_ctx, event) => {
      throw new Error(`SEARCH_PARTICIPANT_FAILED:${event.kind}`)
    }
    let before = await dumpState(t)
    await expect(
      owner.mutation(api.cms.publication.withdrawLocale, {
        pageId,
        locale: "en",
        expectedSnapshotId: published.snapshotId,
        expectedPublicGeneration: published.publicGeneration,
        expectedLifecycleGeneration: 1,
      })
    ).rejects.toThrow("SEARCH_PARTICIPANT_FAILED:withdraw")
    expect(await dumpState(t)).toEqual(before)

    slots.index = null
    slots.history = async (_ctx, event) => {
      throw new Error(`HISTORY_PARTICIPANT_FAILED:${event.kind}`)
    }
    before = await dumpState(t)
    for (const transition of [
      api.cms.publication.archivePage,
      api.cms.publication.softDeletePage,
    ]) {
      await expect(
        owner.mutation(transition, { pageId, expectedLifecycleGeneration: 1 })
      ).rejects.toThrow("HISTORY_PARTICIPANT_FAILED:lifecycle")
      expect(await dumpState(t)).toEqual(before)
    }
  })

  test("participants receive a frozen projection after the pointer and draft cleanup are in place", async () => {
    const { t, owner, pageId } = await activeFixture()
    const seen: Array<{
      event: PublicationContributionEvent
      pointer: Id<"pagePublishedSnapshots"> | undefined
      sourceDraftRows: number
      tamperRejected: boolean
    }> = []
    slots.history = async (ctx, event) => {
      if (event.kind !== "publish") return
      const state = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", event.pageId).eq("locale", event.locale)
        )
        .unique()
      const drafts = await ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", event.pageId).eq("locale", event.locale)
        )
        .take(2)
      let tamperRejected = false
      try {
        ;(event.payload.localized as { slug: string }).slug = "tampered"
      } catch {
        tamperRejected = true
      }
      seen.push({
        event,
        pointer: state?.currentSnapshotId,
        sourceDraftRows: drafts.length,
        tamperRejected,
      })
    }

    const first = await publishEn(t, owner, pageId)
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId,
      locale: "en",
      slug: "cafe-renamed",
      draft: {
        pageType: "landing-page",
        localized: { title: "Renamed" },
        slices: [],
      },
      expectedDraftGeneration: (await generations(t, pageId))
        .expectedDraftGeneration,
      expectedLifecycleGeneration: 1,
    })
    const second = await publishEn(t, owner, pageId)

    expect(seen).toHaveLength(2)
    const candidate = await t.run((ctx) => ctx.db.get(first.candidateId))
    expect(seen[0]!.event).toEqual({
      kind: "publish",
      pageId,
      locale: "en",
      snapshotId: first.snapshotId,
      publicGeneration: 1,
      path: "/cafe",
      payload: JSON.parse(candidate!.payloadJson),
      attribution: expect.objectContaining({ kind: "owner" }),
      occurredAt: first.publishedAt,
    })
    expect(seen[1]!.event).toMatchObject({
      snapshotId: second.snapshotId,
      previousSnapshotId: first.snapshotId,
      publicGeneration: 2,
      path: "/cafe-renamed",
      previousPath: "/cafe",
    })
    for (const record of seen) {
      expect(record.pointer).toBe(
        (record.event as { snapshotId: Id<"pagePublishedSnapshots"> })
          .snapshotId
      )
      expect(record.sourceDraftRows).toBe(0)
      expect(record.tamperRejected).toBe(true)
    }
  })

  test("Publication owns no History or Search writes and never catches a participant failure", () => {
    const between = (start: string, end: string) => {
      const from = publicationSource.indexOf(start)
      const to = publicationSource.indexOf(end, from)
      expect(from).toBeGreaterThan(-1)
      expect(to).toBeGreaterThan(from)
      return publicationSource.slice(from, to)
    }
    for (const body of [
      between(
        "export const publishLocale = mutation",
        "export const withdrawLocale = mutation"
      ),
      between(
        "export const withdrawLocale = mutation",
        "async function recordLifecycleIntents"
      ),
      between(
        "async function transitionLifecycle",
        "export const archivePage = mutation"
      ),
      // F09a Language-domain direct arms run the same step 10 contributions.
      between(
        "export async function publishPreparedTargetLocale",
        "export async function withdrawPreparedTargetLocale"
      ),
      between(
        "export async function withdrawPreparedTargetLocale",
        "export async function createTransitionTargetDraft"
      ),
    ]) {
      expect(
        body.match(
          /runPublicationContributions\(\s*ctx,\s*INSTALLED_PUBLICATION_CONTRIBUTIONS,/g
        )
      ).toHaveLength(1)
      expect(body).not.toMatch(/\btry\s*\{|\bcatch\b/)
    }
    expect(
      publicationSource.match(/runPublicationContributions\(/g)
    ).toHaveLength(5)
    expect(publicationSource).not.toMatch(
      /createPageRevision|syncPageSearch|deletePageSearch|insert\("page(?:Revisions|Search)"/
    )

    expect(seamSource).not.toMatch(/\btry\s*\{|\bcatch\s*[({]|\.catch\(/)
    expect(seamSource).not.toMatch(/ctx\.db\.|cmsModuleState/)
    expect(seamSource).not.toMatch(
      /from ["'][^"']*(?:\/team\/|\/memberships|\/entitlement)/
    )
    expect(seamSource).toContain(
      "INSTALLED_PUBLICATION_CONTRIBUTIONS =\n  composePublicationContributions([])"
    )
  })
})
