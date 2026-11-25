/// <reference types="vite/client" />

import { describe, expect, test, vi } from "vitest"
import { ConvexError } from "convex/values"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { enableRedirectsForTest } from "../redirectsTestHelpers"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import * as freshness from "./lib/language/freshness"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "redirect-loop-owner",
  tokenIdentifier: "redirect-loop-owner",
  email: "redirect-loop-owner@example.com",
}
const SITE_URL = "https://example.test"

async function setup(publicationAuthority?: "legacy") {
  const t = convexTest({ schema, modules, ownerIdentity: OWNER, publicationAuthority })
  const owner = t.withIdentity(OWNER)
  await enableRedirectsForTest(owner)
  await t.run((ctx) => ctx.db.insert("siteSettings", {
    siteName: "Redirect tests",
    siteUrl: SITE_URL,
    defaultLocale: "en",
    enabledLocales: ["en", "fr"],
    updatedAt: 1,
  }))
  return { t, owner }
}

type App = Awaited<ReturnType<typeof setup>>
type Rule = {
  fromPath: string
  toPath?: string
  toPageId?: Id<"pages">
  locale?: string
  statusCode?: 301 | 302
}

function create(app: App, rule: Rule) {
  return app.owner.mutation(api.cms.redirects.create, { statusCode: 301, ...rule })
}

// Direct writes represent already-stored bad rules, not a new mutation API.
async function seedRules({ t }: App, rules: Rule[]) {
  await t.run(async (ctx) => {
    for (const rule of rules) {
      await ctx.db.insert("redirects", {
        statusCode: 301,
        ...rule,
        createdAt: 1,
        updatedAt: 1,
      })
    }
  })
}

async function expectRefusal(app: App, rule: Rule, code = "REDIRECT_LOOP") {
  const rows = () => app.t.run((ctx) => ctx.db.query("redirects").take(100))
  const before = await rows()
  const recordPublicChange = vi.spyOn(freshness, "recordPublicChange")
  try {
    const error: unknown = await create(app, rule).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ConvexError)
    expect(error).toMatchObject({ data: { code } })
    const after = await rows()
    expect(after).toHaveLength(before.length)
    expect(after).toEqual(before)
    expect(recordPublicChange).not.toHaveBeenCalled()
  } finally {
    recordPublicChange.mockRestore()
  }
}

function seedPage({ t }: App) {
  return t.run((ctx) => ctx.db.insert("pages", {
    pageType: "page",
    slug: "a",
    status: "published",
    content: { en: { title: "A", blocks: [] } },
    createdAt: 1,
    updatedAt: 1,
  }))
}

describe("redirect loop save refusal", () => {
  test.each([
    ["en", 2], ["en", 3], ["fr", 2], ["fr", 3],
  ] as const)("refuses a %s %i-hop loop", async (locale, hops) => {
    const app = await setup()
    await create(app, { fromPath: "/a", toPath: "/b", locale })
    if (hops === 3) {
      await create(app, { fromPath: "/b", toPath: "/c", locale })
    }
    await expectRefusal(app, {
      fromPath: hops === 2 ? "/b" : "/c", toPath: "/a", locale,
    })
  })

  test("allows the same paths in different languages", async () => {
    const app = await setup()
    await create(app, { fromPath: "/a", toPath: "/b", locale: "en" })
    await expect(create(app, {
      fromPath: "/b", toPath: "/a", locale: "fr",
    })).resolves.toBeDefined()
  })

  test("refuses a chain entering an existing loop", async () => {
    const app = await setup()
    await seedRules(app, [
      { fromPath: "/b", toPath: "/c", locale: "en" },
      { fromPath: "/c", toPath: "/b", locale: "en" },
    ])
    await expectRefusal(app, { fromPath: "/a", toPath: "/b", locale: "en" })
  })

  test("saves a valid chain and resolve still returns each single hop", async () => {
    const app = await setup()
    await create(app, { fromPath: "/a", toPath: "/b", locale: "en" })
    await create(app, { fromPath: "/b", toPath: "/c", locale: "en", statusCode: 302 })
    for (const [path, destination, statusCode] of [
      ["/a", "/b", 301], ["/b", "/c", 302],
    ] as const) {
      await expect(app.t.query(api.cms.redirects.resolve, {
        path, locale: "en", languageVersion: 0,
      })).resolves.toEqual({ destination, statusCode })
    }
  })

  test.each(["en", "fr"])("refuses normalized same paths with %s", async (locale) => {
    const app = await setup()
    await expectRefusal(app, {
      fromPath: " /a/ ", toPath: " /a ", locale,
    }, "REDIRECT_SAME_PATH")
  })

  test("drops query, hash and trailing slash before matching the next hop", async () => {
    const app = await setup()
    await create(app, { fromPath: "/b", toPath: "/a", locale: "en" })
    await expectRefusal(app, {
      fromPath: "/a", toPath: "/b/?x=1#details", locale: "en",
    })
  })

  test("collapses repeated slashes before matching the next hop", async () => {
    const app = await setup()
    await create(app, { fromPath: "/news/b", toPath: "/a", locale: "en" })
    await expectRefusal(app, {
      fromPath: "/a", toPath: "/news//b", locale: "en",
    })
  })

  test("refuses a loop crossing French and English", async () => {
    const app = await setup()
    await create(app, { fromPath: "/b", toPath: `${SITE_URL}/a`, locale: "fr" })
    await expectRefusal(app, { fromPath: "/a", toPath: "/fr/b", locale: "en" })
  })

  test.each([`${SITE_URL}/a`, "//example.test/a"])(
    "refuses a loop through same-site absolute URL %s", async (toPath) => {
      const app = await setup()
      await create(app, { fromPath: "/b", toPath, locale: "en" })
      await expectRefusal(app, { fromPath: "/a", toPath: "/b", locale: "en" })
    }
  )

  test("ends the walk at another origin", async () => {
    const app = await setup()
    await create(app, {
      fromPath: "/b", toPath: "https://other.test/a", locale: "en",
    })
    await expect(create(app, {
      fromPath: "/a", toPath: "/b", locale: "en",
    })).resolves.toBeDefined()
  })

  test("allows an English protocol-relative destination at another origin", async () => {
    const app = await setup()
    await expect(create(app, {
      fromPath: "/a", toPath: "//other.test/a", locale: "en",
    })).resolves.toBeDefined()
  })

  test("refuses an English loop through a same-origin protocol-relative destination", async () => {
    const app = await setup()
    await create(app, { fromPath: "/b", toPath: "/a", locale: "en" })
    await expectRefusal(app, {
      fromPath: "/a", toPath: "//example.test/b", locale: "en",
    })
  })

  test("refuses a French loop through a protocol-relative internal path", async () => {
    const app = await setup()
    await create(app, {
      fromPath: "/example.test/b", toPath: "/a", locale: "fr",
    })
    await expectRefusal(app, {
      fromPath: "/a", toPath: "//example.test/b", locale: "fr",
    })
  })

  test("a malformed site URL cannot establish a same-site destination", async () => {
    const app = await setup()
    await app.t.run(async (ctx) => {
      const settings = await ctx.db.query("siteSettings").first()
      await ctx.db.patch("siteSettings", settings!._id, { siteUrl: "not a URL" })
    })
    await create(app, { fromPath: "/b", toPath: `${SITE_URL}/a`, locale: "en" })
    await expect(create(app, {
      fromPath: "/a", toPath: "/b", locale: "en",
    })).resolves.toBeDefined()
  })

  test("a toPageId destination ends the walk under snapshot authority", async () => {
    const app = await setup()
    const toPageId = await seedPage(app)
    await expect(create(app, {
      fromPath: "/a", toPageId, locale: "en",
    })).resolves.toBeDefined()
  })

  test("a legacy toPageId URL continues the walk", async () => {
    const app = await setup("legacy")
    const toPageId = await seedPage(app)
    await create(app, { fromPath: "/b", toPageId, locale: "en" })
    await expectRefusal(app, { fromPath: "/a", toPath: "/b", locale: "en" })
  })

  test("a missing legacy page with no path ends the walk", async () => {
    const app = await setup("legacy")
    const toPageId = await seedPage(app)
    await app.t.run((ctx) => ctx.db.delete("pages", toPageId))
    await seedRules(app, [{ fromPath: "/b", toPageId, locale: "en" }])
    await expect(create(app, {
      fromPath: "/a", toPath: "/b", locale: "en",
    })).resolves.toBeDefined()
  })

  test.each(["en", "fr"])("refuses an unscoped rule closing a loop in %s", async (locale) => {
    const app = await setup()
    await create(app, { fromPath: "/b", toPath: "/a", locale })
    await expectRefusal(app, { fromPath: "/a", toPath: "/b" })
  })

  test("an exact-language rule shadows an unscoped start", async () => {
    const app = await setup()
    await create(app, { fromPath: "/a", toPath: "/safe", locale: "en" })
    await create(app, { fromPath: "/b", toPath: "/a", locale: "en" })
    await expect(create(app, { fromPath: "/a", toPath: "/b" })).resolves.toBeDefined()
  })

  test("an unscoped stored rule is used as a fallback in a language walk", async () => {
    const app = await setup()
    await create(app, { fromPath: "/b", toPath: "/a" })
    await expectRefusal(app, { fromPath: "/a", toPath: "/b", locale: "fr" })
  })

  test("an exact-language rule shadows an unscoped proposal mid-walk", async () => {
    const app = await setup("legacy")
    await create(app, { fromPath: "/a", toPath: "/safe", locale: "fr" })
    await expect(create(app, {
      fromPath: "/a", toPath: `${SITE_URL}/fr/a`,
    })).resolves.toBeDefined()
    await expect(app.t.query(api.cms.redirects.resolve, {
      path: "/a", locale: "fr", languageVersion: 0,
    })).resolves.toEqual({ destination: "/fr/safe", statusCode: 301 })
  })

  test.each([32, 33])("%i-hop boundary counts the proposed rule", async (hops) => {
    const app = await setup()
    await seedRules(app, Array.from({ length: hops - 1 }, (_, i) => ({
      fromPath: `/hop-${i + 1}`, toPath: `/hop-${i + 2}`, locale: "en",
    })))
    const rule = { fromPath: "/hop-0", toPath: "/hop-1", locale: "en" }
    if (hops === 33) {
      await expectRefusal(app, rule, "REDIRECT_CHAIN_TOO_LONG")
    } else {
      await expect(create(app, rule)).resolves.toBeDefined()
    }
  })
})
