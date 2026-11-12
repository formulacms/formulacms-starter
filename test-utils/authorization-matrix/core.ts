import { makeFunctionReference } from "convex/server"
import { expect, vi } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { hashOwnerClaim } from "../../convex/lib/ownerClaim"
import {
  defineRow,
  FORMER,
  MATRIX_STATES,
  OWNER,
  setupModuleLanguageState,
  setupSnapshotActiveS4,
  stateLabel,
  type AuthorizationRow,
  type CallTarget,
  type FunctionKind,
  type MatrixState,
  type Site,
} from "./harness"

type Fixture = { redirectId: Id<"redirects">; languageVersion: number }

async function setup(t: Site, state: MatrixState): Promise<Fixture> {
  const { languageVersion } = await setupModuleLanguageState(t, state)
  const redirectId = await t.run((ctx) => ctx.db.insert("redirects", {
    fromPath: "/retired",
    toPath: "/current",
    statusCode: 301,
    createdAt: 1,
    updatedAt: 1,
    origin: "manual",
  }))
  return { redirectId, languageVersion }
}

function protectedRow(
  name: string,
  kind: FunctionKind,
  call: (actor: CallTarget, fixture: Fixture) => Promise<unknown>,
  ownerValue: (state: MatrixState) => unknown,
  ownerOffAllowed = false,
): AuthorizationRow {
  return defineRow({
    name,
    kind,
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setup(t, state),
      call,
      outcomes: {
        signedOut: { error: "UNAUTHENTICATED" },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
        owner: state.redirects === "off" && !ownerOffAllowed
          ? { error: "CMS_MODULE_DISABLED" }
          : { value: ownerValue(state) },
      },
    })),
  })
}

function publicRow(
  name: string,
  call: (actor: CallTarget, fixture: Fixture, stale: boolean) => Promise<unknown>,
  value: (state: MatrixState) => unknown,
): AuthorizationRow {
  return defineRow({
    name,
    kind: "query",
    scenarios: MATRIX_STATES.flatMap((state) => [
      {
        label: stateLabel(state),
        setup: (t: Site) => setup(t, state),
        call: (actor: CallTarget, fixture: Fixture) => call(actor, fixture, false),
        outcomes: {
          owner: { value: value(state) },
          signedOut: { value: value(state) },
          unrelated: { value: value(state) },
          former: { value: value(state) },
        },
        readOnly: true,
      },
      {
        label: `${stateLabel(state)}/stale-version`,
        setup: (t: Site) => setup(t, state),
        call: (actor: CallTarget, fixture: Fixture) => call(actor, fixture, true),
        outcomes: {
          owner: { error: "SITE_LANGUAGE_VERSION_CHANGED" },
          signedOut: { error: "SITE_LANGUAGE_VERSION_CHANGED" },
          unrelated: { error: "SITE_LANGUAGE_VERSION_CHANGED" },
          former: { error: "SITE_LANGUAGE_VERSION_CHANGED" },
        },
        readOnly: true,
      },
    ]),
  })
}

function publicSettingsRow(
  name: string,
  call: (actor: CallTarget) => Promise<unknown>,
  value: (state: MatrixState) => unknown,
): AuthorizationRow {
  return defineRow({
    name,
    kind: "query",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupModuleLanguageState(t, state),
      call,
      outcomes: {
        owner: { value: value(state) },
        signedOut: { value: value(state) },
        unrelated: { value: value(state) },
        former: { value: value(state) },
      },
      readOnly: true,
    })),
  })
}

async function setupS3FromS1(t: Site, redirects: "off" | "on") {
  await setupModuleLanguageState(t, { redirects, language: "F09" })
  await t.run(async (ctx) => {
    const existing = await ctx.db.query("cmsModuleState").first()
    if (existing) {
      await ctx.db.patch(existing._id, {
        enabledModules: [
          ...existing.enabledModules,
          { moduleId: "multilingual", configVersion: 1 },
        ],
        configurationVersion: existing.configurationVersion + 1,
      })
    } else {
      await ctx.db.insert("cmsModuleState", {
        key: "owner",
        configurationVersion: 1,
        enabledModules: [{ moduleId: "multilingual", configVersion: 1 }],
      })
    }
  })
  return null
}

async function setupPreAuthority(t: Site, locales: string[]) {
  await t.run((ctx) => ctx.db.insert("siteSettings", {
    siteName: "Authorization matrix site",
    siteUrl: "https://example.test",
    defaultLocale: "en",
    enabledLocales: locales,
    updatedAt: 1,
  }))
  return null
}

async function setRevalidationOrigin(t: Site): Promise<void> {
  await t.run(async (ctx) => {
    const settings = await ctx.db.query("siteSettings").unique()
    await ctx.db.patch(settings!._id, { siteUrl: "https://site.example.com" })
  })
}

async function setupSnapshotPreAuthority(t: Site, locales: string[]): Promise<void> {
  await setupPreAuthority(t, locales)
  await t.run((ctx) => ctx.db.insert("pagePublicationCutover", {
    key: "published-snapshot-v1",
    phase: "snapshot_active",
    revision: 1,
    updatedAt: 1,
  }))
}

async function setupSnapshotF09(t: Site, redirects: "off" | "on") {
  const fixture = await setupModuleLanguageState(t, { redirects, language: "F09" })
  await t.run(async (ctx) => {
    const cutover = await ctx.db.query("pagePublicationCutover").unique()
    await ctx.db.patch(cutover!._id, { phase: "snapshot_active", revision: 2 })
  })
  return fixture
}

async function setupSnapshotS3(t: Site, redirects: "off" | "on") {
  await setupS3FromS1(t, redirects)
  await t.run(async (ctx) => {
    const cutover = await ctx.db.query("pagePublicationCutover").unique()
    await ctx.db.patch(cutover!._id, { phase: "snapshot_active", revision: 2 })
  })
  return { configurationVersion: redirects === "on" ? 2 : 1 }
}

async function setupSnapshotS4OneLocale(t: Site, redirects: "off" | "on") {
  const fixture = await setupSnapshotActiveS4(t, redirects)
  await t.run(async (ctx) => {
    const settings = await ctx.db.query("siteSettings").unique()
    await ctx.db.patch(settings!._id, { enabledLocales: ["en"] })
    const authority = await ctx.db.query("siteLanguageAuthority").unique()
    await ctx.db.patch(authority!._id, { enabledLocales: ["en"] })
  })
  return fixture
}

async function seedOpenTransition(t: Site, state: MatrixState) {
  await setupModuleLanguageState(t, state)
  const transitionId = await t.run(async (ctx) => {
    const owner = await ctx.db.query("cmsOwner").unique()
    const transitionId = await ctx.db.insert("siteLanguageTransitions", {
      mode: "correct_label",
      sourceLocale: "en",
      targetLocale: "fr",
      phase: "enumerating",
      generation: 1,
      startAuthorityVersion: 1,
      startSettingsUpdatedAt: 1,
      shortPath: true,
      sourcePublicSetVersion: 0,
      preparedSetVersion: 0,
      cursorPhase: "pages",
      pageCount: 0,
      targetCount: 0,
      withdrawCount: 0,
      redirectCount: 0,
      unresolvedCount: 0,
      blockedCount: 0,
      targetDrafts: "retained",
      attribution: {
        kind: "owner",
        ownerId: owner!._id,
        authId: OWNER.subject,
        tokenIdentifier: OWNER.tokenIdentifier,
      },
      createdAt: 1,
      updatedAt: 1,
    })
    const authority = await ctx.db.query("siteLanguageAuthority").unique()
    await ctx.db.patch(authority!._id, { activeTransitionId: transitionId })
    return transitionId
  })
  return { transitionId }
}

async function seedSnapshotS4Transition(t: Site, redirects: "off" | "on") {
  const fixture = await seedOpenTransition(t, { redirects, language: "M05" })
  await t.run(async (ctx) => {
    const cutover = await ctx.db.query("pagePublicationCutover").unique()
    await ctx.db.patch(cutover!._id, { phase: "snapshot_active", revision: 2 })
    const transition = await ctx.db.get(fixture.transitionId)
    await ctx.db.patch(transition!._id, { phase: "committed", committedAt: 2 })
    const authority = await ctx.db.query("siteLanguageAuthority").unique()
    await ctx.db.patch(authority!._id, { activeTransitionId: undefined })
  })
  return fixture
}

async function setupRealTransition(t: Site, owner: CallTarget, redirects: "off" | "on") {
  await setupSnapshotF09(t, redirects)
  const transitionId = await owner.mutation(api.cms.language.startLanguageTransition, {
    mode: "correct_label", sourceLocale: "en", targetLocale: "fr",
    expectedSettingsUpdatedAt: 1, expectedAuthorityVersion: 1,
  })
  return { transitionId }
}

async function seedOwnerAdminMembership(t: Site) {
  await t.run(async (ctx) => {
    await ctx.db.insert("cmsMemberships", {
      authId: OWNER.subject,
      tokenIdentifier: OWNER.tokenIdentifier,
      role: "admin",
      status: "active",
      createdAt: 1,
      activatedAt: 1,
      updatedAt: 1,
      transitionId: "matrix-bootstrap-owner",
    })
    await ctx.db.insert("cmsCapacity", {
      key: "cms",
      activeCount: 1,
      reservedCount: 0,
      allowance: 3,
      overCap: false,
      migrationState: "ready",
      migrationVersion: 1,
      migrationIssueCount: 0,
      lastTransitionId: "matrix-bootstrap-ready",
      updatedAt: 1,
    })
  })
}

const protectedReadDenials = {
  signedOut: { error: "UNAUTHENTICATED" },
  unrelated: { error: "CMS_OWNER_REQUIRED" },
  former: { error: "CMS_OWNER_REQUIRED" },
} as const

function ownerClaimRow(operation: "claimOwner" | "replaceOwner"): AuthorizationRow {
  const ownerClaimMutation = {
    claimOwner: api.cms.owner.claimOwner,
    replaceOwner: api.cms.owner.replaceOwner,
  }[operation]
  type ClaimFixture = { ownerActor: CallTarget; valid: boolean }
  return defineRow<ClaimFixture>({
    name: `cms/owner:${operation}`,
    kind: "mutation",
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: async (t: Site, actors: { owner: CallTarget }) => {
          await setupModuleLanguageState(t, state)
          return { ownerActor: actors.owner, valid: false }
        },
        call: (actor: CallTarget) => actor.mutation(ownerClaimMutation, { claim: "invalid-matrix-claim" }),
        outcomes: {
          owner: { value: { status: "unavailable" } },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { value: { status: "unavailable" } },
          former: { value: { status: "unavailable" } },
        },
      })),
      {
        label: "owner-valid-claim",
        setup: async (t, actors) => {
          await setupModuleLanguageState(t, { redirects: "off", language: "F09" })
          if (operation === "claimOwner") {
            await t.run(async (ctx) => {
              const owner = await ctx.db.query("cmsOwner").unique()
              await ctx.db.delete(owner!._id)
            })
          } else {
            const previousHash = await hashOwnerClaim("matrix-previous-claim")
            await t.run(async (ctx) => {
              const owner = await ctx.db.query("cmsOwner").unique()
              await ctx.db.patch(owner!._id, {
                authId: FORMER.subject,
                tokenIdentifier: FORMER.tokenIdentifier,
              })
              await ctx.db.insert("ownerClaimLedger", {
                key: "owner",
                secretHash: previousHash,
                claimedBy: FORMER.subject,
                claimedAt: 1,
                recovery: false,
              })
            })
          }
          vi.stubEnv("FORMULACMS_OWNER_CLAIM", "matrix-valid-claim")
          return { ownerActor: actors.owner, valid: true }
        },
        call: (actor, fixture) => actor.mutation(ownerClaimMutation, {
          claim: actor === fixture.ownerActor ? "matrix-valid-claim" : "invalid-matrix-claim",
        }),
        outcomes: {
          owner: { value: { status: "claimed" } },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { value: { status: "unavailable" } },
          former: { value: { status: "unavailable" } },
        },
        after: async (t) => {
          const owner = await t.run((ctx) => ctx.db.query("cmsOwner").unique())
          expect(owner).toMatchObject({ authId: OWNER.subject, tokenIdentifier: OWNER.tokenIdentifier })
          const ledger = await t.run((ctx) => ctx.db.query("ownerClaimLedger").unique())
          expect(ledger).toMatchObject({ claimedBy: OWNER.subject })
        },
        teardown: async () => { vi.unstubAllEnvs() },
      },
    ],
  })
}

export const coreRows: AuthorizationRow[] = [
  defineRow({
    name: "cms/multilingual:addLanguage",
    kind: "mutation",
    requiredScenarioLabels: ["snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupModuleLanguageState(t, state),
        call: (actor: CallTarget) => actor.mutation(api.cms.multilingual.addLanguage, {
          locale: "nl", expectedAuthorityVersion: 1, expectedModuleConfigurationVersion: 1,
        }),
        outcomes: { ...protectedReadDenials, owner: state.language === "F09" ? { error: "CMS_MODULE_DISABLED" } : { error: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" } },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotActiveS4(t, redirects),
        call: (actor: CallTarget) => actor.mutation(api.cms.multilingual.addLanguage, {
          locale: "nl", expectedAuthorityVersion: 1, expectedModuleConfigurationVersion: 1,
        }),
        outcomes: { ...protectedReadDenials, owner: { value: {
          version: 2, enabledLocales: ["en", "fr", "nl"], operationKind: "add",
        } } },
        after: async (t: Site) => {
          const authority = await t.run((ctx) => ctx.db.query("siteLanguageAuthority").unique())
          expect(authority).toMatchObject({ version: 2, enabledLocales: ["en", "fr", "nl"] })
        },
      })),
    ],
  }),
  defineRow({
    name: "cms/multilingual:startLanguageImpactPreview",
    kind: "mutation",
    requiredScenarioLabels: ["snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupModuleLanguageState(t, state),
        call: (actor: CallTarget) => actor.mutation(api.cms.multilingual.startLanguageImpactPreview, { kind: "remove", locale: "fr" }),
        outcomes: { ...protectedReadDenials, owner: state.language === "F09" ? { error: "CMS_MODULE_DISABLED" } : { error: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" } },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotActiveS4(t, redirects),
        call: (actor: CallTarget) => actor.mutation(api.cms.multilingual.startLanguageImpactPreview, { kind: "remove", locale: "fr" }),
        outcomes: { ...protectedReadDenials, owner: { value: { previewId: expect.any(String) } } },
        after: async (t: Site) => {
          const preview = await t.run((ctx) => ctx.db.query("siteLanguageImpactPreviews").unique())
          expect(preview).toMatchObject({ kind: "remove", locale: "fr", phase: "scanning" })
        },
      })),
    ],
  }),
  defineRow({
    name: "cms/multilingual:adoptMultilingualAuthority",
    kind: "mutation",
    requiredScenarioLabels: ["snapshot-S3/redirects-off", "snapshot-S3/redirects-on", "snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: async (t: Site) => {
          await setupModuleLanguageState(t, state)
          return { configurationVersion: 1 }
        },
        call: (actor: CallTarget, fixture: { configurationVersion: number }) => actor.mutation(
          api.cms.multilingual.adoptMultilingualAuthority,
          { expectedSettingsUpdatedAt: 1, expectedModuleConfigurationVersion: fixture.configurationVersion, expectedAuthorityVersion: 1 },
        ),
        outcomes: { ...protectedReadDenials, owner: state.language === "F09" ? { error: "CMS_MODULE_DISABLED" } : { error: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" } },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S3/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotS3(t, redirects),
        call: (actor: CallTarget, fixture: { configurationVersion: number }) => actor.mutation(
          api.cms.multilingual.adoptMultilingualAuthority,
          { expectedSettingsUpdatedAt: 1, expectedModuleConfigurationVersion: fixture.configurationVersion, expectedAuthorityVersion: 1 },
        ),
        outcomes: { ...protectedReadDenials, owner: { value: { version: 2, defaultLocale: "en", enabledLocales: ["en"] } } },
        after: async (t: Site) => {
          const authority = await t.run((ctx) => ctx.db.query("siteLanguageAuthority").unique())
          expect(authority).toMatchObject({ mode: "multilingual", version: 2, enabledLocales: ["en"] })
        },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: async (t: Site) => {
          await setupSnapshotActiveS4(t, redirects)
          return { configurationVersion: 1 }
        },
        call: (actor: CallTarget, fixture: { configurationVersion: number }) => actor.mutation(
          api.cms.multilingual.adoptMultilingualAuthority,
          { expectedSettingsUpdatedAt: 1, expectedModuleConfigurationVersion: fixture.configurationVersion, expectedAuthorityVersion: 1 },
        ),
        outcomes: { ...protectedReadDenials, owner: { error: "MULTILINGUAL_ALREADY_ADOPTED" } },
      })),
    ],
  }),
  defineRow({
    name: "cms/multilingual:returnToSingleLanguage",
    kind: "mutation",
    requiredScenarioLabels: ["snapshot-S4/redirects-off", "snapshot-S4/redirects-on", "snapshot-S4-one-locale/redirects-off", "snapshot-S4-one-locale/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupModuleLanguageState(t, state),
        call: (actor: CallTarget) => actor.mutation(api.cms.multilingual.returnToSingleLanguage, { expectedAuthorityVersion: 1 }),
        outcomes: { ...protectedReadDenials, owner: state.language === "F09" ? { error: "CMS_MODULE_DISABLED" } : { error: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" } },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotActiveS4(t, redirects),
        call: (actor: CallTarget) => actor.mutation(api.cms.multilingual.returnToSingleLanguage, { expectedAuthorityVersion: 1 }),
        outcomes: { ...protectedReadDenials, owner: { error: "LANGUAGE_MULTIPLE_LOCALES_ENABLED" } },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4-one-locale/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotS4OneLocale(t, redirects),
        call: (actor: CallTarget) => actor.mutation(api.cms.multilingual.returnToSingleLanguage, { expectedAuthorityVersion: 1 }),
        outcomes: { ...protectedReadDenials, owner: { value: { version: 2, locale: "en" } } },
        after: async (t: Site) => {
          const authority = await t.run((ctx) => ctx.db.query("siteLanguageAuthority").unique())
          expect(authority).toMatchObject({ version: 2 })
          expect(authority?.mode).toBe("single")
        },
      })),
    ],
  }),
  defineRow({
    name: "migrations:startCmsMembershipBackfill",
    kind: "mutation",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: async (t: Site) => {
        await setupModuleLanguageState(t, state)
        await seedOwnerAdminMembership(t)
        return null
      },
      // `convex/migrations.ts` is source-only, so this row names its function by
      // string, like the private `cms/invites` and `cms/roles` rows; the matrix
      // skips it where the module is absent.
      call: (actor: CallTarget) => actor.mutation(makeFunctionReference<"mutation">("migrations:startCmsMembershipBackfill"), {}),
      outcomes: {
        signedOut: { error: "Unauthenticated: sign in to continue" },
        unrelated: { error: "CMS_MEMBERSHIP_REQUIRED" },
        former: { error: "CMS_MEMBERSHIP_REQUIRED" },
        owner: { value: null },
      },
      after: async (t: Site) => {
        const capacity = await t.run((ctx) => ctx.db.query("cmsCapacity").unique())
        expect(capacity?.migrationState).toBe("ready")
      },
    })),
  }),
  defineRow({
    name: "cms/settings:bootstrapInstallation",
    kind: "mutation",
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: async (t: Site) => {
          await setupModuleLanguageState(t, state)
          await seedOwnerAdminMembership(t)
          return null
        },
        call: (actor: CallTarget) => actor.mutation(api.cms.settings.bootstrapInstallation, {
          siteName: "Authorization matrix site", timezone: "UTC", defaultLocale: "en",
        }),
        outcomes: {
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
          owner: { error: "PUBLISHED_SNAPSHOT_CUTOVER_NOT_EMPTY_INSTALL" },
        },
      })),
      {
        label: "fresh-install-owner",
        setup: async (t: Site) => {
          await seedOwnerAdminMembership(t)
          return null
        },
        call: (actor: CallTarget) => actor.mutation(api.cms.settings.bootstrapInstallation, {
          siteName: "Fresh matrix site", timezone: "UTC", defaultLocale: "en",
        }),
        outcomes: {
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
          owner: { value: {
            phase: "snapshot_active", revision: expect.any(Number), onboardingCompletedAt: expect.any(Number),
          } },
        },
        after: async (t: Site) => {
          const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
          expect(settings).toMatchObject({
            siteName: "Fresh matrix site", homePageId: expect.any(String),
            onboardingCompletedAt: expect.any(Number),
          })
          const cutover = await t.run((ctx) => ctx.db.query("pagePublicationCutover").unique())
          expect(cutover?.phase).toBe("snapshot_active")
        },
      },
    ],
  }),
  ...(["continueLanguageTransition", "cancelLanguageTransition"] as const).map((operation) => defineRow({
    name: `cms/language:${operation}`,
    kind: "mutation",
    requiredScenarioLabels: [
      "snapshot-F09/redirects-off", "snapshot-F09/redirects-on",
      "snapshot-S4/redirects-off", "snapshot-S4/redirects-on",
    ],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => seedOpenTransition(t, state),
        call: (actor: CallTarget, fixture: { transitionId: Id<"siteLanguageTransitions"> }) =>
          operation === "continueLanguageTransition"
            ? actor.mutation(api.cms.language.continueLanguageTransition, {
              transitionId: fixture.transitionId, expectedGeneration: 1,
            })
            : actor.mutation(api.cms.language.cancelLanguageTransition, {
              transitionId: fixture.transitionId, expectedGeneration: 1,
              discardTargetDrafts: false,
            }),
        outcomes: { ...protectedReadDenials, owner: { error: "LANGUAGE_TRANSITION_REQUIRES_SNAPSHOT_AUTHORITY" } },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-F09/redirects-${redirects}`,
        setup: (t: Site, actors: { owner: CallTarget }) => setupRealTransition(t, actors.owner, redirects),
        call: (actor: CallTarget, fixture: { transitionId: Id<"siteLanguageTransitions"> }) =>
          operation === "continueLanguageTransition"
            ? actor.mutation(api.cms.language.continueLanguageTransition, {
              transitionId: fixture.transitionId, expectedGeneration: 1,
            })
            : actor.mutation(api.cms.language.cancelLanguageTransition, {
              transitionId: fixture.transitionId, expectedGeneration: 1,
              discardTargetDrafts: false,
            }),
        outcomes: {
          ...protectedReadDenials,
          owner: operation === "continueLanguageTransition"
            ? { check: (value: unknown) => expect(value).toMatchObject({ generation: 1, more: expect.any(Boolean) }) }
            : { value: { generation: 2 } },
        },
        after: async (t: Site) => {
          const transition = await t.run((ctx) => ctx.db.query("siteLanguageTransitions").unique())
          if (operation === "continueLanguageTransition") {
            expect(transition).toMatchObject({ phase: "enumerating", cursorPhase: "target_artifacts" })
          } else {
            expect(transition?.phase).toBe("cancelling")
          }
        },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => seedSnapshotS4Transition(t, redirects),
        call: (actor: CallTarget, fixture: { transitionId: Id<"siteLanguageTransitions"> }) =>
          operation === "continueLanguageTransition"
            ? actor.mutation(api.cms.language.continueLanguageTransition, {
              transitionId: fixture.transitionId, expectedGeneration: 1,
            })
            : actor.mutation(api.cms.language.cancelLanguageTransition, {
              transitionId: fixture.transitionId, expectedGeneration: 1,
              discardTargetDrafts: false,
            }),
        outcomes: { ...protectedReadDenials, owner: { error: "LANGUAGE_TRANSITION_MULTILINGUAL_ENABLED" } },
      })),
    ],
  })),
  ...(["listLanguageTransitionPages", "listLanguageCarryDecisions"] as const).map((operation) => defineRow({
    name: `cms/language:${operation}`,
    kind: "query",
    requiredScenarioLabels: ["snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => seedOpenTransition(t, state),
        call: (actor: CallTarget, fixture: { transitionId: Id<"siteLanguageTransitions"> }) =>
          operation === "listLanguageTransitionPages"
            ? actor.query(api.cms.language.listLanguageTransitionPages, {
              transitionId: fixture.transitionId,
              paginationOpts: { numItems: 10, cursor: null },
            })
            : actor.query(api.cms.language.listLanguageCarryDecisions, {
              transitionId: fixture.transitionId,
              paginationOpts: { numItems: 10, cursor: null },
              filter: "all",
            }),
        outcomes: { ...protectedReadDenials, owner: { value: expect.objectContaining({ page: [] }) } },
        readOnly: true,
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => seedSnapshotS4Transition(t, redirects),
        call: (actor: CallTarget, fixture: { transitionId: Id<"siteLanguageTransitions"> }) =>
          operation === "listLanguageTransitionPages"
            ? actor.query(api.cms.language.listLanguageTransitionPages, {
              transitionId: fixture.transitionId,
              paginationOpts: { numItems: 10, cursor: null },
            })
            : actor.query(api.cms.language.listLanguageCarryDecisions, {
              transitionId: fixture.transitionId,
              paginationOpts: { numItems: 10, cursor: null },
              filter: "all",
            }),
        outcomes: { ...protectedReadDenials, owner: { value: expect.objectContaining({ page: [] }) } },
        readOnly: true,
      })),
    ],
  })),
  defineRow({
    name: "cms/language:startLanguageTransition",
    kind: "mutation",
    requiredScenarioLabels: [
      "snapshot-F09/redirects-off", "snapshot-F09/redirects-on",
      "snapshot-S4/redirects-off", "snapshot-S4/redirects-on",
    ],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupModuleLanguageState(t, state),
        call: (actor: CallTarget) => actor.mutation(api.cms.language.startLanguageTransition, {
          mode: "correct_label", sourceLocale: "en", targetLocale: "fr",
          expectedSettingsUpdatedAt: 1, expectedAuthorityVersion: 1,
        }),
        outcomes: { ...protectedReadDenials, owner: { error: "LANGUAGE_TRANSITION_REQUIRES_SNAPSHOT_AUTHORITY" } },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-F09/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotF09(t, redirects),
        call: (actor: CallTarget) => actor.mutation(api.cms.language.startLanguageTransition, {
          mode: "correct_label", sourceLocale: "en", targetLocale: "fr",
          expectedSettingsUpdatedAt: 1, expectedAuthorityVersion: 1,
        }),
        outcomes: { ...protectedReadDenials, owner: { value: expect.any(String) } },
        after: async (t: Site) => {
          const transition = await t.run((ctx) => ctx.db.query("siteLanguageTransitions").unique())
          expect(transition).toMatchObject({ mode: "correct_label", phase: "enumerating" })
          const authority = await t.run((ctx) => ctx.db.query("siteLanguageAuthority").unique())
          expect(authority?.activeTransitionId).toBe(transition?._id)
        },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotActiveS4(t, redirects),
        call: (actor: CallTarget) => actor.mutation(api.cms.language.startLanguageTransition, {
          mode: "correct_label", sourceLocale: "en", targetLocale: "fr",
          expectedSettingsUpdatedAt: 1, expectedAuthorityVersion: 1,
        }),
        outcomes: { ...protectedReadDenials, owner: { error: "LANGUAGE_TRANSITION_MULTILINGUAL_ENABLED" } },
      })),
    ],
  }),
  ownerClaimRow("claimOwner"),
  ownerClaimRow("replaceOwner"),
  defineRow({
    name: "cms/language:initializeSiteLanguageAuthority",
    kind: "mutation",
    requiredScenarioLabels: ["m05-S0", "m05-S2", "snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupModuleLanguageState(t, state),
        call: (actor: CallTarget) => actor.mutation(api.cms.language.initializeSiteLanguageAuthority, {}),
        outcomes: { ...protectedReadDenials, owner: { error: "LANGUAGE_TRANSITION_REQUIRES_SNAPSHOT_AUTHORITY" } },
      })),
      {
        label: "m05-S0",
        setup: async (t: Site) => {
          await setupSnapshotPreAuthority(t, ["en"])
          return { languageVersion: 0 }
        },
        call: (actor: CallTarget) => actor.mutation(api.cms.language.initializeSiteLanguageAuthority, {}),
        outcomes: { ...protectedReadDenials, owner: { value: { version: 1, currentLocale: "en" } } },
        after: async (t: Site) => {
          const authority = await t.run((ctx) => ctx.db.query("siteLanguageAuthority").unique())
          expect(authority).toMatchObject({ version: 1, currentLocale: "en" })
        },
      },
      {
        label: "m05-S2",
        setup: async (t: Site) => {
          await setupSnapshotPreAuthority(t, ["en", "fr"])
          return { languageVersion: 0 }
        },
        call: (actor: CallTarget) => actor.mutation(api.cms.language.initializeSiteLanguageAuthority, {}),
        outcomes: { ...protectedReadDenials, owner: { error: "LANGUAGE_MULTI_LOCALE_REQUIRES_L01_M05" } },
      },
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotActiveS4(t, redirects),
        call: (actor: CallTarget) => actor.mutation(api.cms.language.initializeSiteLanguageAuthority, {}),
        outcomes: { ...protectedReadDenials, owner: { error: "MULTILINGUAL_ALREADY_ADOPTED" } },
      })),
    ],
  }),
  defineRow({
    name: "cms/multilingual:previewAdoption",
    kind: "query",
    requiredScenarioLabels: ["snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupModuleLanguageState(t, state),
        call: (actor: CallTarget) => actor.query(api.cms.multilingual.previewAdoption, {}),
        outcomes: {
          ...protectedReadDenials,
          owner: state.language === "F09" ? { error: "CMS_MODULE_DISABLED" } : { check: (value: unknown) => expect(value).toMatchObject({ canAdopt: expect.any(Boolean) }) },
        },
        readOnly: true,
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotActiveS4(t, redirects),
        call: (actor: CallTarget) => actor.query(api.cms.multilingual.previewAdoption, {}),
        outcomes: {
          ...protectedReadDenials,
          owner: { check: (value: unknown) => expect(value).toMatchObject({ canAdopt: expect.any(Boolean) }) },
        },
        readOnly: true,
      })),
    ],
  }),
  defineRow({
    name: "cms/languageLifecycle:getLanguageLifecycleStatus",
    kind: "query",
    requiredScenarioLabels: ["snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupModuleLanguageState(t, state),
        call: (actor: CallTarget) => actor.query(api.cms.languageLifecycle.getLanguageLifecycleStatus, {}),
        outcomes: { ...protectedReadDenials, owner: { value: {
          updating: false, notDelivered: false, failing: false, localUnreachable: false,
          oldestUndelivered: null, operation: null,
        } } },
        readOnly: true,
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotActiveS4(t, redirects),
        call: (actor: CallTarget) => actor.query(api.cms.languageLifecycle.getLanguageLifecycleStatus, {}),
        outcomes: { ...protectedReadDenials, owner: { value: {
          updating: false, notDelivered: false, failing: false, localUnreachable: false,
          oldestUndelivered: null, operation: null,
        } } },
        readOnly: true,
      })),
    ],
  }),
  defineRow({
    name: "cms/languageLifecycle:requeueUndeliveredLifecycleIntents",
    kind: "mutation",
    requiredScenarioLabels: ["snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: async (t: Site) => {
          const fixture = await setupModuleLanguageState(t, state)
          await setRevalidationOrigin(t)
          vi.stubEnv("REVALIDATE_SECRET", "matrix-secret")
          return fixture
        },
        teardown: async () => { vi.unstubAllEnvs() },
        call: (actor: CallTarget) => actor.mutation(api.cms.languageLifecycle.requeueUndeliveredLifecycleIntents, {}),
        outcomes: { ...protectedReadDenials, owner: { value: { requeued: 0, moreRemain: false } } },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: async (t: Site) => {
          const fixture = await setupSnapshotActiveS4(t, redirects)
          await setRevalidationOrigin(t)
          vi.stubEnv("REVALIDATE_SECRET", "matrix-secret")
          return fixture
        },
        teardown: async () => { vi.unstubAllEnvs() },
        call: (actor: CallTarget) => actor.mutation(api.cms.languageLifecycle.requeueUndeliveredLifecycleIntents, {}),
        outcomes: { ...protectedReadDenials, owner: { value: { requeued: 0, moreRemain: false } } },
      })),
    ],
  }),
  defineRow({
    name: "cms/language:getLanguageState",
    kind: "query",
    requiredScenarioLabels: ["m05-S0", "m05-S2", "m05-S3/S1", "snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupModuleLanguageState(t, state),
        call: (actor: CallTarget) => actor.query(api.cms.language.getLanguageState, {}),
        outcomes: {
          ...protectedReadDenials,
          owner: { value: expect.objectContaining({
            kind: state.language === "M05" ? "multilingual" : "current",
            version: 1,
            currentLocale: "en",
            enabledLocales: state.language === "M05" ? ["en", "fr"] : ["en"],
          }) },
        },
        readOnly: true,
      })),
      {
        label: "m05-S0",
        setup: (t: Site) => setupPreAuthority(t, ["en"]),
        call: (actor: CallTarget) => actor.query(api.cms.language.getLanguageState, {}),
        outcomes: { ...protectedReadDenials, owner: { value: expect.objectContaining({
          kind: "uninitialized", version: 0, currentLocale: "en", enabledLocales: ["en"],
        }) } },
        readOnly: true,
      },
      {
        label: "m05-S2",
        setup: (t: Site) => setupPreAuthority(t, ["en", "fr"]),
        call: (actor: CallTarget) => actor.query(api.cms.language.getLanguageState, {}),
        outcomes: { ...protectedReadDenials, owner: { value: expect.objectContaining({
          kind: "multi_locale", version: 0, currentLocale: null, enabledLocales: ["en", "fr"],
        }) } },
        readOnly: true,
      },
      {
        label: "m05-S3/S1",
        setup: (t: Site) => setupS3FromS1(t, "off"),
        call: (actor: CallTarget) => actor.query(api.cms.language.getLanguageState, {}),
        outcomes: { ...protectedReadDenials, owner: { value: expect.objectContaining({
          kind: "current", version: 1, currentLocale: "en", enabledLocales: ["en"],
        }) } },
        readOnly: true,
      },
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotActiveS4(t, redirects),
        call: (actor: CallTarget) => actor.query(api.cms.language.getLanguageState, {}),
        outcomes: { ...protectedReadDenials, owner: { value: expect.objectContaining({
          kind: "multilingual", version: 1, currentLocale: "en", enabledLocales: ["en", "fr"],
        }) } },
        readOnly: true,
      })),
    ],
  }),
  defineRow({
    name: "cms/multilingual:getMultilingualState",
    kind: "query",
    requiredScenarioLabels: ["m05-S0", "m05-S2", "m05-S3/S1", "snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupModuleLanguageState(t, state),
        call: (actor: CallTarget) => actor.query(api.cms.multilingual.getMultilingualState, {}),
        outcomes: { ...protectedReadDenials, owner: { value: expect.objectContaining({
          lifecycleState: state.language === "M05" ? "S4" : "S1",
          moduleEnabled: state.language === "M05",
        }) } },
        readOnly: true,
      })),
      {
        label: "m05-S0",
        setup: (t: Site) => setupPreAuthority(t, ["en"]),
        call: (actor: CallTarget) => actor.query(api.cms.multilingual.getMultilingualState, {}),
        outcomes: { ...protectedReadDenials, owner: { value: expect.objectContaining({
          lifecycleState: "S0", moduleEnabled: false,
        }) } },
        readOnly: true,
      },
      {
        label: "m05-S2",
        setup: (t: Site) => setupPreAuthority(t, ["en", "fr"]),
        call: (actor: CallTarget) => actor.query(api.cms.multilingual.getMultilingualState, {}),
        outcomes: { ...protectedReadDenials, owner: { value: expect.objectContaining({
          lifecycleState: "S2", moduleEnabled: false,
        }) } },
        readOnly: true,
      },
      {
        label: "m05-S3/S1",
        setup: (t: Site) => setupS3FromS1(t, "off"),
        call: (actor: CallTarget) => actor.query(api.cms.multilingual.getMultilingualState, {}),
        outcomes: { ...protectedReadDenials, owner: { value: expect.objectContaining({
          lifecycleState: "S3", origin: "S1", moduleEnabled: true,
        }) } },
        readOnly: true,
      },
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotActiveS4(t, redirects),
        call: (actor: CallTarget) => actor.query(api.cms.multilingual.getMultilingualState, {}),
        outcomes: { ...protectedReadDenials, owner: { value: expect.objectContaining({
          lifecycleState: "S4", moduleEnabled: true,
        }) } },
        readOnly: true,
      })),
    ],
  }),
  publicSettingsRow("cms/settings:getSiteConfig",
    (actor) => actor.query(api.cms.settings.getSiteConfig, {}),
    (state) => ({
      onboardingCompletedAt: null,
      defaultLocale: "en",
      enabledLocales: state.language === "M05" ? ["en", "fr"] : ["en"],
      homePageId: null,
      siteUrl: "https://example.test",
      timezone: "UTC",
      languageVersion: 1,
    })),
  publicSettingsRow("cms/settings:getOnboardingProgress",
    (actor) => actor.query(api.cms.settings.getOnboardingProgress, {}),
    () => ({ account: false, identity: false, locales: false, ai: false, finished: false })),
  publicSettingsRow("cms/settings:getBrandingUrls",
    (actor) => actor.query(api.cms.settings.getBrandingUrls, {}),
    () => ({ logo: null, favicon: null, og: null })),
  publicSettingsRow("cms/settings:getPublicChrome",
    (actor) => actor.query(api.cms.settings.getPublicChrome, {}),
    () => expect.objectContaining({ siteName: "Authorization matrix site" })),
  defineRow({
    name: "cms/settings:getSettings",
    kind: "query",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupModuleLanguageState(t, state),
      call: (actor: CallTarget) => actor.query(api.cms.settings.getSettings, {}),
      outcomes: {
        owner: { value: expect.objectContaining({ siteName: "Authorization matrix site" }) },
        signedOut: { value: null },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
      },
      readOnly: true,
    })),
  }),
  defineRow({
    name: "cms/settings:markOnboardingStep",
    kind: "mutation",
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupModuleLanguageState(t, state),
        call: (actor: CallTarget) => actor.mutation(api.cms.settings.markOnboardingStep, {
          step: "ai",
        }),
        outcomes: {
          owner: { value: null },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
        after: async (t: Site) => {
          const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
          expect(settings?.onboardingAiAt).toEqual(expect.any(Number))
        },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotActiveS4(t, redirects),
        call: (actor: CallTarget) => actor.mutation(api.cms.settings.markOnboardingStep, {
          step: "ai",
        }),
        outcomes: {
          owner: { error: "SNAPSHOT_ONBOARDING_WIZARD_DEFERRED" },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
      })),
    ],
  }),
  defineRow({
    name: "cms/settings:completeOnboarding",
    kind: "mutation",
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupModuleLanguageState(t, state),
        call: (actor: CallTarget) => actor.mutation(api.cms.settings.completeOnboarding, {
          siteName: "Completed by current owner",
          timezone: "UTC",
          defaultLocale: "en",
          enabledLocales: state.language === "M05" ? ["en", "fr"] : ["en"],
        }),
        outcomes: {
          owner: { value: { onboardingCompletedAt: expect.any(Number) } },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
        after: async (t: Site) => {
          const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
          expect(settings).toMatchObject({
            siteName: "Completed by current owner",
            homePageId: expect.any(String),
            onboardingCompletedAt: expect.any(Number),
          })
        },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotActiveS4(t, redirects),
        call: (actor: CallTarget) => actor.mutation(api.cms.settings.completeOnboarding, {
          siteName: "Rejected after snapshot cutover",
          timezone: "UTC",
          defaultLocale: "en",
          enabledLocales: ["en", "fr"],
        }),
        outcomes: {
          owner: { error: "SNAPSHOT_ONBOARDING_WIZARD_DEFERRED" },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
      })),
    ],
  }),
  defineRow({
    name: "cms/settings:updateSettings",
    kind: "mutation",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupModuleLanguageState(t, state),
      call: (actor: CallTarget) => actor.mutation(api.cms.settings.updateSettings, {
        siteName: "Changed by current owner",
      }),
      outcomes: {
        owner: { value: null },
        signedOut: { error: "UNAUTHENTICATED" },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
      },
      after: async (t: Site) => {
        const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
        expect(settings?.siteName).toBe("Changed by current owner")
      },
    })),
  }),
  defineRow({
    name: "cms/settings:setBrandingImage",
    kind: "mutation",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: async (t: Site) => {
        await setupModuleLanguageState(t, state)
        await t.run(async (ctx) => {
          const storageId = await ctx.storage.store(new Blob(["logo"], { type: "image/png" }))
          const settings = await ctx.db.query("siteSettings").unique()
          await ctx.db.patch(settings!._id, { logoStorageId: storageId })
        })
        return null
      },
      call: (actor: CallTarget) => actor.mutation(api.cms.settings.setBrandingImage, {
        slot: "logo",
      }),
      outcomes: {
        owner: { value: null },
        signedOut: { error: "UNAUTHENTICATED" },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
      },
      after: async (t: Site) => {
        const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
        expect(settings?.logoStorageId).toBeUndefined()
      },
    })),
  }),
  defineRow({
    name: "cms/modules:effective",
    kind: "query",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupModuleLanguageState(t, state),
      call: (actor: CallTarget) => actor.query(api.cms.modules.effective, {}),
      outcomes: {
        owner: {
          value: {
            version: state.redirects === "on" || state.language === "M05" ? 1 : 0,
            modules: [
              { id: "redirects", outcome: state.redirects === "on" ? "on" : "off" },
              { id: "multilingual", outcome: state.language === "M05" ? "on" : "off" },
              { id: "ai", outcome: "off" },
            ],
          },
        },
        signedOut: { error: "UNAUTHENTICATED" },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
      },
      readOnly: true,
    })),
  }),
  defineRow({
    name: "cms/modules:preview",
    kind: "query",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupModuleLanguageState(t, state),
      call: (actor: CallTarget) => actor.query(api.cms.modules.preview, { changes: [] }),
      outcomes: {
        owner: { check: (value: unknown) => expect(value).toMatchObject({ blockers: [], changes: [] }) },
        signedOut: { error: "UNAUTHENTICATED" },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
      },
      readOnly: true,
    })),
  }),
  defineRow<{ expectedConfigurationVersion: number }>({
    name: "cms/modules:commit",
    kind: "mutation",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: async (t: Site) => {
        await setupModuleLanguageState(t, state)
        return { expectedConfigurationVersion: state.redirects === "on" || state.language === "M05" ? 1 : 0 }
      },
      call: (actor: CallTarget, fixture) => actor.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: fixture.expectedConfigurationVersion,
        changes: [],
      }),
      outcomes: {
        owner: { check: (value: unknown) => expect(value).toMatchObject({ committed: false, changes: [] }) },
        signedOut: { error: "UNAUTHENTICATED" },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
      },
    })),
  }),
  protectedRow("cms/redirects:list", "query",
    (actor) => actor.query(api.cms.redirects.list, {}),
    () => expect.arrayContaining([expect.objectContaining({ fromPath: "/retired" })])),
  protectedRow("cms/redirects:listPaginated", "query",
    (actor) => actor.query(api.cms.redirects.listPaginated, {
      paginationOpts: { numItems: 10, cursor: null },
    }),
    () => expect.objectContaining({ page: expect.arrayContaining([
      expect.objectContaining({ fromPath: "/retired" }),
    ]) })),
  protectedRow("cms/redirects:create", "mutation",
    (actor) => actor.mutation(api.cms.redirects.create, {
      fromPath: "/old-new", toPath: "/new", statusCode: 301,
    }),
    () => expect.any(String)),
  protectedRow("cms/redirects:remove", "mutation",
    (actor, fixture) => actor.mutation(api.cms.redirects.remove, { id: fixture.redirectId }),
    () => null),
  publicRow("cms/redirects:listActiveKeys",
    (actor, fixture, stale) => actor.query(api.cms.redirects.listActiveKeys, {
      languageVersion: fixture.languageVersion + Number(stale),
    }),
    (state) => state.redirects === "on" ? [{ fromPath: "/retired", locale: undefined }] : []),
  publicRow("cms/redirects:resolve",
    (actor, fixture, stale) => actor.query(api.cms.redirects.resolve, {
      path: "/retired", locale: "en",
      languageVersion: fixture.languageVersion + Number(stale),
    }),
    (state) => state.redirects === "on" ? { destination: "/current", statusCode: 301 } : null),
  defineRow({
    name: "cms/owner:getOwnerEstablished",
    kind: "query",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupModuleLanguageState(t, state),
      call: (actor: CallTarget) => actor.query(api.cms.owner.getOwnerEstablished, {}),
      outcomes: {
        owner: { value: { established: true } },
        signedOut: { value: { established: true } },
        unrelated: { value: { established: true } },
        former: { value: { established: true } },
      },
      readOnly: true,
    })),
  }),
  defineRow({
    name: "cms/owner:getOwnerClaimAvailability",
    kind: "query",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupModuleLanguageState(t, state),
      call: (actor: CallTarget) => actor.query(api.cms.owner.getOwnerClaimAvailability, {}),
      outcomes: {
        owner: { value: { available: false } },
        signedOut: { value: { available: false } },
        unrelated: { value: { available: false } },
        former: { value: { available: false } },
      },
      readOnly: true,
    })),
  }),
  defineRow({
    name: "cms/owner:getOwnerSession",
    kind: "query",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: async (t: Site) => {
        await setupModuleLanguageState(t, state)
        const owner = await t.run((ctx) => ctx.db.query("cmsOwner").unique())
        return { ownerId: owner!._id }
      },
      call: (actor: CallTarget) => actor.query(api.cms.owner.getOwnerSession, {}),
      outcomes: ({ ownerId }) => ({
        owner: { value: { ownerId, authId: OWNER.subject, email: null, role: "admin" } },
        signedOut: { value: null },
        unrelated: { value: null },
        former: { value: null },
      }),
      readOnly: true,
    })),
  }),
  defineRow({
    name: "cms/userPreferences:getAdminLocale",
    kind: "query",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: async (t: Site) => {
        await setupModuleLanguageState(t, state)
        await t.run((ctx) => ctx.db.insert("userPreferences", {
          authId: OWNER.subject,
          adminLocale: "fr",
        }))
        return null
      },
      call: (actor: CallTarget) => actor.query(api.cms.userPreferences.getAdminLocale, {}),
      outcomes: {
        owner: { value: "fr" },
        signedOut: { value: null },
        unrelated: { value: null },
        former: { value: null },
      },
      readOnly: true,
    })),
  }),
  defineRow({
    name: "cms/userPreferences:setAdminLocale",
    kind: "mutation",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupModuleLanguageState(t, state),
      call: (actor: CallTarget) => actor.mutation(api.cms.userPreferences.setAdminLocale, {
        locale: "fr",
      }),
      outcomes: {
        owner: { value: null },
        signedOut: { error: "UNAUTHENTICATED" },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
      },
      after: async (t: Site) => {
        const preference = await t.run((ctx) => ctx.db.query("userPreferences").unique())
        expect(preference).toMatchObject({ authId: OWNER.subject, adminLocale: "fr" })
      },
    })),
  }),
]
