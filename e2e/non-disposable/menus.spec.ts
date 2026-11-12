import { expect, test } from "playwright/test"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import {
  anonymousClient,
  clientFor,
  expectConvexDenial,
  ownerPage,
  pageTranslator,
  required,
  requiredNumber,
} from "../support"

// The confirm dialog's default confirm label is hard-coded English in
// confirm-provider.tsx (no message key); the archive dialog passes none.
const defaultConfirm = "Confirm"

function pageIdFromEditor(editor: string): Id<"pages"> {
  const pathname = new URL(editor, "http://formulacms.invalid").pathname
  const match = /^\/admin\/pages\/([^/]+)$/.exec(pathname)
  if (!match) throw new Error("FR6_E2E_MENU_PAGE_EDITOR must point to a Page editor")
  return decodeURIComponent(match[1]!) as Id<"pages">
}

/**
 * FR6.Menus. Preconditions: English built app, completed owner setup, a
 * published test-owned Page named FR6_E2E_MENU_PAGE_TITLE, and a configured
 * primary header menu. FR6_E2E_MENU_PAGE_EDITOR points to that Page. The
 * test-created item is removed at the end; the linked Page is restored and
 * stays published after the trash positive control. The operator owns fixture
 * cleanup.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("Menus item CRUD and live link continuity", async ({ browser, request }) => {
  const pageTitle = required("FR6_E2E_MENU_PAGE_TITLE")
  const editor = required("FR6_E2E_MENU_PAGE_EDITOR")
  const pageId = pageIdFromEditor(editor)
  const staleLanguageVersion = requiredNumber("FR6_E2E_MENU_STALE_LANGUAGE_VERSION")
  const preBumpLabel = required("FR6_E2E_MENU_PRE_BUMP_LABEL")
  const createdMarker = `FR6 menu ${Date.now()}`
  const marker = `${createdMarker} updated`
  const owner = await ownerPage(browser)
  try {
    const publicClient = anonymousClient()
    const ownerClient = await clientFor(owner)
    const config = await publicClient.query(api.cms.settings.getSiteConfig, {})
    const initialMenu = await ownerClient.query(api.cms.menus.getCanonical, { slug: "primary" })
    if (!initialMenu || initialMenu.nav.length === 0) {
      throw new Error("The primary Menu must have an existing item for the reorder fixture")
    }
    expect(staleLanguageVersion).toBeLessThan(config.languageVersion)
    await expectConvexDenial(
      publicClient.query(api.cms.menus.getWithResolvedLinks, {
        slug: "primary",
        locale: "en",
        languageVersion: staleLanguageVersion,
      }),
      "SITE_LANGUAGE_VERSION_CHANGED"
    )

    await owner.goto("/admin/menus/primary")
    const t = await pageTranslator(owner)
    await expect(
      owner.getByRole("heading", { name: t("menus.editor.title", { slug: "primary" }), exact: true })
    ).toBeVisible()
    await owner.getByRole("button", { name: (await pageTranslator(owner))("menus.editor.addItem") }).click()
    const label = owner.getByRole("textbox", { name: (await pageTranslator(owner))("menus.navigationItem.labelPlaceholder") }).last()
    await label.fill(createdMarker)
    await owner.getByRole("button", { name: (await pageTranslator(owner))("menus.navigationItem.expand") }).last().click()
    await owner.getByRole("tab", { name: (await pageTranslator(owner))("menus.link.page"), exact: true }).last().click()
    await owner.getByRole("button", { name: (await pageTranslator(owner))("menus.link.selectPagePlaceholder") }).last().click()
    await owner.getByRole("textbox", { name: (await pageTranslator(owner))("menus.link.searchLabel") }).fill(pageTitle)
    await owner.getByRole("button", { name: new RegExp(pageTitle, "i") }).last().click()
    await owner.getByRole("button", { name: (await pageTranslator(owner))("menus.editor.save") }).click()
    await expect(owner.getByText((await pageTranslator(owner))("menus.editor.saved"), { exact: true })).toBeVisible()
    let home = await request.get("/")
    const homeBody = await home.text()
    expect(homeBody).toContain(createdMarker)
    expect(homeBody).not.toContain(preBumpLabel)
    const resolved = await publicClient.query(api.cms.menus.getWithResolvedLinks, {
      slug: "primary",
      locale: "en",
      languageVersion: config.languageVersion,
    })
    expect(JSON.stringify(resolved?.nav)).toContain(createdMarker)

    await test.step("the created item can be updated and reordered", async () => {
      await owner.goto("/admin/menus/primary")
      const item = owner.locator("div.overflow-hidden.rounded-lg.border.bg-card").filter({
        has: owner.locator(`input[aria-label="${(await pageTranslator(owner))("menus.navigationItem.labelPlaceholder")}"][value="${createdMarker}"]`),
      })
      await expect(item).toHaveCount(1)
      await item.getByLabel((await pageTranslator(owner))("menus.navigationItem.labelPlaceholder")).fill(marker)
      await item.getByRole("button", { name: (await pageTranslator(owner))("menus.navigationItem.moveUp") }).click()
      await owner.getByRole("button", { name: (await pageTranslator(owner))("menus.editor.save") }).click()
      await expect(owner.getByText((await pageTranslator(owner))("menus.editor.saved"), { exact: true })).toBeVisible()
      const updated = await ownerClient.query(api.cms.menus.getCanonical, { slug: "primary" })
      expect(updated?.nav.findIndex((entry) => entry.label.en === marker)).toBe(initialMenu.nav.length - 1)
      home = await request.get("/")
      const updatedBody = await home.text()
      expect(updatedBody).toContain(marker)
      expect(updatedBody).not.toContain(createdMarker + "</")
    })

    await test.step("withdrawn linked content does not leak a public href", async () => {
      await owner.goto(editor)
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.moreActions") }).click()
      await owner.getByRole("menuitem", { name: (await pageTranslator(owner))("editor.page.unpublish") }).click()
      await owner
        .getByRole("alertdialog")
        .getByRole("button", {
          name: (await pageTranslator(owner))("pages.list.unpublish.confirm"),
          exact: true,
        })
        .click()
      await owner.goto("/")
      await expect(owner.getByRole("link", { name: marker })).toHaveCount(0)
      await owner.goto(editor)
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.publish"), exact: true }).click()
      home = await request.get("/")
      expect(await home.text()).toContain(marker)
    })

    await test.step("Page-list trash refuses a Page linked by the live Menu", async () => {
      const actionsForPage = t("pages.list.actionsFor", { title: pageTitle })
      await owner.goto("/admin/pages")
      await owner.getByRole("button", { name: actionsForPage, exact: true }).click()
      await owner.getByRole("menuitem", { name: (await pageTranslator(owner))("pages.list.actions.archive") }).click()
      await expect(
        owner.getByRole("heading", { name: (await pageTranslator(owner))("pages.list.archiveDialog.title") })
      ).toBeVisible()
      await owner.getByRole("button", { name: defaultConfirm, exact: true }).click()
      await expect(owner.getByText((await pageTranslator(owner))("pages.list.toast.archived"), { exact: true })).toBeVisible()

      await owner.getByLabel((await pageTranslator(owner))("pages.list.filters.status")).selectOption("archived")
      const beforePage = await ownerClient.query(api.cms.pages.getForEdit, { id: pageId })
      const beforeMenu = await ownerClient.query(api.cms.menus.getCanonical, {
        slug: "primary",
      })
      expect(beforePage?.page.status).toBe("archived")
      expect(JSON.stringify(beforeMenu?.nav)).toContain(marker)

      await owner.getByRole("button", { name: actionsForPage, exact: true }).click()
      await owner.getByRole("menuitem", { name: (await pageTranslator(owner))("pages.list.actions.moveToTrash") }).click()
      await expect(
        owner.getByRole("heading", { name: (await pageTranslator(owner))("pages.list.trashDialog.title") })
      ).toBeVisible()
      await owner
        .getByRole("button", { name: (await pageTranslator(owner))("pages.list.trashDialog.confirm"), exact: true })
        .click()
      await expect(
        owner.getByText((await pageTranslator(owner))("pages.list.toast.menuReference"), { exact: true })
      ).toBeVisible()

      expect(await ownerClient.query(api.cms.pages.getForEdit, { id: pageId })).toEqual(
        beforePage
      )
      expect(
        await ownerClient.query(api.cms.menus.getCanonical, { slug: "primary" })
      ).toEqual(beforeMenu)
      await expect(
        owner.getByRole("button", { name: actionsForPage, exact: true })
      ).toBeVisible()
    })

    await test.step("removing the item updates the public menu without a publish step", async () => {
      await owner.goto("/admin/menus/primary")
      const item = owner.locator("div.overflow-hidden.rounded-lg.border.bg-card").filter({
        has: owner.locator(`input[aria-label="${(await pageTranslator(owner))("menus.navigationItem.labelPlaceholder")}"][value="${marker}"]`),
      })
      await expect(item).toHaveCount(1)
      await item.getByRole("button", { name: (await pageTranslator(owner))("menus.navigationItem.delete") }).click()
      await owner.getByRole("button", { name: (await pageTranslator(owner))("menus.editor.save") }).click()
      await expect(owner.getByText((await pageTranslator(owner))("menus.editor.saved"), { exact: true })).toBeVisible()
      await owner.goto("/")
      await expect(owner.getByRole("link", { name: marker })).toHaveCount(0)
    })

    await test.step("Page-list trash succeeds after the live Menu link is removed", async () => {
      const actionsForPage = t("pages.list.actionsFor", { title: pageTitle })
      const restoredToast = t("inventory.trash.restored", { title: pageTitle })

      await owner.goto("/admin/pages")
      await owner.getByLabel((await pageTranslator(owner))("pages.list.filters.status")).selectOption("archived")
      await owner.getByRole("button", { name: actionsForPage, exact: true }).click()
      await owner.getByRole("menuitem", { name: (await pageTranslator(owner))("pages.list.actions.moveToTrash") }).click()
      await owner
        .getByRole("button", { name: (await pageTranslator(owner))("pages.list.trashDialog.confirm"), exact: true })
        .click()
      await expect(owner.getByText((await pageTranslator(owner))("pages.list.toast.movedToTrash"), { exact: true })).toBeVisible()
      expect(await ownerClient.query(api.cms.pages.getForEdit, { id: pageId })).toBeNull()

      await owner.goto("/admin/trash")
      const trashRow = owner.locator("div.divide-y > div").filter({
        has: owner.getByText(pageTitle, { exact: true }),
      })
      await expect(trashRow).toHaveCount(1)
      await trashRow.getByRole("button", { name: (await pageTranslator(owner))("inventory.trash.restore") }).click()
      await expect(owner.getByText(restoredToast, { exact: true })).toBeVisible()

      await owner.goto("/admin/pages")
      await owner.getByLabel((await pageTranslator(owner))("pages.list.filters.status")).selectOption("archived")
      await owner.getByRole("button", { name: actionsForPage, exact: true }).click()
      await owner.getByRole("menuitem", { name: (await pageTranslator(owner))("pages.list.actions.unarchive") }).click()
      await expect(owner.getByText((await pageTranslator(owner))("pages.list.toast.restored"), { exact: true })).toBeVisible()
      const restored = await ownerClient.query(api.cms.pages.getForEdit, { id: pageId })
      expect(restored?.page.status).toBe("published")
    })
  } finally {
    await owner.context().close()
  }
})
