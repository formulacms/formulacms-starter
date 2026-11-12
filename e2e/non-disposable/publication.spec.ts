import { expect, test } from "playwright/test"
import {
  pageTranslator,
  adminLocale,
  adminMessages,
  assertNotFoundWithNoindex,
  localOrigin,
  ownerPage,
  required,
  sitemap,
  signIn,
} from "../support"

/**
 * V04 and public publication probes. Preconditions: a built local app with a
 * completed English owner setup; FR6_E2E_V04_EDITOR is an unpublished,
 * test-owned Page with a routable locale and FR6_E2E_V04_PATH is its public
 * URL. FR6_E2E_B_* names an unrelated account. Postcondition: the fixture is
 * withdrawn and absent from the sitemap. The operator owns the fixture's later
 * cleanup.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("V04 keeps drafts private, binds preview to the owner, and withdraws cleanly", async ({ browser, request }) => {
  const editor = required("FR6_E2E_V04_EDITOR")
  const path = required("FR6_E2E_V04_PATH")
  const marker = `FR6 V04 ${Date.now()}`
  const owner = await ownerPage(browser)
  try {
    await test.step("draft save does not alter public output", async () => {
      await assertNotFoundWithNoindex(request, path)
      expect(await sitemap(request)).not.toContain(path)
      await owner.goto(editor)
      const pageTitle = adminMessages(await adminLocale(owner)).editor.page.pageTitle
      await owner.getByLabel(pageTitle, { exact: true }).fill(marker)
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.save"), exact: true }).click()
      await expect(owner.getByText((await pageTranslator(owner))("editor.pageSave.saved"), { exact: true })).toBeVisible()
      await assertNotFoundWithNoindex(request, path)
    })

    await test.step("only the owner can preview the saved draft", async () => {
      const [preview] = await Promise.all([
        owner.waitForEvent("popup"),
        owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.preview"), exact: true }).click(),
      ])
      await expect(preview.getByText(marker)).toBeVisible()
      const previewUrl = preview.url()
      const signedOut = await browser.newContext({ baseURL: localOrigin() })
      const signedOutPage = await signedOut.newPage()
      await signedOutPage.goto(previewUrl)
      await expect(signedOutPage.getByText(marker)).toHaveCount(0)
      await signedOut.close()
      const other = await browser.newContext({ baseURL: localOrigin() })
      const otherPage = await other.newPage()
      await signIn(otherPage, required("FR6_E2E_B_EMAIL"), required("FR6_E2E_B_PASSWORD"))
      await otherPage.goto(previewUrl)
      await expect(otherPage.getByText(marker)).toHaveCount(0)
      await other.close()
      await preview.close()
    })

    await test.step("publication changes only the selected locale's public snapshot", async () => {
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.publish"), exact: true }).click()
      await expect(owner.getByText((await pageTranslator(owner))("editor.pageSave.published"), { exact: true })).toBeVisible()
      const publicResponse = await request.get(path)
      expect(publicResponse.ok()).toBe(true)
      expect(await publicResponse.text()).toContain(marker)
      expect(await sitemap(request)).toContain(path)
      const pageTitle = adminMessages(await adminLocale(owner)).editor.page.pageTitle
      await owner.getByLabel(pageTitle, { exact: true }).fill(`${marker} draft two`)
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.save"), exact: true }).click()
      const stillPublished = await request.get(path)
      expect(await stillPublished.text()).toContain(marker)
      expect(await stillPublished.text()).not.toContain(`${marker} draft two`)
    })

    await test.step("withdrawal removes the route and its sitemap entry", async () => {
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.moreActions") }).click()
      await owner.getByRole("menuitem", { name: (await pageTranslator(owner))("editor.page.unpublish") }).click()
      await owner
        .getByRole("alertdialog")
        .getByRole("button", {
          name: (await pageTranslator(owner))("pages.list.unpublish.confirm"),
          exact: true,
        })
        .click()
      await expect(owner.getByText((await pageTranslator(owner))("editor.pageSave.unpublished"), { exact: true })).toBeVisible()
      await assertNotFoundWithNoindex(request, path)
      expect(await sitemap(request)).not.toContain(path)
    })
  } finally {
    await owner.context().close()
  }
})
