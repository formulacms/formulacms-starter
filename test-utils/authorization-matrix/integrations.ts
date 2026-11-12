import migrationsTest from "@convex-dev/migrations/test"
import { makeFunctionReference } from "convex/server"
import { expect, vi } from "vitest"
import { components } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import {
  defineRow,
  MATRIX_STATES,
  OWNER,
  type AuthorizationRow,
  type CallTarget,
  type FunctionKind,
  type MatrixState,
  type Scenario,
  type Site,
  setupModuleLanguageState,
  stateLabel,
} from "./harness"

// The source includes these paid-vendor modules; the shipped starter omits
// them. Lazy mocks let its own graph load this helper without resolving an
// excluded path. All registered action and authorization code remains real.
if (Object.keys(import.meta.glob("../../lib/ai/connection-validation.ts")).length) {
  vi.doMock("../../lib/ai/connection-validation", () => ({
    validateApiConnection: async () => ({ state: "not-configured", issue: "missing-key" }),
  }))
}
if (Object.keys(import.meta.glob("../../convex/lib/ai.ts")).length) {
  vi.doMock("../../convex/lib/ai", async () => {
    const original = await vi.importActual<Record<string, unknown>>("../../convex/lib/ai")
    return {
      ...original,
      generateRuntimeText: async (_model: unknown, options: { phase: string }) => {
      const text = options.phase === "page-outline"
        ? "[title]Matrix page[/title]\n[slug]matrix-page[/slug]\n[metaTitle]Matrix page[/metaTitle]\n[metaDescription]A matrix page.[/metaDescription]\n[outline]\n- hero-agency | Introduce the page\n[/outline]"
        : options.phase === "page-meta"
          ? "[metaTitle]Matrix page[/metaTitle]\n[metaDescription]A matrix page.[/metaDescription]"
          : "[title]Matrix text[/title]\n[description]Matrix description[/description]"
      return {
        text,
        output: text,
        selected: { lane: "runtime", provider: "openai", model: "matrix-model" },
        actual: { provider: "openai", model: "matrix-model" },
        attempts: 1,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      }
      },
    }
  })
}

type Fixture = MatrixState & {
  endpointId: Id<"webhookEndpoints">
  inviteId: Id<"invites">
}

async function seedState(t: Site, state: MatrixState): Promise<Fixture> {
  await setupModuleLanguageState(t, state)
  const { endpointId, inviteId } = await t.run(async (ctx) => {
    await ctx.db.insert("cmsMemberships", {
      authId: OWNER.subject,
      tokenIdentifier: OWNER.tokenIdentifier,
      role: "admin",
      status: "active",
      createdAt: 1,
      activatedAt: 1,
      updatedAt: 1,
      transitionId: "matrix-owner-replacement",
    })
    await ctx.db.insert("cmsMemberships", {
      authId: "target-user",
      role: "viewer",
      status: "active",
      createdAt: 1,
      activatedAt: 1,
      updatedAt: 1,
      transitionId: "matrix-target-member",
    })
    await ctx.db.insert("cmsMemberships", {
      authId: "removed-user",
      role: "viewer",
      status: "removed",
      createdAt: 1,
      activatedAt: 1,
      removedAt: 2,
      updatedAt: 2,
      transitionId: "matrix-removed-member",
    })
    await ctx.db.insert("cmsCapacity", {
      key: "cms",
      activeCount: 2,
      reservedCount: 0,
      allowance: 3,
      overCap: false,
      migrationState: "ready",
      migrationVersion: 1,
      migrationIssueCount: 0,
      lastTransitionId: "matrix-ready",
      updatedAt: 1,
    })
    const endpointId = await ctx.db.insert("webhookEndpoints", {
      url: "https://example.test/hook",
      events: ["page.published"],
      secret: "matrix-secret",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      createdBy: OWNER.tokenIdentifier,
    })
    const inviteId = await ctx.db.insert("invites", {
      email: "pending@example.test",
      role: "viewer",
      tokenHash: "matrix-unused-token-hash",
      expiresAt: Number.MAX_SAFE_INTEGER,
      invitedBy: OWNER.subject,
      createdAt: 1,
    })
    return { endpointId, inviteId }
  })
  return { ...state, endpointId, inviteId }
}

type Expected = { value: unknown } | { error: string }
type Args = (fixture: Fixture) => Record<string, unknown>

function invoke(
  actor: CallTarget,
  kind: FunctionKind,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (kind === "query") {
    return actor.query(makeFunctionReference<"query", Record<string, unknown>>(name), args)
  }
  if (kind === "mutation") {
    return actor.mutation(makeFunctionReference<"mutation", Record<string, unknown>>(name), args)
  }
  return actor.action(makeFunctionReference<"action", Record<string, unknown>>(name), args)
}

function ownerOnly(
  name: string,
  kind: FunctionKind,
  args: Args,
  owner: Expected,
  options: {
    membership?: boolean
    readOnly?: boolean
    setup?: (t: Site) => Promise<void>
    after?: (t: Site, fixture: Fixture) => Promise<void>
    teardown?: () => void
  } = {},
): AuthorizationRow {
  const scenarios: Scenario<Fixture>[] = MATRIX_STATES.map((state) => ({
    label: stateLabel(state),
    setup: async (t) => {
      const fixture = await seedState(t, state)
      await options.setup?.(t)
      return fixture
    },
    teardown: async () => { options.teardown?.() },
    call: (actor, fixture) => invoke(actor, kind, name, args(fixture)),
    outcomes: {
      owner,
      signedOut: { error: options.membership ? "Unauthenticated: sign in to continue" : "UNAUTHENTICATED" },
      unrelated: { error: options.membership ? "CMS_MEMBERSHIP_REQUIRED" : "CMS_OWNER_REQUIRED" },
      former: { error: options.membership ? "CMS_MEMBERSHIP_REQUIRED" : "CMS_OWNER_REQUIRED" },
    },
    readOnly: options.readOnly,
    after: options.after,
  }))
  return defineRow({ name, kind, scenarios })
}

async function seedActiveEmailProvider(t: Site): Promise<void> {
  await t.run((ctx) => ctx.db.insert("emailProviderState", {
    key: "owner",
    provider: { kind: "active", providerId: "resend", configuration: {} },
    sender: { address: "owner@example.test" },
    configurationVersion: 1,
    updatedAt: 1,
  }))
}

async function seedReadyInviteEmail(t: Site): Promise<void> {
  await seedActiveEmailProvider(t)
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
    JSON.stringify({ id: "matrix-resend-accepted" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ))
  vi.stubEnv("RESEND_API_KEY", "matrix-test-only-key")
}

async function assertInviteEmailDelivered(t: Site): Promise<void> {
  // The immediate retrier job must finish while the row-local fetch mock is
  // installed. Future retention jobs have no outbound transport.
  await t.finishAllScheduledFunctions(() => undefined, 40)
  expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  await t.run(async (ctx) => {
    const events = await ctx.db.query("emailDeliveryEvents").collect()
    expect(events).toEqual([expect.objectContaining({
      consumer: expect.objectContaining({ kind: "invitation" }),
      state: "provider_accepted",
    })])
    const event = events[0]
    if (!event || event.consumer.kind !== "invitation") {
      throw new Error("Missing invitation delivery event")
    }
    const invite = await ctx.db.get(event.consumer.inviteId)
    expect(invite?.deliveryState).toBe("provider_accepted")
  })
}

function restoreInviteEmail(): void {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
}

async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function inviteAcceptBudget(t: Site): Promise<number> {
  const state = await t.run((ctx) => ctx.runQuery(components.rateLimiter.lib.getValue, {
    name: "inviteAcceptGlobal",
    config: { kind: "fixed window", rate: 100, period: 60 * 60 * 1000 },
  }))
  return state.value
}

function acceptInviteRow(): AuthorizationRow {
  type InviteFixture = Fixture & {
    tokens: Map<CallTarget, { token: string; email: string }>
    inviteIds: Id<"invites">[]
    budgetBefore?: number
  }
  const scenarios: Scenario<InviteFixture>[] = MATRIX_STATES.flatMap((state) => [
    {
      label: stateLabel(state),
      setup: async (t, actors) => {
        const fixture = await seedState(t, state)
        await forbidExternalFetch()
        const recipients = [
          [actors.signedOut, "signed-out"],
          [actors.unrelated, "unrelated"],
          [actors.former, "former"],
          [actors.owner, "owner"],
        ] as const
        const tokens = new Map<CallTarget, { token: string; email: string }>()
        const inviteIds: Id<"invites">[] = []
        const expiresAt = Date.now() + 60_000
        for (const [actor, identity] of recipients) {
          const token = `matrix-accept-${state.redirects}-${state.language}-${identity}`
          const tokenHash = await hashInviteToken(token)
          const email = `${identity}-${state.redirects}-${state.language.toLowerCase()}@example.test`
          const inviteId = await t.run(async (ctx) => {
            const id = await ctx.db.insert("invites", {
              email,
              role: "viewer",
              tokenHash,
              expiresAt,
              invitedBy: OWNER.subject,
              reservationKey: `invite:${tokenHash}`,
              createdAt: Date.now(),
            })
            await ctx.db.insert("cmsSeatReservations", {
              reservationKey: `invite:${tokenHash}`,
              kind: "ordinary_invite",
              status: "active",
              inviteId: id,
              tokenHash,
              email,
              expiresAt,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              actorAuthId: OWNER.subject,
              transitionId: `matrix-invite:${tokenHash}`,
              migrationVersion: 1,
            })
            return id
          })
          tokens.set(actor, { token, email })
          inviteIds.push(inviteId)
        }
        await t.run(async (ctx) => {
          const capacity = await ctx.db.query("cmsCapacity").unique()
          await ctx.db.patch(capacity!._id, { reservedCount: 4, allowance: 2, overCap: true })
        })
        return { ...fixture, tokens, inviteIds }
      },
      call: (actor, fixture) => {
        const invite = fixture.tokens.get(actor)
        if (!invite) throw new Error("Missing actor invite fixture")
        return invoke(actor, "action", "cms/invites:acceptInvite", {
          token: invite.token, name: "Matrix Recipient", password: "MatrixSecret123!",
        })
      },
      outcomes: (fixture) => {
        const result = (actor: CallTarget) => ({ value: { ok: true, email: fixture.tokens.get(actor)!.email } })
        const byToken = [...fixture.tokens.keys()]
        return {
          signedOut: result(byToken[0]!),
          unrelated: result(byToken[1]!),
          former: result(byToken[2]!),
          owner: result(byToken[3]!),
        }
      },
      after: async (t, fixture) => {
        await t.run(async (ctx) => {
          const capacity = await ctx.db.query("cmsCapacity").unique()
          expect(capacity).toMatchObject({ activeCount: 6, reservedCount: 0, allowance: 2, overCap: true })
          for (const inviteId of fixture.inviteIds) {
            const invite = await ctx.db.get(inviteId)
            expect(invite?.usedAt).toEqual(expect.any(Number))
            const reservation = await ctx.db.query("cmsSeatReservations")
              .withIndex("by_inviteId", (q) => q.eq("inviteId", inviteId)).unique()
            expect(reservation?.status).toBe("consumed")
            expect(reservation?.successorAuthId).toEqual(expect.any(String))
            const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
              model: "user",
              where: [{ field: "email", operator: "eq", value: invite!.email }],
            })
            expect(user?._id).toBe(reservation?.successorAuthId)
            const member = await ctx.db.query("cmsMemberships")
              .withIndex("by_authId", (q) => q.eq("authId", user!._id)).unique()
            expect(member).toMatchObject({ status: "active", role: "viewer" })
          }
        })
      },
      teardown: async () => { vi.restoreAllMocks() },
    },
    {
      label: `${stateLabel(state)}/invalid-token`,
      setup: async (t) => {
        const fixture = await seedState(t, state)
        await forbidExternalFetch()
        return { ...fixture, tokens: new Map(), inviteIds: [], budgetBefore: await inviteAcceptBudget(t) }
      },
      call: (actor) => invoke(actor, "action", "cms/invites:acceptInvite", {
        token: "matrix-nonempty-invalid-token", name: "Matrix Recipient", password: "MatrixSecret123!",
      }),
      outcomes: {
        owner: { error: "INVALID_INVITE" },
        signedOut: { error: "INVALID_INVITE" },
        unrelated: { error: "INVALID_INVITE" },
        former: { error: "INVALID_INVITE" },
      },
      // The shared harness snapshots every app and writable system table on each
      // denial. The rate-limiter component deliberately consumes one unit first.
      after: async (t, fixture) => {
        expect(await inviteAcceptBudget(t)).toBe(fixture.budgetBefore! - 4)
      },
      teardown: async () => { vi.restoreAllMocks() },
    },
  ])
  return defineRow({ name: "cms/invites:acceptInvite", kind: "action", scenarios })
}

async function forbidExternalFetch(): Promise<void> {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Authorization matrix forbids external fetch")
  })
}

function aiOwnerOnly(name: string, args: Args, owner: Expected): AuthorizationRow {
  return ownerOnly(name, "action", args, name.startsWith("agents/") ? { error: "CMS_MODULE_DISABLED" } : owner, {
    setup: forbidExternalFetch,
    teardown: () => vi.restoreAllMocks(),
  })
}

function canonicalProofJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalProofJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalProofJson(record[key])}`).join(",")}}`
}

async function signMatrixLocalAudit(event: Record<string, unknown>, secret: string) {
  const auditProofExpiresAt = Date.now() + 5 * 60_000
  const payload = `v1:${auditProofExpiresAt}:${canonicalProofJson(event)}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  const auditProofSignature = Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return { ...event, auditProofExpiresAt, auditProofSignature }
}

function publicRead(
  name: string,
  args: Args,
  expected: (fixture: Fixture) => unknown,
): AuthorizationRow {
  const scenarios: Scenario<Fixture>[] = MATRIX_STATES.map((state) => ({
    label: stateLabel(state),
    setup: (t) => seedState(t, state),
    call: (actor, fixture) => invoke(actor, "query", name, args(fixture)),
    outcomes: (fixture) => ({
      owner: { value: expected(fixture) },
      signedOut: { value: expected(fixture) },
      unrelated: { value: expected(fixture) },
      former: { value: expected(fixture) },
    }),
    readOnly: true,
  }))
  return defineRow({
    name,
    kind: "query",
    scenarios,
  })
}

function publicAction(
  name: string,
  args: Args,
  expected: (fixture: Fixture) => unknown,
  readOnly = true,
): AuthorizationRow {
  const scenarios: Scenario<Fixture>[] = MATRIX_STATES.map((state) => ({
    label: stateLabel(state),
    setup: (t) => seedState(t, state),
    call: (actor, fixture) => invoke(actor, "action", name, args(fixture)),
    outcomes: (fixture) => ({
      owner: { value: expected(fixture) },
      signedOut: { value: expected(fixture) },
      unrelated: { value: expected(fixture) },
      former: { value: expected(fixture) },
    }),
    readOnly,
  }))
  return defineRow({ name, kind: "action", scenarios })
}

const noArgs: Args = () => ({})
const array = { value: expect.any(Array) }
const object = { value: expect.any(Object) }
const nullable = { value: null }
// A structurally valid, signed fixture from the repository entitlement contract.
// The generated app's built-in trust registry is empty, so install must reach
// the exact unknown-key outcome rather than fail envelope parsing first.
const MATRIX_ENTITLEMENT_ENVELOPE = '{"format":"formulacms-entitlement","envelopeVersion":1,"keyId":"test-rfc8032","claims":{"schemaVersion":1,"licenseId":"11111111-1111-4111-8111-111111111111","licensee":"Example Test Licensee","projectId":"22222222-2222-4222-8222-222222222222","product":"team","memberCapacity":7,"issuedAt":"2026-08-14T12:00:00Z"},"signature":"Rsneaim7jv8QioidSziSHzNb4hLdxi5uj0tsMYWnpUVfhlOz-Zkm8kFGfhJ_vP05Fm78SgWsnDshzfWxaXZNBA"}'

/** Integration, identity, membership, and agent surfaces. Each name is a real public registration. */
export const integrationsRows: AuthorizationRow[] = [
  ...(
    [
      ["estimatePageJob", "query"],
      ["pageJobProgress", "query"],
      ["pageJobResult", "query"],
      ["startPageJob", "mutation"],
      ["cancelPageJob", "mutation"],
      ["resumePageJob", "mutation"],
      ["acceptPageJob", "mutation"],
      ["dismissPageJob", "mutation"],
    ] as const
  ).map(([entry, kind]) =>
    defineRow({
      name: `cms/aiJobs:${entry}`,
      kind,
      scenarios: MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: async (t: Site) => {
          await seedState(t, state)
          return t.run(async (ctx) => {
            const pageId = await ctx.db.insert("pages", {
              pageType: "page",
              status: "draft",
              slug: "matrix-ai-job",
              createdAt: 1,
              updatedAt: 1,
            })
            return ctx.db.insert("aiJobs", {
              authId: OWNER.subject,
              kind: "write",
              title: "Matrix job",
              locale: "en",
              pageId,
              tuple: {
                mode: "legacy",
                provider: "openrouter",
                model: "matrix-model",
              },
              draftGeneration: 1,
              state: "canceled",
              estimateMicros: 0,
              costMicros: 0,
              createdAt: 1,
              expiresAt: Number.MAX_SAFE_INTEGER,
            })
          })
        },
        call: (actor: CallTarget, jobId: Id<"aiJobs">) =>
          invoke(
            actor,
            kind,
            `cms/aiJobs:${entry}`,
            entry === "pageJobProgress"
              ? {}
              : entry === "acceptPageJob"
                ? { jobId, chosen: [0] }
              : entry === "estimatePageJob" || entry === "startPageJob"
                ? {
                    input: {
                      kind: "write",
                      brief: "Matrix job",
                      locale: "en",
                      meta: { title: "Matrix job", slug: "matrix-job" },
                      rows: [
                        {
                          sliceType: "hero-with-image",
                          purpose: "Introduce the page",
                        },
                      ],
                    },
                  }
                : { jobId }
          ),
        outcomes: {
          owner: { error: "CMS_MODULE_DISABLED" },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
        readOnly: true,
      })),
    })
  ),
  ownerOnly(
    "lib/publishing/staging:startSliceOccurrenceUsageBackfill",
    "mutation",
    () => ({ mode: "backfill" }),
    { value: null },
    {
      setup: async (t) => {
        vi.useFakeTimers()
        migrationsTest.register(t)
      },
      teardown: () => {
        vi.clearAllTimers()
        vi.useRealTimers()
      },
    }
  ),
  ownerOnly("email:getEmailProviderSettings", "query", noArgs, object),
  ownerOnly("email:saveEmailProviderConfiguration", "mutation", () => ({
    providerId: "resend", senderAddress: "owner@example.test",
  }), object),
  ownerOnly("email:checkEmailProviderConfiguration", "action", () => ({ providerId: "resend" }), object),
  ownerOnly("email:sendTestEmail", "action", noArgs,
    { value: { status: "blocked", reason: "owner_email_missing" } }, { readOnly: true }),
  ownerOnly("email:activateEmailProvider", "mutation", () => ({ providerId: "resend" }),
    { value: { providerId: "resend", configurationVersion: 1, status: "active" } },
    { setup: seedActiveEmailProvider, readOnly: true }),
  ownerOnly("email:deactivateEmailProvider", "mutation", () => ({ providerId: "resend" }),
    { value: { providerId: "resend", configurationVersion: 2, status: "configured" } },
    { setup: seedActiveEmailProvider }),
  ownerOnly("webhooks:listEndpoints", "query", noArgs, array),
  ownerOnly("webhooks:getEndpointSecret", "query", (f) => ({ id: f.endpointId }), { value: "matrix-secret" }),
  ownerOnly("webhooks:createEndpoint", "mutation", () => ({
    url: "https://example.test/another", events: ["page.published"],
  }), { value: expect.any(String) }),
  ownerOnly("webhooks:updateEndpoint", "mutation", (f) => ({ id: f.endpointId, enabled: false }), nullable),
  ownerOnly("webhooks:removeEndpoint", "mutation", (f) => ({ id: f.endpointId }), nullable),
  ownerOnly("webhooks:listDeliveries", "query", noArgs, array),
  ownerOnly("webhooks:sendTest", "mutation", (f) => ({ id: f.endpointId }), nullable, {
    setup: async () => {
      vi.useFakeTimers()
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }))
    },
    after: async (t) => {
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
      expect(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0])).toBe("https://example.test/hook")
      expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.method).toBe("POST")
      await t.run(async (ctx) => {
        const deliveries = await ctx.db.query("webhookDeliveries").collect()
        expect(deliveries).toEqual([expect.objectContaining({
          event: "test", status: "success", attempts: 1, responseStatus: 204,
        })])
      })
    },
    teardown: () => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    },
  }),
  ownerOnly("cms/agents:listAgents", "query", noArgs, { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/agents:getContentPresets", "query", noArgs, { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/agents:updateAgent", "mutation", () => ({ agent: "content" }), { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/agents:resetAgentPresets", "mutation", () => ({ agent: "content" }), { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/ai:getModelsSettings", "query", noArgs, { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/ai:admitLocalAttempt", "mutation", () => ({ request: {
    attemptKey: "matrix-local-attempt", provider: "openai",
    modelId: "gpt-5.6-luna", lane: "local-build",
    phase: "content-generation", profile: "editorial-copy",
    inputTokens: 100, imageTokens: 0, maxOutputTokens: 100,
  } }), { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/ai:settleLocalAttempt", "mutation", () => ({
    attemptKey: "erased-attempt", outcome: "failed",
  }), nullable),
  ownerOnly("cms/aiSettings:status", "query", noArgs, { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/aiSettings:setAssistant", "mutation", () => ({ id: "writing", instructions: "Matrix" }), { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/aiSettings:sliceCreator", "query", noArgs, { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/aiSettings:setSliceCreator", "mutation", () => ({ instructions: "Matrix" }), { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/aiSettings:setMonthlyAiCap", "mutation", () => ({
    capMicros: 5_000_000,
  }), { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/aiAuditLog:deleteAuditLogForUser", "mutation", () => ({ authId: "absent-user" }), { value: 0 }),
  ownerOnly("cms/aiConnections:validateProductionConnection", "action", () => ({ provider: "openai" }), { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/aiSettings:setProductionAiConfiguration", "mutation", () => ({
    selectedProvider: "off", providerDefaults: {},
  }), { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/revalidate:getRevalidationHealth", "query", noArgs, object),
  ownerOnly("cms/revalidate:verifyContactIpProofPairing", "action", () => ({
    expiresAt: 1, signature: "invalid-proof",
  }), object),
  aiOwnerOnly("cms/revalidate:runRevalidationSelfTest", noArgs, object),
  ownerOnly("cms/invites:listInvites", "query", noArgs, array, { membership: true }),
  ownerOnly("cms/invites:cancelInvite", "mutation", (f) => ({ inviteId: f.inviteId }), nullable, { membership: true }),
  acceptInviteRow(),
  ownerOnly("cms/invites:bulkInvite", "action", () => ({ emails: [], role: "viewer" }),
    { value: { sent: [], failed: [] } }, { membership: true, readOnly: true }),
  ownerOnly("cms/invites:createInvite", "action", () => ({
    email: "new-member@example.test", role: "viewer",
  }), { value: expect.objectContaining({ ok: true, inviteId: expect.any(String), expiresAt: expect.any(Number) }) },
  { membership: true, setup: seedReadyInviteEmail, after: assertInviteEmailDelivered, teardown: restoreInviteEmail }),
  ownerOnly("cms/invites:createReplacementInvite", "action", () => ({
    outgoingAuthId: "target-user", email: "replacement@example.test",
  }), { value: expect.objectContaining({ ok: true, inviteId: expect.any(String), expiresAt: expect.any(Number) }) },
  { membership: true, setup: seedReadyInviteEmail, after: assertInviteEmailDelivered, teardown: restoreInviteEmail }),
  ownerOnly("cms/members:createMember", "action", () => ({
    email: "created@example.test", password: "MatrixSecret123!", role: "viewer",
  }), { value: expect.objectContaining({ authId: expect.any(String), created: true }) },
  { membership: true }),
  ownerOnly("cms/memberships:getCapacityStatus", "query", noArgs, object, { membership: true }),
  ownerOnly("cms/memberships:listMigrationIssues", "query", noArgs, array, { membership: true }),
  ownerOnly("cms/memberships:suspendMember", "mutation", () => ({ authId: "absent-user" }), nullable, { membership: true }),
  ownerOnly("cms/memberships:reactivateMember", "mutation", () => ({ authId: OWNER.subject }), nullable, { membership: true }),
  ownerOnly("cms/roles:listMembers", "query", noArgs, array, { membership: true }),
  ownerOnly("cms/roles:setRole", "mutation", () => ({ authId: "target-user", role: "editor" }), nullable, { membership: true }),
  ownerOnly("cms/roles:removeMember", "mutation", () => ({ authId: "removed-user" }), nullable, { membership: true }),
  ownerOnly("agents/localGeneration:preflight", "action", () => ({ kind: "field-translate" }), { error: "CMS_MODULE_DISABLED" }),
  aiOwnerOnly("agents/contentWriter:refineField", () => ({
    text: "Original copy", instruction: "Improve the copy", locale: "en", fieldLabel: "Title",
  }), { value: expect.any(String) }),
  aiOwnerOnly("agents/contentWriter:refineRichText", () => ({
    json: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Original copy" }] }] }),
    instruction: "Improve the copy", locale: "en", fieldLabel: "Body",
  }), { value: expect.any(String) }),
  aiOwnerOnly("agents/contentWriter:generateField", () => ({
    brief: "Write a short title", locale: "en", fieldLabel: "Title",
  }), { value: expect.any(String) }),
  aiOwnerOnly("agents/contentWriter:generateSlice", () => ({
    sliceType: "hero-agency", brief: "Introduce the site", locale: "en",
  }), object),
  aiOwnerOnly("agents/contentWriter:generateRichText", () => ({
    brief: "Write a short paragraph", locale: "en", fieldLabel: "Body", profile: "basic",
  }), { value: expect.any(String) }),
  aiOwnerOnly("agents/contentWriter:generatePageMeta", () => ({
    locale: "en", context: { pageTitle: "Matrix page" },
  }), object),
  aiOwnerOnly("agents/contentWriter:generatePageOutline", () => ({
    brief: "A useful matrix page", locale: "en",
  }), object),
  aiOwnerOnly("agents/contentWriter:generatePageSlice", () => ({
    sliceType: "hero-agency", pageBrief: "A useful matrix page", purpose: "Introduce the topic", locale: "en",
  }), object),
  aiOwnerOnly("agents/helpAssistant:answer", () => ({
    question: "How do I publish a page?",
  }), object),
  aiOwnerOnly("agents/localizer:translateField", () => ({
    text: "Hello", sourceLocale: "en", targetLocale: "fr",
  }), { value: expect.any(String) }),
  aiOwnerOnly("agents/localizer:translateRichText", () => ({
    json: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] }),
    sourceLocale: "en", targetLocale: "fr",
  }), { value: expect.any(String) }),
  aiOwnerOnly("agents/localizer:localizePage", () => ({
    title: "Hello", slices: [], sourceLocale: "en", targetLocale: "fr",
  }), object),
  ownerOnly("cms/entitlements:getAdminState", "query", noArgs, object),
  ownerOnly("cms/ai:isConfigured", "query", noArgs, { error: "CMS_MODULE_DISABLED" }),
  publicRead("auth:getProvidersAvailable", noArgs, () => expect.objectContaining({ google: expect.any(Boolean) })),
  publicRead("cms/roles:builtinRoles", noArgs, () => expect.any(Array)),
  publicAction("cms/passwordRecovery:requestPasswordReset", () => ({ email: "nobody@example.test" }),
    () => ({ ok: true })),
  defineRow({
    name: "cms/roles:myPermissions",
    kind: "query",
    scenarios: MATRIX_STATES.map((state): Scenario<Fixture> => ({
      label: stateLabel(state),
      setup: (t) => seedState(t, state),
      call: (actor, fixture) => invoke(actor, "query", "cms/roles:myPermissions", noArgs(fixture)),
      outcomes: {
        owner: { value: expect.objectContaining({ authId: OWNER.subject, role: "admin" }) },
        signedOut: { value: null },
        unrelated: { value: null },
        former: { value: null },
      },
      readOnly: true,
    })),
  }),
  defineRow({
    name: "cms/roles:listAssignableRoles",
    kind: "query",
    scenarios: MATRIX_STATES.map((state): Scenario<Fixture> => ({
      label: stateLabel(state),
      setup: (t) => seedState(t, state),
      call: (actor, fixture) => invoke(actor, "query", "cms/roles:listAssignableRoles", noArgs(fixture)),
      outcomes: {
        owner: array,
        signedOut: { value: [] },
        unrelated: { error: "CMS_MEMBERSHIP_REQUIRED" },
        former: { error: "CMS_MEMBERSHIP_REQUIRED" },
      },
      readOnly: true,
    })),
  }),
  defineRow({
    name: "agents/sliceAuthor:canAuthorSlices",
    kind: "query",
    scenarios: MATRIX_STATES.map((state): Scenario<Fixture> => ({
      label: stateLabel(state),
      setup: (t) => seedState(t, state),
      call: (actor, fixture) => invoke(actor, "query", "agents/sliceAuthor:canAuthorSlices", noArgs(fixture)),
      outcomes: {
        owner: { value: true },
        signedOut: { value: false },
        unrelated: { value: false },
        former: { value: false },
      },
      readOnly: true,
    })),
  }),
  ...(["install", "remove"] as const).map((operation): AuthorizationRow => {
    type EntitlementFixture = Fixture & { stateToken: string }
    return defineRow<EntitlementFixture>({
      name: `cms/entitlements:${operation}`,
      kind: "mutation",
      scenarios: MATRIX_STATES.map((state): Scenario<EntitlementFixture> => ({
        label: stateLabel(state),
        setup: async (t, actors) => {
          const fixture = await seedState(t, state)
          const current = await invoke(actors.owner, "query", "cms/entitlements:getAdminState", {})
          if (!current || typeof current !== "object" || !("stateToken" in current) ||
              typeof current.stateToken !== "string") {
            throw new Error("Owner entitlement state token was not returned")
          }
          return { ...fixture, stateToken: current.stateToken }
        },
        call: (actor, fixture) => invoke(actor, "mutation", `cms/entitlements:${operation}`, {
          operationId: operation === "install"
            ? "11111111-1111-4111-8111-111111111111"
            : "22222222-2222-4222-8222-222222222222",
          expectedStateToken: fixture.stateToken,
          ...(operation === "install" ? { rawEnvelope: MATRIX_ENTITLEMENT_ENVELOPE } : {}),
        }),
        outcomes: {
          owner: { check: (value) => {
            expect(value).toMatchObject({
              outcome: operation === "install" ? "rejected" : "unchanged",
              reason: operation === "install" ? "unknown_key" : "already_absent",
              eventId: operation === "install"
                ? "11111111-1111-4111-8111-111111111111"
                : "22222222-2222-4222-8222-222222222222",
            })
          } },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
      })),
    })
  }),
  defineRow({
    name: "agents/localGeneration:recordAudit",
    kind: "mutation",
    scenarios: MATRIX_STATES.map((state): Scenario<Fixture & { auditArgs: Record<string, unknown> }> => ({
      label: stateLabel(state),
      setup: async (t) => {
        const fixture = await seedState(t, state)
        const secret = "matrix-local-audit-proof-secret"
        vi.stubEnv("CONTACT_IP_PROOF_SECRET", secret)
        const auditArgs = await signMatrixLocalAudit({
          kind: "page-translate" as const,
          selectedEngine: "openrouter-api" as const,
          selectedReasoning: "medium" as const,
          attempts: 0 as const,
          tokenUsage: {},
          success: true,
        }, secret)
        return { ...fixture, auditArgs }
      },
      call: (actor, fixture) => invoke(actor, "mutation", "agents/localGeneration:recordAudit", fixture.auditArgs),
      outcomes: {
        owner: { value: null },
        signedOut: { error: "UNAUTHENTICATED" },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
      },
      teardown: async () => { vi.unstubAllEnvs() },
    })),
  }),
]
