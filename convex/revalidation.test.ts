/// <reference types="vite/client" />
/// <reference types="next/types/global" />
import { afterEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import schema from "./schema"
import { issueContactIpProofPairing } from "../lib/auth/contact-ip-proof-pairing"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import { configuredRevalidationOrigin } from "./lib/language/lifecycle"

vi.mock("server-only", () => ({}))

const modules = import.meta.glob("./**/*.ts")
const DAY_MS = 24 * 60 * 60 * 1000
const REVALIDATION_ATTEMPT_PURGE_BATCH_SIZE = 500

/** The one durable Community owner; both identity fields are explicit. */
const OWNER = {
  subject: "revalidation-owner",
  tokenIdentifier: "https://convex.test|revalidation-owner",
  name: "Owner",
  email: "owner@example.com",
}

/** Signed in, but bound to neither owner field — Community's only other tier. */
const UNRELATED = {
  subject: "revalidation-unrelated",
  tokenIdentifier: "https://convex.test|revalidation-unrelated",
  name: "Unrelated",
  email: "unrelated@example.com",
}

async function ownerTest() {
  const t = convexTest(schema, modules)
  await seedCommunityOwner(t, OWNER)
  return t
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function makeConfiguredTest({
  siteUrl = "https://site.example.com",
}: { siteUrl?: string } = {}) {
  const t = await ownerTest()
  await t.run(async (ctx) => {
    const now = Date.now()
    await ctx.db.insert("siteSettings", {
      siteName: "Test site",
      siteUrl,
      defaultLocale: "en",
      enabledLocales: ["en"],
      updatedAt: now,
    })
  })
  vi.stubEnv("REVALIDATE_SECRET", "test-revalidation-secret")
  return t
}

async function makeConfiguredPageTest(options: { siteUrl?: string } = {}) {
  const t = await makeConfiguredTest(options)
  const pageId = await t.run(async (ctx) => {
    const now = Date.now()
    return await ctx.db.insert("pages", {
      slug: "about",
      pageType: "landing-page",
      status: "published",
      createdAt: now,
      updatedAt: now,
      content: {
        en: {
          title: "About",
          slices: [],
        },
      },
    })
  })
  return { t, pageId }
}

function listAttempts(t: Awaited<ReturnType<typeof ownerTest>>) {
  return t.run((ctx) =>
    ctx.db.query("revalidationAttempts").withIndex("by_timestamp").take(10)
  )
}

describe("revalidation attempt persistence", () => {
  test("a configured successful page revalidation records one ok attempt", async () => {
    const { t, pageId } = await makeConfiguredPageTest()
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      t.action(internal.cms.revalidate.revalidatePage, { pageId })
    ).resolves.toBeNull()

    const attempts = await listAttempts(t)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      target: pageId,
      pathCount: 1,
      tagCount: 2,
      status: "ok",
    })
    expect(attempts[0]?.timestamp).toEqual(expect.any(Number))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("a non-2xx response records an http_error attempt", async () => {
    const { t, pageId } = await makeConfiguredPageTest()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("secret=test-revalidation-secret\u0000", {
            status: 503,
          })
      )
    )

    await expect(
      t.action(internal.cms.revalidate.revalidatePage, { pageId })
    ).resolves.toBeNull()

    const attempts = await listAttempts(t)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      target: pageId,
      pathCount: 1,
      tagCount: 2,
      status: "http_error",
      httpStatus: 503,
      errorSnippet: "HTTP 503",
    })
  })

  test("a rejected fetch records a network_error attempt", async () => {
    const { t, pageId } = await makeConfiguredPageTest()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket closed")
      })
    )

    await expect(
      t.action(internal.cms.revalidate.revalidatePage, { pageId })
    ).resolves.toBeNull()

    const attempts = await listAttempts(t)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      target: pageId,
      pathCount: 1,
      tagCount: 2,
      status: "network_error",
      errorSnippet: "socket closed",
    })
    expect(attempts[0]).not.toHaveProperty("httpStatus")
  })

  test("a missing secret records an unconfigured attempt without fetching", async () => {
    const { t, pageId } = await makeConfiguredPageTest()
    vi.stubEnv("REVALIDATE_SECRET", "")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      t.action(internal.cms.revalidate.revalidatePage, { pageId })
    ).resolves.toBeNull()

    const attempts = await listAttempts(t)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      target: pageId,
      pathCount: 1,
      tagCount: 2,
      status: "unconfigured",
    })
    expect(attempts[0]).not.toHaveProperty("httpStatus")
    expect(attempts[0]).not.toHaveProperty("errorSnippet")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("a missing site origin records an unconfigured attempt without fetching", async () => {
    const { t, pageId } = await makeConfiguredPageTest({ siteUrl: "" })
    vi.stubEnv("SITE_URL", "")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      t.action(internal.cms.revalidate.revalidatePage, { pageId })
    ).resolves.toBeNull()

    const attempts = await listAttempts(t)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      target: pageId,
      pathCount: 1,
      tagCount: 2,
      status: "unconfigured",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("menu revalidation records the menus target and its counts", async () => {
    const t = await makeConfiguredTest()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 }))
    )

    await expect(
      t.action(internal.cms.revalidate.revalidateMenus, {})
    ).resolves.toBeNull()

    const attempts = await listAttempts(t)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      target: "menus",
      pathCount: 1,
      tagCount: 1,
      status: "ok",
    })
  })

  test("settings revalidation records the settings target and its counts", async () => {
    const t = await makeConfiguredTest()
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      t.action(internal.cms.revalidate.revalidateSettings, {
        languageVersion: 2,
        currentLocale: "fr",
      })
    ).resolves.toBeNull()

    const attempts = await listAttempts(t)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      target: "settings",
      pathCount: 3,
      tagCount: 3,
      status: "ok",
    })
    const request = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(request?.body))).toEqual({
      paths: ["/", "/fr"],
      layoutPaths: ["/(public)/[locale]"],
      tags: ["cms:pages", "cms:menus", "cms:settings"],
      languageVersion: 2,
    })
  })

  test("stored attempts exclude request data and sanitize bounded errors", async () => {
    const { t, pageId } = await makeConfiguredPageTest()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          `request test-revalidation-secret\u0000 Bearer bearer-secret api_key=api-secret ${"x".repeat(600)}`
        )
      })
    )

    await t.action(internal.cms.revalidate.revalidatePage, {
      pageId,
      extraPaths: ["/previous-about"],
    })

    const attempts = await listAttempts(t)
    expect(attempts).toHaveLength(1)
    const attempt = attempts[0]
    expect(attempt).toMatchObject({
      target: pageId,
      pathCount: 2,
      tagCount: 2,
      status: "network_error",
    })
    expect(attempt?.errorSnippet?.length).toBeLessThanOrEqual(500)
    expect(attempt?.errorSnippet).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(JSON.stringify(attempt)).not.toContain("test-revalidation-secret")
    expect(JSON.stringify(attempt)).not.toContain("bearer-secret")
    expect(JSON.stringify(attempt)).not.toContain("api-secret")
    expect(attempt).not.toHaveProperty("paths")
    expect(attempt).not.toHaveProperty("tags")
    expect(attempt).not.toHaveProperty("headers")
    expect(attempt).not.toHaveProperty("secret")
  })

  test("recordAttempt rejects counts outside its bounded non-negative contract", async () => {
    const t = convexTest(schema, modules)

    await expect(
      t.mutation(internal.cms.revalidate.recordAttempt, {
        target: "menus",
        pathCount: -1,
        tagCount: 1,
        status: "ok",
      })
    ).rejects.toThrow("pathCount must be a bounded non-negative integer")
    await expect(
      t.mutation(internal.cms.revalidate.recordAttempt, {
        target: "settings",
        pathCount: 1,
        tagCount: 10_001,
        status: "ok",
      })
    ).rejects.toThrow("tagCount must be a bounded non-negative integer")
    await expect(listAttempts(t)).resolves.toHaveLength(0)
  })
})

describe("revalidation attempt retention", () => {
  test("deletes only rows strictly older than the exact 90-day cutoff", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"))
      const t = convexTest(schema, modules)
      // Seed and purge against the same transaction-pinned cutoff.
      const now = await t.run(async (ctx) => {
        const now = Date.now()
        await ctx.db.insert("revalidationAttempts", {
          target: "menus",
          pathCount: 1,
          tagCount: 1,
          status: "ok",
          timestamp: now - 90 * DAY_MS - 1,
        })
        await ctx.db.insert("revalidationAttempts", {
          target: "settings",
          pathCount: 1,
          tagCount: 1,
          status: "http_error",
          httpStatus: 503,
          timestamp: now - 90 * DAY_MS,
        })
        await ctx.db.insert("revalidationAttempts", {
          target: "menus",
          pathCount: 1,
          tagCount: 1,
          status: "network_error",
          errorSnippet: "socket closed",
          timestamp: now - 90 * DAY_MS + 1,
        })
        await expect(
          ctx.runMutation(internal.cms.revalidate.purgeExpiredAttempts, {})
        ).resolves.toBe(1)
        return now
      })

      const remaining = await listAttempts(t)
      expect(remaining.map((attempt) => attempt.timestamp)).toEqual([
        now - 90 * DAY_MS,
        now - 90 * DAY_MS + 1,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  test("retains no target or status variety once its timestamp is expired", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"))
      const { t, pageId } = await makeConfiguredPageTest()
      const now = Date.now()
      await t.run(async (ctx) => {
        for (const [target, status] of [
          ["menus", "ok"],
          ["settings", "http_error"],
          [pageId, "network_error"],
          ["menus", "unconfigured"],
        ] as const) {
          await ctx.db.insert("revalidationAttempts", {
            target,
            pathCount: 1,
            tagCount: 1,
            status,
            ...(status === "http_error" && { httpStatus: 503 }),
            ...(status === "network_error" && {
              errorSnippet: "socket closed",
            }),
            timestamp: now - 91 * DAY_MS,
          })
        }
      })

      await expect(
        t.mutation(internal.cms.revalidate.purgeExpiredAttempts, {})
      ).resolves.toBe(4)
      await expect(listAttempts(t)).resolves.toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test("a full batch schedules one continuation and drains the backlog", async () => {
    vi.useFakeTimers()
    try {
      const t = convexTest(schema, modules)
      const now = Date.now()
      await t.run(async (ctx) => {
        for (
          let index = 0;
          index <= REVALIDATION_ATTEMPT_PURGE_BATCH_SIZE;
          index += 1
        ) {
          await ctx.db.insert("revalidationAttempts", {
            target: "menus",
            pathCount: 1,
            tagCount: 1,
            status: "ok",
            timestamp: now - 91 * DAY_MS,
          })
        }
        await ctx.db.insert("revalidationAttempts", {
          target: "settings",
          pathCount: 1,
          tagCount: 1,
          status: "ok",
          timestamp: now - DAY_MS,
        })
      })

      await expect(
        t.mutation(internal.cms.revalidate.purgeExpiredAttempts, {})
      ).resolves.toBe(REVALIDATION_ATTEMPT_PURGE_BATCH_SIZE)
      const scheduled = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect()
      )
      expect(scheduled).toHaveLength(1)

      await t.finishAllScheduledFunctions(vi.runAllTimers)
      const remaining = await listAttempts(t)
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).toMatchObject({ timestamp: now - DAY_MS })
    } finally {
      vi.useRealTimers()
    }
  })

  test("a short or empty batch schedules no continuation", async () => {
    vi.useFakeTimers()
    try {
      const t = convexTest(schema, modules)
      const now = Date.now()
      await t.run(async (ctx) => {
        for (
          let index = 0;
          index < REVALIDATION_ATTEMPT_PURGE_BATCH_SIZE - 1;
          index += 1
        ) {
          await ctx.db.insert("revalidationAttempts", {
            target: "menus",
            pathCount: 1,
            tagCount: 1,
            status: "ok",
            timestamp: now - 91 * DAY_MS,
          })
        }
      })

      await expect(
        t.mutation(internal.cms.revalidate.purgeExpiredAttempts, {})
      ).resolves.toBe(REVALIDATION_ATTEMPT_PURGE_BATCH_SIZE - 1)
      await expect(
        t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
      ).resolves.toHaveLength(0)
      await expect(
        t.mutation(internal.cms.revalidate.purgeExpiredAttempts, {})
      ).resolves.toBe(0)
      await expect(
        t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
      ).resolves.toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test("health ignores expired rows after the purge", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"))
      const t = convexTest(schema, modules)
      const now = Date.now()
      await t.run(async (ctx) => {
        await ctx.db.insert("revalidationAttempts", {
          target: "settings",
          pathCount: 1,
          tagCount: 1,
          status: "unconfigured",
          timestamp: now - 91 * DAY_MS,
        })
        await ctx.db.insert("revalidationAttempts", {
          target: "menus",
          pathCount: 1,
          tagCount: 1,
          status: "ok",
          httpStatus: 204,
          timestamp: now - 2 * DAY_MS,
        })
        await ctx.db.insert("revalidationAttempts", {
          target: "settings",
          pathCount: 1,
          tagCount: 1,
          status: "http_error",
          httpStatus: 503,
          errorSnippet: "HTTP 503",
          timestamp: now - DAY_MS,
        })
      })

      await t.mutation(internal.cms.revalidate.purgeExpiredAttempts, {})
      await seedCommunityOwner(t, OWNER)
      const asOwner = t.withIdentity(OWNER)
      await expect(
        asOwner.query(api.cms.revalidate.getRevalidationHealth, {})
      ).resolves.toEqual({
        recentAttempts: [
          {
            target: "settings",
            pathCount: 1,
            tagCount: 1,
            status: "http_error",
            httpStatus: 503,
            errorSnippet: "HTTP 503",
            timestamp: now - DAY_MS,
          },
          {
            target: "menus",
            pathCount: 1,
            tagCount: 1,
            status: "ok",
            httpStatus: 204,
            timestamp: now - 2 * DAY_MS,
          },
        ],
        consecutiveFailureCount: 1,
        consecutiveFailureCountCapped: false,
        unconfigured: false,
        updateState: "no_address",
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("revalidation health", () => {
  test("rejects unauthenticated callers", async () => {
    const t = await ownerTest()

    await expect(
      t.query(api.cms.revalidate.getRevalidationHealth, {})
    ).rejects.toThrow(/UNAUTHENTICATED/)
  })

  test("denies a non-owner and returns an empty result to the owner", async () => {
    const t = await ownerTest()

    await expect(
      t
        .withIdentity(UNRELATED)
        .query(api.cms.revalidate.getRevalidationHealth, {})
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      t.withIdentity(OWNER).query(api.cms.revalidate.getRevalidationHealth, {})
    ).resolves.toEqual({
      recentAttempts: [],
      consecutiveFailureCount: 0,
      consecutiveFailureCountCapped: false,
      unconfigured: false,
      updateState: "no_address",
    })
  })

  // Frozen Team role evidence; re-home under T01/T02 without weakening it
  // into Community owner-only assertions. Community resolves no viewer or
  // editor tier, so `settings:view` has no Community authority to split.
  test.skip("requires settings:view and returns an empty result to an editor", async () => {
    const t = convexTest(schema, modules)
    const asViewer = t.withIdentity({
      subject: "viewer-1",
      name: "Viewer",
      email: "viewer@example.com",
    })
    const asEditor = t.withIdentity({
      subject: "editor-1",
      name: "Editor",
      email: "editor@example.com",
    })

    await expect(
      asViewer.query(api.cms.revalidate.getRevalidationHealth, {})
    ).rejects.toThrow(/UNAUTHORIZED/)
    await expect(
      asEditor.query(api.cms.revalidate.getRevalidationHealth, {})
    ).resolves.toEqual({
      recentAttempts: [],
      consecutiveFailureCount: 0,
      consecutiveFailureCountCapped: false,
      unconfigured: false,
      updateState: "no_address",
    })
  })

  test("returns newest attempts and aggregates the current failure streak", async () => {
    const t = await ownerTest()
    await t.run(async (ctx) => {
      await ctx.db.insert("revalidationAttempts", {
        target: "menus",
        pathCount: 1,
        tagCount: 1,
        status: "ok",
        httpStatus: 204,
        timestamp: 100,
      })
      await ctx.db.insert("revalidationAttempts", {
        target: "settings",
        pathCount: 1,
        tagCount: 3,
        status: "http_error",
        httpStatus: 503,
        errorSnippet: "HTTP 503",
        timestamp: 200,
      })
      await ctx.db.insert("revalidationAttempts", {
        target: "menus",
        pathCount: 1,
        tagCount: 1,
        status: "network_error",
        errorSnippet: "socket closed",
        timestamp: 300,
      })
      await ctx.db.insert("revalidationAttempts", {
        target: "settings",
        pathCount: 1,
        tagCount: 3,
        status: "unconfigured",
        timestamp: 400,
      })
    })
    const asOwner = t.withIdentity(OWNER)

    const health = await asOwner.query(
      api.cms.revalidate.getRevalidationHealth,
      {}
    )

    expect(health).toEqual({
      recentAttempts: [
        {
          target: "settings",
          pathCount: 1,
          tagCount: 3,
          status: "unconfigured",
          timestamp: 400,
        },
        {
          target: "menus",
          pathCount: 1,
          tagCount: 1,
          status: "network_error",
          errorSnippet: "socket closed",
          timestamp: 300,
        },
        {
          target: "settings",
          pathCount: 1,
          tagCount: 3,
          status: "http_error",
          httpStatus: 503,
          errorSnippet: "HTTP 503",
          timestamp: 200,
        },
        {
          target: "menus",
          pathCount: 1,
          tagCount: 1,
          status: "ok",
          httpStatus: 204,
          timestamp: 100,
        },
      ],
      // B1 (owner 2026-11-02): an unconfigured record is not a failure and
      // ends the streak, so the newest unconfigured attempt leaves it at 0.
      consecutiveFailureCount: 0,
      consecutiveFailureCountCapped: false,
      unconfigured: true,
      updateState: "no_address",
    })
  })

  test("counts only real delivery failures; an unconfigured record ends the streak", async () => {
    const t = await ownerTest()
    await t.run(async (ctx) => {
      const row = (
        status: "http_error" | "network_error" | "unconfigured" | "ok",
        timestamp: number
      ) =>
        ctx.db.insert("revalidationAttempts", {
          target: "menus",
          pathCount: 1,
          tagCount: 1,
          status,
          timestamp,
        })
      await row("http_error", 100)
      await row("unconfigured", 200)
      await row("unconfigured", 250)
      await row("network_error", 300)
      await row("http_error", 400)
    })
    const health = await t
      .withIdentity(OWNER)
      .query(api.cms.revalidate.getRevalidationHealth, {})
    // Only the two failures after the last unconfigured record count.
    expect(health.consecutiveFailureCount).toBe(2)
    expect(health.unconfigured).toBe(false)
  })

  test("a newer success clears stale failures and unconfigured state", async () => {
    const t = await ownerTest()
    await t.run(async (ctx) => {
      await ctx.db.insert("revalidationAttempts", {
        target: "settings",
        pathCount: 1,
        tagCount: 3,
        status: "unconfigured",
        timestamp: 100,
      })
      await ctx.db.insert("revalidationAttempts", {
        target: "settings",
        pathCount: 1,
        tagCount: 3,
        status: "ok",
        httpStatus: 204,
        timestamp: 200,
      })
    })
    const asOwner = t.withIdentity(OWNER)

    const health = await asOwner.query(
      api.cms.revalidate.getRevalidationHealth,
      {}
    )

    expect(health.consecutiveFailureCount).toBe(0)
    expect(health.consecutiveFailureCountCapped).toBe(false)
    expect(health.unconfigured).toBe(false)
    expect(health.recentAttempts.map((attempt) => attempt.status)).toEqual([
      "ok",
      "unconfigured",
    ])
  })

  test("caps an over-window failure streak without reporting false precision", async () => {
    const t = await ownerTest()
    await t.run(async (ctx) => {
      for (let timestamp = 0; timestamp < 51; timestamp += 1) {
        await ctx.db.insert("revalidationAttempts", {
          target: "menus",
          pathCount: 1,
          tagCount: 1,
          status: "network_error",
          errorSnippet: "socket closed",
          timestamp,
        })
      }
    })
    const asOwner = t.withIdentity(OWNER)

    const health = await asOwner.query(
      api.cms.revalidate.getRevalidationHealth,
      {}
    )

    expect(health.recentAttempts).toHaveLength(50)
    expect(health.recentAttempts[0]?.timestamp).toBe(50)
    expect(health.recentAttempts[49]?.timestamp).toBe(1)
    expect(health.consecutiveFailureCount).toBe(50)
    expect(health.consecutiveFailureCountCapped).toBe(true)
    expect(health.unconfigured).toBe(false)
  })
})

describe("public-site update state (B1)", () => {
  const ORIGIN = "https://site.example.com"
  async function stateFor(
    options: {
      siteUrl?: string
      siteUrlEnv?: string
      secret?: string
      attempts?: Array<"ok" | "http_error" | "network_error" | "unconfigured">
      intents?: Array<{
        status:
          | "pending"
          | "running"
          | "failed"
          | "unconfigured"
          | "local_unreachable"
          | "delivered"
        attempts?: number
      }>
    } = {}
  ) {
    const t = await ownerTest()
    vi.stubEnv("SITE_URL", options.siteUrlEnv ?? "")
    vi.stubEnv("REVALIDATE_SECRET", options.secret ?? "")
    await t.run(async (ctx) => {
      await ctx.db.insert("siteSettings", {
        siteName: "Test site",
        siteUrl: options.siteUrl ?? "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
      })
      let timestamp = 0
      for (const status of options.attempts ?? []) {
        timestamp += 1
        await ctx.db.insert("revalidationAttempts", {
          target: "settings",
          pathCount: 1,
          tagCount: 1,
          status,
          timestamp,
        })
      }
      for (const [index, intent] of (options.intents ?? []).entries()) {
        await ctx.db.insert("siteLanguageLifecycleIntents", {
          operationId: `adopt:v${index + 2}`,
          operationKind: "adopt",
          locales: ["en"],
          capturedAuthorityVersion: 1,
          phase: "tags_and_layout",
          status: intent.status,
          attempts: intent.attempts ?? 0,
          createdAt: 1,
          updatedAt: 1,
        })
      }
    })
    const health = await t
      .withIdentity(OWNER)
      .query(api.cms.revalidate.getRevalidationHealth, {})
    return health.updateState
  }

  test("no_address: neither the saved address nor the environment one is set", async () => {
    expect(await stateFor({ secret: "s" })).toBe("no_address")
  })

  test("incomplete: an address but no shared secret, from settings or the environment", async () => {
    expect(await stateFor({ siteUrl: ORIGIN })).toBe("incomplete")
    expect(await stateFor({ siteUrlEnv: ORIGIN })).toBe("incomplete")
  })

  test("an environment address with the secret is a working setup", async () => {
    expect(await stateFor({ siteUrlEnv: ORIGIN, secret: "s" })).toBe("ok")
  })

  test("updating: queued, running or still-unconfigured intents", async () => {
    for (const status of ["pending", "running", "unconfigured"] as const) {
      expect(
        await stateFor({ siteUrl: ORIGIN, secret: "s", intents: [{ status }] })
      ).toBe("updating")
    }
    // A failure that is still inside the automatic retries is updating.
    expect(
      await stateFor({
        siteUrl: ORIGIN,
        secret: "s",
        intents: [{ status: "failed", attempts: 1 }],
      })
    ).toBe("updating")
  })

  test("failed: a lasting failed intent, or a real failure streak", async () => {
    expect(
      await stateFor({
        siteUrl: ORIGIN,
        secret: "s",
        intents: [{ status: "failed", attempts: 3 }],
      })
    ).toBe("failed")
    expect(
      await stateFor({
        siteUrl: ORIGIN,
        secret: "s",
        attempts: ["ok", "http_error"],
      })
    ).toBe("failed")
  })

  test("local_unreachable: a quiet local intent, or failures against a local address", async () => {
    expect(
      await stateFor({
        siteUrl: ORIGIN,
        secret: "s",
        intents: [{ status: "local_unreachable" }],
      })
    ).toBe("local_unreachable")
    expect(
      await stateFor({
        siteUrl: "http://localhost:3000",
        secret: "s",
        attempts: ["network_error"],
      })
    ).toBe("local_unreachable")
  })

  test("ok: delivered intents and no failure streak; unconfigured history is not a failure", async () => {
    expect(
      await stateFor({
        siteUrl: ORIGIN,
        secret: "s",
        attempts: ["http_error", "unconfigured"],
        intents: [{ status: "delivered", attempts: 1 }],
      })
    ).toBe("ok")
  })

  test("the return never carries the secret or the address", async () => {
    const t = await ownerTest()
    vi.stubEnv("REVALIDATE_SECRET", "super-secret-value")
    vi.stubEnv("SITE_URL", ORIGIN)
    const health = await t
      .withIdentity(OWNER)
      .query(api.cms.revalidate.getRevalidationHealth, {})
    const text = JSON.stringify(health)
    expect(text).not.toContain("super-secret-value")
    expect(text).not.toContain(ORIGIN)
  })
})

describe("revalidation self-test", () => {
  test("rejects unauthenticated callers before fetching or recording", async () => {
    const t = await ownerTest()
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      t.action(api.cms.revalidate.runRevalidationSelfTest, {})
    ).rejects.toThrow(/UNAUTHENTICATED/)

    expect(fetchMock).not.toHaveBeenCalled()
    await expect(listAttempts(t)).resolves.toHaveLength(0)
  })

  test("denies a non-owner before fetching or recording", async () => {
    const t = await ownerTest()
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      t
        .withIdentity(UNRELATED)
        .action(api.cms.revalidate.runRevalidationSelfTest, {})
    ).rejects.toThrow("CMS_OWNER_REQUIRED")

    expect(fetchMock).not.toHaveBeenCalled()
    await expect(listAttempts(t)).resolves.toHaveLength(0)
  })

  // Frozen Team role evidence; re-home under T01/T02 without weakening it
  // into Community owner-only assertions.
  test.skip("requires settings:update before fetching or recording", async () => {
    const t = convexTest(schema, modules)
    const asEditor = t.withIdentity({
      subject: "editor-self-test",
      name: "Editor",
      email: "editor@example.com",
    })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      asEditor.action(api.cms.revalidate.runRevalidationSelfTest, {})
    ).rejects.toThrow(/UNAUTHORIZED/)

    expect(fetchMock).not.toHaveBeenCalled()
    await expect(listAttempts(t)).resolves.toHaveLength(0)
  })

  test("an authorized self-test sends an empty request and records success", async () => {
    const t = await makeConfiguredTest()
    const asOwner = t.withIdentity(OWNER)
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      asOwner.action(api.cms.revalidate.runRevalidationSelfTest, {})
    ).resolves.toEqual({
      status: "ok",
      httpStatus: 204,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://site.example.com/api/revalidate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-revalidate-secret": "test-revalidation-secret",
        },
        body: JSON.stringify({ paths: [], tags: [] }),
      }
    )
    await expect(listAttempts(t)).resolves.toMatchObject([
      {
        target: "settings",
        pathCount: 0,
        tagCount: 0,
        status: "ok",
        httpStatus: 204,
      },
    ])
  })

  test("a mismatched self-test secret records and returns only the 401 result", async () => {
    const t = await makeConfiguredTest()
    const asOwner = t.withIdentity(OWNER)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 }))
    )

    const result = await asOwner.action(
      api.cms.revalidate.runRevalidationSelfTest,
      {}
    )

    expect(result).toEqual({
      status: "http_error",
      httpStatus: 401,
    })
    expect(JSON.stringify(result)).not.toContain("test-revalidation-secret")
    await expect(listAttempts(t)).resolves.toMatchObject([
      {
        target: "settings",
        pathCount: 0,
        tagCount: 0,
        status: "http_error",
        httpStatus: 401,
        errorSnippet: "HTTP 401",
      },
    ])
  })

  test("a self-test network failure does not return secret-bearing diagnostics", async () => {
    const t = await makeConfiguredTest()
    const asOwner = t.withIdentity(OWNER)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          "request test-revalidation-secret to https://user:password@site.example.com failed"
        )
      })
    )

    const result = await asOwner.action(
      api.cms.revalidate.runRevalidationSelfTest,
      {}
    )

    expect(result).toEqual({ status: "network_error" })
    expect(JSON.stringify(result)).not.toContain("test-revalidation-secret")
    expect(JSON.stringify(result)).not.toContain("site.example.com")
    const attempts = await listAttempts(t)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      target: "settings",
      pathCount: 0,
      tagCount: 0,
      status: "network_error",
    })
    expect(attempts[0]?.errorSnippet).not.toContain("test-revalidation-secret")
    expect(attempts[0]?.errorSnippet).not.toContain("user:password")
  })

  test("an unconfigured self-test records a bounded result without fetching", async () => {
    const t = await makeConfiguredTest()
    const asOwner = t.withIdentity(OWNER)
    vi.stubEnv("REVALIDATE_SECRET", "")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      asOwner.action(api.cms.revalidate.runRevalidationSelfTest, {})
    ).resolves.toEqual({ status: "unconfigured" })

    expect(fetchMock).not.toHaveBeenCalled()
    await expect(listAttempts(t)).resolves.toMatchObject([
      {
        target: "settings",
        pathCount: 0,
        tagCount: 0,
        status: "unconfigured",
      },
    ])
  })
})

test("lifecycle preflight and the drain share origin precedence across runtime env changes", async () => {
  const t = await makeConfiguredTest({ siteUrl: "" })
  const asOwner = t.withIdentity(OWNER)
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal("fetch", fetchMock)
  const primary = "https://site.example.com"
  const fallback = "https://fallback.example.com"

  for (const [secret, siteUrl, envUrl, origin] of [
    [undefined, primary, fallback, null],
    ["", primary, fallback, null],
    ["test-revalidation-secret", undefined, undefined, null],
    ["test-revalidation-secret", "", "", null],
    ["test-revalidation-secret", undefined, `${fallback}/`, fallback],
    ["test-revalidation-secret", "", `${fallback}/`, fallback],
    ["test-revalidation-secret", `${primary}/`, `${fallback}/`, primary],
    ["replacement-revalidation-secret", `${primary}/`, undefined, primary],
    [undefined, primary, fallback, null],
  ] as const) {
    vi.stubEnv("REVALIDATE_SECRET", secret)
    vi.stubEnv("SITE_URL", envUrl)
    await t.run(async (ctx) => {
      const settings = await ctx.db.query("siteSettings").first()
      if (!settings) throw new Error("Missing fixture settings")
      await ctx.db.patch(settings._id, { siteUrl: siteUrl ?? "" })
    })
    fetchMock.mockClear()

    expect(configuredRevalidationOrigin(siteUrl)).toBe(origin)
    await expect(
      asOwner.action(api.cms.revalidate.runRevalidationSelfTest, {})
    ).resolves.toEqual(
      origin === null
        ? { status: "unconfigured" }
        : { status: "ok", httpStatus: 204 }
    )
    if (origin === null) {
      expect(fetchMock).not.toHaveBeenCalled()
    } else {
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith(
        `${origin}/api/revalidate`,
        expect.objectContaining({
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-revalidate-secret": secret,
          },
        })
      )
    }
  }
})

describe("CONTACT_IP_PROOF_SECRET pairing", () => {
  test("rejects unauthenticated callers before checking a proof", async () => {
    const t = await ownerTest()

    await expect(
      t.action(api.cms.revalidate.verifyContactIpProofPairing, {
        expiresAt: Date.now(),
        signature: "a".repeat(64),
      })
    ).rejects.toThrow(/UNAUTHENTICATED/)
    await expect(listAttempts(t)).resolves.toHaveLength(0)
  })

  test("denies a non-owner before checking a proof", async () => {
    const t = await ownerTest()

    await expect(
      t
        .withIdentity(UNRELATED)
        .action(api.cms.revalidate.verifyContactIpProofPairing, {
          expiresAt: Date.now(),
          signature: "a".repeat(64),
        })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(listAttempts(t)).resolves.toHaveLength(0)
  })

  // Frozen Team role evidence; re-home under T01/T02 without weakening it
  // into Community owner-only assertions.
  test.skip("requires settings:update before checking a proof", async () => {
    const t = convexTest(schema, modules)
    const asEditor = t.withIdentity({
      subject: "editor-pairing",
      name: "Editor",
      email: "editor-pairing@example.com",
    })

    await expect(
      asEditor.action(api.cms.revalidate.verifyContactIpProofPairing, {
        expiresAt: Date.now(),
        signature: "a".repeat(64),
      })
    ).rejects.toThrow(/UNAUTHORIZED/)
    await expect(listAttempts(t)).resolves.toHaveLength(0)
  })

  test("passes only a current proof signed with the configured shared secret", async () => {
    const t = await ownerTest()
    const secret = "matching-contact-ip-proof-secret"
    vi.stubEnv("CONTACT_IP_PROOF_SECRET", secret)
    const issued = await issueContactIpProofPairing({ secret })
    if (issued.status !== "issued") throw new Error("Expected a proof")
    const asOwner = t.withIdentity(OWNER)

    const result = await asOwner.action(
      api.cms.revalidate.verifyContactIpProofPairing,
      issued.proof
    )

    expect(result).toEqual({ status: "pass" })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(issued.proof.signature)
    expect(JSON.stringify(result)).not.toContain(String(issued.proof.expiresAt))
    await expect(listAttempts(t)).resolves.toHaveLength(0)
  })

  test("returns fail for different-secret, expired, future, malformed, and bad-signature proofs", async () => {
    const t = await ownerTest()
    const configuredSecret = "configured-contact-ip-proof-secret"
    vi.stubEnv("CONTACT_IP_PROOF_SECRET", configuredSecret)
    const now = Date.now()
    const wrongSecret = await issueContactIpProofPairing({
      secret: "other-contact-ip-proof-secret",
      now,
    })
    const expired = await issueContactIpProofPairing({
      secret: configuredSecret,
      expiresAt: now - 1_000,
    })
    const future = await issueContactIpProofPairing({
      secret: configuredSecret,
      expiresAt: now + 20 * 60 * 1000,
    })
    if (
      wrongSecret.status !== "issued" ||
      expired.status !== "issued" ||
      future.status !== "issued"
    ) {
      throw new Error("Expected test proofs")
    }
    const asOwner = t.withIdentity(OWNER)

    for (const proof of [
      wrongSecret.proof,
      expired.proof,
      future.proof,
      { expiresAt: now + 60_000, signature: "not-a-signature" },
      { expiresAt: now + 60_000, signature: ` ${"a".repeat(64)} ` },
      { expiresAt: now + 60_000, signature: "A".repeat(64) },
      { expiresAt: now + 60_000, signature: "a".repeat(10_000) },
      { expiresAt: now + 60_000.5, signature: "a".repeat(64) },
      { expiresAt: now + 60_000, signature: "a".repeat(64) },
    ]) {
      await expect(
        asOwner.action(api.cms.revalidate.verifyContactIpProofPairing, proof)
      ).resolves.toEqual({ status: "fail" })
    }
  })

  test("returns a bounded unconfigured result when Convex lacks the secret", async () => {
    const t = await ownerTest()
    vi.stubEnv("CONTACT_IP_PROOF_SECRET", "")
    const asOwner = t.withIdentity(OWNER)

    await expect(
      asOwner.action(api.cms.revalidate.verifyContactIpProofPairing, {
        expiresAt: Date.now() + 60_000,
        signature: "a".repeat(64),
      })
    ).resolves.toEqual({ status: "unconfigured" })
  })
})


describe("ED3 publication rewrite destinations", () => {
  test.each(["en", "fr"])("includes aliases and actual locale routes for %s, old/new and home paths", async (locale) => {
    const { t, pageId } = await makeConfiguredPageTest()
    const intentId = await t.run((ctx) => ctx.db.insert("pagePublicationRevalidationIntents", {
      operationId: `ed3:${locale}`, operationKind: "republish", pageId, locale,
      oldPublicGeneration: 1, newPublicGeneration: 2,
      oldPath: "/about", newPath: "/", phase: "self", status: "running", attempts: 1,
      createdAt: Date.now(), updatedAt: Date.now(),
    }))
    const step = await t.query(internal.cms.revalidate.planPublicationRevalidationStep, { intentId, attempts: 1 })
    expect(step?.paths).toContain(`/${locale}/about`)
    expect(step?.paths).toContain(`/${locale}`)
    if (locale === "en") expect(step?.paths).toEqual(expect.arrayContaining(["/about", "/"]))
    expect(step?.tags).toEqual(["cms:pages", "cms:menus"])
    expect(await t.query(internal.cms.revalidate.planPublicationRevalidationStep, { intentId, attempts: 2 })).toBeNull()
  })
})
