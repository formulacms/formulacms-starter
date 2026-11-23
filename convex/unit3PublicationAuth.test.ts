/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { FunctionArgs } from "convex/server"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { env } from "./_generated/server"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "unit3-publication-owner",
  tokenIdentifier: "unit3-publication-owner",
}
const UNRELATED = {
  subject: "unit3-publication-unrelated",
  tokenIdentifier: "unit3-publication-unrelated",
}
type App = ReturnType<typeof convexTest>
type Fixture = {
  t: App
  owner: ReturnType<App["withIdentity"]>
  pageId: Id<"pages">
}
const apps: App[] = []
const scheduledExpectations = new Map<App, { jobs: number; intents: number }>()
const unexpectedFetch = vi.fn(() => {
  throw new Error("Unexpected network fetch in publication source proof")
})

function draftContent(title: string) {
  return {
    pageType: "landing-page" as const,
    localized: { title },
    blocks: [],
  }
}

async function makeFixture(): Promise<Fixture> {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  apps.push(t)
  scheduledExpectations.set(t, { jobs: 0, intents: 0 })
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homePageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", blocks: [] } },
  })
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "Unit3 source proof",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en"],
      homePageId,
      updatedAt: Date.now(),
    })
  )
  const pageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "unit3-proof",
    title: "Initial draft",
    content: { en: { title: "Initial draft", blocks: [] } },
  })
  return { t, owner, pageId }
}

async function draftArguments(f: Fixture, title: string) {
  const editor = await f.owner.query(api.cms.pages.getForEdit, { id: f.pageId })
  if (!editor) throw new Error("Valid editor fixture required")
  const state = editor.publication
  const locale = state?.locales.find((row) => row.locale === "en")
  if (!state || !locale) throw new Error("Valid snapshot clocks required")
  const args: FunctionArgs<typeof api.cms.publication.saveEditorDraft> = {
    pageId: f.pageId,
    expectedLifecycleGeneration: state.lifecycleGeneration,
    localized: {
      locale: "en",
      slug: "unit3-proof",
      expectedGeneration: locale.draftGeneration,
      draft: draftContent(title),
    },
  }
  return args
}

async function saveDraft(f: Fixture, title: string) {
  return f.owner.mutation(
    api.cms.publication.saveEditorDraft,
    await draftArguments(f, title)
  )
}

async function publishArguments(f: Fixture) {
  const editor = await f.owner.query(api.cms.pages.getForEdit, { id: f.pageId })
  const state = editor?.publication
  const locale = state?.locales.find((row) => row.locale === "en")
  if (!state || !locale) throw new Error("Valid publication clocks required")
  const args: FunctionArgs<typeof api.cms.publication.publishLocale> = {
    pageId: f.pageId,
    locale: "en",
    expectedDraftGeneration: locale.draftGeneration,
    expectedSharedDraftGeneration: state.sharedDraftGeneration,
    expectedPublicGeneration: locale.publicGeneration,
    expectedLifecycleGeneration: state.lifecycleGeneration,
    expectedReleaseGeneration: locale.releaseGeneration,
  }
  return args
}

async function publish(f: Fixture) {
  await f.owner.mutation(
    api.cms.publication.publishLocale,
    await publishArguments(f)
  )
  // The publish inserts one intent and schedules one immediate drain, which
  // (with no revalidation target configured) records one attempt.
  scheduledExpectations.get(f.t)!.intents += 1
  scheduledExpectations.get(f.t)!.jobs += 1
}

function publicPage(f: Fixture) {
  return f.t.query(api.cms.pages.getPublicPageById, {
    languageVersion: 0,
    id: f.pageId,
    locale: "en",
  })
}

const stateTables = [
  "cmsOwner", "siteSettings", "pagePublicationCutover", "pilotEnvelope",
  "siteLanguageAuthority", "siteLanguageFreshness", "pages", "pageStaging",
  "pageEditorLocks", "pageRevisions", "pageSearch", "documentReferences",
  "mediaReferences", "pagePublicationPageStates", "pageSharedDrafts",
  "pageLocaleDrafts", "pageLocalePublicationStates", "pageLocalePublicationCandidates",
  "pageLocalePublicationReleases", "pagePublishedSnapshots", "pageHistoricalLocaleRoutes",
  "pagePublicationDocumentReferences", "pagePublicationMediaReferences",
  "pagePublicationBlockReferences", "pagePublicationRevalidationIntents",
  "revalidationAttempts",
] as const

async function selectedState(t: App) {
  return t.run(async (ctx) => {
    const entries = await Promise.all(stateTables.map(async (table) => {
      const rows = await ctx.db.query(table).take(20)
      expect(rows.length, `${table} fixture exceeded bounded snapshot`).toBeLessThan(20)
      return [table, rows] as const
    }))
    const jobs = await ctx.db.system.query("_scheduled_functions").take(20)
    expect(jobs.length).toBeLessThan(20)
    return { tables: Object.fromEntries(entries), jobs }
  })
}

async function settleScheduledWork(t: App) {
  // Supported convex-test teardown advances scheduler timers and waits for
  // actual actions. Failure is retained in the job row, so check that too.
  await t.finishAllScheduledFunctions(vi.runAllTimers, 10)
  const { jobs, attempts, intents } = await t.run(async (ctx) => ({
    jobs: await ctx.db.system.query("_scheduled_functions").take(20),
    attempts: await ctx.db.query("revalidationAttempts").take(20),
    intents: await ctx.db.query("pagePublicationRevalidationIntents").take(20),
  }))
  const expected = scheduledExpectations.get(t)!
  expect(jobs).toHaveLength(expected.jobs)
  expect(attempts).toHaveLength(expected.jobs)
  expect(intents).toHaveLength(expected.intents)
  for (const job of jobs) expect(job.state.kind).toBe("success")
  for (const attempt of attempts) expect(attempt.status).toBe("unconfigured")
  for (const intent of intents) {
    expect(intent.status).toBe("complete")
    expect(intent.lastErrorCode).toBe("REVALIDATION_UNCONFIGURED")
  }
}

describe("Unit3 selected publication and write authorization", () => {
  beforeEach(() => {
    // The runner must establish these values before importing any application
    // module. Never inherit an ambient revalidation secret or target origin.
    expect(env.REVALIDATE_SECRET).toBe("")
    expect(env.SITE_URL).toBe("")
    apps.length = 0
    scheduledExpectations.clear()
    unexpectedFetch.mockClear()
    vi.stubGlobal("fetch", unexpectedFetch)
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    vi.setSystemTime(1_800_000_000_000)
  })

  afterEach(async () => {
    try {
      for (const t of apps) await settleScheduledWork(t)
      expect(vi.getTimerCount()).toBe(0)
      expect(unexpectedFetch).not.toHaveBeenCalled()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
      vi.unstubAllGlobals()
      apps.length = 0
      scheduledExpectations.clear()
    }
  })

  test(`owner create, editor save, publish and anonymous readback`, async () => {
    const f = await makeFixture()
    const publicPath = "/unit3-proof"
    await expect(publicPage(f)).resolves.toBeNull()
    await saveDraft(f, "Published title")
    await expect(publicPage(f)).resolves.toBeNull()
    await publish(f)
    const selected = await publicPage(f)
    expect(selected).toMatchObject({
      _id: f.pageId,
      content: { en: { title: "Published title" } },
    })
    await expect(f.t.query(api.cms.pages.resolveLocalizedPathQuery, {
      languageVersion: 0,
      path: publicPath,
      locale: "en",
    })).resolves.toBe(f.pageId)

    await saveDraft(f, "Unpublished later edit")
    expect(await publicPage(f)).toEqual(selected)
    await publish(f)
    await expect(publicPage(f)).resolves.toMatchObject({
      content: { en: { title: "Unpublished later edit" } },
    })
  })

  for (const caller of ["anonymous", "unrelated"] as const) {
    test(`${caller} create, draft-save and publish deny without state change`, async () => {
      const f = await makeFixture()
      await saveDraft(f, "Published title")
      await publish(f)
      await settleScheduledWork(f.t)
      await saveDraft(f, "Valid pending draft")
      const draft = await draftArguments(f, "Denied edit")
      const publication = await publishArguments(f)
      const actor = caller === "anonymous" ? f.t : f.t.withIdentity(UNRELATED)
      const code = caller === "anonymous" ? "UNAUTHENTICATED" : "CMS_OWNER_REQUIRED"
      const before = await selectedState(f.t)
      const beforePublic = await publicPage(f)
      expect(beforePublic).toMatchObject({ content: { en: { title: "Published title" } } })

      await expect(actor.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        slug: "valid-denied-create",
        title: "Denied creation",
        content: { en: { title: "Denied creation", blocks: [] } },
      })).rejects.toMatchObject({ data: code })
      expect(await selectedState(f.t)).toEqual(before)
      expect(await publicPage(f)).toEqual(beforePublic)

      await expect(
        actor.mutation(api.cms.publication.saveEditorDraft, draft)
      ).rejects.toMatchObject({ data: code })
      expect(await selectedState(f.t)).toEqual(before)
      expect(await publicPage(f)).toEqual(beforePublic)

      await expect(
        actor.mutation(api.cms.publication.publishLocale, publication)
      ).rejects.toMatchObject({ data: code })
      expect(await selectedState(f.t)).toEqual(before)
      expect(await publicPage(f)).toEqual(beforePublic)
    })
  }
})
