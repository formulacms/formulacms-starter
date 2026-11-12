import { expect, test, type Page } from "playwright/test"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import type { ConvexHttpClient } from "convex/browser"
import {
  anonymousClient,
  assertNotFoundWithNoindex,
  clientFor,
  controlSnapshot,
  expectConvexDenialWithoutChange,
  ownerPage,
  pageTranslator,
  publicLifecycleEvidence,
  publicLifecycleProbe,
  requireDisposableStage,
  required,
  sitemap,
} from "../support"

async function startRemoval(page: Page, localeLabel: string) {
  await page.goto("/admin/settings/languages")
  const t = await pageTranslator(page)
  const row = page.getByRole("listitem").filter({ hasText: localeLabel })
  await row.getByRole("button", { name: t("settings.multilingualLanguages.list.actionsFor", { language: localeLabel }) }).click()
  await page.getByRole("menuitem", { name: t("settings.multilingualLanguages.list.remove") }).click()
}

async function waitForCompletePreview(client: ConvexHttpClient, locale: string) {
  await expect.poll(async () => {
    const state = await client.query(api.cms.multilingual.getMultilingualState, {})
    return state.latestPreviews.find((preview) => preview.locale === locale && preview.kind === "remove")?.phase
  }).toBe("complete")
  const state = await client.query(api.cms.multilingual.getMultilingualState, {})
  const preview = state.latestPreviews.find((candidate) =>
    candidate.locale === locale && candidate.kind === "remove" && candidate.phase === "complete"
  )
  if (!preview) throw new Error(`No completed removal preview for ${locale}`)
  return preview
}

/**
 * Removes the language from its dialog: the whole list of affected items is on
 * screen, the one Remove button records the review and removes. With two
 * languages that single command also returns the site to one language and
 * switches Multilingual off.
 */
async function reviewAndRemove(page: Page, client: ConvexHttpClient, locale: string) {
  const preview = await waitForCompletePreview(client, locale)
  expect(preview.pageCount).toBeGreaterThan(1)
  const first = await client.query(api.cms.multilingual.listLanguageImpact, {
    previewId: preview.previewId,
    ordinal: 0,
  })
  expect(first.stale).toBe(false)
  if (first.stale) throw new Error("The first impact page became stale")
  await expectConvexDenialWithoutChange(
    () => client.query(api.cms.multilingual.getMultilingualState, {}),
    () => client.mutation(api.cms.multilingual.recordLanguageImpactReview, {
      previewId: preview.previewId,
      ordinal: 0,
      pageDigest: `${first.digest}-wrong`,
    }),
    "LANGUAGE_PREVIEW_MISMATCH"
  )
  const items: unknown[] = []
  for (let ordinal = 0; ordinal < preview.pageCount; ordinal += 1) {
    const disclosure = await client.query(api.cms.multilingual.listLanguageImpact, {
      previewId: preview.previewId,
      ordinal,
    })
    expect(disclosure.stale).toBe(false)
    if (disclosure.stale) throw new Error(`Removal disclosure ${ordinal} became stale`)
    items.push(...disclosure.items)
  }
  const t = await pageTranslator(page)
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("region", { name: t("settings.multilingualLanguages.review.listLabel") })).toBeVisible()
  // Nothing is recorded by opening the list.
  const opened = await client.query(api.cms.multilingual.getMultilingualState, {})
  expect(opened.latestPreviews.find((candidate) => candidate.previewId === preview.previewId)?.reviewedThroughOrdinal).toBe(-1)
  await dialog.getByRole("button", { name: t("settings.multilingualLanguages.remove.confirm"), exact: true }).click()
  await expect.poll(async () => {
    const state = await client.query(api.cms.multilingual.getMultilingualState, {})
    return state.enabledLocales.includes(locale)
  }).toBe(false)
  return items
}

/**
 * M05 stage 4 — P5, P7(a-d,g), and P8's disable preconditions. Preconditions:
 * stage 3 left S4 with `en` default and `fr` enabled, no open migration,
 * substantive multi-page impact disclosures, and the P24 round-trip pointer.
 * Switching the module off is first refused while multilingual authority is
 * active. French is then removed from its dialog with one confirm after the
 * whole list is shown; that command returns the site to one language and
 * leaves Multilingual on. The owner then switches it off in Modules.
 * Postcondition: S1, Multilingual off, one public English
 * language, retained locale data untouched, no open operation. The operator
 * owns the disposable backend and later final cleanup. Start state:
 * `after-m05-3-default-migrations`.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("M05 stage 4 reviews complete removals, returns to S1, and disables safely", async ({ browser, request }, testInfo) => {
  requireDisposableStage("m05", "m05-4-removal-disable")
  const owner = await ownerPage(browser)
  try {
    const client = await clientFor(owner)
    const initial = await client.query(api.cms.multilingual.getMultilingualState, {})
    expect(initial).toMatchObject({
      lifecycleState: "S4",
      moduleEnabled: true,
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      openOperation: null,
      defaultMigration: null,
    })
    const frenchBefore = await publicLifecycleProbe(request, required("FR6_E2E_M05_FR_PATH"))
    expect(frenchBefore).toMatchObject({ status: 200, rscStatus: 200, lang: "fr", noindex: false })

    // While two or more languages are active, switching the module off is
    // refused. The refusal is read from the module preview, which says what
    // blocks it (Multilingual is switched only in Modules).
    const disablePreview = await client.query(api.cms.modules.preview, {
      changes: [{ moduleId: "multilingual", enabled: false }],
    })
    expect(disablePreview.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MULTILINGUAL_AUTHORITY_ACTIVE" })])
    )
    expect(controlSnapshot(await client.query(api.cms.multilingual.getMultilingualState, {}))).toBe(
      controlSnapshot(initial)
    )

    await startRemoval(owner, required("FR6_E2E_M05_FR_LABEL"))
    const frenchDisclosure = await reviewAndRemove(owner, client, "fr")
    expect(JSON.stringify(frenchDisclosure)).toContain(required("FR6_E2E_M05_FR_PATH"))
    expect(JSON.stringify(frenchDisclosure)).toContain(required("FR6_E2E_M05_MANUAL_FR_PATH"))
    await assertNotFoundWithNoindex(request, required("FR6_E2E_M05_FR_PATH"))
    await assertNotFoundWithNoindex(request, required("FR6_E2E_M05_MANUAL_FR_PATH"))
    expect(await sitemap(request)).not.toContain(required("FR6_E2E_M05_FR_PATH"))
    const frenchAfter = await publicLifecycleProbe(request, required("FR6_E2E_M05_FR_PATH"))
    expect([200, 404]).toContain(frenchAfter.status)
    expect(frenchAfter.noindex).toBe(true)

    // Removing the last extra language returns the site to one language and
    // leaves Multilingual on (owner 2026-11-05): it is switched off only in
    // Modules. The site is back to S3(S1).
    await owner.goto("/admin/settings/languages")
    const kept = await client.query(api.cms.multilingual.getMultilingualState, {})
    expect(kept).toMatchObject({
      lifecycleState: "S3",
      origin: "S1",
      moduleEnabled: true,
      defaultLocale: "en",
      enabledLocales: ["en"],
      openOperation: null,
    })
    await owner.goto("/admin/settings/modules")
    const moduleText = await pageTranslator(owner)
    const moduleRow = owner.getByTestId("module-multilingual")
    await expect(moduleRow.getByRole("checkbox")).toBeChecked()

    // With one language the switch now turns it off through Modules.
    await moduleRow.getByRole("checkbox").click()
    await owner.getByRole("button", { name: moduleText("settings.modules.save") }).click()
    await expect.poll(async () => (await client.query(api.cms.multilingual.getMultilingualState, {})).moduleEnabled).toBe(false)
    const disabled = await client.query(api.cms.multilingual.getMultilingualState, {})
    expect(disabled).toMatchObject({
      lifecycleState: "S1",
      origin: null,
      moduleEnabled: false,
      defaultLocale: "en",
      enabledLocales: ["en"],
      openOperation: null,
    })
    await owner.goto("/admin/settings/modules")
    await expect(moduleRow.getByRole("checkbox")).not.toBeChecked()
    const englishAfterDisable = await publicLifecycleProbe(request, required("FR6_E2E_M05_EN_PATH"))
    expect(englishAfterDisable).toMatchObject({ status: 200, rscStatus: 200, lang: "en", noindex: false })
    expect(englishAfterDisable.body).toContain(required("FR6_E2E_M05_EN_MARKER"))

    expect((await client.query(api.cms.modules.effective, {})).modules).toContainEqual({ id: "redirects", outcome: "on" })
    const retainedRules = await client.query(api.cms.redirects.list, {})
    expect(retainedRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ locale: "en", fromPath: required("FR6_E2E_M05_MANUAL_EN_PATH") }),
      expect.objectContaining({ locale: "fr", fromPath: required("FR6_E2E_M05_MANUAL_FR_PATH") }),
    ]))
    const retainedMenu = await client.query(api.cms.menus.getCanonical, {
      slug: required("FR6_E2E_M05_MENU_SLUG"),
    })
    expect(JSON.stringify(retainedMenu)).toContain(required("FR6_E2E_M05_EN_MENU_LABEL"))
    const media = await client.query(api.cms.media.getByName, {
      name: required("FR6_E2E_M05_MEDIA_NAME"),
    })
    if (!media) throw new Error("The retained V10 media fixture is missing")
    const mediaUsage = await client.query(api.cms.media.usage, { id: media._id })
    expect(mediaUsage.pages.map((page) => page._id)).toContain(
      required("FR6_E2E_M05_MEDIA_PAGE_ID") as Id<"pages">
    )
    const publicClient = anonymousClient()
    const siteConfig = await publicClient.query(api.cms.settings.getSiteConfig, {})
    expect(await publicClient.query(api.cms.redirects.resolve, {
      path: required("FR6_E2E_M05_MANUAL_EN_PATH"),
      locale: "en",
      languageVersion: siteConfig.languageVersion,
    })).toEqual({ destination: "/", statusCode: 302 })
    await testInfo.attach("p7-remove-return-disable", {
      body: JSON.stringify({
        frenchBefore: publicLifecycleEvidence(frenchBefore),
        frenchAfter: publicLifecycleEvidence(frenchAfter),
        englishAfterDisable: publicLifecycleEvidence(englishAfterDisable),
      }),
      contentType: "application/json",
    })
  } finally {
    await owner.context().close()
  }
})
