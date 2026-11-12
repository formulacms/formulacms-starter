/// <reference types="vite/client" />

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { DEFAULT_MENU_SLUGS, walkCanonicalMenuTargets, type NavItem } from "./lib/menu"
import { refreshMenuReferences } from "./lib/menu/references"
import schema from "./schema"
import { seedCommunityOwner } from "../convexTestWithExplicitAdmin"

const modules = import.meta.glob("./**/*.ts")
/** The one durable Community owner; both identity fields are explicit. */
const OWNER = {
  subject: "menu-reference-owner",
  tokenIdentifier: "https://convex.test|menu-reference-owner",
  email: "owner@example.test",
}

const pageId = (value: string) => value as Id<"pages">

function canonicalNavItem(id: string, targetId?: Id<"pages">): NavItem {
  return {
    id,
    label: { en: id },
    ...(targetId
      ? { target: { type: "internal" as const, pageId: targetId } }
      : {}),
  }
}

describe("Plan 035 C3 canonical target references", () => {
  test("walks panel and footer targets with stable canonical paths", () => {
    const nav: NavItem[] = [
      {
        id: "root/menu",
        label: { en: "Root" },
        target: { type: "internal", pageId: pageId("root") },
        panel: {
          columns: 2,
          blocks: [
            {
              id: "links",
              kind: "linkGroup",
              links: [
                {
                  id: "child%link",
                  label: { en: "Child" },
                  target: { type: "internal", pageId: pageId("child") },
                },
              ],
            },
          ],
          footer: {
            blocks: [
              {
                id: "feature",
                kind: "featured",
                image: { url: "https://example.com/a.jpg", alt: { en: "" } },
                heading: { en: "Feature" },
                target: { type: "internal", pageId: pageId("feature") },
              },
            ],
          },
        },
      },
    ]

    expect(walkCanonicalMenuTargets(nav)).toEqual([
      { targetId: pageId("root"), path: "nav/id:root%2Fmenu/target" },
      {
        targetId: pageId("child"),
        path: "nav/id:root%2Fmenu/panel/blocks/id:links/links/id:child%25link/target",
      },
      {
        targetId: pageId("feature"),
        path: "nav/id:root%2Fmenu/panel/footer/blocks/id:feature/target",
      },
    ])
  })

  test("refreshes materialized references from the canonical row", async () => {
    const t = convexTest(schema, modules)
    const rows = await t.run(async (ctx) => {
      const targetId = await ctx.db.insert("pages", {
        slug: "target",
        pageType: "page",
        status: "draft",
        content: {},
        createdAt: 1,
        updatedAt: 1,
      })
      const menuId = await ctx.db.insert("menus", {
        slug: "primary",
        nav: [
          {
            id: "target",
            label: { en: "Target" },
            target: { type: "internal", pageId: targetId },
          },
        ],
        updatedAt: 1,
      })
      const menu = await ctx.db.get(menuId)
      if (!menu) throw new Error("Missing menu")
      await refreshMenuReferences(ctx, menu)
      return await ctx.db
        .query("menuReferences")
        .withIndex("by_menu", (q) => q.eq("menuId", menuId))
        .collect()
    })

    expect(rows).toMatchObject([
      { targetId: expect.any(String), path: "nav/id:target/target" },
    ])
  })
})

describe("refreshMenuReferences", () => {
  test("inserts a reference without requiring the target page to exist", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const targetId = await ctx.db.insert("pages", {
        slug: "missing-page",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "missing-page" },
        createdAt: 1,
        updatedAt: 1,
      })
      await ctx.db.delete(targetId)
      const menuId = await ctx.db.insert("menus", {
        slug: "primary",
        nav: [canonicalNavItem("dead-link", targetId)],
        updatedAt: 1,
      })

      const menu = await ctx.db.get(menuId)
      await refreshMenuReferences(ctx, menu!)

      const rows = await ctx.db.query("menuReferences").take(10)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        menuId,
        targetId,
        path: "nav/id:dead-link/target",
      })
      expect(rows[0]!.updatedAt).toEqual(expect.any(Number))
    })
  })

  test("deletes stale rows when targets or paths are removed", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const targetA = await ctx.db.insert("pages", {
        slug: "target-a",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "target-a" },
        createdAt: 1,
        updatedAt: 1,
      })
      const targetB = await ctx.db.insert("pages", {
        slug: "target-b",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "target-b" },
        createdAt: 1,
        updatedAt: 1,
      })
      const initialNav = [
        canonicalNavItem("kept-path", targetA),
        canonicalNavItem("removed", targetB),
      ]
      const menuId = await ctx.db.insert("menus", {
        slug: "primary",
        nav: initialNav,
        updatedAt: 1,
      })
      const initialMenu = await ctx.db.get(menuId)
      await refreshMenuReferences(ctx, initialMenu!)

      const changedNav = [canonicalNavItem("kept-path", targetB)]
      await ctx.db.patch(menuId, { nav: changedNav })
      const changedMenu = await ctx.db.get(menuId)
      await refreshMenuReferences(ctx, changedMenu!)

      const rows = await ctx.db
        .query("menuReferences")
        .withIndex("by_menu", (q) => q.eq("menuId", menuId))
        .collect()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        menuId,
        targetId: targetB,
        path: "nav/id:kept-path/target",
      })
    })
  })

  test("keeps the earliest identical row and deletes deterministic duplicates", async () => {
    const t = convexTest(schema, modules)
    const { menuId, targetId } = await t.run(async (ctx) => {
      const targetId = await ctx.db.insert("pages", {
        slug: "target",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "target" },
        createdAt: 1,
        updatedAt: 1,
      })
      const nav = [canonicalNavItem("same", targetId)]
      const menuId = await ctx.db.insert("menus", {
        slug: "primary",
        nav,
        updatedAt: 1,
      })
      return { menuId, targetId }
    })
    await t.run((ctx) =>
      ctx.db.insert("menuReferences", {
        menuId,
        targetId,
        path: "nav/id:same/target",
        updatedAt: 10,
      })
    )
    await t.run((ctx) =>
      ctx.db.insert("menuReferences", {
        menuId,
        targetId,
        path: "nav/id:same/target",
        updatedAt: 20,
      })
    )
    const before = await t.run((ctx) =>
      ctx.db
        .query("menuReferences")
        .withIndex("by_menu", (q) => q.eq("menuId", menuId))
        .collect()
    )
    const keeper = [...before].sort(
      (a, b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id)
    )[0]!

    await t.run(async (ctx) => {
      const menu = await ctx.db.get(menuId)
      await refreshMenuReferences(ctx, menu!)
    })

    const after = await t.run((ctx) =>
      ctx.db
        .query("menuReferences")
        .withIndex("by_menu", (q) => q.eq("menuId", menuId))
        .collect()
    )
    expect(after).toHaveLength(1)
    expect(after[0]!._id).toBe(keeper._id)
    expect(after[0]!.updatedAt).toBe(keeper.updatedAt)
  })

  test("is a true no-op when the exact graph already exists", async () => {
    const t = convexTest(schema, modules)
    const menuId = await t.run(async (ctx) => {
      const targetId = await ctx.db.insert("pages", {
        slug: "stable-target",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "stable-target" },
        createdAt: 1,
        updatedAt: 1,
      })
      const menuId = await ctx.db.insert("menus", {
        slug: "primary",
        nav: [canonicalNavItem("stable", targetId)],
        updatedAt: 1,
      })
      const menu = await ctx.db.get(menuId)
      await refreshMenuReferences(ctx, menu!)
      return menuId
    })
    const before = await t.run((ctx) =>
      ctx.db
        .query("menuReferences")
        .withIndex("by_menu", (q) => q.eq("menuId", menuId))
        .unique()
    )

    await t.run(async (ctx) => {
      const menu = await ctx.db.get(menuId)
      await refreshMenuReferences(ctx, menu!)
    })

    const after = await t.run((ctx) =>
      ctx.db
        .query("menuReferences")
        .withIndex("by_menu", (q) => q.eq("menuId", menuId))
        .unique()
    )
    expect(after?._id).toBe(before?._id)
    expect(after?.updatedAt).toBe(before?.updatedAt)
  })

  test("clears all rows when the menu is soft-deleted", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const targetId = await ctx.db.insert("pages", {
        slug: "deleted-target",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "deleted-target" },
        createdAt: 1,
        updatedAt: 1,
      })
      const menuId = await ctx.db.insert("menus", {
        slug: "primary",
        nav: [canonicalNavItem("deleted", targetId)],
        updatedAt: 1,
      })
      const liveMenu = await ctx.db.get(menuId)
      await refreshMenuReferences(ctx, liveMenu!)

      await ctx.db.patch(menuId, { deletedAt: 2 })
      const deletedMenu = await ctx.db.get(menuId)
      await refreshMenuReferences(ctx, deletedMenu!)

      expect(
        await ctx.db
          .query("menuReferences")
          .withIndex("by_menu", (q) => q.eq("menuId", menuId))
          .collect()
      ).toEqual([])
    })
  })
})

describe("canonical menu mutation reference integration", () => {
  test("create establishes an empty exact set", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)

    const menuId = await t
      .withIdentity(OWNER)
      .mutation(api.cms.menus.createCanonical, { slug: "empty" })

    expect(
      await t.run((ctx) =>
        ctx.db
          .query("menuReferences")
          .withIndex("by_menu", (q) => q.eq("menuId", menuId))
          .collect()
      )
    ).toEqual([])
    expect(
      await t.query(internal.menuReferences.verifyExact, {})
    ).toMatchObject({
      ok: true,
      expectedCount: 0,
      actualCount: 0,
    })
  })

  test("save, soft-delete, restore with a missing target, and remove stay exact", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)
    const asOwner = t.withIdentity(OWNER)
    await asOwner.mutation(
      api.cms.publication.initializeEmptySnapshotAuthority,
      {}
    )
    const { targetId, changedTargetId } = await t.run(async (ctx) => ({
      targetId: await ctx.db.insert("pages", {
        slug: "target",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "target" },
        createdAt: 1,
        updatedAt: 1,
      }),
      changedTargetId: await ctx.db.insert("pages", {
        slug: "changed-target",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "changed-target" },
        createdAt: 1,
        updatedAt: 1,
      }),
    }))
    // M05 C6: `saveCanonical` accepts only an enabled language, so the site
    // needs its settings row (a fresh install always has one).
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Site",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
      })
    )
    const menuId = await asOwner.mutation(api.cms.menus.createCanonical, {
      slug: "primary",
    })
    await asOwner.mutation(api.cms.menus.saveCanonical, {
      slug: "primary",
      locale: "en",
      nav: [canonicalNavItem("target", targetId)],
    })
    const referencesForMenu = () =>
      t.run((ctx) =>
        ctx.db
          .query("menuReferences")
          .withIndex("by_menu", (q) => q.eq("menuId", menuId))
          .collect()
      )

    const initialReferences = await referencesForMenu()
    expect(initialReferences).toHaveLength(1)

    expect(
      await asOwner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "en",
        nav: [canonicalNavItem("target", targetId)],
      })
    ).toEqual({ id: menuId, updatedAt: expect.any(Number) })
    expect(await referencesForMenu()).toEqual(initialReferences)

    await asOwner.mutation(api.cms.menus.saveCanonical, {
      slug: "primary",
      locale: "en",
      nav: [canonicalNavItem("target", changedTargetId)],
    })
    expect(await referencesForMenu()).toMatchObject([
      { menuId, targetId: changedTargetId },
    ])

    await asOwner.mutation(api.cms.menus.softDelete, { id: menuId })
    expect(await referencesForMenu()).toEqual([])

    await t.run((ctx) => ctx.db.delete(changedTargetId))
    await asOwner.mutation(api.cms.menus.restore, { id: menuId })
    expect(await referencesForMenu()).toMatchObject([
      { menuId, targetId: changedTargetId },
    ])
    const adminMenu = await asOwner.query(api.cms.menus.getCanonical, {
      slug: "primary",
    })
    expect(adminMenu?.nav[0]?.target).toMatchObject({
      type: "internal",
      pageId: changedTargetId,
    })
    const publicMenu = await t.query(api.cms.menus.getWithResolvedLinks, {
      languageVersion: 0,
      slug: "primary",
      locale: "en",
    })
    expect(publicMenu?.nav[0]?.target).toMatchObject({
      type: "internal",
    })
    expect(publicMenu?.nav[0]?.target).not.toHaveProperty("url")

    await asOwner.mutation(api.cms.menus.remove, { id: menuId })
    expect(await referencesForMenu()).toEqual([])
  })
})

describe("exact menu-reference verification", () => {
  test("includes canonical rows with an empty exact graph", async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert("menus", {
        slug: "canonical-only",
        nav: [],
        updatedAt: 1,
      })
    )

    const result = await t.query(internal.menuReferences.verifyExact, {})

    expect(result.ok).toBe(true)
    expect(result.expectedCount).toBe(0)
  })
  test("reports expected-only, actual-only, and duplicate mismatches before passing an exact graph", async () => {
    const t = convexTest(schema, modules)
    const { menuId, targetId } = await t.run(async (ctx) => {
      const targetId = await ctx.db.insert("pages", {
        slug: "verify-target",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "verify-target" },
        createdAt: 1,
        updatedAt: 1,
      })
      const menuId = await ctx.db.insert("menus", {
        slug: "primary",
        nav: [canonicalNavItem("expected", targetId)],
        updatedAt: 1,
      })
      return { menuId, targetId }
    })

    expect(
      await t.query(internal.menuReferences.verifyExact, {})
    ).toMatchObject({
      ok: false,
      expectedCount: 1,
      actualCount: 0,
      missingCount: 1,
      staleCount: 0,
      duplicateCount: 0,
      missingSamples: [{ menuId, targetId, path: "nav/id:expected/target" }],
    })

    await t.run(async (ctx) => {
      for (const updatedAt of [10, 20]) {
        await ctx.db.insert("menuReferences", {
          menuId,
          targetId,
          path: "nav/id:expected/target",
          updatedAt,
        })
      }
      await ctx.db.insert("menuReferences", {
        menuId,
        targetId,
        path: "nav/id:stale/target",
        updatedAt: 30,
      })
    })

    expect(
      await t.query(internal.menuReferences.verifyExact, {})
    ).toMatchObject({
      ok: false,
      expectedCount: 1,
      actualCount: 3,
      missingCount: 0,
      staleCount: 1,
      duplicateCount: 1,
      staleSamples: [{ menuId, targetId, path: "nav/id:stale/target" }],
      duplicateSamples: [{ menuId, targetId, path: "nav/id:expected/target" }],
    })

    await t.run(async (ctx) => {
      const menu = await ctx.db.get(menuId)
      await refreshMenuReferences(ctx, menu!)
    })

    expect(
      await t.query(internal.menuReferences.verifyExact, {})
    ).toMatchObject({
      ok: true,
      expectedCount: 1,
      actualCount: 1,
      missingCount: 0,
      staleCount: 0,
      duplicateCount: 0,
      missingSamples: [],
      staleSamples: [],
      duplicateSamples: [],
    })
  })

  test("counts the complete mismatch set while bounding returned samples", async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const nav: NavItem[] = []
      for (let index = 0; index < 25; index += 1) {
        const targetId = await ctx.db.insert("pages", {
          slug: `bounded-${index}`,
          pageType: "page",
          status: "draft",
          content: {},
          localizedSlugs: { en: `bounded-${index}` },
          createdAt: 1,
          updatedAt: 1,
        })
        nav.push(canonicalNavItem(`item-${index}`, targetId))
      }
      await ctx.db.insert("menus", {
        slug: "primary",
        nav,
        updatedAt: 1,
      })
    })

    const result = await t.query(internal.menuReferences.verifyExact, {})
    expect(result.missingCount).toBe(25)
    expect(result.missingSamples).toHaveLength(20)
  })
})

describe("default menu first save", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  async function fixture() {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)
    const owner = t.withIdentity(OWNER)
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Menus",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        updatedAt: 1,
      })
    )
    return { t, owner }
  }

  function navWithPanel(targetId?: Id<"pages">): NavItem[] {
    return [
      {
        ...canonicalNavItem("products", targetId),
        panel: {
          columns: 1,
          blocks: [
            {
              id: "recent",
              kind: "dynamicList",
              heading: { en: "Recent <news>" },
              source: { pageType: "landing-page", limit: 3 },
            },
          ],
        },
      },
    ]
  }

  async function effects(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => ({
      menus: await ctx.db.query("menus").take(10),
      references: await ctx.db.query("menuReferences").take(10),
      freshness: await ctx.db.query("siteLanguageFreshness").take(10),
      schedules: await ctx.db.system.query("_scheduled_functions").take(20),
    }))
  }

  test.each(DEFAULT_MENU_SLUGS)(
    "%s saves from empty and preserves row identity",
    async (slug) => {
      const { t, owner } = await fixture()
      await t.run((ctx) =>
        ctx.db.insert("cmsModuleState", {
          key: "owner",
          configurationVersion: 1,
          enabledModules: [{ moduleId: "multilingual", configVersion: 1 }],
        })
      )
      await t.run((ctx) =>
        ctx.db.insert("siteLanguageAuthority", {
          key: "site-language-v1",
          version: 1,
          currentLocale: "en",
          mode: "multilingual",
          enabledLocales: ["en", "fr"],
          updatedAt: 1,
        })
      )
      const targetId = await t.run((ctx) =>
        ctx.db.insert("pages", {
          slug: "target",
          pageType: "landing-page",
          status: "draft",
          content: {},
          createdAt: 1,
          updatedAt: 1,
        })
      )
      const nav = navWithPanel(targetId)
      expect(await owner.query(api.cms.menus.getCanonical, { slug })).toBeNull()
      const { id } = await owner.mutation(api.cms.menus.saveCanonical, {
        slug,
        locale: "en",
        nav,
      })
      expect(await owner.query(api.cms.menus.getCanonical, { slug })).toEqual({
        slug,
        updatedAt: expect.any(Number),
        nav,
      })
      const first = await effects(t)
      expect(first.menus).toHaveLength(1)
      expect(first.menus[0]).toMatchObject({
        _id: id,
        slug,
        nav,
        updatedBy: OWNER.tokenIdentifier,
      })
      expect(first.references).toMatchObject([
        { menuId: id, targetId, path: "nav/id:products/target" },
      ])
      expect(first.freshness).toMatchObject([
        { scope: "site", publicationSetVersion: 1, routeClaimVersion: 0 },
      ])
      expect(first.schedules.map((row) => row.name)).toEqual([
        "cms/revalidate:revalidateMenus",
      ])

      const changed = [
        {
          ...nav[0]!,
          label: { en: "Updated [products]" },
          target: { type: "anchor" as const, anchor: "#products" },
        },
      ]
      expect(
        await owner.mutation(api.cms.menus.saveCanonical, {
          slug,
          locale: "en",
          nav: changed,
        })
      ).toEqual({ id, updatedAt: expect.any(Number) })
      expect(await owner.query(api.cms.menus.getCanonical, { slug })).toEqual({
        slug,
        updatedAt: expect.any(Number),
        nav: changed,
      })
      const second = await effects(t)
      expect(second.menus).toHaveLength(1)
      expect(second.references).toEqual([])
      expect(second.freshness).toMatchObject([
        { scope: "site", publicationSetVersion: 2 },
      ])
      expect(second.schedules.map((row) => row.name)).toEqual([
        "cms/revalidate:revalidateMenus",
        "cms/revalidate:revalidateMenus",
      ])
      expect(
        await owner.mutation(api.cms.menus.saveCanonical, {
          slug,
          locale: "en",
          nav: changed,
        })
      ).toEqual({ id, updatedAt: expect.any(Number) })
      expect(await owner.query(api.cms.menus.getCanonical, { slug })).toEqual({
        slug,
        updatedAt: expect.any(Number),
        nav: changed,
      })
    }
  )

  test("refuses a deleted default without restoring or changing anything", async () => {
    const { t, owner } = await fixture()
    await t.run((ctx) =>
      ctx.db.insert("menus", {
        slug: "primary",
        nav: [],
        updatedAt: 1,
        deletedAt: 2,
      })
    )
    const before = await effects(t)
    await expect(
      owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "en",
        nav: navWithPanel(),
      })
    ).rejects.toThrow(/restore it first/)
    expect(await effects(t)).toEqual(before)
  })

  test("refuses a missing custom slug but still edits an existing custom menu", async () => {
    const { t, owner } = await fixture()
    const before = await effects(t)
    await expect(
      owner.mutation(api.cms.menus.saveCanonical, {
        slug: "custom",
        locale: "en",
        nav: [],
      })
    ).rejects.toThrow(/exactly one live row/)
    expect(await effects(t)).toEqual(before)
    const id = await owner.mutation(api.cms.menus.createCanonical, {
      slug: "custom",
    })
    expect(
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "custom",
        locale: "en",
        nav: navWithPanel(),
      })
    ).toEqual({ id, updatedAt: expect.any(Number) })
  })

  test("duplicate slug rows still refuse instead of choosing a row", async () => {
    const { t, owner } = await fixture()
    await t.run(async (ctx) => {
      for (const updatedAt of [1, 2])
        await ctx.db.insert("menus", { slug: "primary", nav: [], updatedAt })
    })
    const before = await effects(t)
    await expect(
      owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "en",
        nav: [],
      })
    ).rejects.toThrow(/unique|more than one/i)
    expect(await effects(t)).toEqual(before)
  })

  test.each([
    {
      name: "invalid default text",
      locale: "en",
      nav: [{ id: "bad", label: { en: "" } }],
      error: /non-blank/,
    },
    {
      name: "secondary locale structure",
      locale: "fr",
      nav: navWithPanel(),
      error: /shared structure/,
    },
    {
      name: "new other-language text",
      locale: "en",
      nav: [{ id: "bad", label: { en: "Home", fr: "Accueil" } }],
      error: /other-language text/,
    },
    {
      name: "ineligible locale",
      locale: "de",
      nav: [],
      error: /LOCALE_NOT_ENABLED/,
    },
  ])(
    "refuses $name before first-save persistence",
    async ({ locale, nav, error }) => {
      const { t, owner } = await fixture()
      const before = await effects(t)
      await expect(
        owner.mutation(api.cms.menus.saveCanonical, {
          slug: "primary",
          locale,
          nav,
        })
      ).rejects.toThrow(error)
      expect(await effects(t)).toEqual(before)
    }
  )

  test.each(["en", "fr"])(
    "empty %s first save updates exactly the applicable transition counter",
    async (locale) => {
      const { t, owner } = await fixture()
      const transitionId = await t.run(async (ctx) => {
        const settings = await ctx.db.query("siteSettings").unique()
        await ctx.db.patch("siteSettings", settings!._id, {
          enabledLocales: ["en"],
        })
        const communityOwner = await ctx.db.query("cmsOwner").unique()
        const id = await ctx.db.insert("siteLanguageTransitions", {
          mode: "replace_content",
          sourceLocale: "en",
          targetLocale: "fr",
          phase: "preparing",
          generation: 1,
          startAuthorityVersion: 1,
          startSettingsUpdatedAt: 1,
          shortPath: false,
          sourcePublicSetVersion: 0,
          preparedSetVersion: 0,
          pageCount: 0,
          targetCount: 0,
          withdrawCount: 0,
          redirectCount: 0,
          unresolvedCount: 0,
          blockedCount: 0,
          targetDrafts: "retained",
          attribution: {
            kind: "owner",
            ownerId: communityOwner!._id,
            authId: OWNER.subject,
            tokenIdentifier: OWNER.tokenIdentifier,
          },
          createdAt: 1,
          updatedAt: 1,
        })
        await ctx.db.insert("siteLanguageAuthority", {
          key: "site-language-v1",
          version: 1,
          currentLocale: "en",
          mode: "single",
          activeTransitionId: id,
          updatedAt: 1,
        })
        await ctx.db.insert("pagePublicationCutover", {
          key: "published-snapshot-v1",
          phase: "snapshot_active",
          revision: 1,
          updatedAt: 1,
        })
        return id
      })
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale,
        nav: [],
      })
      const transition = await t.run((ctx) =>
        ctx.db.get("siteLanguageTransitions", transitionId)
      )
      expect(transition).toMatchObject({
        sourcePublicSetVersion: locale === "en" ? 1 : 0,
        preparedSetVersion: locale === "fr" ? 1 : 0,
      })
      const after = await effects(t)
      expect(after.menus).toHaveLength(1)
      expect(after.menus[0]!.nav).toEqual([])
      expect(after.freshness).toEqual([])
      expect(after.schedules.map((row) => row.name)).toEqual([
        "cms/revalidate:revalidateMenus",
      ])
    }
  )
})
