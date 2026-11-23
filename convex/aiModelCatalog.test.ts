/// <reference types="vite/client" />
import actionRetrierTest from "@convex-dev/action-retrier/test"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  convexTestWithAuth as convexTest,
  prepareAuthSessions,
} from "../test-utils/convexAuthFixtures"
import { DIRECT_PRICES } from "../lib/ai/price-quote"
import { api, internal } from "./_generated/api"
import { loadCatalogModels, loadProviderCatalog } from "./lib/aiCatalog"
import { hashOwnerClaim } from "./lib/ownerClaim"
import schema from "./schema"
import { createTestAccounting } from "@/lib/ai/accounting.testFixtures"
import { executeGeneration } from "../lib/ai/execute-generation"
import { catalogFromEntries } from "../lib/ai/model-catalog"
import { taskProfileTuple } from "../lib/ai/task-profiles"
import type { ApiModelTuple } from "../lib/ai/execution-contract"
import { resolveAssistantRuntimeTuple } from "./lib/ai"
import type { RunId } from "@convex-dev/action-retrier"
import { refusal } from "../lib/ai/model-catalog"
import { BLOCK_CREATOR_PROFILES, TASK_PROFILE_REQUIREMENTS } from "../lib/ai/task-profiles"
import { resolveBlockCreatorSelection } from "../lib/blocks/authoring/creator-selection"
import { resolveLocalApiTuple } from "../scripts/lib/ai-api-engine"
import { refreshDue } from "./cms/vendorModelCatalog"

const modules = import.meta.glob("./**/*.ts")

const ANTHROPIC_URL = "https://api.anthropic.com/v1/models"
const OPENAI_URL = "https://api.openai.com/v1/models"
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models"
const ANTHROPIC_KEY = "anthropic-key-sentinel"
const OPENAI_KEY = "openai-key-sentinel"
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1_000

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "")
  vi.stubEnv("OPENAI_API_KEY", "")
  vi.stubEnv("OPENROUTER_API_KEY", "")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      return handler(url, init)
    })
  )
  return calls
}

function anthropicRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    display_name: `Name ${id}`,
    line: "opus",
    created_at: "2026-10-01T00:00:00Z",
    max_input_tokens: 200_000,
    max_tokens: 64_000,
    lifecycle: "active",
    capabilities: {
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
      },
    },
    ...extra,
  }
}

function openAiRow(id: string, extra: Record<string, unknown> = {}) {
  return { id, object: "model", created: 1_790_000_000, owned_by: "openai", ...extra }
}

function openRouterFeedRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    created: 1_790_000_000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["reasoning", "structured_outputs"],
    pricing: { prompt: "0.000002", completion: "0.00001" },
    ...extra,
  }
}

async function seedOwner(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: 1,
      enabledModules: [{ moduleId: "ai", configVersion: 1 }],
    })
    await ctx.db.insert("cmsOwner", {
      key: "owner",
      authId: "admin-1",
      tokenIdentifier: "admin-1",
      establishedAt: 1,
      updatedAt: 1,
    })
  })
}

function app() {
  const t = convexTest(schema, modules)
  actionRetrierTest.register(t)
  rateLimiterTest.register(t)
  return t
}

async function vendorRows(t: ReturnType<typeof app>, provider: string) {
  return t.run(async (ctx) =>
    (await ctx.db.query("aiVendorModels").take(1000)).filter(
      (row) => row.provider === provider
    )
  )
}

async function syncRow(t: ReturnType<typeof app>, key: string) {
  return t.run(async (ctx) =>
    (await ctx.db.query("openRouterCatalogSync").take(10)).find(
      (row) => row.key === key
    )
  )
}

/** Seeds the running sync row a started refresh writes, as `startCatalogRefresh` does. */
async function startAttempt(
  t: ReturnType<typeof app>,
  provider: "anthropic" | "openai",
  attemptAt: number
) {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("openRouterCatalogSync")
      .withIndex("by_key", (q) => q.eq("key", provider))
      .unique()
    if (row) {
      await ctx.db.patch("openRouterCatalogSync", row._id, { status: "running", lastAttemptAt: attemptAt })
    } else {
      await ctx.db.insert("openRouterCatalogSync", { key: provider, status: "running", lastAttemptAt: attemptAt })
    }
  })
}

/** One fetch as the current run (its sync row is started first). */
async function fetchVendor(t: ReturnType<typeof app>, provider: "anthropic" | "openai", attemptAt = NOW) {
  await startAttempt(t, provider, attemptAt)
  return t.action(internal.cms.vendorModelCatalog.fetchAndPublish, { provider, attemptAt })
}

/** One publish as the current run, started at `syncedAt`. */
async function publishVendor(
  t: ReturnType<typeof app>,
  args: {
    provider: "anthropic" | "openai"
    models: { provider: "anthropic" | "openai"; modelId: string }[]
    syncedAt: number
    keyFingerprint: string
  }
) {
  await startAttempt(t, args.provider, args.syncedAt)
  return t.mutation(internal.cms.vendorModelCatalog.publishVendorCatalog, {
    ...args,
    attemptAt: args.syncedAt,
  })
}

describe("Anthropic list", () => {
  test("follows after_id across two pages and stores both", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY)
    const calls = stubFetch((url) => {
      if (url.includes("after_id=a2"))
        return json({ data: [anthropicRow("c3")], has_more: false, last_id: "c3" })
      return json({
        data: [anthropicRow("a1"), anthropicRow("a2")],
        has_more: true,
        last_id: "a2",
      })
    })
    const t = app()
    const result = await fetchVendor(t, "anthropic")
    expect(result).toEqual({ status: "published", count: 3 })
    expect(calls).toHaveLength(2)
    const first = new URL(calls[0]!.url)
    expect(first.origin + first.pathname).toBe(ANTHROPIC_URL)
    expect(first.searchParams.get("limit")).toBe("1000")
    expect(first.searchParams.getAll("lifecycle")).toEqual([
      "active",
      "deprecated",
      "retired",
    ])
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers["x-api-key"]).toBe(ANTHROPIC_KEY)
    expect(headers["anthropic-version"]).toBe("2026-10-21")
    const rows = await vendorRows(t, "anthropic")
    expect(rows.map((row) => row.modelId).sort()).toEqual(["a1", "a2", "c3"])
    expect(rows[0]!.efforts).toEqual(["low", "medium", "high"])
    // Only a fingerprint is stored, never the key.
    const sync = await syncRow(t, "anthropic")
    expect(sync?.keyFingerprint).toBe(await hashOwnerClaim(ANTHROPIC_KEY))
    expect(JSON.stringify(sync)).not.toContain(ANTHROPIC_KEY)
    expect(sync?.status).toBe("success")
  })

  test("refuses a list that needs more than three pages", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY)
    let n = 0
    stubFetch(() => {
      n += 1
      return json({ data: [anthropicRow(`m${n}`)], has_more: true, last_id: `m${n}` })
    })
    const t = app()
    await expect(
      fetchVendor(t, "anthropic")
    ).rejects.toThrow(/more pages/)
    expect(n).toBe(3)
    expect(await vendorRows(t, "anthropic")).toHaveLength(0)
  })
})

describe("OpenAI list", () => {
  test("keeps text models and drops fine-tunes, pro, audio and others", async () => {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY)
    const calls = stubFetch(() =>
      json({
        data: [
          openAiRow("gpt-7-sol"),
          openAiRow("gpt-6-sol-pro"),
          openAiRow("gpt-7-realtime"),
          openAiRow("ft:gpt-7-sol:acme"),
          openAiRow("text-embedding-9"),
          openAiRow("gpt-5-old", { shutdown_date: "2020-01-01" }),
          openAiRow("gpt-7-third", { owned_by: "someone-else" }),
        ],
      })
    )
    const t = app()
    const result = await fetchVendor(t, "openai")
    expect(result).toEqual({ status: "published", count: 2 })
    expect(calls[0]!.url).toBe(OPENAI_URL)
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${OPENAI_KEY}`
    )
    const rows = await vendorRows(t, "openai")
    expect(rows.map((row) => row.modelId).sort()).toEqual(["gpt-5-old", "gpt-7-sol"])
    expect(rows.find((row) => row.modelId === "gpt-5-old")?.lifecycle).toBe("retired")
    expect(rows.find((row) => row.modelId === "gpt-7-sol")?.lifecycle).toBe("active")
  })
})

describe("failures keep the last good snapshot", () => {
  test("401 records 'key refused', publishes nothing and does not throw", async () => {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY)
    stubFetch(() => json({ error: { message: OPENAI_KEY } }, 401))
    const t = app()
    const result = await fetchVendor(t, "openai")
    expect(result).toEqual({ status: "refused" })
    const sync = await syncRow(t, "openai")
    expect(sync?.status).toBe("failed")
    expect(sync?.error).toBe("key refused")
    expect(await vendorRows(t, "openai")).toHaveLength(0)
  })

  test("500 throws with status and fixed phrase only, rows unchanged", async () => {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY)
    const t = app()
    await publishVendor(t, {
      provider: "openai",
      models: [{ provider: "openai", modelId: "gpt-7-sol" }],
      syncedAt: NOW,
      keyFingerprint: await hashOwnerClaim(OPENAI_KEY),
    })
    stubFetch(() => json({ detail: `secret ${OPENAI_KEY}` }, 500))
    const error = await fetchVendor(t, "openai", NOW + 1).catch((e: Error) => e)
    expect(String(error)).toContain("responded 500")
    expect(String(error)).not.toContain(OPENAI_KEY)
    expect(String(error)).not.toContain("secret")
    const rows = await vendorRows(t, "openai")
    expect(rows.map((row) => row.modelId)).toEqual(["gpt-7-sol"])
    expect(rows[0]!.absentSince).toBeUndefined()
  })

  test("no key: nothing is fetched and nothing fails", async () => {
    const calls = stubFetch(() => json({ data: [] }))
    const t = app()
    for (const provider of ["anthropic", "openai"] as const) {
      await expect(
        t.action(internal.cms.vendorModelCatalog.fetchAndPublish, { provider, attemptAt: NOW })
      ).resolves.toEqual({ status: "no-key" })
    }
    await t.action(internal.cms.vendorModelCatalog.ensureVendorRefresh, {})
    await t.action(internal.cms.vendorModelCatalog.enqueueDailyRefresh, {})
    expect(calls).toHaveLength(0)
    expect(await syncRow(t, "anthropic")).toBeFalsy()
    expect(await syncRow(t, "openai")).toBeFalsy()
  })

  test("an empty list is refused", async () => {
    const t = app()
    await expect(
      publishVendor(t, {
        provider: "openai",
        models: [],
        syncedAt: NOW,
        keyFingerprint: "f",
      })
    ).rejects.toThrow(/invalid model list size/)
  })
})

describe("publishing rules", () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      provider: "openai" as const,
      modelId: `gpt-7-m${i}`,
    }))

  test("shrink guard refuses under half of >= 10 rows with the same key only", async () => {
    const t = app()
    const publish = (count: number, keyFingerprint: string, syncedAt: number) =>
      publishVendor(t, {
        provider: "openai",
        models: ids(count),
        syncedAt,
        keyFingerprint,
      })
    await publish(10, "key-a", NOW)
    await expect(publish(4, "key-a", NOW + DAY)).rejects.toThrow(/less than half/)
    expect(await vendorRows(t, "openai")).toHaveLength(10)
    // Exactly half is allowed; a different key is a different account's list.
    await expect(publish(5, "key-a", NOW + DAY)).resolves.toBe(5)
    await expect(publish(1, "key-b", NOW + 2 * DAY)).resolves.toBe(1)
  })

  test("missing rows get absentSince, reappear cleared, old tombstones are deleted", async () => {
    const t = app()
    const publish = (modelIds: string[], syncedAt: number) =>
      publishVendor(t, {
        provider: "openai",
        models: modelIds.map((modelId) => ({ provider: "openai" as const, modelId })),
        syncedAt,
        keyFingerprint: "k",
      })
    await publish(["gpt-7-a", "gpt-7-b"], NOW)
    await publish(["gpt-7-a"], NOW + DAY)
    let rows = await vendorRows(t, "openai")
    expect(rows.find((row) => row.modelId === "gpt-7-b")?.absentSince).toBe(NOW + DAY)
    expect(rows.find((row) => row.modelId === "gpt-7-a")?.absentSince).toBeUndefined()

    await publish(["gpt-7-a", "gpt-7-b"], NOW + 2 * DAY)
    rows = await vendorRows(t, "openai")
    expect(rows.find((row) => row.modelId === "gpt-7-b")?.absentSince).toBeUndefined()

    await publish(["gpt-7-a"], NOW + 3 * DAY)
    // Still a tombstone just inside 180 days, deleted just beyond.
    await publish(["gpt-7-a"], NOW + 3 * DAY + 179 * DAY)
    expect(await vendorRows(t, "openai")).toHaveLength(2)
    await publish(["gpt-7-a"], NOW + 3 * DAY + 181 * DAY)
    expect((await vendorRows(t, "openai")).map((row) => row.modelId)).toEqual([
      "gpt-7-a",
    ])
  })

  test("a changed key fingerprint starts a refresh; the same key does not", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "setImmediate"] })
    vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY)
    stubFetch(() => json({ data: [] }, 500))
    const t = app()
    await t.action(internal.cms.vendorModelCatalog.ensureVendorRefresh, {})
    const first = await syncRow(t, "openai")
    expect(first?.status).toBe("running")
    // Lock holds: a second tick starts nothing.
    await t.action(internal.cms.vendorModelCatalog.ensureVendorRefresh, {})
    expect((await syncRow(t, "openai"))?.runId).toBe(first?.runId)

    // After a success with this key, the hourly tick does nothing.
    await t.mutation(internal.cms.vendorModelCatalog.publishVendorCatalog, {
      provider: "openai",
      models: ids(1),
      syncedAt: NOW,
      keyFingerprint: await hashOwnerClaim(OPENAI_KEY),
      attemptAt: first!.lastAttemptAt,
    })
    const done = await syncRow(t, "openai")
    await t.action(internal.cms.vendorModelCatalog.ensureVendorRefresh, {})
    expect((await syncRow(t, "openai"))?.runId).toBe(done?.runId)
    expect((await syncRow(t, "openai"))?.status).toBe("success")

    // A new key changes the fingerprint.
    vi.stubEnv("OPENAI_API_KEY", "another-key")
    await t.action(internal.cms.vendorModelCatalog.ensureVendorRefresh, {})
    const after = await syncRow(t, "openai")
    expect(after?.status).toBe("running")
    expect(after?.runId).not.toBe(done?.runId)
  })
})

// Round-1 review guards for the vendor lists (AI-MODELS-1b fix F).
describe("review 1b guards: vendor list storage and refresh", () => {
  const ids = (n: number, prefix = "gpt-7-m") =>
    Array.from({ length: n }, (_, i) => ({ provider: "openai" as const, modelId: `${prefix}${i}` }))

  test("#5 repeated turnover at the cap keeps refreshing; listed rows stay readable", async () => {
    const t = app()
    for (let n = 0; n < 4; n += 1) {
      await expect(
        publishVendor(t, { provider: "openai", models: ids(500, `gpt-7-t${n}-`), syncedAt: NOW + n * DAY, keyFingerprint: `k${n}` })
      ).resolves.toBe(500)
      const rows = await vendorRows(t, "openai")
      expect(rows.length).toBeLessThanOrEqual(1000)
      expect(rows.filter((row) => row.absentSince === undefined).every((row) => row.modelId.startsWith(`gpt-7-t${n}-`))).toBe(true)
    }
    // The newest turnover is kept; older tombstones went first, before 180 days.
    const tombstones = (await vendorRows(t, "openai")).filter((row) => row.absentSince !== undefined)
    expect(tombstones).toHaveLength(500)
    expect(tombstones.every((row) => row.modelId.startsWith("gpt-7-t2-"))).toBe(true)
    // An overflow left by older code (more than 2 x 500 stored) also recovers.
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i += 1) {
        await ctx.db.insert("aiVendorModels", { provider: "openai", modelId: `gpt-7-old${i}`, lifecycle: "active", absentSince: NOW - DAY, syncedAt: NOW - DAY })
      }
    })
    await expect(
      publishVendor(t, { provider: "openai", models: ids(500, "gpt-7-t4-"), syncedAt: NOW + 4 * DAY, keyFingerprint: "k4" })
    ).resolves.toBe(500)
    expect((await vendorRows(t, "openai")).length).toBeLessThanOrEqual(1000)
    const listed = (await t.run((ctx) => loadProviderCatalog(ctx, "openai"))).filter((entry) => entry.listed === "live")
    expect(listed).toHaveLength(500)
  })

  test("#6 K1 lists 20, K2 is refused, then K2 lists 5: published, not a same-key shrink", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "setImmediate"] })
    stubFetch(() => json({}, 500))
    const t = app()
    await publishVendor(t, { provider: "openai", models: ids(20), syncedAt: NOW, keyFingerprint: "k1" })
    await startAttempt(t, "openai", NOW + DAY)
    await expect(
      t.mutation(internal.cms.vendorModelCatalog.recordKeyRefused, { provider: "openai", keyFingerprint: "k2", attemptAt: NOW + DAY })
    ).resolves.toBe(true)
    const refused = (await syncRow(t, "openai"))!
    expect(refused).toMatchObject({ status: "failed", error: "key refused", keyFingerprint: "k1", refusedKeyFingerprint: "k2" })
    // Automatic refreshes skip the refused key; the owner's button retries it.
    expect(refreshDue(refused, "k2", "hourly")).toBe(false)
    expect(refreshDue(refused, "k2", "daily")).toBe(false)
    expect(refreshDue(refused, "k2", "owner")).toBe(true)
    expect(refreshDue(refused, "k3", "hourly")).toBe(true)
    await t.mutation(internal.cms.vendorModelCatalog.startVendorRefreshes, {
      trigger: "owner",
      keys: [{ provider: "openai", keyFingerprint: "k2" }],
    })
    const running = (await syncRow(t, "openai"))!
    // The lock's whole-row replace keeps both fingerprints.
    expect(running).toMatchObject({ status: "running", keyFingerprint: "k1", refusedKeyFingerprint: "k2" })
    await expect(
      t.mutation(internal.cms.vendorModelCatalog.publishVendorCatalog, {
        provider: "openai", models: ids(5), syncedAt: NOW + 2 * DAY, keyFingerprint: "k2", attemptAt: running.lastAttemptAt,
      })
    ).resolves.toBe(5)
    const after = (await syncRow(t, "openai"))!
    expect(after).toMatchObject({ status: "success", keyFingerprint: "k2" })
    expect(after.refusedKeyFingerprint).toBeUndefined()
  })

  test("#6 a legacy refused row (refused key in keyFingerprint) is read as refused, with no list key", async () => {
    const t = app()
    await publishVendor(t, { provider: "openai", models: ids(20), syncedAt: NOW, keyFingerprint: "k1" })
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("openRouterCatalogSync").withIndex("by_key", (q) => q.eq("key", "openai")).unique())!
      await ctx.db.patch("openRouterCatalogSync", row._id, { status: "failed", error: "key refused", keyFingerprint: "k2" })
    })
    const legacy = (await syncRow(t, "openai"))!
    expect(refreshDue(legacy, "k2", "hourly")).toBe(false)
    expect(refreshDue(legacy, "k2", "daily")).toBe(false)
    await expect(
      publishVendor(t, { provider: "openai", models: ids(5), syncedAt: NOW + DAY, keyFingerprint: "k2" })
    ).resolves.toBe(5)
  })

  test("#8 no query or mutation reads a key: providerKey runs only in the two action paths", () => {
    const source = Object.values(
      import.meta.glob("./cms/vendorModelCatalog.ts", { query: "?raw", import: "default", eager: true })
    )[0] as string
    const lines = source.split("\n")
    const owners: string[] = []
    lines.forEach((line, index) => {
      if (!line.includes("providerKey(") || /^function providerKey\(/.test(line)) return
      const declaration = lines
        .slice(0, index)
        .reverse()
        .find((candidate) => /^(export const|async function|function) \w+/.test(candidate))!
      owners.push(declaration)
    })
    expect(owners).toEqual([
      expect.stringMatching(/^async function detectKeysAndStart\(\s*$/),
      expect.stringMatching(/^export const fetchAndPublish = internalAction\(\{/),
    ])
    expect(source).toMatch(/async function detectKeysAndStart\(\s*ctx: ActionCtx,/)
  })

  test("#8 overlapping hourly, daily and owner entry points start one run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "setImmediate"] })
    vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY)
    stubFetch(() => json({}, 500))
    const t = app()
    await Promise.all([
      t.action(internal.cms.vendorModelCatalog.ensureVendorRefresh, {}),
      t.action(internal.cms.vendorModelCatalog.enqueueDailyRefresh, {}),
      t.action(internal.cms.vendorModelCatalog.refreshVendorCatalogsForOwner, {}),
    ])
    const first = (await syncRow(t, "openai"))!
    expect(first.status).toBe("running")
    for (const entry of [
      internal.cms.vendorModelCatalog.ensureVendorRefresh,
      internal.cms.vendorModelCatalog.enqueueDailyRefresh,
      internal.cms.vendorModelCatalog.refreshVendorCatalogsForOwner,
    ]) {
      await t.action(entry, {})
      expect((await syncRow(t, "openai"))!.runId).toBe(first.runId)
    }
    expect(await syncRow(t, "anthropic")).toBeFalsy()
  })

  test("#8 the key changes between detection and fetch: the list is stored with the fetched key", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "setImmediate"] })
    vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY)
    stubFetch(() => json({ data: [openAiRow("gpt-7-sol")] }))
    const t = app()
    await t.action(internal.cms.vendorModelCatalog.ensureVendorRefresh, {})
    const started = (await syncRow(t, "openai"))!
    vi.stubEnv("OPENAI_API_KEY", "a-newer-key")
    await expect(
      t.action(internal.cms.vendorModelCatalog.fetchAndPublish, { provider: "openai", attemptAt: started.lastAttemptAt })
    ).resolves.toEqual({ status: "published", count: 1 })
    expect((await syncRow(t, "openai"))!.keyFingerprint).toBe(await hashOwnerClaim("a-newer-key"))
  })

  test("#8 a stale run writes nothing after a newer publish: refusal, publish and completion", async () => {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY)
    const t = app()
    const stale = NOW
    const newer = NOW + 2 * 60 * 60 * 1_000
    await startAttempt(t, "openai", stale)
    // The lock expired and a newer run started and published.
    await publishVendor(t, { provider: "openai", models: ids(3), syncedAt: newer, keyFingerprint: "k-new" })
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("openRouterCatalogSync").withIndex("by_key", (q) => q.eq("key", "openai")).unique())!
      await ctx.db.patch("openRouterCatalogSync", row._id, { runId: "run-new" })
    })
    const before = (await syncRow(t, "openai"))!
    stubFetch(() => json({}, 401))
    await expect(
      t.action(internal.cms.vendorModelCatalog.fetchAndPublish, { provider: "openai", attemptAt: stale })
    ).resolves.toEqual({ status: "stale" })
    await expect(
      t.mutation(internal.cms.vendorModelCatalog.publishVendorCatalog, {
        provider: "openai", models: ids(1, "gpt-7-stale"), syncedAt: newer + 1, keyFingerprint: "k-old", attemptAt: stale,
      })
    ).resolves.toBeNull()
    await t.mutation(internal.cms.vendorModelCatalog.recordRefreshResult, {
      runId: "run-old" as RunId,
      result: { type: "failed", error: "old run failed" },
    })
    expect(await syncRow(t, "openai")).toEqual(before)
    expect((await vendorRows(t, "openai")).map((row) => row.modelId).sort()).toEqual(["gpt-7-m0", "gpt-7-m1", "gpt-7-m2"])
  })

  test("#8 a refused key: hourly and daily skip it, the owner's button retries it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "setImmediate"] })
    vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY)
    stubFetch(() => json({}, 500))
    const t = app()
    await t.run(async (ctx) => {
      await ctx.db.insert("openRouterCatalogSync", {
        key: "openai", status: "failed", lastAttemptAt: NOW, lastFailureAt: NOW,
        error: "key refused", refusedKeyFingerprint: await hashOwnerClaim(OPENAI_KEY),
      })
    })
    await t.action(internal.cms.vendorModelCatalog.ensureVendorRefresh, {})
    await t.action(internal.cms.vendorModelCatalog.enqueueDailyRefresh, {})
    expect((await syncRow(t, "openai"))!.status).toBe("failed")
    await t.action(internal.cms.vendorModelCatalog.refreshVendorCatalogsForOwner, {})
    expect((await syncRow(t, "openai"))!.status).toBe("running")
  })
})

describe("OpenRouter refresh", () => {
  test("drops :batch and rolling aliases and stores the new fields", async () => {
    stubFetch((url) => {
      expect(url).toBe(OPENROUTER_URL)
      return json({
        data: [
          openRouterFeedRow("openai/gpt-7-sol", {
            expiration_date: "2027-01-31",
            context_length: 400_000,
            top_provider: { max_completion_tokens: 128_000 },
            reasoning: {
              supported_efforts: ["low", "medium", "high", "minimal-ish"],
              default_effort: "high",
              mandatory: false,
            },
          }),
          openRouterFeedRow("openai/gpt-7-sol:batch"),
          openRouterFeedRow("~openai/gpt-latest"),
          openRouterFeedRow("openai/gpt-chat-latest"),
          openRouterFeedRow("acme/aliased", { alias_target: "acme/real" }),
        ],
      })
    })
    const t = app()
    const count = await t.action(internal.cms.openRouterCatalog.fetchAndPublish, {})
    expect(count).toBe(1)
    const rows = await t.run((ctx) => ctx.db.query("openRouterCatalogModels").take(10))
    expect(rows.map((row) => row.modelId)).toEqual(["openai/gpt-7-sol"])
    expect(rows[0]).toMatchObject({
      releasedAt: 1_790_000_000_000,
      expiresAt: Date.parse("2027-01-31T00:00:00Z"),
      vendorEfforts: ["low", "medium", "high"],
      defaultEffort: "high",
      reasoningMandatory: false,
      hasReasoning: true,
      contextLength: 400_000,
      maxOutputTokens: 128_000,
      ceilingInputPerM: 2,
      ceilingOutputPerM: 10,
    })
  })

  test("a row stored before the new fields existed still validates", async () => {
    const t = app()
    await t.run(async (ctx) => {
      await ctx.db.insert("openRouterCatalogModels", {
        modelId: "old/model",
        name: "Old",
        inputModalities: ["text"],
        structuredOutput: false,
        reasoningEfforts: [],
        syncedAt: 1,
      })
      await ctx.db.insert("openRouterCatalogSync", {
        key: "openrouter",
        status: "success",
        lastAttemptAt: 1,
      })
    })
    expect(await t.run((ctx) => ctx.db.query("openRouterCatalogModels").take(2))).toHaveLength(1)
  })
})

describe("refreshModelCatalogs", () => {
  test("is owner-only, needs the ai module, and is limited to once per five minutes", async () => {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY)
    stubFetch(() => json({}, 500))
    const t = app()
    await seedOwner(t)
    await prepareAuthSessions(t, "admin-1")
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "setImmediate"] })
    const as = (subject: string) =>
      t.withIdentity({ subject, email: `${subject}@example.test` })

    await expect(t.mutation(api.cms.vendorModelCatalog.refreshModelCatalogs, {})).rejects.toThrow(
      /UNAUTHENTICATED/
    )
    await expect(
      as("editor-1").mutation(api.cms.vendorModelCatalog.refreshModelCatalogs, {})
    ).rejects.toThrow(/CMS_OWNER_REQUIRED/)

    await as("admin-1").mutation(api.cms.vendorModelCatalog.refreshModelCatalogs, {})
    // The direct lists start in the scheduled action that reads the keys.
    expect(await syncRow(t, "openai")).toBeFalsy()
    vi.runOnlyPendingTimers()
    await t.finishInProgressScheduledFunctions()
    expect((await syncRow(t, "openrouter"))?.status).toBe("running")
    expect((await syncRow(t, "openai"))?.status).toBe("running")
    // No Anthropic key: nothing started for it.
    expect(await syncRow(t, "anthropic")).toBeFalsy()

    await expect(
      as("admin-1").mutation(api.cms.vendorModelCatalog.refreshModelCatalogs, {})
    ).rejects.toThrow()

    await t.run(async (ctx) => {
      const state = await ctx.db.query("cmsModuleState").first()
      await ctx.db.patch("cmsModuleState", state!._id, { enabledModules: [] })
    })
    await expect(
      as("admin-1").mutation(api.cms.vendorModelCatalog.refreshModelCatalogs, {})
    ).rejects.toThrow(/CMS_MODULE_DISABLED/)
  })
})

describe("loaders", () => {
  async function seedLists(t: ReturnType<typeof app>) {
    await t.run(async (ctx) => {
      for (const key of ["openai", "openrouter"] as const) {
        await ctx.db.insert("openRouterCatalogSync", {
          key,
          status: "success",
          lastAttemptAt: NOW,
          lastSuccessAt: NOW,
        })
      }
      for (const modelId of ["gpt-5.6-sol", "gpt-7-sol", "gpt-7-bare"]) {
        await ctx.db.insert("aiVendorModels", {
          provider: "openai",
          modelId,
          lifecycle: "active",
          releasedAt: NOW - DAY,
          syncedAt: NOW,
        })
      }
      const row = {
        name: "OpenAI: Test",
        inputModalities: ["text" as const],
        structuredOutput: true,
        reasoningEfforts: ["high" as const, "medium" as const, "low" as const],
        hasReasoning: true,
        vendorEfforts: ["low" as const, "medium" as const, "high" as const],
        defaultEffort: "medium" as const,
        ceilingInputPerM: 3,
        ceilingOutputPerM: 12,
        syncedAt: NOW,
      }
      await ctx.db.insert("openRouterCatalogModels", { ...row, modelId: "openai/gpt-7-sol" })
      // OpenRouter shows a different (higher) price for a committed model.
      await ctx.db.insert("openRouterCatalogModels", {
        ...row,
        modelId: "openai/gpt-5.6-sol",
        ceilingInputPerM: 4.4,
        ceilingOutputPerM: 22,
      })
    })
  }

  test("committed price wins; a new OpenAI model gets the OpenRouter ceiling", async () => {
    const t = app()
    await seedLists(t)
    const entries = await t.run((ctx) =>
      loadCatalogModels(ctx, [
        { provider: "openai", model: "gpt-5.6-sol" },
        { provider: "openai", model: "gpt-7-sol" },
        { provider: "openai", model: "gpt-7-bare" },
        { provider: "openai", model: "gpt-7-sol" },
      ])
    )
    expect(entries).toHaveLength(3)
    const [committed, fresh, bare] = entries
    expect(committed).toMatchObject({ priceSource: "committed", listed: "live" })
    expect(committed!.price).toEqual(DIRECT_PRICES["openai:gpt-5.6-sol"])
    expect(fresh).toMatchObject({
      priceSource: "openrouter",
      capabilitySource: "openrouter",
      listed: "live",
    })
    expect(fresh!.price?.outputPerM).toBe(12_000_000)
    expect(fresh!.price?.revision).toBe(`openrouter-${NOW}`)
    // Listed by OpenAI but unknown to OpenRouter: no capability, no price.
    expect(bare).toMatchObject({ capabilitySource: "none", listed: "live" })
    expect(bare!.price).toBeUndefined()

    const all = await t.run((ctx) => loadProviderCatalog(ctx, "openai"))
    expect(all.map((entry) => entry.model)).toEqual(
      expect.arrayContaining(["gpt-7-sol", "gpt-5.6-sol", "gpt-7-bare"])
    )
    // Committed models the live list no longer carries are marked absent.
    expect(all.filter((entry) => entry.listed === "absent").length).toBeGreaterThan(0)
  })

  test("with no successful sync the bundled committed list is returned", async () => {
    const t = app()
    const openai = await t.run((ctx) => loadProviderCatalog(ctx, "openai"))
    expect(openai.length).toBeGreaterThan(0)
    expect(openai.every((entry) => entry.listed === "bundled")).toBe(true)
    expect(openai.find((entry) => entry.model === "gpt-5.6-sol")?.priceSource).toBe(
      "committed"
    )
    const anthropic = await t.run((ctx) => loadProviderCatalog(ctx, "anthropic"))
    expect(anthropic.every((entry) => entry.listed === "bundled")).toBe(true)

    const openRouter = await t.run((ctx) => loadProviderCatalog(ctx, "openrouter"))
    expect(openRouter.length).toBeGreaterThan(0)
    // Step 7: the generated bundle carries ceiling prices.
    expect(openRouter.some((entry) => entry.price !== undefined)).toBe(true)
    const one = await t.run((ctx) =>
      loadCatalogModels(ctx, [{ provider: "openrouter", model: openRouter[0]!.model }])
    )
    expect(one[0]!.model).toBe(openRouter[0]!.model)
  })
})

// AI-MODELS-1b step D: Settings, saves, admission and preflight read one
// shared catalog. Fixed `now` for Settings; retirement dates sit far from
// any real clock (2023) so no result depends on when the test runs.
describe("one shared catalog for Settings, saves and runs", () => {
  const OPENROUTER_KEY = "openrouter-key-sentinel"
  const lists: { openai: unknown[]; anthropic: unknown[]; openrouter: unknown[] } = {
    openai: [],
    anthropic: [],
    openrouter: [],
  }
  const caps = {
    image_input: { supported: true },
    pdf_input: { supported: true },
    structured_outputs: { supported: true },
    effort: {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
    },
  }
  const reasoning = {
    reasoning: { supported_efforts: ["low", "medium", "high"], default_effort: "medium" },
  }

  function defaultLists() {
    lists.openai = [
      openAiRow("gpt-6.1-terra"),
      openAiRow("gpt-6.1-sol"),
      openAiRow("gpt-6-sol"),
      openAiRow("gpt-6-luna", { shutdown_date: "2023-01-01" }),
      openAiRow("gpt-7-sol", { created: 1_795_000_000 }),
      openAiRow("gpt-7-luna", { created: 1_795_000_000 }),
    ]
    lists.anthropic = [
      anthropicRow("claude-opus-5-5", {
        display_name: "Claude Opus 5.5",
        created_at: "2026-09-01T00:00:00Z",
      }),
      anthropicRow("claude-opus-6", {
        display_name: "Claude Opus 6",
        created_at: "2026-11-01T00:00:00Z",
        capabilities: caps,
      }),
      anthropicRow("claude-sonnet-6", {
        display_name: "Claude Sonnet 6",
        line: "sonnet",
        capabilities: caps,
      }),
      anthropicRow("claude-opus-4-8", {
        display_name: "Claude Opus 4.8",
        lifecycle: "retired",
      }),
    ]
    lists.openrouter = [
      openRouterFeedRow("openai/gpt-7-sol", { name: "OpenAI: GPT-7 Sol", ...reasoning }),
      openRouterFeedRow("anthropic/claude-opus-6", {
        name: "Anthropic: Claude Opus 6",
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        ...reasoning,
      }),
      openRouterFeedRow("anthropic/claude-opus-4.8", {
        name: "Anthropic: Claude Opus 4.8",
        ...reasoning,
      }),
    ]
  }

  async function refresh(t: ReturnType<typeof app>) {
    for (const provider of ["openai", "anthropic"] as const) {
      await fetchVendor(t, provider)
    }
    await t.action(internal.cms.openRouterCatalog.fetchAndPublish, {})
  }

  async function liveApp() {
    vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY)
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY)
    vi.stubEnv("OPENROUTER_API_KEY", OPENROUTER_KEY)
    defaultLists()
    stubFetch((url) =>
      url.startsWith(OPENAI_URL)
        ? json({ data: lists.openai })
        : url.startsWith(ANTHROPIC_URL)
          ? json({ data: lists.anthropic, has_more: false })
          : json({ data: lists.openrouter })
    )
    const t = app()
    await seedOwner(t)
    await prepareAuthSessions(t, "admin-1")
    await t.run(async (ctx) => {
      await ctx.db.insert("siteSettings", {
        siteName: "Test site",
        siteUrl: "https://example.test",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
      })
    })
    await refresh(t)
    const owner = t.withIdentity({ subject: "admin-1", email: "admin-1@example.test" })
    return { t, owner }
  }

  const tuple = (
    provider: "openai" | "anthropic",
    model: string,
    effort: "none" | "low" | "medium" | "high"
  ): Extract<ApiModelTuple, { mode: "catalog"; provider: "openai" | "anthropic" }> =>
    ({ mode: "catalog", provider, model, reasoning: { kind: "effort", effort } }) as Extract<
      ApiModelTuple,
      { mode: "catalog"; provider: "openai" | "anthropic" }
    >

  const admit = (
    t: ReturnType<typeof app>,
    key: string,
    provider: "openai" | "anthropic" | "openrouter",
    modelId: string
  ) =>
    t.mutation(internal.cms.ai.admitRuntimeAttempt, {
      authId: "admin-1",
      request: {
        attemptKey: key,
        provider,
        modelId,
        lane: "runtime",
        phase: "content-generation",
        profile: "editorial-copy",
        inputTokens: 100,
        imageTokens: 0,
        maxOutputTokens: 1_000,
      },
    })

  const syncedAt = (t: ReturnType<typeof app>, modelId: string) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query("openRouterCatalogModels")
          .withIndex("by_modelId", (q) => q.eq("modelId", modelId))
          .unique()
      )!.syncedAt
    )

  const writing = async (owner: Awaited<ReturnType<typeof liveApp>>["owner"]) =>
    ((await owner.query(api.cms.aiSettings.status, { now: NOW }))!).assistants.find(
      (assistant) => assistant.id === "writing"
    )!

  test("tracer: a model added after release is offered, saved, admitted and passes preflight", async () => {
    const { t, owner } = await liveApp()
    const status = (await owner.query(api.cms.aiSettings.status, { now: NOW }))!
    const choices = status.assistants.find((a) => a.id === "writing")!.choices
    expect(choices.openai.find((c) => c.model === "gpt-7-sol")).toMatchObject({
      priceSource: "openrouter",
      efforts: ["low", "medium", "high"],
    })
    expect(choices.anthropic.find((c) => c.model === "claude-opus-6")).toMatchObject({
      name: "Claude Opus 6",
      family: "Opus",
      priceSource: "openrouter",
    })
    expect(status.catalogSync).toMatchObject({
      openai: { status: "success", keyRefused: false },
      anthropic: { status: "success" },
      openrouter: { status: "success" },
    })

    for (const [provider, model, mapped] of [
      ["openai", "gpt-7-sol", "openai/gpt-7-sol"],
      ["anthropic", "claude-opus-6", "anthropic/claude-opus-6"],
    ] as const) {
      const saved = tuple(provider, model, "high")
      await owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple: saved })
      expect((await writing(owner)).effective).toEqual(saved)
      const admission = await admit(t, `tracer-${provider}`, provider, model)
      expect(admission.estimateMicros).toBeGreaterThan(0)
      expect(admission.priceRevision).toBe(`openrouter-${await syncedAt(t, mapped)}`)

      // The real prepare query hands the action its entries; preflight
      // accepts the tuple with them and a fake adapter answers.
      const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
      const catalog = catalogFromEntries(prepared.catalog)
      const resolved = resolveAssistantRuntimeTuple(prepared.assistant, {
        profile: "editorial-copy",
        phase: "content-generation",
        catalog,
      })
      expect(resolved).toEqual(saved)
      const generate = vi.fn(async () => ({
        text: "Fake answer",
        finishReason: "stop",
        actualModel: model,
        usage: { inputTokens: 1, outputTokens: 1 },
      }))
      await expect(
        executeGeneration(
          {
            target: { lane: "runtime", provider },
            tuple: resolved,
            catalogEntry: catalog.get(provider, model),
            profile: "editorial-copy",
            phase: "content-generation",
            input: { prompt: "Write one line." },
            requirements: { inputModalities: ["text"], structuredOutput: false },
            output: { kind: "text" },
          },
          { provider, generate },
          createTestAccounting()
        )
      ).resolves.toMatchObject({ text: "Fake answer" })
      expect(generate).toHaveBeenCalledOnce()
    }
  })

  test("refusals: unpriced, capability-unknown, retired, not offered and unknown effort", async () => {
    const { t, owner } = await liveApp()
    const { choices } = await writing(owner)
    const offered = [...choices.openai, ...choices.anthropic].map((c) => c.model)
    // Not offered: no capabilities (gpt-7-luna), no price (claude-sonnet-6),
    // retired (claude-opus-4-8 by lifecycle, gpt-6-luna by shutdown date),
    // and the owner's not-offered gpt-6-sol.
    for (const model of ["gpt-7-luna", "claude-sonnet-6", "claude-opus-4-8", "gpt-6-luna", "gpt-6-sol"])
      expect(offered).not.toContain(model)
    for (const saved of [
      tuple("openai", "gpt-7-luna", "high"),
      tuple("anthropic", "claude-sonnet-6", "high"),
      tuple("anthropic", "claude-opus-4-8", "high"),
      tuple("openai", "gpt-6-sol", "high"),
      tuple("openai", "gpt-6.1-sol", "none"),
    ]) {
      await expect(
        owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple: saved })
      ).rejects.toThrow("INVALID_AI_ASSISTANT_SELECTION")
    }
    await expect(admit(t, "unpriced", "anthropic", "claude-sonnet-6")).rejects.toThrow(
      "no complete price"
    )
    await expect(admit(t, "retired", "anthropic", "claude-opus-4-8")).rejects.toThrow(/retired/)
    await expect(admit(t, "shutdown", "openai", "gpt-6-luna")).rejects.toThrow(/retired/)

    // A saved not-offered model still shows as saved and is refused at run.
    const notOffered = tuple("openai", "gpt-6-sol", "high")
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", settings._id, {
        aiRuntime: { assistants: { writing: { tuple: notOffered } } },
      })
    })
    expect((await writing(owner)).effective).toEqual(notOffered)
    await expect(admit(t, "not-offered", "openai", "gpt-6-sol")).rejects.toThrow(/not-offered/)
    const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
    const catalog = catalogFromEntries(prepared.catalog)
    const generate = vi.fn()
    await expect(
      executeGeneration(
        {
          target: { lane: "runtime", provider: "openai" },
          tuple: Object.freeze({ ...notOffered, reasoning: Object.freeze({ ...notOffered.reasoning! }) }),
          catalogEntry: catalog.get("openai", "gpt-6-sol"),
          profile: "editorial-copy",
          phase: "content-generation",
          input: { prompt: "Write one line." },
          requirements: { inputModalities: ["text"], structuredOutput: false },
          output: { kind: "text" },
        },
        { provider: "openai", generate },
        createTestAccounting()
      )
    ).rejects.toMatchObject({ category: "UNSUPPORTED_CAPABILITY", attempts: 0 })
    expect(generate).not.toHaveBeenCalled()
  })

  test("guards: a saved choice survives leaving the list, defaults stay committed, a newer model is named", async () => {
    const { t, owner } = await liveApp()
    // The committed default stays the default when a newer model appears.
    expect((await writing(owner)).defaults.openai).toEqual(
      taskProfileTuple("openai", "editorial-copy")
    )

    // Saved Opus 5.5 with Opus 6 listed and newer: Settings names Opus 6.
    const opus = tuple("anthropic", "claude-opus-5-5", "high")
    await owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple: opus })
    expect((await writing(owner)).newerModel).toEqual({
      provider: "anthropic",
      model: "claude-opus-6",
      name: "Claude Opus 6",
    })

    // gpt-7-sol leaves the OpenAI list: the saved choice is kept unchanged,
    // no longer offered, and refused at admission as not listed.
    const sol = tuple("openai", "gpt-7-sol", "high")
    await owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple: sol })
    lists.openai = lists.openai.filter((row) => (row as { id: string }).id !== "gpt-7-sol")
    await refresh(t)
    const after = await writing(owner)
    expect(after.tuple).toEqual(sol)
    expect(after.effective).toEqual(sol)
    expect(after.choices.openai.map((c) => c.model)).not.toContain("gpt-7-sol")
    expect(after.defaults.openai).toEqual(taskProfileTuple("openai", "editorial-copy"))
    expect((await vendorRows(t, "openai")).find((r) => r.modelId === "gpt-7-sol")?.absentSince)
      .toEqual(expect.any(Number))
    await expect(admit(t, "absent", "openai", "gpt-7-sol")).rejects.toThrow(/not-listed/)
  })

  test("Block creator: newerModels names the newer model of the saved tuple and of each provider default", async () => {
    const { owner } = await liveApp()
    const nothingSaved = await owner.query(api.cms.aiSettings.blockCreator, { now: NOW })
    // Every entry is for a tuple the card could show, and none repeats.
    const shownTuples = (["anthropic", "openrouter", "openai"] as const)
      .flatMap((provider) => nothingSaved.defaults[provider] ?? [])
    for (const entry of nothingSaved.newerModels) {
      expect(shownTuples.some((tuple) => tuple.provider === entry.for.provider && tuple.model === entry.for.model)).toBe(true)
    }
    expect(new Set(nothingSaved.newerModels.map((entry) => `${entry.for.provider}/${entry.for.model}`)).size)
      .toBe(nothingSaved.newerModels.length)

    // Saved Opus 5.5 with Opus 6 listed and newer: the entry names Opus 6.
    const opus = tuple("anthropic", "claude-opus-5-5", "high")
    await owner.mutation(api.cms.aiSettings.setBlockCreator, { tuple: opus })
    const saved = await owner.query(api.cms.aiSettings.blockCreator, { now: NOW })
    expect(saved.newerModels).toContainEqual({
      for: { provider: "anthropic", model: "claude-opus-5-5" },
      provider: "anthropic",
      model: "claude-opus-6",
      name: "Claude Opus 6",
    })

    // Saved Opus 6 has nothing newer: no entry for it.
    await owner.mutation(api.cms.aiSettings.setBlockCreator, { tuple: tuple("anthropic", "claude-opus-6", "high") })
    const latest = await owner.query(api.cms.aiSettings.blockCreator, { now: NOW })
    expect(latest.newerModels.some((entry) => entry.for.model === "claude-opus-6")).toBe(false)
  })

  test("#1 unsaved Block creator, committed default removed: the run uses the Settings default and passes preflight", async () => {
    const { t, owner } = await liveApp()
    lists.openai = lists.openai.filter((row) => (row as { id: string }).id !== "gpt-6.1-sol")
    await refresh(t)
    const creator = await owner.query(api.cms.aiSettings.blockCreator, { now: NOW })
    expect(creator.tuple).toBeUndefined()
    const shown = creator.defaults.openai
    expect(shown).not.toBeNull()
    expect(shown).not.toEqual(taskProfileTuple("openai", "vision-spec"))
    // The action's own choice with nothing saved: the first provider with a key, no model.
    const selection = resolveBlockCreatorSelection(creator.tuple, { anthropic: false, openrouter: false, openai: true })
    expect(selection).toEqual({ provider: "openai", keyPresent: true })
    const catalog = catalogFromEntries(creator.catalog)
    for (const profile of BLOCK_CREATOR_PROFILES) {
      const resolved = resolveLocalApiTuple("openai", profile, {}, catalog, NOW)
      expect(resolved).toEqual(shown)
      const entry = catalog.get("openai", resolved.model)
      expect(refusal(entry, resolved as { reasoning?: { effort: "high" } }, NOW)).toBeNull()
      const generate = vi.fn(async () => ({
        text: "Fake answer", finishReason: "stop", actualModel: resolved.model, usage: { inputTokens: 1, outputTokens: 1 },
      }))
      await expect(
        executeGeneration(
          {
            target: { lane: "local-build", provider: "openai", engine: "openai-api" },
            tuple: resolved,
            catalogEntry: entry,
            profile,
            phase: profile === "vision-spec" ? "block-spec" : "renderer-jsx",
            input: { prompt: "Make a block." },
            requirements: { inputModalities: ["text"], structuredOutput: TASK_PROFILE_REQUIREMENTS[profile].structuredOutput },
            output: { kind: "text" },
          },
          { provider: "openai", generate },
          createTestAccounting()
        )
      ).resolves.toMatchObject({ text: "Fake answer" })
    }
  })

  test.each(["task", "site", "agent"] as const)(
    "#2 a saved %s default whose model row was removed: Settings loads and shows it; a run refuses it",
    async (source) => {
      const { t, owner } = await liveApp()
      const saved = {
        mode: "catalog", provider: "openrouter", model: "openai/gpt-7-sol",
        reasoning: { kind: "effort", effort: "high" },
      } as const
      await t.run(async (ctx) => {
        const settings = (await ctx.db.query("siteSettings").first())!
        await ctx.db.patch("siteSettings", settings._id, {
          aiRuntime: {
            selectedProvider: "openrouter",
            ...(source === "task" ? { taskDefaults: { "editorial-copy": saved } } : {}),
            ...(source === "site" ? { providerDefaults: { openrouter: saved } } : {}),
          },
        })
        if (source === "agent") {
          await ctx.db.insert("agentConfigs", { agent: "content", modelOverrides: { openrouter: saved }, updatedAt: 1 })
        }
        const row = await ctx.db.query("openRouterCatalogModels")
          .withIndex("by_modelId", (q) => q.eq("modelId", saved.model)).unique()
        await ctx.db.delete("openRouterCatalogModels", row!._id)
      })
      const shown = await writing(owner)
      expect(shown.provider).toBe("openrouter")
      expect(shown.effective).toEqual(saved)
      const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
      expect(() => resolveAssistantRuntimeTuple(prepared.assistant, {
        profile: "editorial-copy",
        phase: "content-generation",
        providerDefaults: prepared.providerDefaults ?? undefined,
        taskDefaults: prepared.taskDefaults ?? undefined,
        modelOverrides: prepared.modelOverrides ?? undefined,
        catalog: catalogFromEntries(prepared.catalog),
      })).toThrow("Unknown model or unknown model capabilities.")
    }
  )

  test.each(["~openai/gpt-latest", "openai/gpt-chat-latest", "openai/gpt-7-sol:batch"])(
    "#3 a stored %s row from before the feed filter: not offered, refused at admission",
    async (model) => {
      const { t, owner } = await liveApp()
      // The live snapshot (lastSuccessAt set) is read, not the bundle.
      expect((await syncRow(t, "openrouter"))?.lastSuccessAt).toEqual(expect.any(Number))
      await t.run(async (ctx) => {
        const row = (await ctx.db.query("openRouterCatalogModels")
          .withIndex("by_modelId", (q) => q.eq("modelId", "openai/gpt-7-sol")).unique())!
        const { _id, _creationTime, ...fields } = row
        void _id
        void _creationTime
        await ctx.db.insert("openRouterCatalogModels", { ...fields, modelId: model })
      })
      const status = (await owner.query(api.cms.aiSettings.status, { now: NOW }))!
      for (const assistant of status.assistants)
        expect(assistant.choices.openrouter.map((choice) => choice.model)).not.toContain(model)
      const [entry] = await t.run((ctx) => loadCatalogModels(ctx, [{ provider: "openrouter", model }]))
      expect(entry!.price).toBeDefined()
      expect(refusal(entry, { reasoning: { effort: "high" } }, NOW)).toBe("not-offered")
      await expect(admit(t, `alias-${model}`, "openrouter", model)).rejects.toThrow(/not-offered/)
    }
  )
})
