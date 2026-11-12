import { expect, test } from "playwright/test"
import { api } from "../../convex/_generated/api"
import {
  assertNotFoundWithNoindex,
  clientFor,
  controlSnapshot,
  expectConvexDenialWithoutChange,
  ownerPage,
  publicLifecycleEvidence,
  pageTranslator,
  publicLifecycleProbe,
  requireDisposableStage,
  required,
} from "../support"

/**
 * M05 stage 1 — P3 and the first P7 cache transition. Preconditions: a
 * disposable completed `en` app in S1, Multilingual off, snapshot authority
 * active, no F09/default-language operation, and a published test Page at the
 * supplied English path. Postcondition: S4 with only `en`; the existing public
 * Page/snapshot is unchanged and no French route was revealed. The operator
 * owns the disposable backend and fixtures. Start state: `single-en`.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("M05 stage 1 moves S1 through S3(S1) to S4 without changing publication", async ({ browser, request }, testInfo) => {
  requireDisposableStage("m05", "m05-1-adoption")
  const owner = await ownerPage(browser)
  try {
    const client = await clientFor(owner)
    expect(await client.query(api.cms.publication.getAdminAuthority, {})).toBe("snapshot_active")
    expect(await client.query(api.cms.language.getLanguageState, {})).toMatchObject({
      kind: "current",
      currentLocale: "en",
      transition: null,
    })
    const initial = await client.query(api.cms.multilingual.getMultilingualState, {})
    expect(initial).toMatchObject({
      lifecycleState: "S1",
      origin: null,
      moduleEnabled: false,
      defaultLocale: "en",
      enabledLocales: ["en"],
      openOperation: null,
      defaultMigration: null,
    })
    const englishPath = required("FR6_E2E_M05_EN_PATH")
    const englishMarker = required("FR6_E2E_M05_EN_MARKER")
    const frenchPath = required("FR6_E2E_M05_FR_PATH")
    const englishBefore = await publicLifecycleProbe(request, englishPath)
    const frenchBefore = await publicLifecycleProbe(request, frenchPath)
    expect(englishBefore).toMatchObject({ status: 200, rscStatus: 200, lang: "en", noindex: false, inSitemap: true })
    expect(englishBefore.body).toContain(englishMarker)
    expect([200, 404]).toContain(frenchBefore.status)
    expect(frenchBefore.noindex).toBe(true)
    await assertNotFoundWithNoindex(request, frenchPath)

    // Multilingual is switched only in Modules (owner 2026-11-05): the row has
    // the same switch as other optional modules, off here, and the owner turns
    // it on and applies. Languages is linked from the row only while it is on.
    await owner.goto("/admin/settings/modules")
    const moduleText = await pageTranslator(owner)
    const moduleRow = owner.getByTestId("module-multilingual")
    const moduleSwitch = moduleRow.getByRole("checkbox")
    await expect(moduleSwitch).toHaveCount(1)
    await expect(moduleSwitch).not.toBeChecked()
    await expect(moduleRow.getByRole("link", { name: moduleText("settings.modules.openLanguages") })).toHaveCount(0)
    await moduleSwitch.click()
    await owner.getByRole("button", { name: moduleText("settings.modules.save") }).click()
    await expect.poll(async () => (await client.query(api.cms.multilingual.getMultilingualState, {})).moduleEnabled).toBe(true)
    await owner.goto("/admin/settings/modules")
    await expect(moduleRow.getByRole("checkbox")).toBeChecked()
    await expect(moduleRow.getByRole("link", { name: moduleText("settings.modules.openLanguages") })).toBeVisible()
    const enabled = await client.query(api.cms.multilingual.getMultilingualState, {})
    expect(enabled).toMatchObject({
      lifecycleState: "S3",
      origin: "S1",
      moduleEnabled: true,
      defaultLocale: "en",
      enabledLocales: ["en"],
      openOperation: null,
    })

    // The Languages screen no longer shows an adoption step (L3): adoption
    // happens inside the first add or the first Remove or Make default. This
    // stage must stop at S4 with only `en`, which the screen never produces
    // by itself, so it adopts through the command.
    const adoption = await client.query(api.cms.multilingual.previewAdoption, {})
    expect(adoption.canAdopt).toBe(true)
    if (!adoption.canAdopt) throw new Error(`P3 adoption blocked: ${adoption.blockerCode}`)
    await client.mutation(api.cms.multilingual.adoptMultilingualAuthority, {
      expectedSettingsUpdatedAt: adoption.expectedSettingsUpdatedAt,
      expectedModuleConfigurationVersion: adoption.expectedModuleConfigurationVersion,
      expectedAuthorityVersion: adoption.expectedAuthorityVersion,
    })
    await owner.goto("/admin/settings/languages")
    await expect(owner.getByRole("heading", { level: 1, name: (await pageTranslator(owner))("settings.multilingualLanguages.title"), exact: true })).toBeVisible()

    const adopted = await client.query(api.cms.multilingual.getMultilingualState, {})
    expect(adopted).toMatchObject({
      lifecycleState: "S4",
      origin: null,
      moduleEnabled: true,
      defaultLocale: "en",
      enabledLocales: ["en"],
      openOperation: null,
    })
    expect(adopted.version).toBeGreaterThan(initial.version ?? 0)
    expect(await client.query(api.cms.multilingual.previewAdoption, {})).toEqual({
      canAdopt: false,
      blockerCode: "MULTILINGUAL_ALREADY_ADOPTED",
    })
    await expectConvexDenialWithoutChange(
      () => client.query(api.cms.multilingual.getMultilingualState, {}),
      () => client.mutation(api.cms.multilingual.adoptMultilingualAuthority, {
        expectedSettingsUpdatedAt: adoption.expectedSettingsUpdatedAt,
        expectedModuleConfigurationVersion: adoption.expectedModuleConfigurationVersion,
        expectedAuthorityVersion: adoption.expectedAuthorityVersion,
      }),
      "MULTILINGUAL_ALREADY_ADOPTED"
    )
    expect(controlSnapshot(await client.query(api.cms.multilingual.getMultilingualState, {}))).toBe(
      controlSnapshot(adopted)
    )
    const englishAfter = await publicLifecycleProbe(request, englishPath)
    const frenchAfter = await publicLifecycleProbe(request, frenchPath)
    expect(englishAfter).toMatchObject({ status: 200, rscStatus: 200, lang: "en", noindex: false, inSitemap: true })
    expect(englishAfter.body).toContain(englishMarker)
    expect([200, 404]).toContain(frenchAfter.status)
    expect(frenchAfter.noindex).toBe(true)
    await assertNotFoundWithNoindex(request, frenchPath)
    await testInfo.attach("p7-adoption", {
      body: JSON.stringify({
        englishBefore: publicLifecycleEvidence(englishBefore),
        frenchBefore: publicLifecycleEvidence(frenchBefore),
        englishAfter: publicLifecycleEvidence(englishAfter),
        frenchAfter: publicLifecycleEvidence(frenchAfter),
      }),
      contentType: "application/json",
    })
  } finally {
    await owner.context().close()
  }
})
