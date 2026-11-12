/// <reference types="vite/client" />

import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { enableRedirectsForTest } from "../redirectsTestHelpers"
import { redirectRuleOrigin } from "./cms/redirects"
import schema from "./schema"

// M01a: explicit Redirects rule provenance. Every behavioral assertion drives
// the registered `cms.redirects` entry points; pre-provenance rows are written
// directly because no current entry point can produce one.
const modules = import.meta.glob("./**/*.ts")

const OWNER = {
  subject: "m01a-owner",
  tokenIdentifier: "https://convex.test|m01a-owner",
  name: "M01a Owner",
  email: "m01a-owner@example.com",
}

function app() {
  return convexTest({ schema, modules, ownerIdentity: OWNER })
}

describe("redirectRuleOrigin", () => {
  test("reads only the explicit origin field", () => {
    expect(redirectRuleOrigin({ origin: "manual" })).toBe("manual")
    expect(redirectRuleOrigin({})).toBe("unresolved")
    expect(redirectRuleOrigin({ origin: undefined })).toBe("unresolved")
  })
})

describe("cms.redirects provenance", () => {
  test("create stamps manual provenance whatever the path shape", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await enableRedirectsForTest(owner)

    // Shapes that could be mistaken for historical locale continuity (a
    // locale-prefixed retired slug, locale-scoped) are still manual rules.
    const ids = [
      await owner.mutation(api.cms.redirects.create, {
        fromPath: "/fr/ancien-article",
        toPath: "/fr/nouvel-article",
        locale: "fr",
        statusCode: 301,
      }),
      await owner.mutation(api.cms.redirects.create, {
        fromPath: "/promo",
        toPath: "https://example.com/offer",
        statusCode: 302,
      }),
    ]

    const rows = await t.run((ctx) =>
      Promise.all(ids.map((id) => ctx.db.get(id)))
    )
    for (const row of rows) {
      expect(row?.origin).toBe("manual")
      expect(redirectRuleOrigin(row!)).toBe("manual")
    }
  })

  test("create does not accept caller-supplied provenance", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await enableRedirectsForTest(owner)

    await expect(
      owner.mutation(api.cms.redirects.create, {
        fromPath: "/spoofed",
        toPath: "/target",
        statusCode: 301,
        origin: "manual",
      } as never)
    ).rejects.toThrow()
    await expect(
      t.query(api.cms.redirects.listActiveKeys, { languageVersion: 0 })
    ).resolves.toEqual([])
  })

  test("pre-provenance rows are preserved, unresolved, and served unchanged", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await enableRedirectsForTest(owner)

    // Neither row carries origin. One looks like a manual campaign rule, the
    // other like a retired slug; both must stay unresolved.
    const legacyIds = await t.run(async (ctx) => {
      const now = Date.now()
      return [
        await ctx.db.insert("redirects", {
          fromPath: "/campaign",
          toPath: "https://example.com/landing",
          statusCode: 302,
          createdAt: now,
          updatedAt: now,
        }),
        await ctx.db.insert("redirects", {
          fromPath: "/old-slug",
          toPath: "/new-slug",
          statusCode: 301,
          createdAt: now,
          updatedAt: now,
        }),
      ]
    })
    const before = await t.run((ctx) =>
      Promise.all(legacyIds.map((id) => ctx.db.get(id)))
    )

    await owner.mutation(api.cms.redirects.create, {
      fromPath: "/manual",
      toPath: "/elsewhere",
      statusCode: 301,
    })

    const after = await t.run((ctx) =>
      Promise.all(legacyIds.map((id) => ctx.db.get(id)))
    )
    expect(after).toEqual(before)
    for (const row of after) {
      expect(row).not.toBeNull()
      expect(row).not.toHaveProperty("origin")
      expect(redirectRuleOrigin(row!)).toBe("unresolved")
    }

    // Matching and key listing do not partition by provenance.
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/campaign",
      })
    ).resolves.toEqual({
      destination: "https://example.com/landing",
      statusCode: 302,
    })
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/old-slug",
      })
    ).resolves.toEqual({ destination: "/new-slug", statusCode: 301 })
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/manual",
      })
    ).resolves.toEqual({ destination: "/elsewhere", statusCode: 301 })
    const keys = await t.query(api.cms.redirects.listActiveKeys, {
      languageVersion: 0,
    })
    expect(keys.map((key) => key.fromPath).sort()).toEqual([
      "/campaign",
      "/manual",
      "/old-slug",
    ])
    const listed = await owner.query(api.cms.redirects.list, {})
    expect(listed.map((row) => row.fromPath)).toEqual([
      "/campaign",
      "/manual",
      "/old-slug",
    ])
  })

  test("duplicate protection and removal still cover unresolved rows", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await enableRedirectsForTest(owner)

    const legacyId: Id<"redirects"> = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert("redirects", {
        fromPath: "/retired",
        toPath: "/current",
        statusCode: 301,
        createdAt: now,
        updatedAt: now,
      })
    })

    await expect(
      owner.mutation(api.cms.redirects.create, {
        fromPath: "/retired",
        toPath: "/other",
        statusCode: 302,
      })
    ).rejects.toThrow("A redirect from /retired already exists")
    await expect(t.run((ctx) => ctx.db.get(legacyId))).resolves.toMatchObject({
      toPath: "/current",
    })

    await owner.mutation(api.cms.redirects.remove, { id: legacyId })
    await expect(t.run((ctx) => ctx.db.get(legacyId))).resolves.toBeNull()
  })
})
