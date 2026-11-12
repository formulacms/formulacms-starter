import { expect, test, type Page } from "playwright/test"
import { api } from "../../convex/_generated/api"
import {
  anonymousClient,
  assertNotFoundWithNoindex,
  clientFor,
  expectConvexDenialWithoutChange,
  getLocaleDisplayName,
  ownerPage,
  pageTranslator,
  publicLifecycleEvidence,
  publicLifecycleProbe,
  requireDisposableStage,
  required,
  sitemap,
} from "../support"

async function addLanguage(page: Page, locale: string) {
  const t = await pageTranslator(page)
  await page.goto("/admin/settings/languages")
  await page.getByRole("button", { name: t("settings.multilingualLanguages.list.addLabel") }).click()
  await page.getByRole("option").filter({ hasText: new RegExp(`${locale}$`) }).click()
  await page.getByRole("button", { name: t("settings.multilingualLanguages.list.addButton") }).click()
  const language = getLocaleDisplayName(locale)
  const saved = t("settings.multilingualLanguages.add.added", { language })
  await expect(page.getByText(saved, { exact: true })).toBeVisible()
}

async function publishLocale(page: Page, editor: string, tab: string, marker: string) {
  await page.goto(editor)
  await page.getByRole("tab", { name: tab }).click()
  await page.getByLabel((await pageTranslator(page))("editor.page.pageTitle")).fill(marker)
  await page.getByRole("button", { name: (await pageTranslator(page))("editor.page.save"), exact: true }).click()
  await expect(page.getByText((await pageTranslator(page))("editor.pageSave.saved"), { exact: true })).toBeVisible()
  await page.getByRole("button", { name: (await pageTranslator(page))("editor.page.publish"), exact: true }).click()
  await expect(page.getByText((await pageTranslator(page))("editor.pageSave.published"), { exact: true })).toBeVisible()
}

/**
 * M05 stage 2 — P4, relation recovery, P7(g), and locale-output parts of V10.
 * Preconditions: stage 1 left S4 with only `en`; the fixture Page is published
 * in English, its `fr` draft is private, the relation source and target are
 * test-owned, and the public path is warmed as not-found. Postcondition:
 * `en` and `fr` are enabled and published for the main fixture; the
 * relation source publishes only after its target is available in the same
 * locale. No fixture is deleted. Start state: `after-m05-1-adoption`.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("M05 stage 2 adds locales, publishes independently, and recovers a cross-locale relation", async ({ browser, request }, testInfo) => {
  requireDisposableStage("m05", "m05-2-languages")
  const owner = await ownerPage(browser)
  try {
    const client = await clientFor(owner)
    const start = await client.query(api.cms.multilingual.getMultilingualState, {})
    expect(start).toMatchObject({ lifecycleState: "S4", defaultLocale: "en", enabledLocales: ["en"] })
    const englishBefore = await publicLifecycleProbe(request, required("FR6_E2E_M05_EN_PATH"))
    expect(englishBefore).toMatchObject({ status: 200, lang: "en", noindex: false })
    expect(englishBefore.body).toContain(required("FR6_E2E_M05_EN_MARKER"))
    const frenchPath = required("FR6_E2E_M05_FR_PATH")
    const frenchBefore = await publicLifecycleProbe(request, frenchPath)
    expect([200, 404]).toContain(frenchBefore.status)
    expect(frenchBefore.noindex).toBe(true)
    await assertNotFoundWithNoindex(request, frenchPath)

    await addLanguage(owner, "fr")
    const added = await client.query(api.cms.multilingual.getMultilingualState, {})
    expect(added.enabledLocales).toEqual(["en", "fr"])
    expect(added.version).toBe((start.version ?? 0) + 1)

    await expectConvexDenialWithoutChange(
      () => client.query(api.cms.multilingual.getMultilingualState, {}),
      () => client.mutation(api.cms.multilingual.addLanguage, {
        locale: "fr",
        expectedAuthorityVersion: added.version!,
        expectedModuleConfigurationVersion: added.moduleConfigurationVersion,
      }),
      "LOCALE_ALREADY_ENABLED"
    )
    await publishLocale(
      owner,
      required("FR6_E2E_M05_PAGE_EDITOR"),
      required("FR6_E2E_M05_FR_TAB"),
      required("FR6_E2E_M05_FR_MARKER")
    )

    const afterPublication = []
    for (const [locale, path, marker] of [
      ["fr", frenchPath, required("FR6_E2E_M05_FR_MARKER")],
    ] as const) {
      const probe = await publicLifecycleProbe(request, path)
      expect(probe).toMatchObject({ status: 200, rscStatus: 200, lang: locale, noindex: false, inSitemap: true })
      const body = probe.body
      expect(body).toContain(marker)
      expect(body).toMatch(new RegExp(`<html[^>]+lang=["']${locale}["']`))
      expect(body).toMatch(/hreflang=["']en["']/)
      expect(body).toMatch(/hreflang=["']fr["']/)
      expect(body).toMatch(/hreflang=["']x-default["']/)
      expect(await sitemap(request)).toContain(path)
      afterPublication.push({ locale, fields: publicLifecycleEvidence(probe) })
    }
    const french = await (await request.get(frenchPath)).text()
    expect(french).not.toContain(required("FR6_E2E_M05_UNTRANSLATED_MENU_LABEL"))
    expect(french).not.toContain(required("FR6_E2E_M05_UNTRANSLATED_MENU_CHILD_LABEL"))

    await owner.goto(required("FR6_E2E_M05_RELATION_SOURCE_EDITOR"))
    await owner.getByRole("tab", { name: required("FR6_E2E_M05_FR_TAB") }).click()
    const relationSearch = owner.getByRole("searchbox", {
      name: required("FR6_E2E_M05_RELATION_FIELD_LABEL"),
    })
    await relationSearch.fill(required("FR6_E2E_M05_RELATION_TARGET_TITLE"))
    await owner.getByRole("option", { name: new RegExp(required("FR6_E2E_M05_RELATION_TARGET_TITLE")) }).click()
    await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.save"), exact: true }).click()
    await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.publish"), exact: true }).click()
    await expect(owner.getByText((await pageTranslator(owner))("editor.pageSave.publication.targetLocaleUnavailable"))).toBeVisible()

    await publishLocale(
      owner,
      required("FR6_E2E_M05_RELATION_TARGET_EDITOR"),
      required("FR6_E2E_M05_FR_TAB"),
      required("FR6_E2E_M05_RELATION_TARGET_FR_MARKER")
    )
    await owner.goto(required("FR6_E2E_M05_RELATION_SOURCE_EDITOR"))
    await owner.getByRole("tab", { name: required("FR6_E2E_M05_FR_TAB") }).click()
    await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.publish"), exact: true }).click()
    await expect(owner.getByText((await pageTranslator(owner))("editor.pageSave.published"), { exact: true })).toBeVisible()
    expect(await (await request.get(required("FR6_E2E_M05_RELATION_SOURCE_FR_PATH"))).text()).toContain(
      required("FR6_E2E_M05_RELATION_TARGET_FR_MARKER")
    )

    await owner.goto("/admin/settings/modules")
    const moduleText = await pageTranslator(owner)
    const redirectsToggle = owner.getByRole("checkbox", {
      name: moduleText("settings.modules.toggle", {
        name: moduleText("settings.modules.items.redirects.name"),
      }),
      exact: true,
    })
    await expect(redirectsToggle).not.toBeChecked()
    await redirectsToggle.click()
    await owner.getByRole("button", { name: (await pageTranslator(owner))("settings.modules.save") }).click()
    await expect(redirectsToggle).toBeChecked()
    for (const [locale, fromPath] of [
      ["en", required("FR6_E2E_M05_MANUAL_EN_PATH")],
      ["fr", required("FR6_E2E_M05_MANUAL_FR_PATH")],
    ] as const) {
      await client.mutation(api.cms.redirects.create, {
        fromPath,
        toPath: "/",
        locale,
        statusCode: 302,
      })
    }
    const publicClient = anonymousClient()
    const siteConfig = await publicClient.query(api.cms.settings.getSiteConfig, {})
    for (const [locale, fromPath, destination] of [
      ["en", required("FR6_E2E_M05_MANUAL_EN_PATH"), "/"],
      ["fr", required("FR6_E2E_M05_MANUAL_FR_PATH"), "/fr"],
    ] as const) {
      expect(await publicClient.query(api.cms.redirects.resolve, {
        path: fromPath,
        locale,
        languageVersion: siteConfig.languageVersion,
      })).toEqual({ destination, statusCode: 302 })
    }
    await testInfo.attach("p7-add-and-publish", {
      body: JSON.stringify({
        before: {
          fr: publicLifecycleEvidence(frenchBefore),
        },
        afterPublication,
      }),
      contentType: "application/json",
    })
  } finally {
    await owner.context().close()
  }
})
