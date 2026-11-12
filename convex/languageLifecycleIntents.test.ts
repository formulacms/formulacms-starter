/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ConvexError } from "convex/values"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import {
  LANGUAGE_LIFECYCLE_LEASE_MS,
  LANGUAGE_LIFECYCLE_RETRY_DELAY_MS,
} from "./cms/languageLifecycle"
import { insertLanguageLifecycleIntent } from "./lib/language/lifecycle"
import schema from "./schema"

// M05 P19a (foundation): durable lifecycle intents, the drain, status and the
// owner requeue. Adoption and return intents are proved with those commands.

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "p19a-owner",
  tokenIdentifier: "https://convex.test|p19a-owner",
}
const STRANGER = {
  subject: "p19a-stranger",
  tokenIdentifier: "https://convex.test|p19a-stranger",
}
const ORIGIN = "https://site.example.com"
const LAYOUT = "/(public)/[locale]"
const TAGS = ["cms:pages", "cms:menus", "cms:settings"]

type T = ReturnType<typeof convexTest>
type Intent = {
  _id: Id<"siteLanguageLifecycleIntents">
  operationId: string
  status: string
  phase: string
  attempts: number
  updatedAt: number
  origin?: string
  cursor?: string
  lastErrorCode?: string
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.UTC(2026, 8, 16, 12, 0, 0))
  vi.stubEnv("REVALIDATE_SECRET", "test-revalidation-secret")
  vi.stubEnv("SITE_URL", "")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ConvexError) return String(error.data)
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected the call to be refused")
}

async function site(siteUrl = ORIGIN) {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.settings.bootstrapInstallation, {
    siteName: "P19a",
    timezone: "UTC",
    defaultLocale: "en",
  })
  await t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").unique())!
    await ctx.db.patch(settings._id, { siteUrl })
  })
  await t.finishAllScheduledFunctions(vi.runAllTimers)
  return { t, owner }
}

function okFetch() {
  const fetchMock = vi.fn<
    (url: string, init: RequestInit) => Promise<Response>
  >(async () => new Response(null, { status: 204 }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function posted(fetchMock: ReturnType<typeof okFetch>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  }))
}

async function intents(t: T): Promise<Intent[]> {
  return t.run((ctx) =>
    ctx.db.query("siteLanguageLifecycleIntents").take(100)
  ) as Promise<Intent[]>
}

async function insertIntent(
  t: T,
  operationId: string,
  locales: string[] = ["en"]
) {
  await t.run((ctx) =>
    insertLanguageLifecycleIntent(ctx, {
      operationId,
      operationKind: "adopt",
      locales,
      capturedAuthorityVersion: 1,
    })
  )
  const row = (await intents(t)).find((i) => i.operationId === operationId)
  return row!._id
}

const drain = (t: T) =>
  t.action(internal.cms.languageLifecycle.drainLanguageLifecycleIntents, {})

async function moduleVersion(t: T) {
  return (
    (await t.run((ctx) => ctx.db.query("cmsModuleState").first()))
      ?.configurationVersion ?? 0
  )
}

describe("M05 P19a lifecycle intents", () => {
  test("every public-module toggle inserts exactly one intent in its commit", async () => {
    const { t, owner } = await site()
    await owner.mutation(api.cms.modules.commit, {
      expectedConfigurationVersion: 0,
      changes: [{ moduleId: "redirects", enabled: true }],
    })
    expect(await intents(t)).toMatchObject([
      {
        operationId: "module_toggle:c1",
        operationKind: "module_toggle",
        locales: ["en"],
        capturedAuthorityVersion: 1,
        phase: "tags_and_layout",
        status: "pending",
        attempts: 0,
      },
    ])

    // A no-op request commits nothing and inserts nothing.
    await owner.mutation(api.cms.modules.commit, {
      expectedConfigurationVersion: 1,
      changes: [{ moduleId: "redirects", enabled: true }],
    })
    // A stale commit refuses and inserts nothing.
    expect(
      await codeOf(
        owner.mutation(api.cms.modules.commit, {
          expectedConfigurationVersion: 0,
          changes: [{ moduleId: "redirects", enabled: false }],
        })
      )
    ).toBe("CMS_MODULE_CONFIGURATION_STALE")
    expect(await intents(t)).toHaveLength(1)

    // The intent is part of the commit: when it cannot be inserted, the
    // module state does not change either.
    await insertIntent(t, "module_toggle:c2")
    expect(
      await codeOf(
        owner.mutation(api.cms.modules.commit, {
          expectedConfigurationVersion: 1,
          changes: [{ moduleId: "redirects", enabled: false }],
        })
      )
    ).toBe("LANGUAGE_LIFECYCLE_INTENT_DUPLICATE")
    expect(await moduleVersion(t)).toBe(1)

    await t.run(async (ctx) => {
      const seeded = (await ctx.db
        .query("siteLanguageLifecycleIntents")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", "module_toggle:c2")
        )
        .unique())!
      await ctx.db.delete(seeded._id)
    })
    await owner.mutation(api.cms.modules.commit, {
      expectedConfigurationVersion: 1,
      changes: [{ moduleId: "redirects", enabled: false }],
    })
    expect((await intents(t)).map((i) => i.operationId).sort()).toEqual([
      "module_toggle:c1",
      "module_toggle:c2",
    ])
  })

  test("the drain posts exact tags and layout, then roots, and reports delivered", async () => {
    const { t, owner } = await site()
    await insertIntent(t, "adopt:v2", ["en", "fr", "de"])
    const fetchMock = okFetch()
    await drain(t)

    expect(posted(fetchMock)).toEqual([
      {
        url: `${ORIGIN}/api/revalidate`,
        body: { layoutPaths: [LAYOUT], tags: TAGS },
      },
      { url: `${ORIGIN}/api/revalidate`, body: { paths: ["/", "/fr", "/de"] } },
    ])
    expect(await intents(t)).toMatchObject([
      { status: "delivered", phase: "complete", origin: ORIGIN, attempts: 1 },
    ])
    expect(
      await owner.query(api.cms.languageLifecycle.getLanguageLifecycleStatus, {
        operationId: "adopt:v2",
      })
    ).toEqual({
      updating: false,
      notDelivered: false,
      failing: false,
      localUnreachable: false,
      oldestUndelivered: null,
      operation: {
        operationId: "adopt:v2",
        operationKind: "adopt",
        status: "delivered",
        lastErrorCode: null,
      },
    })
  })

  test("with no origin an intent ends unconfigured and is never delivered", async () => {
    const { t, owner } = await site("")
    await insertIntent(t, "adopt:v2")
    const fetchMock = okFetch()
    await drain(t)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await intents(t)).toMatchObject([
      {
        status: "unconfigured",
        phase: "tags_and_layout",
        lastErrorCode: "REVALIDATION_UNCONFIGURED",
      },
    ])
    expect(
      await owner.query(
        api.cms.languageLifecycle.getLanguageLifecycleStatus,
        {}
      )
    ).toMatchObject({
      updating: false,
      notDelivered: true,
      oldestUndelivered: { operationId: "adopt:v2", status: "unconfigured" },
    })
    // A later drain does not pick it up again.
    await drain(t)
    expect(await intents(t)).toMatchObject([{ status: "unconfigured" }])
  })

  test("a default migration intent without its migration fails closed at its path phases (ledger C3c.2b-2)", async () => {
    const { t, owner } = await site()
    // After `fr → en`: the old default `fr` is prefixed; the new default is not.
    // No `migrationId`, so `manifest_paths` has no generation to page (P19c).
    await t.run((ctx) =>
      insertLanguageLifecycleIntent(ctx, {
        operationId: "default_migration:v3",
        operationKind: "default_migration",
        locales: ["fr", "en"],
        generation: 1,
        capturedAuthorityVersion: 3,
      })
    )
    await insertIntent(t, "adopt:v4", ["en", "de"])
    const fetchMock = okFetch()
    await drain(t)

    expect(posted(fetchMock).map((call) => call.body)).toEqual([
      { layoutPaths: [LAYOUT], tags: TAGS },
      { paths: ["/", "/fr"] },
      { layoutPaths: [LAYOUT], tags: TAGS },
      { paths: ["/", "/de"] },
    ])
    const byId = Object.fromEntries(
      (await intents(t)).map((intent) => [intent.operationId, intent])
    )
    expect(byId["default_migration:v3"]).toMatchObject({
      status: "failed",
      phase: "manifest_paths",
      origin: ORIGIN,
      attempts: 1,
      lastErrorCode: "LANGUAGE_LIFECYCLE_PHASE_UNSUPPORTED",
    })
    expect(byId["adopt:v4"]).toMatchObject({
      status: "delivered",
      phase: "complete",
    })
    expect(
      await owner.query(api.cms.languageLifecycle.getLanguageLifecycleStatus, {
        operationId: "default_migration:v3",
      })
    ).toMatchObject({
      updating: true,
      operation: { status: "failed" },
    })

    // A retry resumes the same intent at its phase and still fails closed.
    vi.setSystemTime(
      byId["default_migration:v3"]!.updatedAt +
        LANGUAGE_LIFECYCLE_RETRY_DELAY_MS +
        1
    )
    await drain(t)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(
      (await intents(t)).find((i) => i.operationId === "default_migration:v3")
    ).toMatchObject({
      status: "failed",
      phase: "manifest_paths",
      attempts: 2,
    })
  })

  test("an HTTP failure retries after the delay from the failed phase", async () => {
    const { t } = await site()
    await insertIntent(t, "adopt:v2")
    const failing = vi.fn(async () => new Response(null, { status: 500 }))
    vi.stubGlobal("fetch", failing)
    await drain(t)
    expect(await intents(t)).toMatchObject([
      {
        status: "failed",
        phase: "tags_and_layout",
        lastErrorCode: "REVALIDATION_HTTP_ERROR",
        attempts: 1,
      },
    ])

    const fetchMock = okFetch()
    await drain(t)
    expect(fetchMock).not.toHaveBeenCalled()

    const [failedIntent] = await intents(t)
    vi.setSystemTime(
      failedIntent!.updatedAt + LANGUAGE_LIFECYCLE_RETRY_DELAY_MS + 1
    )
    await drain(t)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await intents(t)).toMatchObject([
      { status: "delivered", attempts: 2 },
    ])
  })

  test("claims compare-and-set on attempts, and an abandoned lease is reclaimed", async () => {
    const { t } = await site()
    const intentId = await insertIntent(t, "adopt:v2")
    const [claim] = await t.mutation(
      internal.cms.languageLifecycle.claimLanguageLifecycleIntents,
      {}
    )
    expect(claim).toEqual({ intentId, attempts: 1 })

    // Within the lease a running intent is not reclaimed.
    expect(
      await t.mutation(
        internal.cms.languageLifecycle.claimLanguageLifecycleIntents,
        {}
      )
    ).toEqual([])

    const [runningIntent] = await intents(t)
    vi.setSystemTime(runningIntent!.updatedAt + LANGUAGE_LIFECYCLE_LEASE_MS + 1)
    const [reclaimed] = await t.mutation(
      internal.cms.languageLifecycle.claimLanguageLifecycleIntents,
      {}
    )
    expect(reclaimed).toEqual({ intentId, attempts: 2 })

    // The abandoned claim can no longer advance the intent.
    expect(
      await t.mutation(
        internal.cms.languageLifecycle.advanceLanguageLifecycleIntent,
        {
          ...claim!,
          fromPhase: "tags_and_layout",
          fromCursor: null,
          origin: ORIGIN,
          nextPhase: "roots",
          nextCursor: null,
        }
      )
    ).toBe(false)
    expect(
      await t.mutation(
        internal.cms.languageLifecycle.advanceLanguageLifecycleIntent,
        {
          ...reclaimed!,
          fromPhase: "tags_and_layout",
          fromCursor: null,
          origin: ORIGIN,
          nextPhase: "roots",
          nextCursor: null,
        }
      )
    ).toBe(true)
  })

  test("a changed origin restarts every phase against the new origin", async () => {
    const { t } = await site()
    const intentId = await insertIntent(t, "adopt:v2")
    await t.run((ctx) =>
      ctx.db.patch(intentId, {
        phase: "roots",
        origin: "https://old.example.com",
      })
    )
    const fetchMock = okFetch()
    await drain(t)
    expect(posted(fetchMock).map((call) => call.url)).toEqual([
      `${ORIGIN}/api/revalidate`,
      `${ORIGIN}/api/revalidate`,
    ])
    expect(posted(fetchMock)[0]!.body).toEqual({
      layoutPaths: [LAYOUT],
      tags: TAGS,
    })
    expect(await intents(t)).toMatchObject([
      { status: "delivered", origin: ORIGIN },
    ])
  })

  test("status keeps an older failure or undelivered intent visible after newer deliveries", async () => {
    const { t, owner } = await site()
    const status = () =>
      owner.query(api.cms.languageLifecycle.getLanguageLifecycleStatus, {})

    await insertIntent(t, "adopt:v2")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 }))
    )
    await drain(t)
    vi.advanceTimersByTime(1000)
    await insertIntent(t, "return_to_single:v3")
    // The newer intent is claimed first only if the older one is still
    // inside its retry delay, so deliver it alone.
    okFetch()
    await drain(t)
    expect(
      (await intents(t)).map((i) => [i.operationId, i.status]).sort()
    ).toEqual([
      ["adopt:v2", "failed"],
      ["return_to_single:v3", "delivered"],
    ])
    expect(await status()).toMatchObject({
      updating: true,
      notDelivered: false,
    })

    const { t: other, owner: otherOwner } = await site("")
    await insertIntent(other, "adopt:v2")
    await drain(other)
    await other.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, { siteUrl: ORIGIN })
    })
    // Move the clock without firing the re-arm the first drain scheduled
    // (A1 would otherwise return the older intent to `pending`).
    vi.setSystemTime(Date.now() + 1000)
    await insertIntent(other, "module_toggle:c1")
    okFetch()
    await drain(other)
    expect(
      await otherOwner.query(
        api.cms.languageLifecycle.getLanguageLifecycleStatus,
        {}
      )
    ).toMatchObject({
      updating: false,
      notDelivered: true,
      oldestUndelivered: { operationId: "adopt:v2" },
    })
  })

  test("requeue refuses without an origin and requeues exactly 32 per call, oldest first", async () => {
    const { t, owner } = await site("")
    const requeue = () =>
      owner.mutation(
        api.cms.languageLifecycle.requeueUndeliveredLifecycleIntents,
        {}
      )
    for (let index = 0; index < 33; index += 1) {
      await insertIntent(t, `module_toggle:c${index + 1}`)
      vi.advanceTimersByTime(10)
    }
    await drain(t)
    await drain(t)
    await drain(t)
    await drain(t)
    await drain(t)
    expect(
      (await intents(t)).every((intent) => intent.status === "unconfigured")
    ).toBe(true)

    const before = await intents(t)
    // An expected state, so a structured result rather than a thrown error.
    expect(await requeue()).toEqual({
      ok: false,
      code: "REVALIDATION_UNCONFIGURED",
    })
    expect(await intents(t)).toEqual(before)

    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, { siteUrl: ORIGIN })
    })
    expect(await requeue()).toEqual({ requeued: 32, moreRemain: true })
    const afterFirst = await intents(t)
    expect(afterFirst.filter((i) => i.status === "pending")).toHaveLength(32)
    expect(afterFirst.find((i) => i.status === "unconfigured")).toMatchObject({
      operationId: "module_toggle:c33",
    })
    expect(await requeue()).toEqual({ requeued: 1, moreRemain: false })
    // Idempotent: nothing left to requeue, and pending rows are untouched.
    const settled = await intents(t)
    expect(await requeue()).toEqual({ requeued: 0, moreRemain: false })
    expect(await intents(t)).toEqual(settled)

    const fetchMock = okFetch()
    await drain(t)
    expect(fetchMock).toHaveBeenCalled()
    const delivered = (await intents(t))
      .filter((intent) => intent.status === "delivered")
      .map((intent) => intent.operationId)
    expect(delivered).toContain("module_toggle:c1")
    expect(delivered).not.toContain("module_toggle:c33")
  })

  // ─── Languages L0 (amendments A1 and A2, 2026-11-01) ──────────────────────

  const rearm = (t: T) =>
    t.mutation(
      internal.cms.languageLifecycle.rearmUndeliveredLifecycleIntents,
      {}
    )
  const lifecycleStatus = (
    owner: ReturnType<T["withIdentity"]>,
    operationId?: string
  ) =>
    owner.query(api.cms.languageLifecycle.getLanguageLifecycleStatus, {
      ...(operationId === undefined ? {} : { operationId }),
    })
  const setSiteUrl = (t: T, siteUrl: string) =>
    t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, { siteUrl })
    })
  async function undeliveredSite(count: number, siteUrl = "") {
    const made = await site(siteUrl)
    for (let index = 0; index < count; index += 1) {
      await insertIntent(made.t, `module_toggle:c${index + 1}`)
      vi.advanceTimersByTime(10)
    }
    // No origin: every drain ends the intents `unconfigured`.
    for (let pass = 0; pass < Math.ceil(count / 8) + 1; pass += 1) {
      await drain(made.t)
    }
    expect(
      (await intents(made.t)).every((i) => i.status === "unconfigured")
    ).toBe(true)
    return made
  }

  test("A1: the re-arm returns 33 unconfigured intents as 32 then 1, oldest first", async () => {
    const { t } = await undeliveredSite(33)
    await setSiteUrl(t, ORIGIN)

    expect(await rearm(t)).toEqual({ requeued: 32, moreRemain: false })
    const afterFirst = await intents(t)
    expect(afterFirst.filter((i) => i.status === "pending")).toHaveLength(32)
    expect(afterFirst.filter((i) => i.status === "pending")).toSatisfy(
      (rows: Intent[]) =>
        rows.every((i) => i.origin === ORIGIN && i.phase === "tags_and_layout")
    )
    expect(afterFirst.find((i) => i.status === "unconfigured")).toMatchObject({
      operationId: "module_toggle:c33",
    })
    expect(await rearm(t)).toEqual({ requeued: 1, moreRemain: false })
    // Idempotent over rows that are already pending.
    const settled = await intents(t)
    expect(await rearm(t)).toEqual({ requeued: 0, moreRemain: false })
    expect(await intents(t)).toEqual(settled)
  })

  test("A1: the drain schedules the re-arm, which schedules the next drain while more remain", async () => {
    const { t } = await undeliveredSite(33)
    await setSiteUrl(t, ORIGIN)
    const fetchMock = okFetch()

    await drain(t)
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const rows = await intents(t)
    expect(rows.some((i) => i.status === "unconfigured")).toBe(false)
    expect(fetchMock).toHaveBeenCalled()
    const delivered = rows.filter((i) => i.status === "delivered")
    expect(delivered.length).toBeGreaterThanOrEqual(8)
    // Delivery to the oldest intent happened without the owner pushing.
    expect(delivered.map((i) => i.operationId)).toContain("module_toggle:c1")
  })

  test("A1: nothing re-arms with no origin, and the drain schedules nothing without the shared code", async () => {
    const { t } = await undeliveredSite(2)
    const before = await intents(t)
    expect(await rearm(t)).toEqual({ requeued: 0, moreRemain: false })
    expect(await intents(t)).toEqual(before)

    // An address without the shared code is still no origin.
    await setSiteUrl(t, ORIGIN)
    vi.stubEnv("REVALIDATE_SECRET", "")
    expect(await rearm(t)).toEqual({ requeued: 0, moreRemain: false })
    expect(await intents(t)).toEqual(before)
    const fetchMock = okFetch()
    await drain(t)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await intents(t)).toEqual(before)
  })

  test("A1: an origin from the settings and one from the environment both re-arm", async () => {
    const fromSettings = await undeliveredSite(1)
    await setSiteUrl(fromSettings.t, ORIGIN)
    expect(await rearm(fromSettings.t)).toEqual({
      requeued: 1,
      moreRemain: false,
    })
    expect(await intents(fromSettings.t)).toMatchObject([
      { status: "pending", origin: ORIGIN },
    ])

    const fromEnv = await undeliveredSite(1)
    vi.stubEnv("SITE_URL", "https://env.example.com/")
    expect(await rearm(fromEnv.t)).toEqual({ requeued: 1, moreRemain: false })
    expect(await intents(fromEnv.t)).toMatchObject([
      { status: "pending", origin: "https://env.example.com" },
    ])
  })

  test("A2: only the current language version raises the notice; the operation status still reports an older one", async () => {
    const { t, owner } = await undeliveredSite(0)
    await insertIntent(t, "adopt:v2") // captured version 1
    await drain(t)
    expect((await intents(t))[0]).toMatchObject({ status: "unconfigured" })

    // While version 1 is current the intent raises the notice.
    expect(await lifecycleStatus(owner)).toMatchObject({
      notDelivered: true,
      oldestUndelivered: { operationId: "adopt:v2" },
    })

    // A later language change makes version 2 current.
    await t.run(async (ctx) => {
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(authority._id, { version: 2 })
    })
    expect(await lifecycleStatus(owner)).toMatchObject({
      notDelivered: false,
      oldestUndelivered: null,
    })
    expect(await lifecycleStatus(owner, "adopt:v2")).toMatchObject({
      notDelivered: false,
      operation: { operationId: "adopt:v2", status: "unconfigured" },
    })

    await t.run((ctx) =>
      insertLanguageLifecycleIntent(ctx, {
        operationId: "add:v3",
        operationKind: "add",
        locales: ["en"],
        capturedAuthorityVersion: 2,
      })
    )
    await drain(t)
    expect(await lifecycleStatus(owner)).toMatchObject({
      notDelivered: true,
      oldestUndelivered: { operationId: "add:v3", status: "unconfigured" },
    })
  })

  test("A2: a current-version intent failed after its third attempt is a lasting failure", async () => {
    const { t, owner } = await site()
    const intentId = await insertIntent(t, "adopt:v2")
    const fail = (attempts: number, capturedAuthorityVersion = 1) =>
      t.run((ctx) =>
        ctx.db.patch(intentId, {
          status: "failed",
          attempts,
          capturedAuthorityVersion,
          lastErrorCode: "REVALIDATION_HTTP_ERROR",
        })
      )
    await fail(2)
    expect(await lifecycleStatus(owner)).toMatchObject({
      updating: true,
      failing: false,
    })
    await fail(3)
    expect(await lifecycleStatus(owner)).toMatchObject({ failing: true })
    // An older version's failure keeps `updating` but is not a lasting alarm.
    await fail(3, 0)
    expect(await lifecycleStatus(owner)).toMatchObject({
      updating: true,
      failing: false,
    })
  })

  test("A2: a failed delivery to a local origin ends quiet; only Push or an origin change re-arms it", async () => {
    const local = "http://localhost:3000"
    const { t, owner } = await site(local)
    await insertIntent(t, "adopt:v2")
    // A fresh intent stores no origin until its first attempt.
    expect((await intents(t))[0]!.origin).toBeUndefined()
    // A network error: the fetch throws, no HTTP response comes back.
    const failing = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED")
    })
    vi.stubGlobal("fetch", failing)
    await drain(t)
    // The re-arm the drain scheduled leaves the fresh failure alone: the
    // attempted origin was stored and equals the current one.
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    // Delivery was attempted to the local origin.
    expect(failing).toHaveBeenCalledWith(
      `${local}/api/revalidate`,
      expect.anything()
    )
    expect(await intents(t)).toMatchObject([
      {
        status: "local_unreachable",
        origin: local,
        lastErrorCode: "REVALIDATION_NETWORK_ERROR",
        attempts: 1,
      },
    ])
    // Never delivered, never an alarm.
    expect(await lifecycleStatus(owner)).toMatchObject({
      updating: false,
      notDelivered: false,
      failing: false,
      localUnreachable: true,
    })

    // The automatic re-arm and the drain leave it alone, even after a while.
    vi.advanceTimersByTime(LANGUAGE_LIFECYCLE_RETRY_DELAY_MS * 3)
    expect(await rearm(t)).toEqual({ requeued: 0, moreRemain: false })
    await drain(t)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(failing).toHaveBeenCalledTimes(1)
    expect(await intents(t)).toMatchObject([{ status: "local_unreachable" }])

    // A changed origin re-arms it automatically.
    await setSiteUrl(t, "http://localhost:3001")
    expect(await rearm(t)).toEqual({ requeued: 1, moreRemain: false })
    expect(await intents(t)).toMatchObject([
      { status: "pending", origin: "http://localhost:3001" },
    ])

    // "Push updates now" re-arms it with the same origin, and a reachable
    // local origin delivers.
    await drain(t)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await intents(t)).toMatchObject([{ status: "local_unreachable" }])
    expect(
      await owner.mutation(
        api.cms.languageLifecycle.requeueUndeliveredLifecycleIntents,
        {}
      )
    ).toEqual({ requeued: 1, moreRemain: false })
    const fetchMock = okFetch()
    await drain(t)
    expect(fetchMock).toHaveBeenCalled()
    expect(await intents(t)).toMatchObject([{ status: "delivered" }])
  })

  test.each([401, 500])(
    "A2: an HTTP %i from a local origin fails (not quiet), keeps its origin, and is retried by the drain",
    async (httpStatus) => {
      const local = "http://localhost:3000"
      const { t, owner } = await site(local)
      await insertIntent(t, "adopt:v2", ["en", "fr"])
      // The first purge (tags and layout) succeeds, which stores the origin;
      // the second (roots) is answered with an HTTP error.
      let calls = 0
      const rejecting = vi.fn(async () =>
        ++calls === 1
          ? new Response(null, { status: 204 })
          : new Response(null, { status: httpStatus })
      )
      vi.stubGlobal("fetch", rejecting)
      await drain(t)
      await t.finishAllScheduledFunctions(vi.runAllTimers)

      expect(rejecting).toHaveBeenCalledTimes(2)
      expect(await intents(t)).toMatchObject([
        {
          status: "failed",
          phase: "roots",
          origin: local,
          lastErrorCode: "REVALIDATION_HTTP_ERROR",
          attempts: 1,
        },
      ])
      expect(await lifecycleStatus(owner)).toMatchObject({
        updating: true,
        localUnreachable: false,
      })

      // Inside the retry delay the drain leaves it alone.
      const okMock = okFetch()
      await drain(t)
      expect(okMock).not.toHaveBeenCalled()

      // After the delay the drain reclaims it and, now reachable, delivers
      // the remaining purge to the same origin.
      const [failedIntent] = await intents(t)
      vi.setSystemTime(
        failedIntent!.updatedAt + LANGUAGE_LIFECYCLE_RETRY_DELAY_MS + 1
      )
      await drain(t)
      expect(posted(okMock)).toEqual([
        { url: `${local}/api/revalidate`, body: { paths: ["/", "/fr"] } },
      ])
      expect(await intents(t)).toMatchObject([
        { status: "delivered", origin: local, attempts: 2 },
      ])
    }
  )

  describe("A1/A2: an intent that failed after its first phase starts over and ends delivered", () => {
    const local = "http://localhost:3000"
    // The first purge (tags and layout) succeeds; the second (roots) fails
    // against a local origin: the intent ends quiet at `roots`, origin stored.
    async function quietAtRoots() {
      const { t, owner } = await site(local)
      await insertIntent(t, "adopt:v2", ["en", "fr"])
      let calls = 0
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          // The second POST (roots) has no HTTP response: a network error.
          if (++calls === 1) return new Response(null, { status: 204 })
          throw new Error("connect ECONNREFUSED")
        })
      )
      await drain(t)
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      expect(await intents(t)).toMatchObject([
        {
          status: "local_unreachable",
          phase: "roots",
          origin: local,
          lastErrorCode: "REVALIDATION_NETWORK_ERROR",
        },
      ])
      // A stale cursor must not survive a re-arm.
      await t.run(async (ctx) => {
        const [row] = await ctx.db.query("siteLanguageLifecycleIntents").take(1)
        await ctx.db.patch(row!._id, { cursor: "stale-cursor" })
      })
      return { t, owner }
    }
    const expectBothPurges = (
      fetchMock: ReturnType<typeof okFetch>,
      origin: string
    ) =>
      expect(posted(fetchMock)).toEqual([
        {
          url: `${origin}/api/revalidate`,
          body: { layoutPaths: [LAYOUT], tags: TAGS },
        },
        { url: `${origin}/api/revalidate`, body: { paths: ["/", "/fr"] } },
      ])

    test("Push re-arms it at tags_and_layout, then both purges are posted", async () => {
      const { t, owner } = await quietAtRoots()
      expect(
        await owner.mutation(
          api.cms.languageLifecycle.requeueUndeliveredLifecycleIntents,
          {}
        )
      ).toEqual({ requeued: 1, moreRemain: false })
      const [rearmed] = await intents(t)
      expect(rearmed).toMatchObject({
        status: "pending",
        phase: "tags_and_layout",
        origin: local,
      })
      expect(rearmed!.cursor).toBeUndefined()

      const fetchMock = okFetch()
      await drain(t)
      expectBothPurges(fetchMock, local)
      expect(await intents(t)).toMatchObject([
        { status: "delivered", phase: "complete" },
      ])
    })

    test("the automatic re-arm after an origin change does the same", async () => {
      const { t } = await quietAtRoots()
      const changed = "http://localhost:3001"
      await setSiteUrl(t, changed)
      expect(await rearm(t)).toEqual({ requeued: 1, moreRemain: false })
      const [rearmed] = await intents(t)
      expect(rearmed).toMatchObject({
        status: "pending",
        phase: "tags_and_layout",
        origin: changed,
      })
      expect(rearmed!.cursor).toBeUndefined()

      const fetchMock = okFetch()
      await drain(t)
      expectBothPurges(fetchMock, changed)
      expect(await intents(t)).toMatchObject([
        { status: "delivered", phase: "complete" },
      ])
    })
  })

  test("A2: Push updates now takes one status per call, unconfigured first, then local_unreachable", async () => {
    const { t, owner } = await site("")
    const push = () =>
      owner.mutation(
        api.cms.languageLifecycle.requeueUndeliveredLifecycleIntents,
        {}
      )
    await insertIntent(t, "adopt:v2")
    await insertIntent(t, "module_toggle:c1")
    await drain(t)
    // A quiet local intent, as a failed local delivery leaves it.
    await t.run(async (ctx) => {
      const [first] = await ctx.db.query("siteLanguageLifecycleIntents").take(1)
      await ctx.db.patch(first!._id, {
        status: "local_unreachable",
        origin: "http://localhost:3000",
      })
    })
    await setSiteUrl(t, ORIGIN)

    const statuses = async () => (await intents(t)).map((i) => i.status).sort()
    expect(await statuses()).toEqual(["local_unreachable", "unconfigured"])
    // First call: only the unconfigured intent; the quiet one waits behind it.
    expect(await push()).toEqual({ requeued: 1, moreRemain: true })
    expect(await statuses()).toEqual(["local_unreachable", "pending"])
    // Next call: none unconfigured remain, so the local one.
    expect(await push()).toEqual({ requeued: 1, moreRemain: false })
    expect(await statuses()).toEqual(["pending", "pending"])
    expect(await push()).toEqual({ requeued: 0, moreRemain: false })
  })

  test("A1/A2: the re-arm takes 32 in all, unconfigured first, then local intents of another origin", async () => {
    const { t } = await undeliveredSite(30)
    // Quiet local intents: below, above, and equal to the current origin, and
    // one with no stored origin (never read).
    await t.run(async (ctx) => {
      for (const [operationId, origin] of [
        ["add:below", "http://localhost:3000"],
        ["add:above", "https://zzz.example.com"],
        ["add:same", ORIGIN],
        ["add:none", undefined],
      ] as const) {
        await insertLanguageLifecycleIntent(ctx, {
          operationId,
          operationKind: "add",
          locales: ["en"],
          capturedAuthorityVersion: 1,
        })
        const row = (await ctx.db
          .query("siteLanguageLifecycleIntents")
          .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
          .unique())!
        await ctx.db.patch(row._id, { status: "local_unreachable", origin })
      }
    })
    await setSiteUrl(t, ORIGIN)

    // 30 unconfigured + the two other-origin local ones = 32; the intent on
    // the current origin and the one with no origin are never touched.
    expect(await rearm(t)).toEqual({ requeued: 32, moreRemain: false })
    const rows = await intents(t)
    expect(rows.filter((i) => i.status === "pending")).toHaveLength(32)
    for (const operationId of ["add:below", "add:above"]) {
      expect(rows.find((i) => i.operationId === operationId)).toMatchObject({
        status: "pending",
        origin: ORIGIN,
      })
    }
    for (const operationId of ["add:same", "add:none"]) {
      expect(rows.find((i) => i.operationId === operationId)).toMatchObject({
        status: "local_unreachable",
      })
    }
    expect(await rearm(t)).toEqual({ requeued: 0, moreRemain: false })
  })

  test("A2: a network error to a private address also ends quiet", async () => {
    const { t } = await site("http://192.168.1.20:3000")
    await insertIntent(t, "adopt:v2")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED")
      })
    )
    await drain(t)
    expect(await intents(t)).toMatchObject([
      {
        status: "local_unreachable",
        origin: "http://192.168.1.20:3000",
        lastErrorCode: "REVALIDATION_NETWORK_ERROR",
      },
    ])
  })

  test("B1: Push updates now also requeues failed intents, keeps running claims and stays bounded", async () => {
    const { t, owner } = await site(ORIGIN)
    const push = () =>
      owner.mutation(
        api.cms.languageLifecycle.requeueUndeliveredLifecycleIntents,
        {}
      )
    await insertIntent(t, "adopt:v2")
    await insertIntent(t, "module_toggle:c1")
    await insertIntent(t, "module_toggle:c2")
    const [failedId, runningId, pendingId] = (await intents(t)).map((i) => i._id)
    await t.run(async (ctx) => {
      await ctx.db.patch(failedId!, {
        status: "failed",
        attempts: 3,
        phase: "roots",
        lastErrorCode: "REVALIDATION_HTTP_ERROR",
      })
      await ctx.db.patch(runningId!, { status: "running", attempts: 1 })
    })
    const runningBefore = (await intents(t)).find((i) => i._id === runningId)

    expect(await push()).toEqual({ requeued: 1, moreRemain: false })
    const after = await intents(t)
    // The failed intent restarts from its first phase; the running claim and
    // the pending row are not touched.
    expect(after.find((i) => i._id === failedId)).toMatchObject({
      status: "pending",
      phase: "tags_and_layout",
      origin: ORIGIN,
      attempts: 3,
    })
    expect(after.find((i) => i._id === runningId)).toEqual(runningBefore)
    expect(after.find((i) => i._id === pendingId)?.status).toBe("pending")
    // Idempotent once nothing failed remains.
    expect(await push()).toEqual({ requeued: 0, moreRemain: false })

    // One status per call: unconfigured, then failed, then local_unreachable.
    await t.run(async (ctx) => {
      await ctx.db.patch(failedId!, { status: "failed" })
      await ctx.db.patch(pendingId!, { status: "unconfigured" })
      await ctx.db.patch(runningId!, {
        status: "local_unreachable",
        origin: "http://localhost:3000",
      })
    })
    expect(await push()).toEqual({ requeued: 1, moreRemain: true })
    expect(await push()).toEqual({ requeued: 1, moreRemain: true })
    expect(await push()).toEqual({ requeued: 1, moreRemain: false })
  })

  test("B1: the failed requeue takes 32 per call", async () => {
    const { t, owner } = await site(ORIGIN)
    for (let index = 0; index < 33; index += 1) {
      await insertIntent(t, `module_toggle:c${index + 1}`)
    }
    await t.run(async (ctx) => {
      for (const row of await ctx.db
        .query("siteLanguageLifecycleIntents")
        .take(40)) {
        await ctx.db.patch(row._id, { status: "failed", attempts: 3 })
      }
    })
    const push = () =>
      owner.mutation(
        api.cms.languageLifecycle.requeueUndeliveredLifecycleIntents,
        {}
      )
    expect(await push()).toEqual({ requeued: 32, moreRemain: true })
    expect(await push()).toEqual({ requeued: 1, moreRemain: false })
  })

  test("status and requeue are owner-only and write nothing for anyone else", async () => {
    const { t } = await site()
    await insertIntent(t, "adopt:v2")
    const before = await intents(t)
    for (const caller of [t, t.withIdentity(STRANGER)]) {
      await expect(
        caller.query(api.cms.languageLifecycle.getLanguageLifecycleStatus, {})
      ).rejects.toThrow()
      await expect(
        caller.mutation(
          api.cms.languageLifecycle.requeueUndeliveredLifecycleIntents,
          {}
        )
      ).rejects.toThrow()
    }
    expect(await intents(t)).toEqual(before)
  })
})
