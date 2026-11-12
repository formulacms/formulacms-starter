import { expect, test } from "playwright/test"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import fr from "../../messages/admin/fr.json" with { type: "json" }
import {
  anonymousClient,
  assertNotFoundWithNoindex,
  clientFor,
  expectConvexDenial,
  getLocaleDisplayName,
  ownerPage,
  pageTranslator,
  required,
} from "../support"

/**
 * V06. Preconditions: built English single-language app, completed owner
 * setup, no enabled French content, and an unset English admin preference.
 * FR6_E2E_FRENCH_ABSENT_PATH is a known unpublished French route.
 * Postcondition: admin preference is restored to English; site language and
 * publication are unchanged.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("V06 French admin preference does not enable French public content", async ({ browser, request }) => {
  const owner = await ownerPage(browser)
  try {
    const ownerClient = await clientFor(owner)
    const publicClient = anonymousClient()
    const pageId = required("FR6_E2E_V06_PAGE_ID") as Id<"pages">
    const config = await publicClient.query(api.cms.settings.getSiteConfig, {})
    expect(config.enabledLocales).toEqual(["en"])
    const beforeAdmin = await ownerClient.query(api.cms.pages.getForEdit, { id: pageId })
    const beforePublic = await publicClient.query(api.cms.pages.getPublicPageById, {
      id: pageId,
      locale: "fr",
      languageVersion: config.languageVersion,
    })
    expect(beforePublic).toBeNull()
    await expectConvexDenial(
      ownerClient.mutation(api.cms.publication.discardLocaleDraft, {
        pageId,
        locale: "fr",
        expectedDraftGeneration: 0,
        expectedLifecycleGeneration: 0,
      }),
      "LOCALE_NOT_ENABLED"
    )
    expect(await ownerClient.query(api.cms.pages.getForEdit, { id: pageId })).toEqual(beforeAdmin)
    expect(await publicClient.query(api.cms.pages.getPublicPageById, {
      id: pageId,
      locale: "fr",
      languageVersion: config.languageVersion,
    })).toBeNull()

    await owner.goto("/admin/settings/account")
    await expect(owner.locator("html")).toHaveAttribute("lang", "en")
    await owner.getByRole("combobox").click()
    await owner.getByRole("option", { name: getLocaleDisplayName("fr"), exact: true }).click()
    await owner.getByRole("button", { name: (await pageTranslator(owner))("settings.account.ok"), exact: true }).click()
    await expect(owner.locator("html")).toHaveAttribute("lang", "fr")
    await expect(owner.getByRole("heading", { name: fr.settings.account.title })).toBeVisible()
    const home = await request.get("/")
    expect(home.ok()).toBe(true)
    expect(await home.text()).toMatch(/<html[^>]+lang="en"/)
    await assertNotFoundWithNoindex(request, required("FR6_E2E_FRENCH_ABSENT_PATH"))
    await owner.getByRole("combobox").click()
    await owner.getByRole("option", { name: getLocaleDisplayName("en"), exact: true }).click()
    await owner.getByRole("button", { name: (await pageTranslator(owner))("settings.account.ok"), exact: true }).click()
    await expect(owner.locator("html")).toHaveAttribute("lang", "en")
  } finally {
    await owner.context().close()
  }
})

/**
 * V07. Preconditions: built single-language app with Redirects and M05 off.
 * Postcondition: no module setting changes.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 * The spec records only Convex function names (no
 * arguments, credentials, response bodies, or raw trace) on `/` and a real
 * editor route, then checks them against the optional-module namespaces.
 */
test("V07 optional modules are off while core editing and public delivery remain reachable", async ({ browser, request }) => {
  const owner = await ownerPage(browser)
  try {
    await owner.context().addInitScript(() => {
      const sent: string[] = []
      const target = window as Window & { __fr6ConvexFunctions?: string[] }
      target.__fr6ConvexFunctions = sent
      const original = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          try {
            const visit = (value: unknown): void => {
              if (typeof value === "string" && /^[a-zA-Z0-9_/-]+:[a-zA-Z0-9_/-]+$/.test(value)) {
                sent.push(value)
              } else if (Array.isArray(value)) {
                value.forEach(visit)
              } else if (value && typeof value === "object") {
                Object.values(value).forEach(visit)
              }
            }
            visit(JSON.parse(data))
          } catch {
            // Non-JSON websocket frames are outside the Convex name audit.
          }
        }
        return original.call(this, data)
      }
    })
    await owner.goto("/admin/settings/modules")
    await expect(owner.getByRole("heading", { name: (await pageTranslator(owner))("settings.modules.title") })).toBeVisible()
    const moduleText = await pageTranslator(owner)
    for (const moduleId of ["redirects", "multilingual"] as const) {
      const toggleName = moduleText("settings.modules.toggle", {
        name: moduleText(`settings.modules.items.${moduleId}.name`),
      })
      await expect(owner.getByRole("checkbox", { name: toggleName, exact: true })).not.toBeChecked()
    }
    await owner.goto("/admin/pages")
    await expect(owner.getByRole("heading", { name: (await pageTranslator(owner))("pages.title") })).toBeVisible()
    await owner.goto("/admin/menus")
    await expect(owner.getByRole("heading", { name: (await pageTranslator(owner))("menus.list.title") })).toBeVisible()
    await owner.goto("/admin/media")
    await expect(owner.getByRole("heading", { name: (await pageTranslator(owner))("inventory.mediaLibrary.title") })).toBeVisible()
    // These absence probes stay deliberately broad: no single shipped string
    // names search or scheduling. They are English patterns, so first prove the
    // admin rendered English and they cannot pass vacuously.
    await expect(owner.locator("html")).toHaveAttribute("lang", "en")
    await expect(owner.getByRole("link", { name: /submissions|search/i })).toHaveCount(0)
    await expect(owner.getByText(/schedule|scheduled/i)).toHaveCount(0)
    await owner.goto("/")
    await expect(owner.locator("html")).toHaveAttribute("lang", "en")
    const publicCalls = await owner.evaluate(() =>
      [...new Set((window as Window & { __fr6ConvexFunctions?: string[] }).__fr6ConvexFunctions ?? [])]
    )
    await owner.goto(required("FR6_E2E_V07_EDITOR"))
    await expect(owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.save"), exact: true })).toBeVisible()
    const editorCalls = await owner.evaluate(() =>
      [...new Set((window as Window & { __fr6ConvexFunctions?: string[] }).__fr6ConvexFunctions ?? [])]
    )
    const optionalPrefixes = ["cms/multilingual:", "cms/redirects:", "email:"]
    for (const functionName of [...publicCalls, ...editorCalls]) {
      expect(optionalPrefixes.some((prefix) => functionName.startsWith(prefix)), functionName).toBe(false)
    }
    const home = await request.get("/")
    expect(home.ok()).toBe(true)
    expect(await home.text()).toMatch(/<html[^>]+lang="en"/)
  } finally {
    await owner.context().close()
  }
})
