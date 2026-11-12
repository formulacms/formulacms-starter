import { expect, test, type Page } from "playwright/test"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import type { ConvexHttpClient } from "convex/browser"
import {
  anonymousClient,
  assertNotFoundWithNoindex,
  clientFor,
  ownerPage,
  pageTranslator,
  publicLifecycleEvidence,
  publicLifecycleProbe,
  requireDisposableStage,
  required,
} from "../support"

function withoutLocalePrefix(path: string, locale: "fr") {
  const prefix = `/${locale}`
  if (path === prefix) return "/"
  if (!path.startsWith(`${prefix}/`)) {
    throw new Error(`Expected ${path} to start with ${prefix}/`)
  }
  return path.slice(prefix.length)
}

/**
 * Brings a retained language back: Multilingual is switched on in Modules
 * (the only place that turns it on, owner 2026-11-05), then the language is
 * added from the Languages screen. Adding is silent: no review step, no
 * dialog, and it re-adopts the site on the way.
 */
async function revealRetainedLocale(page: Page, client: ConvexHttpClient, locale: string) {
  const t = await pageTranslator(page)
  await page.goto("/admin/settings/modules")
  const moduleRow = page.getByTestId("module-multilingual")
  await expect(moduleRow.getByRole("checkbox")).not.toBeChecked()
  await moduleRow.getByRole("checkbox").click()
  await page.getByRole("button", { name: t("settings.modules.save") }).click()
  await expect.poll(async () => (await client.query(api.cms.multilingual.getMultilingualState, {})).moduleEnabled).toBe(true)
  // Switching it on changed nothing public: still one language, not adopted yet.
  expect(await client.query(api.cms.multilingual.getMultilingualState, {})).toMatchObject({
    lifecycleState: "S3",
    origin: "S1",
    moduleEnabled: true,
    defaultLocale: "fr",
    enabledLocales: ["fr"],
  })
  await page.goto("/admin/settings/languages")
  await page.getByRole("button", { name: t("settings.multilingualLanguages.list.addLabel") }).click()
  await page.getByRole("option").filter({ hasText: new RegExp(`${locale}$`) }).click()
  await page.getByRole("button", { name: t("settings.multilingualLanguages.list.addButton") }).click()
  await expect.poll(async () => {
    const after = await client.query(api.cms.multilingual.getMultilingualState, {})
    return after.enabledLocales
  }).toContain(locale)
}

/**
 * M05 stage 6 — P8 and final V10 continuity. Preconditions: stage 5 left a
 * module-off single-language `fr` site, retained English snapshots and
 * translations, retained relations, and a committed carried redirect. The
 * stage switches Multilingual on in Modules, then re-adds retained English
 * from the Languages screen: Add is silent and re-adopts M05.
 * Postcondition: S4 with `fr` and `en`, no open
 * operation; old English content is public again without an
 * editor publish action, and the carried redirect still resolves. The operator
 * owns the disposable backend and final fixture teardown. Start state:
 * `after-m05-5-p24`.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("M05 stage 6 re-adopts and reveals retained translations without republishing", async ({ browser, request }, testInfo) => {
  requireDisposableStage("m05", "m05-6-re-adoption")
  const owner = await ownerPage(browser)
  try {
    const client = await clientFor(owner)
    const initial = await client.query(api.cms.multilingual.getMultilingualState, {})
    expect(initial).toMatchObject({
      lifecycleState: "S1",
      origin: null,
      moduleEnabled: false,
      defaultLocale: "fr",
      enabledLocales: ["fr"],
      openOperation: null,
    })
    const frenchDefaultPath = withoutLocalePrefix(required("FR6_E2E_M05_FR_PATH"), "fr")
    const relationDefaultPath = withoutLocalePrefix(
      required("FR6_E2E_M05_RELATION_SOURCE_FR_PATH"),
      "fr"
    )
    const frenchBefore = await publicLifecycleProbe(request, frenchDefaultPath)
    const englishBefore = await publicLifecycleProbe(request, required("FR6_E2E_M05_EN_PREFIXED_PATH"))
    expect(frenchBefore).toMatchObject({ status: 200, rscStatus: 200, lang: "fr", noindex: false })
    expect(frenchBefore.body).toContain(required("FR6_E2E_M05_FR_MARKER"))
    expect([200, 404]).toContain(englishBefore.status)
    expect(englishBefore.noindex).toBe(true)
    await assertNotFoundWithNoindex(request, required("FR6_E2E_M05_EN_PREFIXED_PATH"))
    expect((await client.query(api.cms.modules.effective, {})).modules).toContainEqual({ id: "redirects", outcome: "on" })
    expect(await client.query(api.cms.redirects.list, {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ locale: "fr", fromPath: required("FR6_E2E_M05_MANUAL_FR_PATH") }),
    ]))
    expect(JSON.stringify(await client.query(api.cms.menus.getCanonical, {
      slug: required("FR6_E2E_M05_MENU_SLUG"),
    }))).toContain(required("FR6_E2E_M05_FR_MENU_LABEL"))
    const retainedMedia = await client.query(api.cms.media.getByName, {
      name: required("FR6_E2E_M05_MEDIA_NAME"),
    })
    if (!retainedMedia) throw new Error("The disabled-state V10 media fixture is missing")
    expect((await client.query(api.cms.media.usage, { id: retainedMedia._id })).pages.map((page) => page._id)).toContain(
      required("FR6_E2E_M05_MEDIA_PAGE_ID") as Id<"pages">
    )
    const carriedBefore = await request.get(required("FR6_E2E_P24_CARRY_PATH"), {
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(carriedBefore.status()).toBe(307)
    expect(carriedBefore.headers().location).toBe(required("FR6_E2E_P24_CARRY_DESTINATION"))

    await revealRetainedLocale(owner, client, "en")

    const french = await publicLifecycleProbe(request, frenchDefaultPath)
    expect(french).toMatchObject({ status: 200, rscStatus: 200, lang: "fr", noindex: false, inSitemap: true })
    expect(french.body).toContain(required("FR6_E2E_M05_FR_MARKER"))
    const english = await publicLifecycleProbe(request, required("FR6_E2E_M05_EN_PREFIXED_PATH"))
    expect(english).toMatchObject({ status: 200, rscStatus: 200, lang: "en", noindex: false, inSitemap: true })
    expect(english.body).toContain(required("FR6_E2E_M05_EN_MARKER"))
    expect(await (await request.get(relationDefaultPath)).text()).toContain(
      required("FR6_E2E_M05_RELATION_TARGET_FR_MARKER")
    )
    const carried = await request.get(required("FR6_E2E_P24_CARRY_PATH"), {
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(carried.status()).toBe(307)
    expect(carried.headers().location).toBe(required("FR6_E2E_P24_CARRY_DESTINATION"))

    const publicClient = anonymousClient()
    const siteConfig = await publicClient.query(api.cms.settings.getSiteConfig, {})
    const publicMenu = await publicClient.query(api.cms.menus.getWithResolvedLinks, {
      slug: required("FR6_E2E_M05_MENU_SLUG"),
      locale: "fr",
      languageVersion: siteConfig.languageVersion,
    })
    expect(JSON.stringify(publicMenu)).toContain(required("FR6_E2E_M05_FR_MENU_LABEL"))
    expect(await publicClient.query(api.cms.redirects.resolve, {
      path: required("FR6_E2E_M05_MANUAL_FR_PATH"),
      locale: "fr",
      languageVersion: siteConfig.languageVersion,
    })).toEqual({ destination: "/", statusCode: 302 })
    expect((await client.query(api.cms.media.usage, { id: retainedMedia._id })).pages.map((page) => page._id)).toContain(
      required("FR6_E2E_M05_MEDIA_PAGE_ID") as Id<"pages">
    )
    await testInfo.attach("p7-reenable-readopt-reveal", {
      body: JSON.stringify({
        frenchBefore: publicLifecycleEvidence(frenchBefore),
        englishBefore: publicLifecycleEvidence(englishBefore),
        frenchAfter: publicLifecycleEvidence(french),
        englishAfter: publicLifecycleEvidence(english),
      }),
      contentType: "application/json",
    })

    const finalState = await client.query(api.cms.multilingual.getMultilingualState, {})
    expect(finalState).toMatchObject({
      lifecycleState: "S4",
      moduleEnabled: true,
      defaultLocale: "fr",
      enabledLocales: ["fr", "en"],
      openOperation: null,
    })
  } finally {
    await owner.context().close()
  }
})
