/// <reference types="vite/client" />
// Edit-time tokens (`updatedAt` compared by equality) move strictly forward on
// every write, even when two writes land in the same millisecond. One real
// mutation path per table; the helper itself is covered in lib/versions.test.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { convexTestWithAuth as convexTest } from "../test-utils/convexAuthFixtures"
import {
  convexTest as convexTestExplicit,
  seedCommunityOwner,
} from "../convexTestWithExplicitAdmin"
import { api } from "./_generated/api"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const OWNER = { subject: "edit-token-owner", tokenIdentifier: "edit-token-owner" }
const CLOCK = 1_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(CLOCK)
})
afterEach(() => vi.useRealTimers())

async function fixture() {
  const t = convexTest(schema, modules)
  await seedCommunityOwner(t, OWNER)
  await t
    .withIdentity(OWNER)
    .mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  await t.run(async (ctx) => {
    await ctx.db.insert("siteSettings", {
      siteName: "Tokens",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en"],
      updatedAt: CLOCK,
    })
    await ctx.db.insert("menus", {
      slug: "primary",
      nav: [{ id: "a", label: { en: "A" } }],
      updatedAt: CLOCK,
    })
  })
  return { t, owner: t.withIdentity(OWNER) }
}

describe("edit-time tokens move forward in the same millisecond", () => {
  test("siteSettings: two settings saves never repeat the token", async () => {
    const { t, owner } = await fixture()
    const token = () =>
      t.run(async (ctx) => (await ctx.db.query("siteSettings").first())!.updatedAt)
    const seen = [await token()]
    for (const siteName of ["Tokens A", "Tokens B"]) {
      await owner.mutation(api.cms.settings.updateSettings, { siteName })
      seen.push(await token())
    }
    expect(seen[1]).toBeGreaterThan(seen[0]!)
    expect(seen[2]).toBeGreaterThan(seen[1]!)
  })

  test("menus: restore moves the token, so an old token is refused", async () => {
    const { t, owner } = await fixture()
    const menuId = await t.run(async (ctx) => (await ctx.db.query("menus").first())!._id)
    await owner.mutation(api.cms.menus.softDelete, { id: menuId })
    await owner.mutation(api.cms.menus.restore, { id: menuId })
    const restored = await t.run((ctx) => ctx.db.get("menus", menuId))
    expect(restored!.updatedAt).toBeGreaterThan(CLOCK)
    await expect(
      owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        nav: restored!.nav,
        locale: "en",
        expectedUpdatedAt: CLOCK,
      })
    ).rejects.toThrow(/changed since/)
    await expect(
      owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        nav: restored!.nav,
        locale: "en",
        expectedUpdatedAt: restored!.updatedAt,
      })
    ).resolves.toMatchObject({ id: menuId })
  })

  test("pages: same-millisecond saves move the token and a stale save is refused", async () => {
    const t = convexTestExplicit({ schema, modules, ownerIdentity: OWNER })
    const owner = t.withIdentity(OWNER)
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Initial",
      content: { en: { title: "Initial", blocks: [] } },
    })
    const stored = async () =>
      (await t.run((ctx) => ctx.db.get("pages", pageId)))!.updatedAt
    const first = await owner.mutation(api.cms.pages.update, {
      id: pageId,
      expectedUpdatedAt: await stored(),
      title: "One",
    })
    expect(first.updatedAt).toBe(await stored())
    const second = await owner.mutation(api.cms.pages.update, {
      id: pageId,
      expectedUpdatedAt: first.updatedAt,
      title: "Two",
    })
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
    expect(second.updatedAt).toBe(await stored())
    await expect(
      owner.mutation(api.cms.pages.update, {
        id: pageId,
        expectedUpdatedAt: first.updatedAt,
        title: "Stale",
      })
    ).rejects.toThrow(/changed since you opened it/)
  })

  test("pageStaging: same-millisecond autosaves move the token and a stale one is refused", async () => {
    const t = convexTestExplicit({ schema, modules, ownerIdentity: OWNER })
    const owner = t.withIdentity(OWNER)
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Initial",
      content: { en: { title: "Initial", blocks: [] } },
    })
    await owner.mutation(api.cms.pages.acquirePageEditorLock, { pageId, force: true })
    const stored = async () =>
      (await t.run((ctx) =>
        ctx.db.query("pageStaging").withIndex("by_pageId", (q) => q.eq("pageId", pageId)).first()
      ))!.updatedAt
    const body = (title: string) => ({
      en: { pageType: "landing-page" as const, localized: { title }, blocks: [] },
    })
    const first = await owner.mutation(api.cms.pages.updateDraft, {
      pageId,
      content: body("First"),
    })
    expect(first.updatedAt).toBe(await stored())
    const second = await owner.mutation(api.cms.pages.updateDraft, {
      pageId,
      expectedUpdatedAt: first.updatedAt,
      content: body("Second"),
    })
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
    expect(second.updatedAt).toBe(await stored())
    await expect(
      owner.mutation(api.cms.pages.updateDraft, {
        pageId,
        expectedUpdatedAt: first.updatedAt,
        content: body("Stale"),
      })
    ).rejects.toThrow(/took over editing/i)
  })
})
