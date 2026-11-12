import { expect, test } from "playwright/test"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import {
  clientFor,
  controlSnapshot,
  expectConvexDenial,
  expectConvexDenialWithoutChange,
  localOrigin,
  ownerPage,
  pageTranslator,
  requireDisposable,
  required,
} from "../support"

/**
 * Owner replacement and former-owner session. Preconditions: disposable
 * completed English S4 app with `en` default and `fr` enabled, a live
 * former-owner session, and a newly rotated
 * FORMULACMS_OWNER_CLAIM that has not been consumed. The replacement email is
 * unused. FORMULACMS_DISPOSABLE_TARGET=1 and
 * FR6_E2E_START_STATE=owned-rotated-claim are mandatory. Postcondition: the
 * former owner starts a sealed French-removal impact preview before cutover.
 * Postcondition: the replacement owns the app, every former-owner M05 command
 * and impact query is denied, the old preview is owner-bound, and the new owner
 * can create and review its own preview. All denied mutations leave the new
 * owner's control snapshot unchanged.
 * Run last in the English app. The operator owns claim rotation and the
 * disposable backend.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("replacement revokes the former owner's existing browser and signed token", async ({ browser }) => {
  requireDisposable("owned-rotated-claim")
  const former = await ownerPage(browser)
  const formerClient = await clientFor(former)
  const replacementContext = await browser.newContext({ baseURL: localOrigin() })
  const replacement = await replacementContext.newPage()
  try {
    const before = await formerClient.query(api.cms.multilingual.getMultilingualState, {})
    expect(before).toMatchObject({ lifecycleState: "S4", defaultLocale: "en" })
    expect(before.enabledLocales).toContain("fr")
    const started = await formerClient.mutation(api.cms.multilingual.startLanguageImpactPreview, {
      kind: "remove",
      locale: "fr",
    })
    await expect.poll(async () => {
      const state = await formerClient.query(api.cms.multilingual.getMultilingualState, {})
      return state.latestPreviews.find((preview) => preview.previewId === started.previewId)?.phase
    }).toBe("complete")
    const sealed = (await formerClient.query(api.cms.multilingual.getMultilingualState, {})).latestPreviews.find(
      (preview) => preview.previewId === started.previewId
    )
    if (!sealed) throw new Error("Former-owner impact preview did not seal")
    expect(sealed.pageCount).toBeGreaterThan(0)
    const firstImpact = await formerClient.query(api.cms.multilingual.listLanguageImpact, {
      previewId: sealed.previewId,
      ordinal: 0,
    })
    await replacement.goto("/setup?recover-owner=1")
    await replacement.getByRole("button", { name: (await pageTranslator(replacement))("setup.actions.replaceOwnerAccount") }).click()
    await replacement.getByLabel((await pageTranslator(replacement))("setup.fields.name")).fill("FR6 replacement owner")
    await replacement.getByLabel((await pageTranslator(replacement))("setup.fields.signInEmail")).fill(required("FR6_E2E_REPLACEMENT_EMAIL"))
    await replacement.getByLabel((await pageTranslator(replacement))("setup.fields.newPassword")).fill(required("FR6_E2E_REPLACEMENT_PASSWORD"))
    await replacement.getByLabel((await pageTranslator(replacement))("setup.fields.confirmPassword")).fill(required("FR6_E2E_REPLACEMENT_PASSWORD"))
    await replacement.getByLabel((await pageTranslator(replacement))("setup.fields.ownerCode")).fill(required("FR6_E2E_ROTATED_OWNER_CLAIM"))
    await replacement.getByRole("button", { name: (await pageTranslator(replacement))("setup.actions.createReplacementAccount") }).click()
    const moved = (await pageTranslator(replacement))("setup.notices.ownerMoved", {
      email: required("FR6_E2E_REPLACEMENT_EMAIL"),
    })
    await expect(replacement.getByText(moved, { exact: true })).toBeVisible()
    await replacement.goto("/admin")
    await expect(replacement).toHaveURL(/\/admin(?:\/|$)/)
    const replacementClient = await clientFor(replacement)
    const migrationId = required("FR6_E2E_REPLACEMENT_MIGRATION_ID") as Id<"siteDefaultLanguageMigrations">
    const control = async () => ({
      multilingual: await replacementClient.query(api.cms.multilingual.getMultilingualState, {}),
      language: await replacementClient.query(api.cms.language.getLanguageState, {}),
      modules: await replacementClient.query(api.cms.modules.preview, { changes: [] }),
    })
    const unchanged = controlSnapshot(await control())

    for (const query of [
      () => formerClient.query(api.cms.multilingual.getMultilingualState, {}),
      () => formerClient.query(api.cms.multilingual.previewAdoption, {}),
      () => formerClient.query(api.cms.multilingual.listLanguageImpact, {
        previewId: sealed.previewId,
        ordinal: 0,
      }),
      () => formerClient.query(api.cms.multilingual.listDefaultLanguageRoutes, {
        migrationId,
        generation: 1,
        paginationOpts: { cursor: null, numItems: 1 },
        filter: "all",
      }),
      () => formerClient.query(api.cms.multilingual.listDefaultMigrationDisclosure, {
        migrationId,
        generation: 1,
        ordinal: 0,
      }),
      () => formerClient.query(api.cms.languageLifecycle.getLanguageLifecycleStatus, {}),
      () => formerClient.query(api.cms.modules.preview, { changes: [] }),
    ]) {
      await expectConvexDenial(query(), "CMS_OWNER_REQUIRED")
      expect(controlSnapshot(await control())).toBe(unchanged)
    }

    const deniedMutations = [
      () => formerClient.mutation(api.cms.multilingual.adoptMultilingualAuthority, {
        expectedSettingsUpdatedAt: 0,
        expectedModuleConfigurationVersion: before.moduleConfigurationVersion,
        expectedAuthorityVersion: before.version,
      }),
      () => formerClient.mutation(api.cms.multilingual.returnToSingleLanguage, {
        expectedAuthorityVersion: before.version!,
      }),
      () => formerClient.mutation(api.cms.multilingual.startLanguageImpactPreview, {
        kind: "remove",
        locale: "fr",
      }),
      () => formerClient.mutation(api.cms.multilingual.recordLanguageImpactReview, {
        previewId: sealed.previewId,
        ordinal: 0,
        pageDigest: !firstImpact.stale ? firstImpact.digest : sealed.digest,
      }),
      () => formerClient.mutation(api.cms.multilingual.addLanguage, {
        locale: "fr",
        expectedAuthorityVersion: before.version!,
        expectedModuleConfigurationVersion: before.moduleConfigurationVersion,
      }),
      () => formerClient.mutation(api.cms.multilingual.removeLanguage, {
        previewId: sealed.previewId,
        expectedDigest: sealed.digest,
        expectedCount: sealed.count,
      }),
      () => formerClient.mutation(api.cms.multilingual.startDefaultLanguageMigration, {
        toLocale: "fr",
        expectedAuthorityVersion: before.version!,
        expectedModuleConfigurationVersion: before.moduleConfigurationVersion,
      }),
      () => formerClient.mutation(api.cms.multilingual.continueDefaultLanguageMigration, {
        migrationId,
        expectedGeneration: 1,
      }),
      () => formerClient.mutation(api.cms.multilingual.recordDefaultMigrationReview, {
        migrationId,
        expectedGeneration: 1,
        ordinal: 0,
        pageDigest: "former-owner",
      }),
      () => formerClient.mutation(api.cms.multilingual.activateDefaultLanguageMigration, {
        migrationId,
        expectedGeneration: 1,
        expectedReadinessVersion: 1,
        expectedAuthorityVersion: before.version!,
      }),
      () => formerClient.mutation(api.cms.multilingual.cancelDefaultLanguageMigration, {
        migrationId,
        expectedGeneration: 1,
      }),
      () => formerClient.mutation(api.cms.languageLifecycle.requeueUndeliveredLifecycleIntents, {}),
      () => formerClient.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: before.moduleConfigurationVersion,
        changes: [{ moduleId: "multilingual", enabled: false }],
      }),
    ]
    for (const action of deniedMutations) {
      await expectConvexDenialWithoutChange(control, action, "CMS_OWNER_REQUIRED")
    }

    await expectConvexDenial(
      replacementClient.query(api.cms.multilingual.listLanguageImpact, {
        previewId: sealed.previewId,
        ordinal: 0,
      }),
      "LANGUAGE_PREVIEW_MISMATCH"
    )
    const own = await replacementClient.mutation(api.cms.multilingual.startLanguageImpactPreview, {
      kind: "remove",
      locale: "fr",
    })
    await expect.poll(async () => {
      const state = await replacementClient.query(api.cms.multilingual.getMultilingualState, {})
      return state.latestPreviews.find((preview) => preview.previewId === own.previewId)?.phase
    }).toBe("complete")
    const ownState = await replacementClient.query(api.cms.multilingual.getMultilingualState, {})
    const ownPreview = ownState.latestPreviews.find((preview) => preview.previewId === own.previewId)
    if (!ownPreview) throw new Error("Replacement-owner preview did not seal")
    if (ownPreview.pageCount > 0) {
      expect(await replacementClient.query(api.cms.multilingual.listLanguageImpact, {
        previewId: own.previewId,
        ordinal: 0,
      })).toMatchObject({ stale: false, ordinal: 0 })
    }
    expect(await replacementClient.query(api.cms.languageLifecycle.getLanguageLifecycleStatus, {})).toEqual(
      expect.objectContaining({ updating: expect.any(Boolean), notDelivered: expect.any(Boolean) })
    )
    expect(await replacementClient.query(api.cms.modules.preview, { changes: [] })).toEqual(
      expect.objectContaining({ configurationVersion: before.moduleConfigurationVersion })
    )
    await former.goto("/admin")
    await expect(former).not.toHaveURL(/\/admin(?:\/|$)/)
  } finally {
    await former.context().close()
    await replacementContext.close()
  }
})
