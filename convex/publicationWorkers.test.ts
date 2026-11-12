/// <reference types="vite/client" />

import { sliceProfile } from "@/test-utils/slice-profile"
import { afterEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"
import {
  PUBLICATION_REVALIDATION_LEASE_MS,
  PUBLICATION_REVALIDATION_RETRY_DELAY_MS,
  PUBLICATION_REVALIDATION_STEP_SIZE,
} from "./cms/revalidate"
import publicationSource from "./cms/publication.ts?raw"

// F08c required workers: the durable revalidation intent → bounded cursor
// worker → retry path, and post-cutover digest-gated legacy staging cleanup.

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "f08c-worker-owner",
  tokenIdentifier: "https://convex.test|f08c-worker-owner",
}
const PAGE_TAGS = ["cms:pages", "cms:menus"]

type App = ReturnType<typeof convexTest>
type Body = { paths: string[]; tags: string[] }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const bodySlice = (id: string, text: string) => ({
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

const firstPublish = (pageId: Id<"pages">, locale = "en") => ({
  pageId,
  locale,
  expectedDraftGeneration: 1,
  expectedSharedDraftGeneration: 1,
  expectedPublicGeneration: 0,
  expectedLifecycleGeneration: 1,
  expectedReleaseGeneration: 0,
})

function stubRevalidationTarget() {
  vi.stubEnv("REVALIDATE_SECRET", "f08c-secret")
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const postedBodies = (fetchMock: ReturnType<typeof stubRevalidationTarget>) =>
  fetchMock.mock.calls.map((call) => {
    const init = (call as unknown[])[1] as RequestInit
    return JSON.parse(String(init.body)) as Body
  })

async function activeApp() {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homeId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", slices: [] } },
  })
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "Workers",
      siteUrl: "https://site.example.com",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      homePageId: homeId,
      updatedAt: Date.now(),
    })
  )
  return { t, owner }
}

const drain = (t: App) =>
  t.action(internal.cms.revalidate.drainPublicationRevalidationIntents, {})

const allIntents = (t: App) =>
  t.run((ctx) => ctx.db.query("pagePublicationRevalidationIntents").take(100))

async function localeState(t: App, pageId: Id<"pages">, locale: string) {
  const state = await t.run((ctx) =>
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique()
  )
  if (!state) throw new Error("locale state missing")
  return state
}

async function insertIntent(
  t: App,
  pageId: Id<"pages">,
  path: string | undefined,
  overrides: Partial<{
    phase: "self" | "referrers" | "descendants" | "complete"
    status: "pending" | "running" | "failed" | "complete"
    attempts: number
    updatedAt: number
  }> = {}
) {
  const now = Date.now()
  return t.run((ctx) =>
    ctx.db.insert("pagePublicationRevalidationIntents", {
      operationId: `f08c-test:${pageId}:${now}:${Math.random()}`,
      operationKind: "republish",
      pageId,
      locale: "en",
      oldPublicGeneration: 1,
      newPublicGeneration: 1,
      ...(path ? { oldPath: path, newPath: path } : {}),
      phase: "self",
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
  )
}

describe("F08c required revalidation worker", () => {
  test("a real withdrawal purges its path, then only same-locale current referrers", sliceProfile(["rich-text-body"]), async () => {
    const { t, owner } = await activeApp()
    const authorId = await owner.mutation(api.cms.pages.create, {
      pageType: "author",
      status: "draft",
      slug: "ada",
      title: "Ada",
      name: "Ada",
      content: {
        en: { title: "Ada", slices: [] },
        fr: { title: "Ada", slices: [] },
      },
    })
    const postId = await owner.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      slug: "proof",
      title: "Proof",
      authorIds: [authorId],
      content: {
        en: { title: "Proof", slices: [bodySlice("en", "English proof")] },
        fr: { title: "Preuve", slices: [bodySlice("fr", "Preuve")] },
      },
    })
    for (const locale of ["en", "fr"]) {
      await owner.mutation(
        api.cms.publication.publishLocale,
        firstPublish(authorId, locale)
      )
      await owner.mutation(
        api.cms.publication.publishLocale,
        firstPublish(postId, locale)
      )
    }
    const fetchMock = stubRevalidationTarget()
    await drain(t)
    expect((await allIntents(t)).map((intent) => intent.status)).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
    ])

    const author = await localeState(t, authorId, "en")
    const postEn = await localeState(t, postId, "en")
    const postFr = await localeState(t, postId, "fr")
    await owner.mutation(api.cms.publication.withdrawLocale, {
      pageId: authorId,
      locale: "en",
      expectedSnapshotId: author.currentSnapshotId!,
      expectedPublicGeneration: 1,
      expectedLifecycleGeneration: 1,
    })
    fetchMock.mockClear()
    await drain(t)

    expect(postedBodies(fetchMock)).toEqual([
      {
        paths: author.currentPath ? [author.currentPath, `/en${author.currentPath}`] : [],
        tags: PAGE_TAGS,
      },
      { paths: [postEn.currentPath, `/en${postEn.currentPath}`], tags: [] },
    ])
    expect(JSON.stringify(postedBodies(fetchMock))).not.toContain(
      `/fr${postFr.currentPath}`
    )
    const withdraw = (await allIntents(t)).find(
      (intent) => intent.operationKind === "withdraw"
    )
    expect(withdraw).toMatchObject({
      status: "complete",
      phase: "complete",
      attempts: 1,
    })
  })

  test("descendants come from ancestry references in bounded cursor steps", async () => {
    const { t, owner } = await activeApp()
    const parentId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "parent",
      title: "Parent",
      content: { en: { title: "Parent", slices: [] } },
    })
    const childId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "child",
      title: "Child",
      content: { en: { title: "Child", slices: [] } },
    })
    await owner.mutation(
      api.cms.publication.publishLocale,
      firstPublish(parentId)
    )
    await t.run(async (ctx) => {
      const shared = await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", childId))
        .unique()
      if (!shared) throw new Error("child shared draft missing")
      await ctx.db.patch(shared._id, { system: { parentId } })
    })
    await owner.mutation(
      api.cms.publication.publishLocale,
      firstPublish(childId)
    )
    const fetchMock = stubRevalidationTarget()
    await drain(t)

    // Pad the ancestry arm past one step so the cursor must resume.
    await t.run(async (ctx) => {
      const [ancestry] = await ctx.db
        .query("pagePublicationDocumentReferences")
        .withIndex("by_targetId_and_sourceKind_and_locale", (q) =>
          q
            .eq("targetId", parentId)
            .eq("sourceKind", "current_public")
            .eq("locale", "en")
        )
        .take(1)
      if (!ancestry || ancestry.referenceKind !== "ancestry") {
        throw new Error("child ancestry reference missing")
      }
      const { _id, _creationTime, ...copy } = ancestry
      void _id
      void _creationTime
      for (let i = 0; i < PUBLICATION_REVALIDATION_STEP_SIZE; i += 1) {
        await ctx.db.insert("pagePublicationDocumentReferences", copy)
      }
    })
    const parent = await localeState(t, parentId, "en")
    const child = await localeState(t, childId, "en")
    const intentId = await insertIntent(t, parentId, parent.currentPath)
    fetchMock.mockClear()
    await drain(t)

    expect(postedBodies(fetchMock)).toEqual([
      { paths: [parent.currentPath, `/en${parent.currentPath}`], tags: PAGE_TAGS },
      { paths: [child.currentPath, `/en${child.currentPath}`], tags: [] },
      { paths: [child.currentPath, `/en${child.currentPath}`], tags: [] },
    ])
    expect(await t.run((ctx) => ctx.db.get(intentId))).toMatchObject({
      status: "complete",
      phase: "complete",
    })
  })

  test("a failed POST retries the same step after the delay and a stale lease is reclaimed", async () => {
    const { t, owner } = await activeApp()
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "retry",
      title: "Retry",
      content: { en: { title: "Retry", slices: [] } },
    })
    await owner.mutation(
      api.cms.publication.publishLocale,
      firstPublish(pageId)
    )
    const fetchMock = stubRevalidationTarget()
    fetchMock.mockImplementation(async () => {
      throw new Error("offline")
    })
    await drain(t)
    const [failed] = await allIntents(t)
    expect(failed).toMatchObject({
      status: "failed",
      phase: "self",
      attempts: 1,
      lastErrorCode: "REVALIDATION_NETWORK_ERROR",
    })

    fetchMock.mockClear()
    await drain(t)
    expect(fetchMock).not.toHaveBeenCalled()

    // A stale claim token can never advance the cursor.
    expect(
      await t.mutation(
        internal.cms.revalidate.advancePublicationRevalidationIntent,
        {
          intentId: failed!._id,
          attempts: 1,
          fromPhase: "self",
          fromCursor: null,
          nextPhase: "complete",
          nextCursor: null,
          unconfigured: false,
        }
      )
    ).toBe(false)

    await t.run((ctx) =>
      ctx.db.patch(failed!._id, {
        updatedAt: Date.now() - PUBLICATION_REVALIDATION_RETRY_DELAY_MS - 1,
      })
    )
    fetchMock.mockImplementation(
      async () => new Response("{}", { status: 200 })
    )
    await drain(t)
    const state = await localeState(t, pageId, "en")
    expect(postedBodies(fetchMock)).toEqual([
      { paths: [state.currentPath, `/en${state.currentPath}`], tags: PAGE_TAGS },
    ])
    expect(await t.run((ctx) => ctx.db.get(failed!._id))).toMatchObject({
      status: "complete",
      attempts: 2,
    })

    const abandoned = await insertIntent(t, pageId, state.currentPath, {
      phase: "referrers",
      status: "running",
      attempts: 5,
      updatedAt: Date.now() - PUBLICATION_REVALIDATION_LEASE_MS - 1,
    })
    // An older claim on a running intent cannot advance it either.
    expect(
      await t.mutation(
        internal.cms.revalidate.advancePublicationRevalidationIntent,
        {
          intentId: abandoned,
          attempts: 4,
          fromPhase: "referrers",
          fromCursor: null,
          nextPhase: "complete",
          nextCursor: null,
          unconfigured: false,
        }
      )
    ).toBe(false)
    expect(await t.run((ctx) => ctx.db.get(abandoned))).toMatchObject({
      status: "running",
      phase: "referrers",
      attempts: 5,
    })
    fetchMock.mockClear()
    await drain(t)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await t.run((ctx) => ctx.db.get(abandoned))).toMatchObject({
      status: "complete",
      phase: "complete",
      attempts: 6,
    })
  })

  test("an unconfigured target completes the intent without fetching", async () => {
    const { t, owner } = await activeApp()
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "quiet",
      title: "Quiet",
      content: { en: { title: "Quiet", slices: [] } },
    })
    await owner.mutation(
      api.cms.publication.publishLocale,
      firstPublish(pageId)
    )
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await drain(t)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await allIntents(t)).toEqual([
      expect.objectContaining({
        status: "complete",
        lastErrorCode: "REVALIDATION_UNCONFIGURED",
      }),
    ])
  })

  test("publication transactions schedule no webhook, notification, or fetch", () => {
    expect(publicationSource).not.toContain("emitWebhookEvent")
    expect(publicationSource).not.toContain("internal.webhooks")
    expect(publicationSource).not.toContain("emailNode")
    expect(publicationSource).not.toContain("fetch(")
    expect(publicationSource).not.toContain("deleteStagingByPageId")
    // M05 C5a appends sitemap maintenance; the listing backfill finalizer
    // also purges caches. Publication transactions above keep exactly one.
    const sitemapStart = publicationSource.indexOf(
      "// ─── Sitemap partitions (M05 C5a)"
    )
    expect(sitemapStart).toBeGreaterThan(0)
    const publication = publicationSource.slice(0, sitemapStart)
    const sitemap = publicationSource.slice(sitemapStart)
    const schedulerCalls = publication.match(/scheduler\.run(?:After|At)\(/g)
    expect(schedulerCalls).toHaveLength(1)
    const sitemapTargets = [
      ...sitemap.matchAll(
        /scheduler\.run(?:After|At)\(\s*0,\s*(internal\.[\w.]+)/g
      ),
    ].map((match) => match[1])
    expect(new Set(sitemapTargets)).toEqual(
      new Set([
        "internal.cms.publication.stepSitemapManifestBuild",
        "internal.cms.publication.sweepSitemapManifests",
        "internal.cms.revalidate.revalidateSettings",
      ])
    )
    expect(sitemap.match(/scheduler\.run(?:After|At)\(/g)).toHaveLength(
      sitemapTargets.length
    )
    const cleanup = publication.slice(
      publication.indexOf("export const cleanupMigratedLegacyStaging")
    )
    expect(cleanup).toMatch(/scheduler\.runAfter\(/)
  })
})

