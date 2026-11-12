/// <reference types="vite/client" />

import type { FunctionReference } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import type { MutationCtx } from "./_generated/server"
import { convexTest } from "../convexTestWithExplicitAdmin"
import schema from "./schema"
import type { PublicationPolicyParticipant } from "./lib/publishing/publicationPolicy"
import type { PublicationContributionEvent } from "./lib/publishing/publicationContributions"

type PolicyRun = PublicationPolicyParticipant["run"]
type ContributionRun = (
  ctx: MutationCtx,
  event: PublicationContributionEvent
) => Promise<void>

// Only the optional slot functions are injected. Every assertion below drives
// the registered cms.publication, cms.pages, and cms.modules entry points.
const injected = vi.hoisted(() => ({
  policy: null as PolicyRun | null,
  history: null as ContributionRun | null,
  index: null as ContributionRun | null,
}))

vi.mock("./lib/publishing/publicationPolicy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./lib/publishing/publicationPolicy")>()
  return {
    ...actual,
    INSTALLED_PUBLICATION_POLICY: {
      get "publication.policy"() {
        return injected.policy
          ? {
              moduleId: "team",
              contribution: "publication.policy",
              run: injected.policy,
            }
          : null
      },
    },
  }
})

vi.mock("./lib/publishing/publicationContributions", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./lib/publishing/publicationContributions")
    >()
  return {
    ...actual,
    INSTALLED_PUBLICATION_CONTRIBUTIONS: {
      get "publication.history"() {
        return injected.history
          ? {
              moduleId: "history",
              contribution: "publication.history",
              run: injected.history,
            }
          : null
      },
      get "publication.index"() {
        return injected.index
          ? {
              moduleId: "search",
              contribution: "publication.index",
              run: injected.index,
            }
          : null
      },
    },
  }
})

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "f08-boundary-owner",
  tokenIdentifier: "https://convex.test|f08-boundary-owner",
}

// Generated declarations intentionally remain untouched in this source-only
// checkout. Exercise the registered runtime paths through a narrow proxy.
const moduleApi = api as unknown as {
  cms: {
    modules: {
      preview: FunctionReference<"query">
      commit: FunctionReference<"mutation">
    }
  }
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

async function activeFixture() {
  const t = app()
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homePageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", slices: [] } },
  })
  const pageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "boundary-page",
    title: "Boundary page",
    content: { en: { title: "Boundary snapshot", slices: [] } },
  })
  await t.run((ctx) =>
    ctx.db.insert("siteSettings", {
      siteName: "Boundary test",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en"],
      homePageId,
      updatedAt: Date.now(),
    })
  )
  return { t, owner, pageId }
}

function publish(owner: Owner, pageId: Id<"pages">) {
  return owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale: "en",
    expectedDraftGeneration: 1,
    expectedSharedDraftGeneration: 1,
    expectedPublicGeneration: 0,
    expectedLifecycleGeneration: 1,
    expectedReleaseGeneration: 0,
  })
}

const OWNED_TABLES = [
  "pages",
  "siteSettings",
  "cmsModuleState",
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
  "pageRevisions",
  "pageSearch",
] as const

function dumpOwnedState(t: TestApp) {
  return t.run(async (ctx) => {
    const dump: Record<string, unknown[]> = {}
    for (const table of OWNED_TABLES) {
      dump[table] = await ctx.db.query(table).collect()
    }
    return dump
  })
}

beforeEach(() => {
  injected.policy = null
  injected.history = null
  injected.index = null
})

describe("F08 real module boundaries", () => {
  test("registered module configuration, publication, and public readers meet at runtime", async () => {
    const { t, owner, pageId } = await activeFixture()
    const changes = [{ moduleId: "redirects", enabled: true }]
    const preview = await owner.query(moduleApi.cms.modules.preview, {
      changes,
    })
    expect(preview).toMatchObject({
      configurationVersion: 0,
      changes: [{ moduleId: "redirects", fromEnabled: false, toEnabled: true }],
      blockers: [],
    })
    await expect(
      owner.mutation(moduleApi.cms.modules.commit, {
        expectedConfigurationVersion: preview.configurationVersion,
        changes,
      })
    ).resolves.toMatchObject({ committed: true, configurationVersion: 1 })

    const published = await publish(owner, pageId)
    await t.run((ctx) =>
      ctx.db.patch(pageId, {
        slug: "mutable-legacy-slug",
        content: {
          en: { title: "MUTABLE LEGACY PAGE", slices: [] },
        },
      } as never)
    )

    expect(
      await t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale: "en",
      })
    ).toMatchObject({
      _id: pageId,
      pageType: "landing-page",
      content: { en: { title: "Boundary snapshot" } },
    })
    expect(
      await t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/boundary-page",
        locale: "en",
      })
    ).toBe(pageId)
    expect(
      await t.query(api.cms.pages.getLocalizedPathsByIds, {
        languageVersion: 0,
        ids: [pageId],
        locale: "en",
      })
    ).toEqual({ [pageId]: "/boundary-page" })
    expect(
      await t.query(api.cms.pages.getPublicRelationCardsByIds, {
        languageVersion: 0,
        ids: [pageId],
        locale: "en",
      })
    ).toEqual({
      [pageId]: {
        pageId,
        pageType: "landing-page",
        title: "Boundary snapshot",
        href: "/boundary-page",
      },
    })
    expect(
      await t.query(api.cms.pages.getLocalizedBreadcrumb, {
        languageVersion: 0,
        pageId,
        locale: "en",
      })
    ).toEqual([{ name: "Boundary snapshot", url: "/boundary-page" }])
    expect(
      await t.query(api.cms.pages.getPublicLocaleAlternates, {
        languageVersion: 0,
        pageId,
      })
    ).toEqual([{ locale: "en", url: "/boundary-page", indexable: true }])
    expect(
      await t.query(api.cms.pages.getAllLocalizedPageUrls, {
        languageVersion: 0,
      })
    ).toContainEqual({
      pageId,
      locale: "en",
      url: "/boundary-page",
    })
    expect(
      await t.query(api.cms.pages.getSitemapChild, {
        languageVersion: 0,
        manifestVersion: 0,
        locale: "en",
        ordinal: 0,
      })
    ).toMatchObject({
      status: "ok",
      entries: expect.arrayContaining([
        expect.objectContaining({ url: "/boundary-page" }),
      ]),
    })
    expect(
      await t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        languageVersion: 0,
        locale: "en",
        path: "/boundary-page",
      })
    ).toEqual({
      authority: "snapshot_active",
      disposition: "current",
      pageId,
      locale: "en",
      snapshotId: published.snapshotId,
      publicGeneration: 1,
    })
    expect(
      await t.query(api.cms.pages.listRecentPublicRelationCards, {
        languageVersion: 0,
        pageType: "landing-page",
        limit: 3,
        locale: "en",
      })
    ).toEqual([{ pageId, pageType: "landing-page", title: "Boundary snapshot", href: "/boundary-page" }])
    expect(
      await t.query(api.cms.pages.getPublicByline, {
        languageVersion: 0,
        authorPageId: pageId,
        locale: "en",
      })
    ).toBeNull()

    await expect(
      owner.mutation(moduleApi.cms.modules.commit, {
        expectedConfigurationVersion: 1,
        changes: [{ moduleId: "redirects", enabled: false }],
      })
    ).resolves.toMatchObject({ committed: true, configurationVersion: 2 })
    expect(
      await t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/boundary-page",
        locale: "en",
      })
    ).toBe(pageId)
  })

  test.each([
    {
      slot: "policy",
      install() {
        injected.policy = async () => {
          throw new Error("POLICY_SLOT_FAILED")
        }
      },
      error: "POLICY_SLOT_FAILED",
    },
    {
      slot: "history",
      install() {
        injected.history = async (ctx, event) => {
          await ctx.db.insert("pageRevisions", {
            pageId: event.pageId,
            revisionNumber: 1,
            createdAt: Date.now(),
            reason: "publish",
            status: "published",
            slug: "boundary-page",
            pageType: "landing-page",
            metadata: { title: "Boundary", locales: ["en"], summary: [] },
          })
          throw new Error("HISTORY_SLOT_FAILED")
        }
      },
      error: "HISTORY_SLOT_FAILED",
    },
    {
      slot: "index",
      install() {
        injected.index = async (ctx, event) => {
          await ctx.db.insert("pageSearch", {
            pageId: event.pageId,
            locale: "en",
            status: "published",
            title: "Boundary",
            slug: "boundary-page",
            text: "Boundary",
            updatedAt: Date.now(),
          })
          throw new Error("INDEX_SLOT_FAILED")
        }
      },
      error: "INDEX_SLOT_FAILED",
    },
  ])(
    "a $slot failure rolls back the real publish command",
    async ({ install, error }) => {
      const { t, owner, pageId } = await activeFixture()
      const before = await dumpOwnedState(t)
      install()
      await expect(publish(owner, pageId)).rejects.toThrow(error)
      expect(await dumpOwnedState(t)).toEqual(before)
    }
  )
})
