import { expect, test, type Page } from "playwright/test"
import { pageTranslator, adminLocale, adminMessages, ownerPage, required } from "../support"

async function saveOutcome(page: Page) {
  const saved = page.getByText((await pageTranslator(page))("editor.pageSave.saved"), { exact: true })
  const conflict = page.getByText((await pageTranslator(page))("editor.pageSave.changedElsewhere"))
  await expect(saved.or(conflict)).toBeVisible()
  return (await saved.isVisible()) ? "saved" : "conflict"
}

async function titleField(page: Page) {
  const label = adminMessages(await adminLocale(page)).editor.page.pageTitle
  return page.getByLabel(label, { exact: true })
}

/**
 * V05. Preconditions: completed owner setup and a test-owned, editable Page at
 * FR6_E2E_V05_EDITOR. Both browser contexts start from the same saved version.
 * Postcondition: the Page remains editable with one saved winner and a visible
 * recovery/conflict path for the loser. The operator owns the test Page's
 * later cleanup.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("V05 rejects stale and concurrent editor saves without erasing the losing draft", async ({ browser }) => {
  const path = required("FR6_E2E_V05_EDITOR")
  const first = await ownerPage(browser)
  const second = await ownerPage(browser)
  const observer = await ownerPage(browser)
  try {
    await test.step("a stale tab cannot overwrite a completed newer save", async () => {
      await first.goto(path)
      await second.goto(path)
      const firstValue = `FR6 stale first ${Date.now()}`
      const secondValue = `FR6 stale second ${Date.now()}`
      await (await titleField(first)).fill(firstValue)
      await (await titleField(second)).fill(secondValue)
      await second.getByRole("button", { name: (await pageTranslator(second))("editor.page.save"), exact: true }).click()
      await expect(second.getByText((await pageTranslator(second))("editor.pageSave.saved"), { exact: true })).toBeVisible()
      await first.getByRole("button", { name: (await pageTranslator(first))("editor.page.save"), exact: true }).click()
      await expect(first.getByText((await pageTranslator(first))("editor.pageSave.changedElsewhere"))).toBeVisible()
      await expect(await titleField(first)).toHaveValue(firstValue)
      await expect(first.getByRole("button", { name: (await pageTranslator(first))("editor.page.conflict.saveAsNew") })).toBeVisible()
      await second.reload()
      await expect(await titleField(second)).toHaveValue(secondValue)
    })

    await test.step("two actions from the same pre-change state have one winner", async () => {
      await first.reload()
      await second.reload()
      const commonValue = await (await titleField(first)).inputValue()
      await expect(await titleField(second)).toHaveValue(commonValue)
      const firstValue = `FR6 simultaneous first ${Date.now()}`
      const secondValue = `FR6 simultaneous second ${Date.now()}`
      await (await titleField(first)).fill(firstValue)
      await (await titleField(second)).fill(secondValue)
      await Promise.all([
        first.getByRole("button", { name: (await pageTranslator(first))("editor.page.save"), exact: true }).click(),
        second.getByRole("button", { name: (await pageTranslator(second))("editor.page.save"), exact: true }).click(),
      ])
      const outcomes = await Promise.all([saveOutcome(first), saveOutcome(second)])
      expect(outcomes.sort()).toEqual(["conflict", "saved"])
      await observer.goto(path)
      const stored = await (await titleField(observer)).inputValue()
      expect([firstValue, secondValue]).toContain(stored)
      const loser = stored === firstValue ? second : first
      const losingValue = stored === firstValue ? secondValue : firstValue
      await expect(await titleField(loser)).toHaveValue(losingValue)
      await expect(loser.getByText((await pageTranslator(loser))("editor.pageSave.changedElsewhere"))).toBeVisible()
      await expect(loser.getByRole("button", { name: (await pageTranslator(loser))("editor.page.conflict.saveAsNew") })).toBeVisible()
    })
  } finally {
    await first.context().close()
    await second.context().close()
    await observer.context().close()
  }
})
