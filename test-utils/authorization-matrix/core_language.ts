import { expect, vi } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import {
  defineRow,
  MATRIX_STATES,
  OWNER,
  setupModuleLanguageState,
  stateLabel,
  type AuthorizationRow,
  type CallTarget,
  type MatrixState,
  type Site,
  type Outcome,
} from "./harness"

type TransitionId = Id<"siteLanguageTransitions">
type PageId = Id<"pages">
type Fixture = {
  transitionId: TransitionId
  pageId: PageId
  retainedReviewDigest?: string
}
const denied = {
  signedOut: { error: "UNAUTHENTICATED" },
  unrelated: { error: "CMS_OWNER_REQUIRED" },
  former: { error: "CMS_OWNER_REQUIRED" },
} as const

async function seedAdmin(t: Site) {
  await t.run(async (ctx) => {
    await ctx.db.insert("cmsMemberships", {
      authId: OWNER.subject, tokenIdentifier: OWNER.tokenIdentifier,
      role: "admin", status: "active", createdAt: 1, activatedAt: 1,
      updatedAt: 1, transitionId: "matrix-language-owner",
    })
    await ctx.db.insert("cmsCapacity", {
      key: "cms", activeCount: 1, reservedCount: 0, allowance: 3,
      overCap: false, migrationState: "ready", migrationVersion: 1,
      migrationIssueCount: 0, lastTransitionId: "matrix-language-ready", updatedAt: 1,
    })
  })
}

async function publishedHome(t: Site, owner: CallTarget, redirects: "off" | "on"): Promise<PageId> {
  await seedAdmin(t)
  await owner.mutation(api.cms.settings.bootstrapInstallation, {
    siteName: "Matrix language site", timezone: "UTC", defaultLocale: "en",
  })
  if (redirects === "on") {
    await t.run(async (ctx) => {
      const moduleRow = await ctx.db.query("cmsModuleState").unique()
      if (moduleRow) {
        await ctx.db.patch(moduleRow._id, {
          configurationVersion: moduleRow.configurationVersion + 1,
          enabledModules: [...moduleRow.enabledModules, { moduleId: "redirects", configVersion: 1 }],
        })
      } else {
        await ctx.db.insert("cmsModuleState", {
          key: "owner", configurationVersion: 1,
          enabledModules: [{ moduleId: "redirects", configVersion: 1 }],
        })
      }
    })
  }
  const home = await t.run((ctx) => ctx.db.query("siteSettings").unique())
  const pageId = home!.homePageId!
  const versions = await t.run(async (ctx) => ({
    state: await ctx.db.query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId).eq("locale", "en"))
      .unique(),
    shared: await ctx.db.query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId)).unique(),
    page: await ctx.db.query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId)).unique(),
  }))
  await owner.mutation(api.cms.publication.publishLocale, {
    pageId, locale: "en",
    expectedDraftGeneration: versions.state!.draftGeneration,
    expectedSharedDraftGeneration: versions.shared!.generation,
    expectedPublicGeneration: versions.state!.publicGeneration,
    expectedLifecycleGeneration: versions.page!.lifecycleGeneration,
    expectedReleaseGeneration: versions.state!.releaseGeneration,
  })
  await owner.mutation(api.cms.menus.createCanonical, { slug: "main" })
  return pageId
}

async function transition(t: Site, transitionId: TransitionId) {
  const row = await t.run((ctx) => ctx.db.get(transitionId))
  if (!row) throw new Error("matrix transition missing")
  return row
}

async function advanceUntil(
  t: Site,
  transitionId: TransitionId,
  predicate: (row: Awaited<ReturnType<typeof transition>>) => boolean,
) {
  for (let step = 0; step < 50; step += 1) {
    const row = await transition(t, transitionId)
    if (predicate(row)) return row
    await t.mutation(internal.cms.language.stepLanguageTransition, {
      transitionId, generation: row.generation,
    })
  }
  throw new Error("matrix transition did not advance")
}

async function startPublishedTransition(
  t: Site,
  owner: CallTarget,
  mode: "correct_label" | "replace_content",
  redirects: "off" | "on",
): Promise<Fixture> {
  const pageId = await publishedHome(t, owner, redirects)
  const versions = await t.run(async (ctx) => ({
    settings: await ctx.db.query("siteSettings").unique(),
    authority: await ctx.db.query("siteLanguageAuthority").unique(),
  }))
  const transitionId = await owner.mutation(api.cms.language.startLanguageTransition, {
    mode, sourceLocale: "en", targetLocale: "fr",
    expectedSettingsUpdatedAt: versions.settings!.updatedAt,
    expectedAuthorityVersion: versions.authority!.version,
  })
  await advanceUntil(t, transitionId, (row) =>
    row.phase === "preparing" && row.cursorPhase === undefined &&
    (mode === "replace_content" || row.unresolvedCount === 0)
  )
  return { transitionId, pageId }
}

async function rowFor(t: Site, fixture: Fixture) {
  const row = await t.run((ctx) => ctx.db.query("siteLanguageTransitionPages")
    .withIndex("by_transitionId_and_pageId", (q) =>
      q.eq("transitionId", fixture.transitionId).eq("pageId", fixture.pageId)
    ).unique())
  if (!row) throw new Error("matrix transition page missing")
  return row
}

async function sourceVersions(t: Site, pageId: PageId) {
  return t.run(async (ctx) => ({
    state: await ctx.db.query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId).eq("locale", "en"))
      .unique(),
    shared: await ctx.db.query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId)).unique(),
    page: await ctx.db.query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId)).unique(),
  }))
}

async function targetVersion(t: Site, pageId: PageId) {
  return t.run((ctx) => ctx.db.query("pageLocalePublicationStates")
    .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId).eq("locale", "fr"))
    .unique())
}

async function replacementAt(t: Site, owner: CallTarget, redirects: "off" | "on", stage: "started" | "disposition" | "copied" | "confirmed" | "prepared") {
  const fixture = await startPublishedTransition(t, owner, "replace_content", redirects)
  if (stage === "started") return fixture
  let page = await rowFor(t, fixture)
  await owner.mutation(api.cms.language.setPageDisposition, {
    transitionId: fixture.transitionId, pageId: fixture.pageId,
    disposition: "target", expectedPageGeneration: page.generation,
  })
  if (stage === "disposition") return fixture
  const source = await sourceVersions(t, fixture.pageId)
  await owner.mutation(api.cms.language.copySourceToTargetDraft, {
    transitionId: fixture.transitionId, pageId: fixture.pageId,
    expectedSourceDraftGeneration: source.state!.draftGeneration,
    expectedLifecycleGeneration: source.page!.lifecycleGeneration,
  })
  if (stage === "copied") return fixture
  page = await rowFor(t, fixture)
  const target = await targetVersion(t, fixture.pageId)
  await owner.mutation(api.cms.language.confirmTargetContent, {
    transitionId: fixture.transitionId, pageId: fixture.pageId,
    expectedTargetDraftGeneration: target!.draftGeneration,
    expectedSharedDraftGeneration: source.shared!.generation,
    expectedPageGeneration: page.generation,
  })
  if (stage === "confirmed") return fixture
  page = await rowFor(t, fixture)
  await owner.mutation(api.cms.language.prepareTargetPage, {
    transitionId: fixture.transitionId, pageId: fixture.pageId,
    expectedPageGeneration: page.generation,
  })
  return fixture
}

async function openRetainedDraftFixture(t: Site, owner: CallTarget, redirects: "off" | "on"): Promise<Fixture> {
  const pageId = await publishedHome(t, owner, redirects)
  await t.run(async (ctx) => {
    const source = await ctx.db.query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId).eq("locale", "en"))
      .unique()
    const snapshot = await ctx.db.get(source!.currentSnapshotId!)
    await ctx.db.insert("pageLocalePublicationStates", {
      pageId, locale: "fr", draftGeneration: 1, publicGeneration: 0,
      releaseGeneration: 0, hasCurrentSnapshot: false, updatedAt: 1,
    })
    await ctx.db.insert("pageLocaleDrafts", {
      pageId, locale: "fr", pageType: "landing-page", generation: 1,
      slug: "accueil", content: { title: "Brouillon conserve", slices: [] },
      updatedBy: snapshot!.attribution, createdAt: 1, updatedAt: 1,
    })
  })
  const versions = await t.run(async (ctx) => ({
    settings: await ctx.db.query("siteSettings").unique(),
    authority: await ctx.db.query("siteLanguageAuthority").unique(),
  }))
  const transitionId = await owner.mutation(api.cms.language.startLanguageTransition, {
    mode: "replace_content", sourceLocale: "en", targetLocale: "fr",
    expectedSettingsUpdatedAt: versions.settings!.updatedAt,
    expectedAuthorityVersion: versions.authority!.version,
  })
  await advanceUntil(t, transitionId, (row) => row.phase === "preparing" && row.cursorPhase === undefined)
  const report = await owner.query(api.cms.language.listLanguageTransitionPages, {
    transitionId,
    paginationOpts: { numItems: 10, cursor: null },
  })
  const retained = report.page.find((row) => row.pageId === pageId)?.retainedTarget
  if (!retained) throw new Error("matrix retained review missing")
  return { transitionId, pageId, retainedReviewDigest: retained.reviewDigest }
}

async function retainedDraftFixture(t: Site, owner: CallTarget, redirects: "off" | "on"): Promise<Fixture> {
  const fixture = await openRetainedDraftFixture(t, owner, redirects)
  const { transitionId } = fixture
  const current = await transition(t, transitionId)
  await owner.mutation(api.cms.language.cancelLanguageTransition, {
    transitionId, expectedGeneration: current.generation, discardTargetDrafts: false,
  })
  await advanceUntil(t, transitionId, (row) => row.phase === "cancelled")
  return fixture
}

async function baseline(t: Site, state: MatrixState): Promise<Fixture> {
  await setupModuleLanguageState(t, state)
  return t.run(async (ctx) => {
    const pageId = await ctx.db.insert("pages", {
      pageType: "landing-page", slug: "matrix", status: "draft",
      content: {}, createdAt: 1, updatedAt: 1,
    })
    const owner = await ctx.db.query("cmsOwner").unique()
    const transitionId = await ctx.db.insert("siteLanguageTransitions", {
      mode: "replace_content", sourceLocale: "en", targetLocale: "fr",
      phase: "preparing", generation: 1, startAuthorityVersion: 1,
      startSettingsUpdatedAt: 1, shortPath: false, sourcePublicSetVersion: 0,
      preparedSetVersion: 0, pageCount: 1, targetCount: 0,
      withdrawCount: 0, redirectCount: 0, unresolvedCount: 1,
      blockedCount: 0, targetDrafts: "retained",
      attribution: { kind: "owner", ownerId: owner!._id,
        authId: OWNER.subject, tokenIdentifier: OWNER.tokenIdentifier },
      createdAt: 1, updatedAt: 1,
    })
    const authority = await ctx.db.query("siteLanguageAuthority").unique()
    await ctx.db.patch(authority!._id, { activeTransitionId: transitionId })
    return { transitionId, pageId }
  })
}

async function snapshotS4(t: Site, redirects: "off" | "on"): Promise<Fixture> {
  const fixture = await baseline(t, { redirects, language: "M05" })
  await t.run(async (ctx) => {
    const cutover = await ctx.db.query("pagePublicationCutover").unique()
    await ctx.db.patch(cutover!._id, { phase: "snapshot_active", revision: 2 })
    const authority = await ctx.db.query("siteLanguageAuthority").unique()
    await ctx.db.patch(authority!._id, { activeTransitionId: undefined })
    await ctx.db.patch(fixture.transitionId, { phase: "committed", committedAt: 2 })
  })
  return fixture
}

type ActionFixture = Fixture & {
  pageGeneration: number
  sourceDraftGeneration: number
  targetDraftGeneration: number
  lifecycleGeneration: number
  sharedGeneration: number
  preparedSetVersion: number
  generation: number
  authorityVersion: number
  settingsUpdatedAt: number
  readinessVersion: number
}

async function actionFixture(t: Site, fixture: Fixture): Promise<ActionFixture> {
  const [row, source, target, current, settings, authority] = await Promise.all([
    rowFor(t, fixture).catch(() => null),
    sourceVersions(t, fixture.pageId),
    targetVersion(t, fixture.pageId),
    transition(t, fixture.transitionId),
    t.run((ctx) => ctx.db.query("siteSettings").unique()),
    t.run((ctx) => ctx.db.query("siteLanguageAuthority").unique()),
  ])
  return {
    ...fixture,
    pageGeneration: row?.generation ?? 1,
    sourceDraftGeneration: source.state?.draftGeneration ?? 0,
    targetDraftGeneration: target?.draftGeneration ?? 0,
    lifecycleGeneration: source.page?.lifecycleGeneration ?? 1,
    sharedGeneration: source.shared?.generation ?? 0,
    preparedSetVersion: current.preparedSetVersion,
    generation: current.generation,
    authorityVersion: authority?.version ?? 1,
    settingsUpdatedAt: settings?.updatedAt ?? 1,
    readinessVersion: current.manifest?.readinessVersion ?? 0,
  }
}

function protectedMutation(
  name: string,
  call: (actor: CallTarget, fixture: ActionFixture) => Promise<unknown>,
  positive: (t: Site, owner: CallTarget, redirects: "off" | "on") => Promise<Fixture>,
  owner: Outcome,
  after?: (t: Site, fixture: ActionFixture) => Promise<void>,
): AuthorizationRow {
  return defineRow<ActionFixture>({
    name: `cms/language:${name}`,
    kind: "mutation",
    requiredScenarioLabels: [
      "snapshot-F09/redirects-off", "snapshot-F09/redirects-on",
      "snapshot-S4/redirects-off", "snapshot-S4/redirects-on",
    ],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: async (t: Site) => actionFixture(t, await baseline(t, state)),
        call,
        outcomes: { ...denied, owner: { error: "LANGUAGE_TRANSITION_REQUIRES_SNAPSHOT_AUTHORITY" } },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-F09/redirects-${redirects}`,
        setup: async (t: Site, actors: { owner: CallTarget }) => {
          vi.useFakeTimers()
          try {
            return await actionFixture(t, await positive(t, actors.owner, redirects))
          } catch (error) {
            vi.useRealTimers()
            throw error
          }
        },
        call,
        outcomes: { ...denied, owner },
        after,
        teardown: async () => { vi.useRealTimers() },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: async (t: Site) => actionFixture(t, await snapshotS4(t, redirects)),
        call,
        outcomes: { ...denied, owner: { error: "LANGUAGE_TRANSITION_MULTILINGUAL_ENABLED" } },
      })),
    ],
  })
}

async function correctionConfirmed(t: Site, owner: CallTarget, redirects: "off" | "on") {
  const fixture = await startPublishedTransition(t, owner, "correct_label", redirects)
  const current = await transition(t, fixture.transitionId)
  await owner.mutation(api.cms.language.confirmTransitionPreview, {
    transitionId: fixture.transitionId,
    expectedPreparedSetVersion: current.preparedSetVersion,
  })
  return fixture
}

async function correctionValidating(t: Site, owner: CallTarget, redirects: "off" | "on") {
  const fixture = await correctionConfirmed(t, owner, redirects)
  const current = await transition(t, fixture.transitionId)
  await owner.mutation(api.cms.language.validateLanguageTransition, {
    transitionId: fixture.transitionId, expectedGeneration: current.generation,
  })
  return fixture
}

async function correctionReady(t: Site, owner: CallTarget, redirects: "off" | "on") {
  const fixture = await correctionValidating(t, owner, redirects)
  await advanceUntil(t, fixture.transitionId, (row) => row.phase === "ready")
  return fixture
}

export const coreLanguageRows: AuthorizationRow[] = [
  defineRow({
    name: "cms/language:getRetainedTargetDraftRemedy",
    kind: "query",
    requiredScenarioLabels: ["snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => baseline(t, state),
        call: (actor: CallTarget, fixture: Fixture) => actor.query(api.cms.language.getRetainedTargetDraftRemedy, { pageId: fixture.pageId }),
        outcomes: { owner: { error: "LANGUAGE_TRANSITION_REQUIRES_SNAPSHOT_AUTHORITY" }, signedOut: { value: null }, unrelated: { value: null }, former: { value: null } },
        readOnly: true,
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-F09/redirects-${redirects}`,
        setup: async (t: Site, actors: { owner: CallTarget }) => {
          vi.useFakeTimers()
          try { return await retainedDraftFixture(t, actors.owner, redirects) }
          catch (error) { vi.useRealTimers(); throw error }
        },
        call: (actor: CallTarget, fixture: Fixture) => actor.query(api.cms.language.getRetainedTargetDraftRemedy, { pageId: fixture.pageId }),
        outcomes: (fixture: Fixture) => ({
          owner: { value: {
            transitionId: fixture.transitionId, pageId: fixture.pageId,
            locale: "fr", draftGeneration: 1, lifecycleGeneration: 1,
          } },
          signedOut: { value: null }, unrelated: { value: null }, former: { value: null },
        }),
        readOnly: true,
        teardown: async () => { vi.useRealTimers() },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => snapshotS4(t, redirects),
        call: (actor: CallTarget, fixture: Fixture) => actor.query(api.cms.language.getRetainedTargetDraftRemedy, { pageId: fixture.pageId }),
        outcomes: { owner: { value: null }, signedOut: { value: null }, unrelated: { value: null }, former: { value: null } },
        readOnly: true,
      })),
    ],
  }),
  defineRow({
    name: "cms/language:deleteRetainedTargetDraft",
    kind: "mutation",
    requiredScenarioLabels: ["snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => baseline(t, state),
        call: (actor: CallTarget, fixture: Fixture) => actor.mutation(api.cms.language.deleteRetainedTargetDraft, {
          transitionId: fixture.transitionId, pageId: fixture.pageId,
          locale: "fr", draftGeneration: 1, lifecycleGeneration: 1,
        }),
        outcomes: { ...denied, owner: { error: "LANGUAGE_TRANSITION_REQUIRES_SNAPSHOT_AUTHORITY" } },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-F09/redirects-${redirects}`,
        setup: async (t: Site, actors: { owner: CallTarget }) => {
          vi.useFakeTimers()
          try { return await retainedDraftFixture(t, actors.owner, redirects) }
          catch (error) { vi.useRealTimers(); throw error }
        },
        call: (actor: CallTarget, fixture: Fixture) => actor.mutation(api.cms.language.deleteRetainedTargetDraft, {
          transitionId: fixture.transitionId, pageId: fixture.pageId,
          locale: "fr", draftGeneration: 1, lifecycleGeneration: 1,
        }),
        outcomes: { ...denied, owner: { check: (value: unknown) => expect(value).toMatchObject({ generation: expect.any(Number) }) } },
        after: async (t: Site, fixture: Fixture) => {
          const draft = await t.run((ctx) => ctx.db.query("pageLocaleDrafts")
            .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", fixture.pageId).eq("locale", "fr"))
            .unique())
          expect(draft).toBeNull()
        },
        teardown: async () => { vi.useRealTimers() },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => snapshotS4(t, redirects),
        call: (actor: CallTarget, fixture: Fixture) => actor.mutation(api.cms.language.deleteRetainedTargetDraft, {
          transitionId: fixture.transitionId, pageId: fixture.pageId,
          locale: "fr", draftGeneration: 1, lifecycleGeneration: 1,
        }),
        outcomes: { ...denied, owner: { error: "RETAINED_TARGET_DRAFT_NOT_AVAILABLE" } },
      })),
    ],
  }),
  defineRow({
    name: "cms/language:getSourcePublicationNotice",
    kind: "query",
    requiredScenarioLabels: ["snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => baseline(t, state),
        call: (actor: CallTarget, fixture: Fixture) => actor.query(api.cms.language.getSourcePublicationNotice, { pageId: fixture.pageId }),
        outcomes: { owner: { value: null }, signedOut: { value: null }, unrelated: { value: null }, former: { value: null } },
        readOnly: true,
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-F09/redirects-${redirects}`,
        setup: async (t: Site, actors: { owner: CallTarget }) => {
          vi.useFakeTimers()
          try { return await startPublishedTransition(t, actors.owner, "replace_content", redirects) }
          catch (error) { vi.useRealTimers(); throw error }
        },
        call: (actor: CallTarget, fixture: Fixture) => actor.query(api.cms.language.getSourcePublicationNotice, { pageId: fixture.pageId }),
        outcomes: {
          owner: { value: { sourceLocale: "en", targetLocale: "fr", sharedChangedSinceSourcePublication: false } },
          signedOut: { value: null }, unrelated: { value: null }, former: { value: null },
        },
        readOnly: true,
        teardown: async () => { vi.useRealTimers() },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => snapshotS4(t, redirects),
        call: (actor: CallTarget, fixture: Fixture) => actor.query(api.cms.language.getSourcePublicationNotice, { pageId: fixture.pageId }),
        outcomes: { owner: { value: null }, signedOut: { value: null }, unrelated: { value: null }, former: { value: null } },
        readOnly: true,
      })),
    ],
  }),
  protectedMutation(
    "confirmTransitionPreview",
    (actor, fixture) => actor.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId: fixture.transitionId,
      expectedPreparedSetVersion: fixture.preparedSetVersion,
    }),
    (t, owner, redirects) => startPublishedTransition(t, owner, "correct_label", redirects),
    { check: (value: unknown) => expect(value).toMatchObject({ preparedSetVersion: expect.any(Number) }) },
    async (t, fixture) => {
      const current = await transition(t, fixture.transitionId)
      expect(current.previewConfirmedPreparedSetVersion).toBe(current.preparedSetVersion)
    },
  ),
  protectedMutation(
    "validateLanguageTransition",
    (actor, fixture) => actor.mutation(api.cms.language.validateLanguageTransition, {
      transitionId: fixture.transitionId, expectedGeneration: fixture.generation,
    }),
    correctionConfirmed,
    { check: (value: unknown) => expect(value).toMatchObject({ generation: expect.any(Number) }) },
    async (t, fixture) => {
      const current = await transition(t, fixture.transitionId)
      expect(current.phase).toBe("validating")
    },
  ),
  protectedMutation(
    "activateLanguageTransition",
    (actor, fixture) => actor.mutation(api.cms.language.activateLanguageTransition, {
      transitionId: fixture.transitionId,
      expectedGeneration: fixture.generation,
      expectedAuthorityVersion: fixture.authorityVersion,
      expectedSettingsUpdatedAt: fixture.settingsUpdatedAt,
      expectedReadinessVersion: fixture.readinessVersion,
    }),
    correctionReady,
    { check: (value: unknown) => expect(value).toMatchObject({ version: 2, currentLocale: "fr" }) },
    async (t, fixture) => {
      const current = await transition(t, fixture.transitionId)
      expect(current.phase).toBe("committed")
    },
  ),
  protectedMutation(
    "setPageDisposition",
    (actor, fixture) => actor.mutation(api.cms.language.setPageDisposition, {
      transitionId: fixture.transitionId, pageId: fixture.pageId,
      disposition: "target", expectedPageGeneration: fixture.pageGeneration,
      ...(fixture.retainedReviewDigest ? { retainedTargetReview: {
        digest: fixture.retainedReviewDigest, basis: "draft" as const,
      } } : {}),
    }),
    openRetainedDraftFixture,
    { check: (value: unknown) => expect(value).toMatchObject({ generation: expect.any(Number) }) },
    async (t, fixture) => {
      expect(await rowFor(t, fixture)).toMatchObject({
        disposition: "target",
        target: { targetBasis: "draft", retainedReview: expect.any(Object) },
      })
    },
  ),
  protectedMutation(
    "copySourceToTargetDraft",
    (actor, fixture) => actor.mutation(api.cms.language.copySourceToTargetDraft, {
      transitionId: fixture.transitionId, pageId: fixture.pageId,
      expectedSourceDraftGeneration: fixture.sourceDraftGeneration,
      expectedLifecycleGeneration: fixture.lifecycleGeneration,
    }),
    (t, owner, redirects) => replacementAt(t, owner, redirects, "disposition"),
    { check: (value: unknown) => expect(value).toMatchObject({ draftGeneration: expect.any(Number) }) },
    async (t, fixture) => {
      const target = await targetVersion(t, fixture.pageId)
      expect(target?.draftGeneration).toBeGreaterThan(0)
    },
  ),
  protectedMutation(
    "confirmTargetContent",
    (actor, fixture) => actor.mutation(api.cms.language.confirmTargetContent, {
      transitionId: fixture.transitionId, pageId: fixture.pageId,
      expectedTargetDraftGeneration: fixture.targetDraftGeneration,
      expectedSharedDraftGeneration: fixture.sharedGeneration,
      expectedPageGeneration: fixture.pageGeneration,
    }),
    (t, owner, redirects) => replacementAt(t, owner, redirects, "copied"),
    { check: (value: unknown) => expect(value).toMatchObject({ generation: expect.any(Number) }) },
    async (t, fixture) => {
      expect(await rowFor(t, fixture)).toMatchObject({ status: "stale", target: {
        confirmedDraftGeneration: fixture.targetDraftGeneration,
        confirmedSharedDraftGeneration: fixture.sharedGeneration,
      } })
    },
  ),
  protectedMutation(
    "prepareTargetPage",
    (actor, fixture) => actor.mutation(api.cms.language.prepareTargetPage, {
      transitionId: fixture.transitionId, pageId: fixture.pageId,
      expectedPageGeneration: fixture.pageGeneration,
    }),
    (t, owner, redirects) => replacementAt(t, owner, redirects, "confirmed"),
    { check: (value: unknown) => expect(value).toMatchObject({ snapshotId: expect.any(String), generation: expect.any(Number) }) },
    async (t, fixture) => {
      expect(await rowFor(t, fixture)).toMatchObject({ status: "ready" })
    },
  ),
]
