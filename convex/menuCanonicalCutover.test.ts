/// <reference types="vite/client" />

import { convexTest } from "convex-test"
import { expect, test } from "vitest"
import { internal } from "./_generated/api"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")

test("C3 narrowed verification accepts unique semantically valid menus", async () => {
  const t = convexTest(schema, modules)
  await t.run(async (ctx) => {
    await ctx.db.insert("siteSettings", {
      siteName: "Test",
      siteUrl: "https://example.test",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      updatedAt: 1,
    })
    await ctx.db.insert("menus", {
      slug: "primary",
      nav: [{ id: "home", label: { fr: "Accueil" } }],
      updatedAt: 1,
    })
    await ctx.db.insert("menus", {
      slug: "footer",
      nav: [],
      updatedAt: 1,
      deletedAt: 2,
    })
  })

  await expect(
    t.query(internal.menuCanonicalCutover.verifyNarrowed, {})
  ).resolves.toEqual({
    ok: true,
    rowCount: 2,
    slugCount: 2,
    duplicateSlugs: { count: 0, slugSamples: [] },
    invalidCanonical: { count: 0, slugSamples: [] },
  })
})

test("C3 narrowed verification reports duplicate and invalid canonical rows", async () => {
  const t = convexTest(schema, modules)
  await t.run(async (ctx) => {
    await ctx.db.insert("siteSettings", {
      siteName: "Test",
      siteUrl: "https://example.test",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      updatedAt: 1,
    })
    await ctx.db.insert("menus", {
      slug: "primary",
      nav: [],
      updatedAt: 1,
    })
    await ctx.db.insert("menus", {
      slug: "primary",
      nav: [{ id: "blank-everywhere", label: { fr: "  " } }],
      updatedAt: 2,
    })
  })

  await expect(
    t.query(internal.menuCanonicalCutover.verifyNarrowed, {})
  ).resolves.toEqual({
    ok: false,
    rowCount: 2,
    slugCount: 1,
    duplicateSlugs: { count: 1, slugSamples: ["primary"] },
    invalidCanonical: { count: 1, slugSamples: ["primary"] },
  })
})
