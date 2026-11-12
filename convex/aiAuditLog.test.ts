/// <reference types="vite/client" />
// Tests for ADR-0015 — `aiAuditLog` retention purge + per-user erasure.
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import { afterEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import schema from "./schema"
import rateLimiterTest from "@convex-dev/rate-limiter/test"

afterEach(() => vi.unstubAllEnvs())

const modules = import.meta.glob("./**/*.ts")

const DAY_MS = 24 * 60 * 60 * 1000

function rowAt(createdAt: number, authId = "u-1") {
  return {
    authId,
    kind: "page-generate-meta" as const,
    sliceCount: 0,
    modelId: "test-model",
    tokenUsage: {},
    success: true,
    createdAt,
  }
}

describe("aiAuditLog.purgeExpired — 90-day cutoff", () => {
  test("rows older than 90 days are deleted; newer rows survive", async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    await t.run(async (ctx) => {
      // Stale: 91 days old → deleted.
      await ctx.db.insert("aiAuditLog", rowAt(now - 91 * DAY_MS))
      // Edge: 89 days old → survives (cutoff is `< now - 90d`).
      await ctx.db.insert("aiAuditLog", rowAt(now - 89 * DAY_MS))
      // Fresh.
      await ctx.db.insert("aiAuditLog", rowAt(now - 1 * DAY_MS))
    })

    const deleted = await t.mutation(internal.cms.aiAuditLog.purgeExpired, {})
    expect(deleted).toBe(1)

    const remaining = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(remaining).toHaveLength(2)
    for (const row of remaining) {
      expect(now - row.createdAt).toBeLessThan(91 * DAY_MS)
    }
  })

  test("a full batch self-continues until the backlog is drained", async () => {
    vi.useFakeTimers()
    try {
      const t = convexTest(schema, modules)
      const now = Date.now()
      await t.run(async (ctx) => {
        // One row past a full batch, so a single invocation cannot finish.
        for (let i = 0; i < 501; i++) {
          await ctx.db.insert("aiAuditLog", rowAt(now - 91 * DAY_MS))
        }
        await ctx.db.insert("aiAuditLog", rowAt(now - 1 * DAY_MS))
      })

      const deleted = await t.mutation(internal.cms.aiAuditLog.purgeExpired, {})
      expect(deleted).toBe(500)
      // The full batch scheduled a continuation; run it to completion. This
      // would hang if a short batch also rescheduled (infinite loop guard).
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      const remaining = await t.run((ctx) =>
        ctx.db.query("aiAuditLog").collect()
      )
      expect(remaining).toHaveLength(1)
      expect(now - remaining[0]!.createdAt).toBeLessThan(91 * DAY_MS)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("aiAuditLog — translation actions write audit rows (AI-03)", () => {
  test("translateField records one field-translate row for the caller", async () => {
    const t = convexTest(schema, modules)
    rateLimiterTest.register(t)
    vi.stubEnv("OPENAI_API_KEY", "fake-audit-key")
    await t.run((ctx) =>
      ctx.db.insert("cmsModuleState", {
        key: "owner",
        configurationVersion: 1,
        enabledModules: ["ai", "multilingual"].map((moduleId) => ({
          moduleId,
          configVersion: 1,
        })),
      })
    )
    await seedCommunityOwner(t, {
      subject: "auth-1",
      tokenIdentifier: "https://convex.test|auth-1",
    })
    const asUser = t.withIdentity({
      subject: "auth-1",
      name: "E",
      email: "e@x.com",
    })
    // Same source/target locale short-circuits before any model call, so this
    // exercises the audit wrap without a live provider.
    const result = await asUser.action(api.agents.localizer.translateField, {
      text: "Hello",
      sourceLocale: "en",
      targetLocale: "en",
    })
    expect(result).toBe("Hello")

    const rows = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "field-translate",
      authId: "auth-1",
      success: true,
      sliceCount: 0,
    })
    expect(rows[0]!.modelId).toBeTruthy()
  })

  test("localizePage preserves optional metadata and records one page audit for a locale no-op", async () => {
    const t = convexTest(schema, modules)
    rateLimiterTest.register(t)
    vi.stubEnv("OPENAI_API_KEY", "fake-audit-key")
    await t.run((ctx) =>
      ctx.db.insert("cmsModuleState", {
        key: "owner",
        configurationVersion: 1,
        enabledModules: ["ai", "multilingual"].map((moduleId) => ({
          moduleId,
          configVersion: 1,
        })),
      })
    )
    await seedCommunityOwner(t, {
      subject: "auth-page-translate",
      tokenIdentifier: "https://convex.test|auth-page-translate",
    })
    const asUser = t.withIdentity({
      subject: "auth-page-translate",
      name: "E",
      email: "e@x.com",
    })

    const result = await asUser.action(api.agents.localizer.localizePage, {
      title: "Hello",
      metaTitle: "",
      slices: [],
      sourceLocale: "en",
      targetLocale: "en",
    })

    expect(result).toEqual({
      title: "Hello",
      metaTitle: "",
      slices: [],
      translatables: [],
    })
    expect(Object.hasOwn(result, "metaTitle")).toBe(true)
    expect(Object.hasOwn(result, "metaDescription")).toBe(false)

    const rows = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "page-translate",
      authId: "auth-page-translate",
      success: true,
      sliceCount: 0,
    })
  })
})

describe("aiAuditLog.deleteAuditLogForUser — admin-only erasure", () => {
  test("admin deletes only the target user's rows", async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    await t.run(async (ctx) => {
      await ctx.db.insert("roles", {
        authId: "admin-1",
        role: "admin",
        assignedAt: now,
      })
      await ctx.db.insert("roles", {
        authId: "editor-1",
        role: "editor",
        assignedAt: now,
      })
      await ctx.db.insert("cmsOwner", {
        key: "owner",
        authId: "admin-1",
        tokenIdentifier: "https://convex.test|admin-1",
        establishedAt: now,
        updatedAt: now,
      })
      await ctx.db.insert("aiAuditLog", rowAt(now, "victim"))
      await ctx.db.insert("aiAuditLog", rowAt(now, "victim"))
      await ctx.db.insert("aiAuditLog", rowAt(now, "bystander"))
    })

    const asAdmin = t.withIdentity({
      subject: "admin-1",
      name: "A",
      email: "a@x.com",
    })
    const deleted = await asAdmin.mutation(
      api.cms.aiAuditLog.deleteAuditLogForUser,
      { authId: "victim" }
    )
    expect(deleted).toBe(2)

    const remaining = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.authId).toBe("bystander")
  })

  test("non-admin (editor) is denied", async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert("roles", {
        authId: "admin-1",
        role: "admin",
        assignedAt: Date.now(),
      })
      await ctx.db.insert("roles", {
        authId: "editor-1",
        role: "editor",
        assignedAt: Date.now(),
      })
      await ctx.db.insert("cmsOwner", {
        key: "owner",
        authId: "admin-1",
        tokenIdentifier: "https://convex.test|admin-1",
        establishedAt: Date.now(),
        updatedAt: Date.now(),
      })
    })
    const asEditor = t.withIdentity({
      subject: "editor-1",
      name: "E",
      email: "e@x.com",
    })
    await expect(
      asEditor.mutation(api.cms.aiAuditLog.deleteAuditLogForUser, {
        authId: "victim",
      })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
  })
})

describe("aiAuditLog.recordEvent — internal writer", () => {
  test("rejects reasoning values and attempt counts outside the shared contract", async () => {
    const t = convexTest(schema, modules)
    const base = {
      authId: "u-7",
      kind: "page-generate-meta" as const,
      sliceCount: 0,
      modelId: "test-model",
      tokenUsage: {},
      success: true,
    }

    await expect(
      t.mutation(internal.cms.aiAuditLog.recordEvent, {
        ...base,
        attempts: 3 as 1,
      })
    ).rejects.toThrow(/ArgumentValidationError|Validator error/)
    await expect(
      t.mutation(internal.cms.aiAuditLog.recordEvent, {
        ...base,
        selectedReasoning: "extreme" as "medium",
      })
    ).rejects.toThrow(/ArgumentValidationError|Validator error/)
  })

  test("inserts a row with the provided fields + a fresh createdAt", async () => {
    const t = convexTest(schema, modules)
    const before = Date.now()
    await t.mutation(internal.cms.aiAuditLog.recordEvent, {
      authId: "u-7",
      kind: "page-generate-meta",
      sliceCount: 0,
      modelId: "deepseek/deepseek-v4-flash",
      selectedProvider: "openrouter",
      selectedModel: "openai/gpt-5.6-terra",
      selectedReasoning: "medium",
      actualProvider: "openrouter",
      actualModel: "openai/gpt-5.6-terra-actual",
      actualReasoning: "medium",
      routedProvider: "openai",
      phase: "page-meta",
      attempts: 1,
      tokenUsage: { promptTokens: 12, completionTokens: 34, totalTokens: 46 },
      success: true,
    })
    const rows = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.authId).toBe("u-7")
    expect(row.kind).toBe("page-generate-meta")
    expect(row.modelId).toBe("deepseek/deepseek-v4-flash")
    expect(row).toMatchObject({
      selectedProvider: "openrouter",
      selectedModel: "openai/gpt-5.6-terra",
      selectedReasoning: "medium",
      actualProvider: "openrouter",
      actualModel: "openai/gpt-5.6-terra-actual",
      actualReasoning: "medium",
      routedProvider: "openai",
      phase: "page-meta",
      attempts: 1,
    })
    expect(row.tokenUsage.totalTokens).toBe(46)
    expect(row.success).toBe(true)
    expect(row.createdAt).toBeGreaterThanOrEqual(before)
    // Privacy contract: row should NOT carry the brief text or output.
    expect(row.briefHash).toBeUndefined()
  })

  test("records failure rows with an errorCode", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.cms.aiAuditLog.recordEvent, {
      authId: "u-7",
      kind: "page-generate-meta",
      sliceCount: 0,
      modelId: "deepseek/deepseek-v4-flash",
      tokenUsage: {},
      success: false,
      errorCode: "TimeoutError",
    })
    const row = (await t.run((ctx) => ctx.db.query("aiAuditLog").collect()))[0]!
    expect(row.success).toBe(false)
    expect(row.errorCode).toBe("TimeoutError")
  })
})
