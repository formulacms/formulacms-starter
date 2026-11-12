/// <reference types="vite/client" />

import { convexTest } from "../convexTestWithExplicitAdmin"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"
import { enableRedirectsForTest } from "../redirectsTestHelpers"
import { expectF03cBoundary } from "../accessBoundaryTestHelpers"
import rateLimiterTest from "@convex-dev/rate-limiter/test"

const modules = import.meta.glob("./**/*.ts")
const owner = {
  subject: "f03c-owner",
  tokenIdentifier: "https://issuer.test|f03c-owner",
  email: "owner@example.test",
}
const unrelated = {
  subject: "f03c-unrelated",
  tokenIdentifier: "https://issuer.test|f03c-unrelated",
  email: "unrelated@example.test",
}

function makeTest() {
  const t = convexTest(schema, modules)
  rateLimiterTest.register(t)
  return t
}

async function makeOwnerTest() {
  const t = makeTest()
  await t.run((ctx) =>
    ctx.db.insert("cmsOwner", {
      key: "owner",
      authId: owner.subject,
      tokenIdentifier: owner.tokenIdentifier,
      establishedAt: 1,
      updatedAt: 1,
    })
  )
  return t
}

/**
 * FR2e (D-7): the AI, Search and Forms boundaries moved to their
 * capability-owned suites (f03c.ai, search.boundaries,
 * formSubmissions.boundaries), which ship only with their module.
 *
 * Every F03c boundary keyed by path, so reordering or extending the inventory
 * cannot silently move a file into the wrong assertion class. `seam` is the
 * access helper the file must reach; every file must additionally be free of
 * the retired `authHelpers` permission vocabulary.
 */
const F03C_BOUNDARIES: { file: string; seam: RegExp }[] = [
  { file: "convex/cms/menus.ts", seam: /requireOperationAccess/ },
  { file: "convex/cms/redirects.ts", seam: /requireOperationAccess/ },
  { file: "convex/cms/tags.ts", seam: /requireOperationAccess/ },
]

describe("F03c Community optional and agent boundaries", () => {
  test("routes optional modules, AI preflights, and Next AI actions through F01 seams", async () => {
    for (const { file, seam } of F03C_BOUNDARIES) {
      await expectF03cBoundary(file, seam)
    }
  })

  test("denies unrelated callers while the owner can use optional reads", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(owner)
    const asUnrelated = t.withIdentity(unrelated)
    await enableRedirectsForTest(asOwner)

    for (const call of [
      () => asUnrelated.query(api.cms.menus.listSlugs, {}),
      () => asUnrelated.query(api.cms.redirects.list, {}),
      () => asUnrelated.query(api.cms.tags.list, {}),
    ]) {
      await expect(call()).rejects.toThrow("CMS_OWNER_REQUIRED")
    }

    await expect(asOwner.query(api.cms.menus.listSlugs, {})).resolves.toEqual(
      []
    )
    await expect(asOwner.query(api.cms.redirects.list, {})).resolves.toEqual([])
    await expect(asOwner.query(api.cms.tags.list, {})).resolves.toEqual([])
  })

  test("denies every protected boundary when there is no authenticated identity", async () => {
    const t = await makeOwnerTest()
    for (const call of [
      () => t.query(api.cms.menus.listSlugs, {}),
      () => t.query(api.cms.redirects.list, {}),
      () => t.query(api.cms.tags.list, {}),
      () => t.mutation(api.cms.menus.createCanonical, { slug: "anon" }),
    ]) {
      await expect(call()).rejects.toThrow(/UNAUTHENTICATED|Unauthenticated/)
    }
  })

  test("menu writes record the session tokenIdentifier as attribution, not the account id", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(owner)

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
    const id = await asOwner.mutation(api.cms.menus.createCanonical, {
      slug: "f03c-main",
    })
    const created = await t.run((ctx) => ctx.db.get(id))
    // F01 invariant 8: attribution is the authenticated `tokenIdentifier`.
    // `owner.subject` (the Better Auth account id) is a different string, so
    // this assertion actually discriminates the two.
    expect(created?.updatedBy).toBe(owner.tokenIdentifier)
    expect(created?.updatedBy).not.toBe(owner.subject)

    await asOwner.mutation(api.cms.menus.saveCanonical, {
      slug: "f03c-main",
      locale: "en",
      nav: [],
    })
    const saved = await t.run((ctx) => ctx.db.get(id))
    expect(saved?.updatedBy).toBe(owner.tokenIdentifier)
  })

  // FR2b: the Search and Forms cases and probes of this suite moved to
  // convex/search.boundaries.test.ts and convex/formSubmissions.boundaries.test.ts.
  test("keeps public redirect boundaries unauthenticated", async () => {
    const t = await makeOwnerTest()
    await enableRedirectsForTest(t.withIdentity(owner))
    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/missing",
      })
    ).resolves.toBeNull()
    await expect(
      t.query(api.cms.redirects.listActiveKeys, { languageVersion: 0 })
    ).resolves.toEqual([])
  })

  test("keeps redirects public", async () => {
    const t = await makeOwnerTest()
    await enableRedirectsForTest(t.withIdentity(owner))
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("redirects", {
        fromPath: "/f03c-old",
        toPath: "/f03c-new",
        statusCode: 302,
        createdAt: now,
        updatedAt: now,
      })
    })

    await expect(
      t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/f03c-old",
      })
    ).resolves.toEqual({ destination: "/f03c-new", statusCode: 302 })
    await expect(
      t.query(api.cms.redirects.listActiveKeys, { languageVersion: 0 })
    ).resolves.toEqual([{ fromPath: "/f03c-old" }])
  })
})
