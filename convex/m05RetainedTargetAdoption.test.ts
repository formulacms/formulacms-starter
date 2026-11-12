/// <reference types="vite/client" />

import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { ConvexError } from "convex/values"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { readCurrentSnapshotProjection } from "./lib/publishing/snapshots"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "m05-retained-adoption-owner",
  tokenIdentifier: "https://convex.test|m05-retained-adoption-owner",
}
const NOW = Date.UTC(2026, 8, 28, 18, 0, 0)

type T = ReturnType<typeof convexTest>
type Caller = ReturnType<T["withIdentity"]>

type RetainedTargetReport = {
  decisionCurrent: boolean
  decisionBasis: "retained_snapshot" | "draft" | null
  reviewDigest: string
  targetLocale: string
  selection: null | {
    snapshotId: Id<"pagePublishedSnapshots">
    publishedAt: number
    title: string
    path: string | null
    seoTitle: string | null
    seoDescription: string | null
    contentKeys: string[]
  }
  draftBaseSnapshotId: Id<"pagePublishedSnapshots"> | null
  workingDraft: null | {
    generation: number
    slug: string
    title: string
    contentKeys: string[]
    differsFromSelection: boolean
  }
  sharedDraft: null | {
    generation: number
    differsFromSelection: boolean
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

function app() {
  return convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
}

async function drain(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers)
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ConvexError) return String(error.data)
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected the call to be refused")
}

async function refusalCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    if (error instanceof ConvexError) return String(error.data)
    return error instanceof Error ? error.message : String(error)
  }
}

async function generations(t: T, pageId: Id<"pages">, locale: string) {
  return t.run(async (ctx) => ({
    state: await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique(),
    shared: await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique(),
    page: await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique(),
  }))
}

async function publish(
  t: T,
  owner: Caller,
  pageId: Id<"pages">,
  locale: string
) {
  const { state, shared, page } = await generations(t, pageId, locale)
  return owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale,
    expectedDraftGeneration: state!.draftGeneration,
    expectedSharedDraftGeneration: shared!.generation,
    expectedPublicGeneration: state!.publicGeneration,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
    expectedReleaseGeneration: state!.releaseGeneration,
  })
}

async function saveDraft(
  t: T,
  owner: Caller,
  pageId: Id<"pages">,
  locale: string,
  slug: string,
  title: string
) {
  const { state, page } = await generations(t, pageId, locale)
  return owner.mutation(api.cms.publication.saveLocaleDraft, {
    pageId,
    locale,
    slug,
    draft: {
      pageType: "landing-page",
      localized: { title },
      slices: [],
    } as never,
    expectedDraftGeneration: state?.draftGeneration ?? 0,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
  })
}

async function authorityVersion(t: T) {
  return (await t.run((ctx) => ctx.db.query("siteLanguageAuthority").unique()))!
    .version
}

async function moduleConfigurationVersion(t: T) {
  return (
    (await t.run((ctx) => ctx.db.query("cmsModuleState").first()))
      ?.configurationVersion ?? 0
  )
}

async function toggleMultilingual(t: T, owner: Caller, enabled: boolean) {
  const changes = [{ moduleId: "multilingual", enabled }]
  if (!enabled) {
    const preview = await owner.query(api.cms.modules.preview, { changes })
    return owner.mutation(api.cms.modules.commit, {
      expectedConfigurationVersion: preview.configurationVersion,
      changes,
      multilingualCommandTokens: preview.multilingualCommandTokens,
    })
  }
  return owner.mutation(api.cms.modules.commit, {
    expectedConfigurationVersion: await moduleConfigurationVersion(t),
    changes,
  })
}

async function adoptMultilingual(t: T, owner: Caller) {
  const preview = await owner.query(api.cms.multilingual.previewAdoption, {})
  if (!preview.canAdopt) throw new Error(preview.blockerCode ?? "cannot adopt")
  const { canAdopt, defaultLocale, enabledLocales, ...tokens } = preview
  void canAdopt
  void defaultLocale
  void enabledLocales
  return owner.mutation(api.cms.multilingual.adoptMultilingualAuthority, tokens)
}

async function addLanguage(
  t: T,
  owner: Caller,
  locale: string,
  preview?: {
    previewId: Id<"siteLanguageImpactPreviews">
    expectedDigest: string
    expectedCount: {
      publicPages: number
      routes: number
      menus: number
      manualRules: number
    }
  }
) {
  return owner.mutation(api.cms.multilingual.addLanguage, {
    locale,
    expectedAuthorityVersion: await authorityVersion(t),
    expectedModuleConfigurationVersion: await moduleConfigurationVersion(t),
    ...(preview ? { preview } : {}),
  })
}

async function completeImpactPreview(
  t: T,
  owner: Caller,
  kind: "remove" | "reveal",
  locale: string
) {
  const { previewId } = await owner.mutation(
    api.cms.multilingual.startLanguageImpactPreview,
    { kind, locale }
  )
  for (let guard = 0; guard < 200; guard += 1) {
    const preview = await t.run((ctx) => ctx.db.get(previewId))
    if (!preview) throw new Error("impact preview missing")
    if (preview.phase !== "scanning") break
    await t.mutation(internal.cms.multilingual.stepLanguageImpactPreview, {
      previewId,
      generation: preview.generation,
    })
  }
  const preview = (await t.run((ctx) => ctx.db.get(previewId)))!
  expect(preview.phase).toBe("complete")
  for (let ordinal = 0; ordinal < preview.pageCount; ordinal += 1) {
    const listed = await owner.query(api.cms.multilingual.listLanguageImpact, {
      previewId,
      ordinal,
    })
    expect(listed.stale).toBe(false)
    if (listed.stale) throw new Error("impact preview became stale")
    await owner.mutation(api.cms.multilingual.recordLanguageImpactReview, {
      previewId,
      ordinal,
      pageDigest: listed.digest,
    })
  }
  const reviewed = (await t.run((ctx) => ctx.db.get(previewId)))!
  return {
    previewId,
    expectedDigest: reviewed.digest,
    expectedCount: reviewed.count,
  }
}

async function removeLanguage(t: T, owner: Caller, locale: string) {
  const claim = await completeImpactPreview(t, owner, "remove", locale)
  return owner.mutation(api.cms.multilingual.removeLanguage, claim)
}

async function startTransition(
  t: T,
  owner: Caller,
  mode: "correct_label" | "replace_content",
  targetLocale: string
) {
  const [settings, authority] = await t.run(async (ctx) => [
    (await ctx.db.query("siteSettings").unique())!,
    (await ctx.db.query("siteLanguageAuthority").unique())!,
  ])
  const transitionId = await owner.mutation(
    api.cms.language.startLanguageTransition,
    {
      mode,
      sourceLocale: authority.currentLocale,
      targetLocale,
      expectedSettingsUpdatedAt: settings.updatedAt,
      expectedAuthorityVersion: authority.version,
    }
  )
  await drain(t)
  return transitionId
}

async function startReplacement(t: T, owner: Caller, targetLocale: string) {
  return startTransition(t, owner, "replace_content", targetLocale)
}

async function transitionReport(
  owner: Caller,
  transitionId: Id<"siteLanguageTransitions">
) {
  return owner.query(api.cms.language.listLanguageTransitionPages, {
    transitionId,
    paginationOpts: { numItems: 100, cursor: null },
  })
}

function retainedRow(
  report: Awaited<ReturnType<typeof transitionReport>>,
  pageId: Id<"pages">
) {
  const row = report.page.find((candidate) => candidate.pageId === pageId)
  if (!row) throw new Error("transition page missing")
  return row
}

async function adoptRetainedSnapshot(
  owner: Caller,
  transitionId: Id<"siteLanguageTransitions">,
  pageId: Id<"pages">
) {
  const report = await transitionReport(owner, transitionId)
  const row = report.page.find((candidate) => candidate.pageId === pageId)
  if (!row) throw new Error("transition page missing")
  const retainedTarget = (
    row as typeof row & { retainedTarget: RetainedTargetReport | null }
  ).retainedTarget
  expect(retainedTarget).toMatchObject({
    targetLocale: "fr",
    selection: { title: "Accueil publié", path: "/" },
    workingDraft: {
      title: "Accueil privé",
      differsFromSelection: true,
    },
  })
  const decision = await owner.mutation(
    api.cms.language.setPageDisposition,
    {
      transitionId,
      pageId,
      disposition: "target",
      expectedPageGeneration: row.generation,
      retainedTargetReview: {
        digest: retainedTarget!.reviewDigest,
        basis: "retained_snapshot",
      },
    } as never
  )
  return owner.mutation(api.cms.language.prepareTargetPage, {
    transitionId,
    pageId,
    expectedPageGeneration: decision.generation,
  })
}

async function activateReplacement(
  t: T,
  owner: Caller,
  transitionId: Id<"siteLanguageTransitions">
) {
  let transition = (await t.run((ctx) => ctx.db.get(transitionId)))!
  await owner.mutation(api.cms.language.confirmTransitionPreview, {
    transitionId,
    expectedPreparedSetVersion: transition.preparedSetVersion,
    ...(transition.carryDecisionDigest
      ? { expectedCarryDecisionDigest: transition.carryDecisionDigest }
      : {}),
  })
  transition = (await t.run((ctx) => ctx.db.get(transitionId)))!
  await owner.mutation(api.cms.language.validateLanguageTransition, {
    transitionId,
    expectedGeneration: transition.generation,
  })
  await drain(t)
  transition = (await t.run((ctx) => ctx.db.get(transitionId)))!
  expect(transition.phase).toBe("ready")
  const [settings, authority] = await t.run(async (ctx) => [
    (await ctx.db.query("siteSettings").unique())!,
    (await ctx.db.query("siteLanguageAuthority").unique())!,
  ])
  return owner.mutation(api.cms.language.activateLanguageTransition, {
    transitionId,
    expectedGeneration: transition.generation,
    expectedAuthorityVersion: authority.version,
    expectedSettingsUpdatedAt: settings.updatedAt,
    expectedReadinessVersion: transition.manifest!.readinessVersion,
  })
}

async function startRetainedReplacement(
  t: T,
  owner: Caller,
  basis: "retained_snapshot" | "draft",
  options: { keepSourceDraft?: boolean } = {}
) {
  await owner.mutation(api.cms.settings.bootstrapInstallation, {
    siteName: `Retained ${basis} successor`,
    timezone: "UTC",
    defaultLocale: "en",
  })
  const settings = (await t.run((ctx) => ctx.db.query("siteSettings").unique()))!
  const homeId = settings.homePageId!
  await publish(t, owner, homeId, "en")
  if (options.keepSourceDraft) {
    await saveDraft(t, owner, homeId, "en", "home-updated", "Home updated")
  }
  await toggleMultilingual(t, owner, true)
  await adoptMultilingual(t, owner)
  await addLanguage(t, owner, "fr")
  await saveDraft(t, owner, homeId, "fr", "accueil", "Accueil conservé")
  if (basis === "retained_snapshot") {
    await publish(t, owner, homeId, "fr")
  }
  await removeLanguage(t, owner, "fr")
  await owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
    expectedAuthorityVersion: await authorityVersion(t),
  })
  await toggleMultilingual(t, owner, false)
  return { homeId, transitionId: await startReplacement(t, owner, "fr") }
}

async function reviewAndPrepareDraft(
  t: T,
  owner: Caller,
  transitionId: Id<"siteLanguageTransitions">,
  pageId: Id<"pages">
) {
  const row = retainedRow(await transitionReport(owner, transitionId), pageId)
  const retained = row.retainedTarget as RetainedTargetReport | null
  expect(retained).not.toBeNull()
  const decision = await owner.mutation(api.cms.language.setPageDisposition, {
    transitionId,
    pageId,
    disposition: "target",
    expectedPageGeneration: row.generation,
    retainedTargetReview: {
      digest: retained!.reviewDigest,
      basis: "draft",
    },
  })
  const { state, shared } = await generations(t, pageId, "fr")
  const confirmation = await owner.mutation(
    api.cms.language.confirmTargetContent,
    {
      transitionId,
      pageId,
      expectedTargetDraftGeneration: state!.draftGeneration,
      expectedSharedDraftGeneration: shared!.generation,
      expectedPageGeneration: decision.generation,
    }
  )
  return owner.mutation(api.cms.language.prepareTargetPage, {
    transitionId,
    pageId,
    expectedPageGeneration: confirmation.generation,
  })
}

test(
  "the owner adopts an M05 retained snapshot without republishing, keeps its newer draft through cancellation, then reveals the old source after F09",
  async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Retained target adoption",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const settings = (await t.run((ctx) => ctx.db.query("siteSettings").unique()))!
    const homeId = settings.homePageId!
    await publish(t, owner, homeId, "en")
    const englishSnapshotId = (await generations(t, homeId, "en")).state!
      .currentSnapshotId!

    await toggleMultilingual(t, owner, true)
    await adoptMultilingual(t, owner)
    await addLanguage(t, owner, "fr")
    await saveDraft(t, owner, homeId, "fr", "accueil", "Accueil publié")
    await publish(t, owner, homeId, "fr")
    const selected = (await generations(t, homeId, "fr")).state!
    const retainedSnapshotId = selected.currentSnapshotId!
    const retainedPublicGeneration = selected.publicGeneration
    await saveDraft(t, owner, homeId, "fr", "accueil-prive", "Accueil privé")
    const retainedDraft = await t.run((ctx) =>
      ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", homeId).eq("locale", "fr")
        )
        .unique()
    )

    await removeLanguage(t, owner, "fr")
    await owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
      expectedAuthorityVersion: await authorityVersion(t),
    })
    await toggleMultilingual(t, owner, false)

    const cancelledId = await startReplacement(t, owner, "fr")
    const cancelledReport = retainedRow(
      await transitionReport(owner, cancelledId),
      homeId
    )
    expect(
      await codeOf(
        owner.mutation(api.cms.language.setPageDisposition, {
          transitionId: cancelledId,
          pageId: homeId,
          disposition: "target",
          expectedPageGeneration: cancelledReport.generation,
          retainedTargetReview: {
            digest: cancelledReport.retainedTarget!.reviewDigest,
            basis: "draft",
          },
        })
      )
    ).toBe("RETAINED_TARGET_SELECTION_MUST_BE_WITHDRAWN")
    expect(
      await adoptRetainedSnapshot(owner, cancelledId, homeId)
    ).toMatchObject({ snapshotId: retainedSnapshotId })
    let cancelled = (await t.run((ctx) => ctx.db.get(cancelledId)))!
    await owner.mutation(api.cms.language.cancelLanguageTransition, {
      transitionId: cancelledId,
      expectedGeneration: cancelled.generation,
      discardTargetDrafts: true,
    })
    await drain(t)
    cancelled = (await t.run((ctx) => ctx.db.get(cancelledId)))!
    expect(cancelled.phase).toBe("cancelled")
    const afterCancel = await generations(t, homeId, "fr")
    expect(afterCancel.state).toMatchObject({
      currentSnapshotId: retainedSnapshotId,
      publicGeneration: retainedPublicGeneration,
      hasCurrentSnapshot: true,
    })
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", homeId).eq("locale", "fr")
          )
          .unique()
      )
    ).toEqual(retainedDraft)

    const transitionId = await startReplacement(t, owner, "fr")
    expect(
      await adoptRetainedSnapshot(owner, transitionId, homeId)
    ).toMatchObject({ snapshotId: retainedSnapshotId })
    expect((await generations(t, homeId, "fr")).state!.publicGeneration).toBe(
      retainedPublicGeneration
    )
    await activateReplacement(t, owner, transitionId)
    const frenchPublic = await t.run((ctx) =>
      readCurrentSnapshotProjection(ctx, homeId, "fr")
    )
    expect(frenchPublic?.payload.localized.content.title).toBe(
      "Accueil publié"
    )

    await toggleMultilingual(t, owner, true)
    await adoptMultilingual(t, owner)
    const reveal = await completeImpactPreview(t, owner, "reveal", "en")
    await addLanguage(t, owner, "en", reveal)
    expect((await generations(t, homeId, "en")).state!.currentSnapshotId).toBe(
      englishSnapshotId
    )
  },
  120_000
)

test(
  "an M05 retained Working Draft needs a separate confirmed draft decision and is never treated as transition-created",
  async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Retained draft adoption",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const settings = (await t.run((ctx) => ctx.db.query("siteSettings").unique()))!
    const homeId = settings.homePageId!
    await publish(t, owner, homeId, "en")
    await toggleMultilingual(t, owner, true)
    await adoptMultilingual(t, owner)
    await addLanguage(t, owner, "fr")
    await saveDraft(t, owner, homeId, "fr", "accueil", "Accueil privé")
    const retainedDraft = await t.run((ctx) =>
      ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", homeId).eq("locale", "fr")
        )
        .unique()
    )

    await removeLanguage(t, owner, "fr")
    await owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
      expectedAuthorityVersion: await authorityVersion(t),
    })
    await toggleMultilingual(t, owner, false)

    const undecidedId = await startReplacement(t, owner, "fr")
    const undecided = (await t.run((ctx) => ctx.db.get(undecidedId)))!
    await owner.mutation(api.cms.language.cancelLanguageTransition, {
      transitionId: undecidedId,
      expectedGeneration: undecided.generation,
      discardTargetDrafts: true,
    })
    await drain(t)
    expect((await t.run((ctx) => ctx.db.get(undecidedId)))!.phase).toBe(
      "cancelled"
    )
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", homeId).eq("locale", "fr")
          )
          .unique()
      )
    ).toEqual(retainedDraft)

    const transitionId = await startReplacement(t, owner, "fr")
    const report = await transitionReport(owner, transitionId)
    const reportRow = report.page.find((row) => row.pageId === homeId)!
    expect(reportRow.retainedTarget).toMatchObject({
      selection: null,
      workingDraft: { title: "Accueil privé" },
    })
    expect(
      await codeOf(
        owner.mutation(api.cms.language.setPageDisposition, {
          transitionId,
          pageId: homeId,
          disposition: "redirect",
          redirectToPageId: homeId,
          expectedPageGeneration: reportRow.generation,
          retainedTargetReview: {
            digest: reportRow.retainedTarget!.reviewDigest,
            basis: "draft",
          },
        })
      )
    ).toBe("RETAINED_TARGET_DECISION_INVALID")
    const decision = await owner.mutation(
      api.cms.language.setPageDisposition,
      {
        transitionId,
        pageId: homeId,
        disposition: "target",
        expectedPageGeneration: reportRow.generation,
        retainedTargetReview: {
          digest: reportRow.retainedTarget!.reviewDigest,
          basis: "draft",
        },
      }
    )
    const shared = (await generations(t, homeId, "en")).shared!
    const target = (await generations(t, homeId, "fr")).state!
    const confirmation = await owner.mutation(
      api.cms.language.confirmTargetContent,
      {
        transitionId,
        pageId: homeId,
        expectedTargetDraftGeneration: target.draftGeneration,
        expectedSharedDraftGeneration: shared.generation,
        expectedPageGeneration: decision.generation,
      }
    )
    const prepared = await owner.mutation(api.cms.language.prepareTargetPage, {
      transitionId,
      pageId: homeId,
      expectedPageGeneration: confirmation.generation,
    })
    expect(prepared.snapshotId).not.toBeNull()
    const adoptedRow = await t.run((ctx) =>
      ctx.db
        .query("siteLanguageTransitionPages")
        .withIndex("by_transitionId_and_pageId", (q) =>
          q.eq("transitionId", transitionId).eq("pageId", homeId)
        )
        .unique()
    )
    expect(adoptedRow?.target).toMatchObject({
      draftCreatedByTransition: false,
      targetBasis: "draft",
      selectionProvenance: "transition_prepared",
    })

    const open = (await t.run((ctx) => ctx.db.get(transitionId)))!
    await owner.mutation(api.cms.language.cancelLanguageTransition, {
      transitionId,
      expectedGeneration: open.generation,
      discardTargetDrafts: false,
    })
    await drain(t)
    expect((await generations(t, homeId, "fr")).state).toMatchObject({
      hasCurrentSnapshot: false,
    })
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", homeId).eq("locale", "fr")
          )
          .unique()
      )
    ).toEqual(retainedDraft)
  },
  120_000
)

test.each(["correct_label", "replace_content"] as const)(
  "a retained-review claim is refused on an ordinary %s row",
  async (mode) => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: `Invalid ${mode} retained claim`,
      timezone: "UTC",
      defaultLocale: "en",
    })
    const settings = (await t.run((ctx) => ctx.db.query("siteSettings").unique()))!
    const homeId = settings.homePageId!
    await publish(t, owner, homeId, "en")
    const transitionId = await startTransition(t, owner, mode, "fr")
    const row = retainedRow(await transitionReport(owner, transitionId), homeId)

    expect(
      await codeOf(
        owner.mutation(api.cms.language.setPageDisposition, {
          transitionId,
          pageId: homeId,
          disposition: "target",
          expectedPageGeneration: row.generation,
          retainedTargetReview: {
            digest: "sha256:not-a-retained-review",
            basis: "retained_snapshot",
          },
        })
      )
    ).toBe("RETAINED_TARGET_DECISION_INVALID")
  },
  120_000
)

test.each(["retained_snapshot", "draft"] as const)(
  "a saved target Working Draft keeps %s adoption eligible for fresh review",
  async (basis) => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: `Retained ${basis} re-review`,
      timezone: "UTC",
      defaultLocale: "en",
    })
    const settings = (await t.run((ctx) => ctx.db.query("siteSettings").unique()))!
    const homeId = settings.homePageId!
    await publish(t, owner, homeId, "en")
    await toggleMultilingual(t, owner, true)
    await adoptMultilingual(t, owner)
    await addLanguage(t, owner, "fr")
    await saveDraft(t, owner, homeId, "fr", "accueil", "Accueil conservé")
    if (basis === "retained_snapshot") {
      await publish(t, owner, homeId, "fr")
    }
    await removeLanguage(t, owner, "fr")
    await owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
      expectedAuthorityVersion: await authorityVersion(t),
    })
    await toggleMultilingual(t, owner, false)

    const transitionId = await startReplacement(t, owner, "fr")
    const beforeSave = retainedRow(
      await transitionReport(owner, transitionId),
      homeId
    )
    expect(beforeSave.retainedTarget).not.toBeNull()
    const adopted = await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId,
      pageId: homeId,
      disposition: "target",
      expectedPageGeneration: beforeSave.generation,
      retainedTargetReview: {
        digest: beforeSave.retainedTarget!.reviewDigest,
        basis,
      },
    })

    await saveDraft(
      t,
      owner,
      homeId,
      "fr",
      "accueil-modifie",
      "Accueil modifié"
    )
    const afterSave = retainedRow(
      await transitionReport(owner, transitionId),
      homeId
    )
    expect(afterSave.generation).toBeGreaterThan(adopted.generation)
    expect.soft(
      (afterSave.retainedTarget as RetainedTargetReport | null)?.decisionCurrent
    ).toBe(false)
    expect(
      await codeOf(
        owner.mutation(api.cms.language.prepareTargetPage, {
          transitionId,
          pageId: homeId,
          expectedPageGeneration: afterSave.generation,
        })
      )
    ).toBe("RETAINED_TARGET_REVIEW_STALE")

    // Saving invalidates the receipt, but the retained choice must remain
    // visible so the owner can review the changed artifact and choose again.
    const fresh = retainedRow(
      await transitionReport(owner, transitionId),
      homeId
    )
    expect(fresh.retainedTarget).not.toBeNull()
    const reviewed = await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId,
      pageId: homeId,
      disposition: "target",
      expectedPageGeneration: fresh.generation,
      retainedTargetReview: {
        digest: fresh.retainedTarget!.reviewDigest,
        basis,
      },
    })
    expect.soft(
      (
        retainedRow(await transitionReport(owner, transitionId), homeId)
          .retainedTarget as RetainedTargetReport | null
      )?.decisionCurrent
    ).toBe(true)
    let expectedPageGeneration = reviewed.generation
    if (basis === "draft") {
      const shared = (await generations(t, homeId, "en")).shared!
      const target = (await generations(t, homeId, "fr")).state!
      const confirmed = await owner.mutation(
        api.cms.language.confirmTargetContent,
        {
          transitionId,
          pageId: homeId,
          expectedTargetDraftGeneration: target.draftGeneration,
          expectedSharedDraftGeneration: shared.generation,
          expectedPageGeneration,
        }
      )
      expectedPageGeneration = confirmed.generation
    }
    await expect(
      owner.mutation(api.cms.language.prepareTargetPage, {
        transitionId,
        pageId: homeId,
        expectedPageGeneration,
      })
    ).resolves.toMatchObject({ generation: expect.any(Number) })
  },
  120_000
)

test(
  "a retained snapshot decision becomes reviewable after an English publish without republishing the target",
  async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { homeId, transitionId } = await startRetainedReplacement(
      t,
      owner,
      "retained_snapshot",
      { keepSourceDraft: true }
    )
    const initial = retainedRow(
      await transitionReport(owner, transitionId),
      homeId
    )
    const decision = await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId,
      pageId: homeId,
      disposition: "target",
      expectedPageGeneration: initial.generation,
      retainedTargetReview: {
        digest: initial.retainedTarget!.reviewDigest,
        basis: "retained_snapshot",
      },
    })
    await owner.mutation(api.cms.language.prepareTargetPage, {
      transitionId,
      pageId: homeId,
      expectedPageGeneration: decision.generation,
    })
    const targetBefore = (await generations(t, homeId, "fr")).state!
    expect.soft(
      (
        retainedRow(await transitionReport(owner, transitionId), homeId)
          .retainedTarget as RetainedTargetReport | null
      )?.decisionCurrent
    ).toBe(true)

    await publish(t, owner, homeId, "en")
    const changed = retainedRow(
      await transitionReport(owner, transitionId),
      homeId
    )
    const changedRetained = changed.retainedTarget as RetainedTargetReport | null
    expect.soft(changedRetained?.decisionCurrent).toBe(false)
    const reviewed = await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId,
      pageId: homeId,
      disposition: "target",
      expectedPageGeneration: changed.generation,
      retainedTargetReview: {
        digest: changedRetained!.reviewDigest,
        basis: "retained_snapshot",
      },
    })
    await owner.mutation(api.cms.language.prepareTargetPage, {
      transitionId,
      pageId: homeId,
      expectedPageGeneration: reviewed.generation,
    })
    expect((await generations(t, homeId, "fr")).state).toMatchObject({
      currentSnapshotId: targetBefore.currentSnapshotId,
      publicGeneration: targetBefore.publicGeneration,
    })
  },
  120_000
)

test.each(["an English publish", "a Shared Draft save"] as const)(
  "a prepared retained draft stays current and can be reviewed again after %s",
  async (trigger) => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { homeId, transitionId } = await startRetainedReplacement(
      t,
      owner,
      "draft",
      { keepSourceDraft: true }
    )
    await reviewAndPrepareDraft(t, owner, transitionId, homeId)
    expect.soft(
      (
        retainedRow(await transitionReport(owner, transitionId), homeId)
          .retainedTarget as RetainedTargetReport | null
      )?.decisionCurrent
    ).toBe(true)

    if (trigger === "an English publish") {
      await publish(t, owner, homeId, "en")
    } else {
      const { shared, page } = await generations(t, homeId, "en")
      await owner.mutation(api.cms.publication.saveSharedDraft, {
        pageId: homeId,
        expectedSharedDraftGeneration: shared!.generation,
        expectedLifecycleGeneration: page!.lifecycleGeneration,
        seo: { metaTitle: "Changed after preparation" },
      })
    }
    expect.soft(
      (
        retainedRow(await transitionReport(owner, transitionId), homeId)
          .retainedTarget as RetainedTargetReport | null
      )?.decisionCurrent
    ).toBe(false)
    await reviewAndPrepareDraft(t, owner, transitionId, homeId)
    expect.soft(
      (
        retainedRow(await transitionReport(owner, transitionId), homeId)
          .retainedTarget as RetainedTargetReport | null
      )?.decisionCurrent
    ).toBe(true)
  },
  120_000
)

test(
  "a transition-prepared retained draft selection cannot become pre-existing and is withdrawn on cancellation",
  async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { homeId, transitionId } = await startRetainedReplacement(
      t,
      owner,
      "draft"
    )
    await reviewAndPrepareDraft(t, owner, transitionId, homeId)
    const report = retainedRow(
      await transitionReport(owner, transitionId),
      homeId
    )
    const retained = report.retainedTarget as RetainedTargetReport | null
    expect.soft(retained?.decisionCurrent).toBe(true)
    expect.soft(
      await refusalCode(
        owner.mutation(api.cms.language.setPageDisposition, {
          transitionId,
          pageId: homeId,
          disposition: "target",
          expectedPageGeneration: report.generation,
          retainedTargetReview: {
            digest: retained!.reviewDigest,
            basis: "retained_snapshot",
          },
        })
      )
    ).toBe("RETAINED_TARGET_DECISION_INVALID")
    const row = await t.run((ctx) =>
      ctx.db
        .query("siteLanguageTransitionPages")
        .withIndex("by_transitionId_and_pageId", (q) =>
          q.eq("transitionId", transitionId).eq("pageId", homeId)
        )
        .unique()
    )
    expect.soft(row?.target.selectionProvenance).toBe("transition_prepared")

    const transition = (await t.run((ctx) => ctx.db.get(transitionId)))!
    await owner.mutation(api.cms.language.cancelLanguageTransition, {
      transitionId,
      expectedGeneration: transition.generation,
      discardTargetDrafts: false,
    })
    await drain(t)
    expect((await generations(t, homeId, "fr")).state).toMatchObject({
      hasCurrentSnapshot: false,
    })
  },
  120_000
)

async function adoptedSnapshotSetup(t: T, owner: Caller) {
  await owner.mutation(api.cms.settings.bootstrapInstallation, {
    siteName: "Retained adoption cancellation",
    timezone: "UTC",
    defaultLocale: "en",
  })
  const settings = (await t.run((ctx) => ctx.db.query("siteSettings").unique()))!
  const homeId = settings.homePageId!
  await publish(t, owner, homeId, "en")
  await toggleMultilingual(t, owner, true)
  await adoptMultilingual(t, owner)
  await addLanguage(t, owner, "fr")
  await saveDraft(t, owner, homeId, "fr", "accueil", "Accueil publié")
  await publish(t, owner, homeId, "fr")
  await saveDraft(t, owner, homeId, "fr", "accueil-prive", "Accueil privé")
  await removeLanguage(t, owner, "fr")
  await owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
    expectedAuthorityVersion: await authorityVersion(t),
  })
  await toggleMultilingual(t, owner, false)
  const transitionId = await startReplacement(t, owner, "fr")
  await adoptRetainedSnapshot(owner, transitionId, homeId)
  const selected = (await generations(t, homeId, "fr")).state!
  return {
    homeId,
    transitionId,
    adopted: {
      snapshotId: selected.currentSnapshotId!,
      publicGeneration: selected.publicGeneration,
    },
  }
}

async function frenchDraft(t: T, homeId: Id<"pages">) {
  return t.run((ctx) =>
    ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", homeId).eq("locale", "fr")
      )
      .unique()
  )
}

async function transitionRow(
  t: T,
  transitionId: Id<"siteLanguageTransitions">,
  homeId: Id<"pages">
) {
  return t.run((ctx) =>
    ctx.db
      .query("siteLanguageTransitionPages")
      .withIndex("by_transitionId_and_pageId", (q) =>
        q.eq("transitionId", transitionId).eq("pageId", homeId)
      )
      .unique()
  )
}

async function discardFrenchDraft(t: T, owner: Caller, homeId: Id<"pages">) {
  const { state, page } = await generations(t, homeId, "fr")
  return owner.mutation(api.cms.publication.discardLocaleDraft, {
    pageId: homeId,
    locale: "fr",
    expectedDraftGeneration: state!.draftGeneration,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
  })
}

async function cancelTransition(
  t: T,
  owner: Caller,
  transitionId: Id<"siteLanguageTransitions">,
  discardTargetDrafts: boolean
) {
  const open = (await t.run((ctx) =>
    ctx.db.get("siteLanguageTransitions", transitionId)
  ))!
  await owner.mutation(api.cms.language.cancelLanguageTransition, {
    transitionId,
    expectedGeneration: open.generation,
    discardTargetDrafts,
  })
  await drain(t)
  return (await t.run((ctx) =>
    ctx.db.get("siteLanguageTransitions", transitionId)
  ))!
}

async function reviewRetainedTarget(
  owner: Caller,
  transitionId: Id<"siteLanguageTransitions">,
  pageId: Id<"pages">,
  disposition: "target" | "withdraw",
  basis: "retained_snapshot" | "draft"
) {
  const report = retainedRow(await transitionReport(owner, transitionId), pageId)
  const retained = report.retainedTarget as RetainedTargetReport | null
  expect(retained).not.toBeNull()
  return owner.mutation(api.cms.language.setPageDisposition, {
    transitionId,
    pageId,
    disposition,
    expectedPageGeneration: report.generation,
    retainedTargetReview: { digest: retained!.reviewDigest, basis },
  })
}

async function publicSelections(t: T, pageId: Id<"pages">) {
  return t.run(async (ctx) => ({
    en: await readCurrentSnapshotProjection(ctx, pageId, "en"),
    fr: await readCurrentSnapshotProjection(ctx, pageId, "fr"),
  }))
}

async function expectCancelledWithAdoptedSelection(
  t: T,
  homeId: Id<"pages">,
  phase: string,
  adopted: {
    snapshotId: Id<"pagePublishedSnapshots">
    publicGeneration: number
  }
) {
  expect(phase).toBe("cancelled")
  const authority = (await t.run((ctx) =>
    ctx.db.query("siteLanguageAuthority").unique()
  ))!
  expect(authority.activeTransitionId).toBeUndefined()
  expect((await generations(t, homeId, "fr")).state).toMatchObject({
    hasCurrentSnapshot: true,
    currentSnapshotId: adopted.snapshotId,
    publicGeneration: adopted.publicGeneration,
  })
}

test.each([false, true])(
  "re-reviewing an adopted selection preserves transition-created draft ownership through another save and cancel (discard %s)",
  async (discardTargetDrafts) => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { homeId, transitionId, adopted } = await adoptedSnapshotSetup(t, owner)
    const publicBefore = await publicSelections(t, homeId)
    await discardFrenchDraft(t, owner, homeId)
    await saveDraft(t, owner, homeId, "fr", "accueil-nouveau", "Accueil nouveau")
    await reviewRetainedTarget(
      owner,
      transitionId,
      homeId,
      "target",
      "retained_snapshot"
    )
    const reviewed = await transitionRow(t, transitionId, homeId)
    expect.soft(reviewed?.target.draftCreatedByTransition).toBe(true)
    expect.soft(reviewed?.target.retainedDraftAttribution).toBeUndefined()

    await saveDraft(t, owner, homeId, "fr", "accueil-revu", "Accueil revu")
    const saved = await transitionRow(t, transitionId, homeId)
    expect.soft(saved?.target.draftCreatedByTransition).toBe(true)
    expect.soft(saved?.target.retainedDraftAttribution).toBeUndefined()
    // Refresh the receipt after the second save, so cancellation also checks
    // the retained-snapshot arm rather than relying on a cleared receipt.
    await reviewRetainedTarget(
      owner,
      transitionId,
      homeId,
      "target",
      "retained_snapshot"
    )
    const draftBefore = await frenchDraft(t, homeId)
    const cancelled = await cancelTransition(
      t,
      owner,
      transitionId,
      discardTargetDrafts
    )
    await expectCancelledWithAdoptedSelection(t, homeId, cancelled.phase, adopted)
    expect(await frenchDraft(t, homeId)).toEqual(
      discardTargetDrafts ? null : draftBefore
    )
    expect(cancelled.targetDrafts).toBe(
      discardTargetDrafts ? "discarded" : "retained"
    )
    expect(await publicSelections(t, homeId)).toEqual(publicBefore)
  },
  120_000
)

test.each([
  ["target", false],
  ["target", true],
  ["withdraw", false],
  ["withdraw", true],
] as const)(
  "a %s draft-basis re-review keeps transition draft ownership and cancellation semantics (discard %s)",
  async (disposition, discardTargetDrafts) => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { homeId, transitionId } = await startRetainedReplacement(
      t,
      owner,
      "draft"
    )
    const publicBefore = await publicSelections(t, homeId)
    await reviewRetainedTarget(owner, transitionId, homeId, "target", "draft")
    await discardFrenchDraft(t, owner, homeId)
    await saveDraft(t, owner, homeId, "fr", "accueil-nouveau", "Accueil nouveau")
    await reviewRetainedTarget(owner, transitionId, homeId, disposition, "draft")
    const reviewed = await transitionRow(t, transitionId, homeId)
    expect.soft(reviewed?.target.draftCreatedByTransition).toBe(true)
    expect.soft(reviewed?.target.retainedDraftAttribution).toBeUndefined()
    expect.soft(reviewed?.target.retainedReview?.basis).toBe("draft")
    const draftBefore = await frenchDraft(t, homeId)
    const cancelled = await cancelTransition(
      t,
      owner,
      transitionId,
      discardTargetDrafts
    )
    expect(cancelled.phase).toBe("cancelled")
    expect(await frenchDraft(t, homeId)).toEqual(
      discardTargetDrafts ? null : draftBefore
    )
    expect(cancelled.targetDrafts).toBe(
      discardTargetDrafts ? "discarded" : "retained"
    )
    expect(await publicSelections(t, homeId)).toEqual(publicBefore)
  },
  120_000
)

test.each([false, true])(
  "correction preparation creates a private target draft that retained review cannot re-attribute (discard %s)",
  async (discardTargetDrafts) => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Prepared private draft provenance",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const settings = (await t.run((ctx) => ctx.db.query("siteSettings").unique()))!
    await publish(t, owner, settings.homePageId!, "en")
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "private-source",
      title: "Private source",
      content: { en: { title: "Private source", slices: [] } },
    })
    const publicBefore = await publicSelections(t, settings.homePageId!)
    const transitionId = await startTransition(t, owner, "correct_label", "fr")
    const rowBefore = await transitionRow(t, transitionId, pageId)
    expect(rowBefore).toMatchObject({
      kind: "private_draft",
      target: { draftCreatedByTransition: true },
    })
    const report = retainedRow(
      await transitionReport(owner, transitionId),
      pageId
    )
    expect(report.retainedTarget).toBeNull()
    expect(
      await codeOf(
        owner.mutation(api.cms.language.setPageDisposition, {
          transitionId,
          pageId,
          disposition: "withdraw",
          expectedPageGeneration: report.generation,
          retainedTargetReview: {
            digest: "not-an-adoption-disclosure",
            basis: "draft",
          },
        })
      )
    ).toBe("RETAINED_TARGET_DECISION_INVALID")
    expect(await transitionRow(t, transitionId, pageId)).toEqual(rowBefore)
    const draftBefore = await frenchDraft(t, pageId)
    expect(draftBefore).toMatchObject({ slug: "private-source" })
    expect(rowBefore?.target.retainedDraftAttribution).toBeUndefined()
    const cancelled = await cancelTransition(
      t,
      owner,
      transitionId,
      discardTargetDrafts
    )
    expect(cancelled.phase).toBe("cancelled")
    expect(await frenchDraft(t, pageId)).toEqual(
      discardTargetDrafts ? null : draftBefore
    )
    expect(await publicSelections(t, settings.homePageId!)).toEqual(publicBefore)
    expect(await publicSelections(t, pageId)).toEqual({ en: null, fr: null })
  },
  120_000
)

test.each([false, true])(
  "cancelling after an adopted selection's target Working Draft is saved keeps the selection and the draft (discard %s)",
  async (discardTargetDrafts) => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { homeId, transitionId, adopted } = await adoptedSnapshotSetup(
      t,
      owner
    )
    await saveDraft(t, owner, homeId, "fr", "accueil-modifie", "Accueil modifié")
    const row = await transitionRow(t, transitionId, homeId)
    expect(row?.target).toMatchObject({
      selectionProvenance: "retained_preexisting",
      draftCreatedByTransition: false,
    })
    expect(row?.target.retainedReview).toBeUndefined()

    const cancelled = await cancelTransition(
      t,
      owner,
      transitionId,
      discardTargetDrafts
    )
    await expectCancelledWithAdoptedSelection(
      t,
      homeId,
      cancelled.phase,
      adopted
    )
    expect(await frenchDraft(t, homeId)).toMatchObject({
      slug: "accueil-modifie",
    })
  },
  120_000
)

test.each([false, true])(
  "cancelling after an adopted selection's target Working Draft is discarded keeps the selection (discard %s)",
  async (discardTargetDrafts) => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { homeId, transitionId, adopted } = await adoptedSnapshotSetup(
      t,
      owner
    )
    await discardFrenchDraft(t, owner, homeId)
    expect(await frenchDraft(t, homeId)).toBeNull()

    const cancelled = await cancelTransition(
      t,
      owner,
      transitionId,
      discardTargetDrafts
    )
    await expectCancelledWithAdoptedSelection(
      t,
      homeId,
      cancelled.phase,
      adopted
    )
    expect(await frenchDraft(t, homeId)).toBeNull()
  },
  120_000
)

test.each([false, true])(
  "cancelling deletes a transition-created draft only in discard mode and always keeps the adopted selection (discard %s)",
  async (discardTargetDrafts) => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { homeId, transitionId, adopted } = await adoptedSnapshotSetup(
      t,
      owner
    )
    await discardFrenchDraft(t, owner, homeId)
    await saveDraft(t, owner, homeId, "fr", "accueil-nouveau", "Accueil nouveau")
    const row = await transitionRow(t, transitionId, homeId)
    expect(row?.target).toMatchObject({
      selectionProvenance: "retained_preexisting",
      draftCreatedByTransition: true,
    })

    const cancelled = await cancelTransition(
      t,
      owner,
      transitionId,
      discardTargetDrafts
    )
    await expectCancelledWithAdoptedSelection(
      t,
      homeId,
      cancelled.phase,
      adopted
    )
    const draft = await frenchDraft(t, homeId)
    if (discardTargetDrafts) expect(draft).toBeNull()
    else expect(draft).toMatchObject({ slug: "accueil-nouveau" })
    expect(cancelled.targetDrafts).toBe(
      discardTargetDrafts ? "discarded" : "retained"
    )
  },
  120_000
)

test.each([false, true])(
  "cancelling holds on a successor selection pointer after a target draft save and touches nothing (discard %s)",
  async (discardTargetDrafts) => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { homeId, transitionId, adopted } = await adoptedSnapshotSetup(
      t,
      owner
    )
    await discardFrenchDraft(t, owner, homeId)
    await saveDraft(t, owner, homeId, "fr", "accueil-nouveau", "Accueil nouveau")
    // Fault injection: product mutations cannot move a retained target
    // selection pointer under an active transition. Simulate a successor.
    const state = (await generations(t, homeId, "fr")).state!
    await t.run((ctx) =>
      ctx.db.patch("pageLocalePublicationStates", state._id, {
        publicGeneration: adopted.publicGeneration + 1,
      })
    )

    const held = await cancelTransition(
      t,
      owner,
      transitionId,
      discardTargetDrafts
    )
    expect(held.phase).toBe("cancelling")
    const draftBefore = await frenchDraft(t, homeId)
    expect(draftBefore).toMatchObject({ slug: "accueil-nouveau" })
    const untouched = (await generations(t, homeId, "fr")).state
    expect(untouched).toMatchObject({
      hasCurrentSnapshot: true,
      currentSnapshotId: adopted.snapshotId,
      publicGeneration: adopted.publicGeneration + 1,
    })

    await owner.mutation(api.cms.language.continueLanguageTransition, {
      transitionId,
      expectedGeneration: held.generation,
    })
    await drain(t)
    expect(
      (await t.run((ctx) => ctx.db.get("siteLanguageTransitions", transitionId)))!
        .phase
    ).toBe("cancelling")
    expect((await generations(t, homeId, "fr")).state).toEqual(untouched)
    expect(await frenchDraft(t, homeId)).toEqual(draftBefore)
  },
  120_000
)
