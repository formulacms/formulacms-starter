import migrationsTest from "@convex-dev/migrations/test"
import { makeFunctionReference } from "convex/server"
import { expect, vi } from "vitest"
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
}

async function seedState(t: Site, state: MatrixState): Promise<Fixture> {
  await setupModuleLanguageState(t, state)
  const { endpointId } = await t.run(async (ctx) => {
    const endpointId = await ctx.db.insert("webhookEndpoints", {
      url: "https://example.test/hook",
      events: ["page.published"],
      secret: "matrix-secret",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      createdBy: OWNER.tokenIdentifier,
    })
    return { endpointId }
  })
  return { ...state, endpointId }
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

const noArgs: Args = () => ({})
const array = { value: expect.any(Array) }
const object = { value: expect.any(Object) }
const nullable = { value: null }
// A structurally valid, signed fixture from the repository entitlement contract.
// The generated app's built-in trust registry is empty, so install must reach
// the exact unknown-key outcome rather than fail envelope parsing first.
const MATRIX_ENTITLEMENT_ENVELOPE = '{"format":"formulacms-entitlement","envelopeVersion":1,"keyId":"test-rfc8032","claims":{"schemaVersion":1,"licenseId":"11111111-1111-4111-8111-111111111111","licensee":"Example Test Licensee","projectId":"22222222-2222-4222-8222-222222222222","product":"team","memberCapacity":7,"issuedAt":"2026-08-14T12:00:00Z"},"signature":"Rsneaim7jv8QioidSziSHzNb4hLdxi5uj0tsMYWnpUVfhlOz-Zkm8kFGfhJ_vP05Fm78SgWsnDshzfWxaXZNBA"}'

const MATRIX_RUNNER_SECRET = "A".repeat(43)
const MATRIX_SECRET_HASH = "a".repeat(64)
/**
 * The local whole-page job functions (AI-LOCAL-2). Start and Resume are owner
 * session calls behind the AI module gate. The runner calls carry no session
 * (a tool run outlives the access token) and prove themselves with the job's
 * runner secret, so every actor, signed in or not, gets the same refusal for a
 * secret that does not match.
 */
function localJobRows(): AuthorizationRow[] {
  const route = { engine: "claude", model: "matrix-model", effort: "high" } as const
  const input = {
    kind: "write",
    brief: "Matrix job",
    locale: "en",
    meta: { title: "Matrix job", slug: "matrix-job" },
    rows: [{ sliceType: "hero-with-image", purpose: "Introduce the page" }],
  }
  const seedLocalJob = async (t: Site, state: MatrixState) => {
    await seedState(t, state)
    return t.run(async (ctx) => {
      const pageId = await ctx.db.insert("pages", {
        pageType: "page", status: "draft", slug: "matrix-local-job", createdAt: 1, updatedAt: 1,
      })
      const jobId = await ctx.db.insert("aiJobs", {
        authId: OWNER.subject, kind: "write", title: "Matrix job", locale: "en", pageId,
        localRoute: route,
        runner: { secretHash: MATRIX_SECRET_HASH, leaseExpiresAt: Number.MAX_SAFE_INTEGER },
        draftGeneration: 1, state: "canceled", estimateMicros: 0, costMicros: 0,
        createdAt: 1, expiresAt: Number.MAX_SAFE_INTEGER,
      })
      const unitId = await ctx.db.insert("aiJobUnits", {
        authId: OWNER.subject, jobId, index: 0, kind: "write", state: "inProgress",
        reused: false, costMicros: 0, attemptKeys: [], claimToken: "matrix-claim",
      })
      return { jobId, unitId }
    })
  }
  type Local = { jobId: Id<"aiJobs">; unitId: Id<"aiJobUnits"> }
  const sessionRow = (
    entry: "startLocalPageJob" | "resumeLocalPageJob",
    args: (fixture: Local) => Record<string, unknown>
  ) =>
    defineRow({
      name: `cms/aiLocalJobs:${entry}`,
      kind: "mutation",
      scenarios: MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => seedLocalJob(t, state),
        call: (actor: CallTarget, fixture: Local) =>
          invoke(actor, "mutation", `cms/aiLocalJobs:${entry}`, args(fixture)),
        outcomes: {
          owner: { error: "CMS_MODULE_DISABLED" },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
        readOnly: true,
      })),
    })
  const runnerRow = (
    entry: string,
    extra: (fixture: Local) => Record<string, unknown>,
    refusal: unknown,
    kind: "mutation" | "query" = "mutation"
  ) =>
    defineRow({
      name: `cms/aiLocalJobs:${entry}`,
      kind,
      scenarios: MATRIX_STATES.map((state) => {
        const outcome = { value: refusal }
        return {
          label: stateLabel(state),
          setup: (t: Site) => seedLocalJob(t, state),
          call: (actor: CallTarget, fixture: Local) =>
            invoke(actor, kind, `cms/aiLocalJobs:${entry}`, {
              jobId: fixture.jobId, runnerSecret: MATRIX_RUNNER_SECRET, ...extra(fixture),
            }),
          outcomes: { owner: outcome, signedOut: outcome, unrelated: outcome, former: outcome },
          readOnly: true,
        }
      }),
    })
  const claimArgs = (fixture: Local) => ({
    unitId: fixture.unitId, claimToken: "matrix-claim",
  })
  const audit = { funding: "plan" }
  return [
    sessionRow("startLocalPageJob", () => ({
      input, localRoute: route, runnerSecretHash: MATRIX_SECRET_HASH,
    })),
    sessionRow("resumeLocalPageJob", (fixture) => ({
      jobId: fixture.jobId, kind: "write", runnerSecretHash: MATRIX_SECRET_HASH,
    })),
    runnerRow("localClaimUnit", () => ({}), { kind: "refused" }),
    runnerRow("localHeartbeat", () => ({}), { keepGoing: false }),
    runnerRow("localJobState", () => ({}), { keepGoing: false }, "query"),
    runnerRow("localSaveUnit", (f) => ({ ...claimArgs(f), text: "x", audit }), { kind: "refused" }),
    runnerRow("localFailUnit", (f) => ({
      ...claimArgs(f), errorCategory: "LOCAL_PROCESS_FAILED", audit,
    }), { kind: "refused" }),
    runnerRow("localReleaseUnit", (f) => ({ ...claimArgs(f) }), { kind: "refused" }),
  ]
}

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
          // pageJobProgress answers an empty list while AI is off; the owner check still refuses others.
          owner:
            entry === "pageJobProgress"
              ? { value: [] }
              : { error: "CMS_MODULE_DISABLED" },
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
    senderAddress: "owner@example.test",
  }), { value: { enabledProviderId: null, configurationVersion: 1, status: "disabled" } }),
  ownerOnly("email:checkEmailProviderConfiguration", "action", () => ({ providerId: "resend" }), object),
  ownerOnly("email:sendTestEmail", "action", noArgs,
    { value: { status: "blocked", reason: "owner_email_missing" } }, { readOnly: true }),
  ownerOnly("email:enableEmailProvider", "mutation", () => ({ providerId: "resend" }),
    { value: { enabledProviderId: "resend", configurationVersion: 1, status: "inactive" } }),
  ownerOnly("email:disableEmailProvider", "mutation", () => ({ providerId: "resend" }),
    { value: { enabledProviderId: null, configurationVersion: 2, status: "disabled" } },
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
  ownerOnly("cms/aiSettings:status", "query", noArgs, nullable),
  ownerOnly("cms/aiSettings:setAssistant", "mutation", () => ({ id: "writing", instructions: "Matrix" }), { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/aiSettings:setAssistantLocalTool", "mutation", () => ({ assistant: "writing", on: true }), { error: "CMS_MODULE_DISABLED" }),
  ...localJobRows(),
  ownerOnly("cms/aiSettings:sliceCreator", "query", noArgs, { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/aiSettings:setSliceCreator", "mutation", () => ({ instructions: "Matrix" }), { error: "CMS_MODULE_DISABLED" }),
  ownerOnly("cms/vendorModelCatalog:refreshModelCatalogs", "mutation", noArgs, { error: "CMS_MODULE_DISABLED" }),
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
