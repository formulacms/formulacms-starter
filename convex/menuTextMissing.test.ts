/// <reference types="vite/client" />

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"
import { seedCommunityOwner } from "../convexTestWithExplicitAdmin"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "menu-text-owner",
  tokenIdentifier: "https://convex.test|menu-text-owner",
  email: "owner@example.test",
}

describe("countMenuTextMissing", () => {
  test("counts missing menu text per language and ignores deleted menus", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)
    await t.run(async (ctx) => {
      await ctx.db.insert("menus", {
        slug: "primary",
        nav: [
          { id: "home", label: { en: "Home", fr: "Accueil" } },
          { id: "about", label: { en: "About" } },
          { id: "blog", label: { en: "Blog" } },
        ],
        updatedAt: 1,
      })
      await ctx.db.insert("menus", {
        slug: "footer",
        nav: [{ id: "legal", label: { en: "Legal" } }],
        updatedAt: 1,
      })
      // A deleted menu is not counted.
      await ctx.db.insert("menus", {
        slug: "old",
        nav: [{ id: "gone", label: { en: "Gone" } }],
        updatedAt: 1,
        deletedAt: 2,
      })
    })

    const counts = await t
      .withIdentity(OWNER)
      .query(api.cms.menus.countMenuTextMissing, { locales: ["fr", "es", "fr"] })

    expect(counts).toEqual({ fr: 3, es: 4 })
  })

  test("a language with every item translated counts zero", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)
    await t.run(async (ctx) => {
      await ctx.db.insert("menus", {
        slug: "primary",
        nav: [{ id: "home", label: { en: "Home", fr: "Accueil" } }],
        updatedAt: 1,
      })
    })

    await expect(
      t
        .withIdentity(OWNER)
        .query(api.cms.menus.countMenuTextMissing, { locales: ["fr"] })
    ).resolves.toEqual({ fr: 0 })
  })

  test("a signed-out caller is refused", async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.query(api.cms.menus.countMenuTextMissing, { locales: ["fr"] })
    ).rejects.toThrow()
  })
})

test("status ignores untranslated optional headings but counts a lost featured node once", async () => {
  const t = convexTest(schema, modules)
  await seedCommunityOwner(t, OWNER)
  await t.run((ctx) => ctx.db.insert("menus", {
    slug: "primary", updatedAt: 1,
    nav: [{ id: "root", label: { en: "Menu" }, panel: { columns: 1, blocks: [
      { id: "group", kind: "linkGroup", heading: { fr: "Groupe" }, links: [
        { id: "link", label: { en: "Link" }, target: { type: "anchor", anchor: "#link" } },
      ] },
      { id: "list", kind: "dynamicList", heading: { fr: "Liste" }, source: { pageType: "landing-page", limit: 3 } },
    ], footer: { blocks: [{ id: "feature", kind: "featured", heading: { fr: "À la une" },
      image: { url: "https://example.com/image.jpg", alt: { fr: "" } }, target: { type: "anchor", anchor: "#feature" } }] } } }],
  }))
  await expect(t.withIdentity(OWNER).query(api.cms.menus.countMenuTextMissing, { locales: ["en"] })).resolves.toEqual({ en: 1 })
})
