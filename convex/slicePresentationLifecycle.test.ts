/// <reference types="vite/client" />

import { sliceProfile } from "@/test-utils/slice-profile"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import { api } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import schema from "./schema"
import { readSlicePresentationCatalog } from "./lib/slices/presentations"

// Owned source inputs can change between requests. Keep the real catalog,
// authorization, mutation, schema and revision calculation in this test.
const source = vi.hoisted(() => ({
  centeredState: "active" as "active" | "archived" | "unavailable",
  defaultState: "active" as "active" | "archived" | "unavailable",
  centeredInstalled: true,
  incompatible: false,
  missingRenderer: "" as string,
}))
vi.mock("./lib/slices/heroPresentationDefinitions", async (original) => {
  const actual =
    await original<typeof import("./lib/slices/heroPresentationDefinitions")>()
  return {
    ...actual,
    get HERO_PRESENTATION_DEFINITIONS() {
      return actual.HERO_PRESENTATION_DEFINITIONS.map((entry) =>
        entry.id === "centered"
          ? {
              ...entry,
              state: source.centeredState,
              installed: source.centeredInstalled,
              contractSha256: source.incompatible
                ? "sha256:incompatible-owned-test-contract"
                : entry.contractSha256,
            }
          : { ...entry, state: source.defaultState }
      )
    },
  }
})
vi.mock("./lib/slices/presentationRendererInventory", async (original) => {
  const actual =
    await original<
      typeof import("./lib/slices/presentationRendererInventory")
    >()
  return {
    ...actual,
    hasOwnedSlicePresentationRenderer(type: string, id: string) {
      return (
        !(type === "hero-with-image" && id === source.missingRenderer) &&
        actual.hasOwnedSlicePresentationRenderer(type, id)
      )
    },
  }
})

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "presentation-lifecycle-owner",
  tokenIdentifier: "https://convex.test|presentation-lifecycle-owner",
}
const STRANGER = {
  subject: "presentation-lifecycle-stranger",
  tokenIdentifier: "https://convex.test|presentation-lifecycle-stranger",
}
const TARGET = { type: "hero-with-image", presentationId: "centered" }
type T = ReturnType<typeof convexTest>
type Actor = ReturnType<T["withIdentity"]>

beforeEach(() => {
  source.centeredState = "active"
  source.defaultState = "active"
  source.centeredInstalled = true
  source.incompatible = false
  source.missingRenderer = ""
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"))
})
afterEach(() => vi.useRealTimers())

async function fixture(setup = true) {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  await seedCommunityOwner(t, OWNER)
  const owner = t.withIdentity(OWNER)
  if (setup) {
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Presentation lifecycle",
      timezone: "UTC",
      defaultLocale: "en",
    })
  }
  return { t, owner }
}

async function settings(t: T) {
  return t.run((ctx) => ctx.db.query("siteSettings").unique())
}

// Bounded complete snapshots of ordinary test fixtures, following the existing
// multilingual census seam. This proves all application-table no-write controls,
// including Pages, locale drafts, snapshots, freshness and module ownership.
async function database(t: T) {
  return t.run(async (ctx) => {
    const result: Record<string, unknown> = {}
    for (const table of Object.keys(schema.tables).sort()) {
      const rows = await ctx.db
        .query(table as keyof typeof schema.tables)
        .take(100)
      expect(rows.length).toBeLessThan(100)
      result[table] = rows
    }
    return result
  })
}

async function setArchived(owner: Actor, archived: boolean, revision?: string) {
  const catalog = revision
    ? { revision }
    : await owner.query(api.cms.slices.getPresentationCatalog, {})
  return owner.mutation(api.cms.slices.setPresentationArchived, {
    ...TARGET,
    archived,
    expectedCatalogRevision: catalog.revision,
  })
}

async function refusesWithoutWrites(t: T, operation: () => Promise<unknown>) {
  const before = await database(t)
  await expect(operation()).rejects.toThrow()
  expect(await database(t)).toEqual(before)
}

function unrelatedSettings(row: Doc<"siteSettings">) {
  const { archivedSlicePresentationsV1, updatedAt, ...unrelated } = row
  void archivedSlicePresentationsV1
  void updatedAt
  return unrelated
}

describe("owner presentation lifecycle", () => {
  test("absent membership preserves the owned source catalog exactly", async () => {
    const { t, owner } = await fixture()
    expect((await settings(t))?.archivedSlicePresentationsV1).toBeUndefined()
    expect(
      await owner.query(api.cms.slices.getPresentationCatalog, {})
    ).toEqual(await readSlicePresentationCatalog())
  })

  test("archive and restore change only membership and settings timestamp", sliceProfile(["hero-with-image"]), async () => {
    const { t, owner } = await fixture()
    const initial = await owner.query(api.cms.slices.getPresentationCatalog, {})
    const row = (await settings(t))!
    const publicationTokens = await t.run(async (ctx) => {
      const pageId = row.homePageId!
      const locale = "en"
      const state = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", locale)
        )
        .unique()
      const shared = (await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique())!
      const page = (await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique())!
      return {
        pageId,
        locale,
        expectedDraftGeneration: state?.draftGeneration ?? 0,
        expectedSharedDraftGeneration: shared.generation,
        expectedLifecycleGeneration: page.lifecycleGeneration,
        expectedPublicGeneration: state?.publicGeneration ?? 0,
        expectedReleaseGeneration: state?.releaseGeneration ?? 0,
      }
    })
    await owner.mutation(api.cms.publication.publishLocale, publicationTokens)
    await t.run((ctx) =>
      ctx.db.patch(row._id, {
        siteDescription: "Preserved metadata",
        brandVoice: "Preserved voice",
        archivedSliceTypes: ["unrelated-retired-type"],
        archivedContentTypes: ["unrelated-retired-content-type"],
      })
    )
    const beforeSettings = (await settings(t))!
    const { siteSettings: ignoredSettings, ...beforeOtherTables } =
      await database(t)
    void ignoredSettings
    // Publish the real bootstrapped Home Page so preservation includes populated
    // publication stores, not merely empty-table equality.
    expect(beforeOtherTables.pages).toHaveLength(1)
    expect(beforeOtherTables.pageSharedDrafts).toHaveLength(1)
    expect(beforeOtherTables.pagePublishedSnapshots).toHaveLength(1)
    expect(beforeOtherTables.pageLocaleDrafts).toEqual([])

    vi.setSystemTime(new Date("2026-10-26T12:01:00Z"))
    const archived = await setArchived(owner, true, initial.revision)
    expect(archived).toEqual(
      await owner.query(api.cms.slices.getPresentationCatalog, {})
    )
    expect(archived.revision).not.toBe(initial.revision)
    expect(archived.entries.find((entry) => entry.id === "centered")).toEqual({
      ...initial.entries.find((entry) => entry.id === "centered"),
      state: "archived",
    })
    const archivedSettings = (await settings(t))!
    expect(archivedSettings.archivedSlicePresentationsV1).toEqual([TARGET])
    expect(archivedSettings.updatedAt).toBeGreaterThan(beforeSettings.updatedAt)
    expect(unrelatedSettings(archivedSettings)).toEqual(
      unrelatedSettings(beforeSettings)
    )
    const { siteSettings: ignoredArchivedSettings, ...afterArchiveTables } =
      await database(t)
    void ignoredArchivedSettings
    expect(afterArchiveTables).toEqual(beforeOtherTables)

    vi.setSystemTime(new Date("2026-10-26T12:02:00Z"))
    const restored = await setArchived(owner, false, archived.revision)
    expect(restored).toEqual(initial)
    const restoredSettings = (await settings(t))!
    expect(restoredSettings.archivedSlicePresentationsV1).toEqual([])
    expect(unrelatedSettings(restoredSettings)).toEqual(
      unrelatedSettings(beforeSettings)
    )
    const { siteSettings: ignoredRestoredSettings, ...afterRestoreTables } =
      await database(t)
    void ignoredRestoredSettings
    expect(afterRestoreTables).toEqual(beforeOtherTables)
  })

  test.each([false, true])(
    "current archived=%s no-op writes nothing; stale no-op refuses", sliceProfile(["hero-with-image"]),
    async (archived) => {
      const { t, owner } = await fixture()
      if (archived) await setArchived(owner, true)
      const catalog = await owner.query(
        api.cms.slices.getPresentationCatalog,
        {}
      )
      const before = await database(t)
      vi.setSystemTime(new Date("2026-10-26T12:03:00Z"))
      expect(await setArchived(owner, archived, catalog.revision)).toEqual(
        catalog
      )
      expect(await database(t)).toEqual(before)
      await refusesWithoutWrites(t, () =>
        setArchived(owner, archived, "sha256:stale-lifecycle-revision")
      )
    }
  )

  test.each(["unauthenticated", "non-owner", "legacy-admin"])(
    "%s cannot read or mutate the catalog and leaves all state unchanged", sliceProfile([]),
    async (actorKind) => {
      const { t } = await fixture()
      if (actorKind === "legacy-admin") {
        await t.run((ctx) =>
          ctx.db.insert("roles", {
            authId: STRANGER.subject,
            role: "admin",
            assignedAt: 1,
          })
        )
      }
      const actor =
        actorKind === "unauthenticated" ? t : t.withIdentity(STRANGER)
      await refusesWithoutWrites(t, () =>
        actor.query(api.cms.slices.getPresentationCatalog, {})
      )
      await refusesWithoutWrites(t, () =>
        actor.mutation(api.cms.slices.setPresentationArchived, {
          ...TARGET,
          archived: true,
          expectedCatalogRevision: "sha256:untrusted",
        })
      )
    }
  )

  test("a legacy admin without any owner binding cannot bootstrap authority", sliceProfile([]), async () => {
    const t = convexTest({ schema, modules, publicationAuthority: "missing" })
    await t.run((ctx) =>
      ctx.db.insert("roles", {
        authId: STRANGER.subject,
        role: "admin",
        assignedAt: 1,
      })
    )
    await refusesWithoutWrites(t, () =>
      t
        .withIdentity(STRANGER)
        .mutation(api.cms.slices.setPresentationArchived, {
          ...TARGET,
          archived: true,
          expectedCatalogRevision: "sha256:untrusted",
        })
    )
  })

  test.each(["missing", "incomplete", "duplicate"])(
    "%s setup refuses without provisioning or repairing settings", sliceProfile([]),
    async (kind) => {
      const { t, owner } = await fixture(kind === "duplicate")
      await t.run(async (ctx) => {
        if (kind === "incomplete") {
          await ctx.db.insert("siteSettings", {
            siteName: "Incomplete",
            siteUrl: "",
            defaultLocale: "en",
            enabledLocales: ["en"],
            updatedAt: 1,
          })
        } else if (kind === "duplicate") {
          const row = (await ctx.db.query("siteSettings").unique())!
          const { _id, _creationTime, ...fields } = row
          void _id
          void _creationTime
          await ctx.db.insert("siteSettings", fields)
        }
      })
      const sourceCatalog = await readSlicePresentationCatalog()
      await refusesWithoutWrites(t, () =>
        setArchived(owner, true, sourceCatalog.revision)
      )
    }
  )

  test.each([true, false])(
    "Default archived=%s always refuses", sliceProfile([]),
    async (archived) => {
      const { t, owner } = await fixture()
      const catalog = await owner.query(
        api.cms.slices.getPresentationCatalog,
        {}
      )
      await refusesWithoutWrites(t, () =>
        owner.mutation(api.cms.slices.setPresentationArchived, {
          type: TARGET.type,
          presentationId: "default",
          archived,
          expectedCatalogRevision: catalog.revision,
        })
      )
    }
  )

  test.each([
    { type: TARGET.type, presentationId: "missing-choice" },
    { type: "missing-type", presentationId: "centered" },
  ])("unknown target $type/$presentationId refuses", sliceProfile([]), async (target) => {
    const { t, owner } = await fixture()
    const catalog = await owner.query(api.cms.slices.getPresentationCatalog, {})
    await refusesWithoutWrites(t, () =>
      owner.mutation(api.cms.slices.setPresentationArchived, {
        ...target,
        archived: true,
        expectedCatalogRevision: catalog.revision,
      })
    )
  })

  test.each(["unknown", "duplicate"])(
    "%s stored membership refuses mutation without normalization writes", sliceProfile([]),
    async (kind) => {
      const { t, owner } = await fixture()
      const row = (await settings(t))!
      await t.run((ctx) =>
        ctx.db.patch(row._id, {
          archivedSlicePresentationsV1:
            kind === "unknown"
              ? [{ type: TARGET.type, presentationId: "removed-choice" }]
              : [TARGET, TARGET],
        })
      )
      const catalog = await owner.query(
        api.cms.slices.getPresentationCatalog,
        {}
      )
      await refusesWithoutWrites(t, () =>
        setArchived(owner, false, catalog.revision)
      )
    }
  )

  test("effective reads filter unknown membership and retain source flags", sliceProfile([]), async () => {
    const { t, owner } = await fixture()
    const row = (await settings(t))!
    await t.run((ctx) =>
      ctx.db.patch(row._id, {
        archivedSlicePresentationsV1: [
          TARGET,
          { type: TARGET.type, presentationId: "removed-choice" },
          { type: "removed-type", presentationId: "centered" },
        ],
      })
    )
    source.centeredState = "unavailable"
    source.centeredInstalled = false
    const before = await database(t)
    const catalog = await owner.query(api.cms.slices.getPresentationCatalog, {})
    expect(catalog).toEqual(await readSlicePresentationCatalog())
    expect(
      catalog.entries.find((entry) => entry.id === "centered")
    ).toMatchObject({
      state: "unavailable",
      installed: false,
    })
    expect(await database(t)).toEqual(before)
  })

  test.each([
    "source-archived",
    "source-unavailable",
    "not-installed",
    "incompatible",
    "target-renderer-missing",
    "default-renderer-missing",
    "default-unavailable",
  ])("%s cannot be archived or restored", sliceProfile([]), async (kind) => {
    const { t, owner } = await fixture()
    const row = (await settings(t))!
    if (kind === "source-archived") source.centeredState = "archived"
    if (kind === "source-unavailable") source.centeredState = "unavailable"
    if (kind === "not-installed") source.centeredInstalled = false
    if (kind === "incompatible") source.incompatible = true
    if (kind === "target-renderer-missing") source.missingRenderer = "centered"
    if (kind === "default-renderer-missing") source.missingRenderer = "default"
    if (kind === "default-unavailable") source.defaultState = "unavailable"
    const catalog = await owner.query(api.cms.slices.getPresentationCatalog, {})
    await refusesWithoutWrites(t, () =>
      setArchived(owner, true, catalog.revision)
    )

    // Restoring a saved membership cannot override source availability.
    await t.run((ctx) =>
      ctx.db.patch(row._id, { archivedSlicePresentationsV1: [TARGET] })
    )
    const current = await owner.query(api.cms.slices.getPresentationCatalog, {})
    await refusesWithoutWrites(t, () =>
      setArchived(owner, false, current.revision)
    )
  })
})
