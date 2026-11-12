import { expect, test } from "playwright/test"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import {
  pageTranslator,
  anonymousClient,
  clientFor,
  expectConvexDenial,
  localOrigin,
  ownerPage,
  required,
  requiredNumber,
} from "../support"

/**
 * Runtime authorization representatives for the page/editor, Menu, and
 * language guard paths. Preconditions: completed English owner setup, an
 * unrelated signed-in B, a real test Page id, and configured primary Menu.
 * Redirects and M05 are off. Postcondition: no test-owned data changes; the
 * positive Menu save writes the same nav and the denied calls leave its row
 * unchanged.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("signed-out and unrelated identities receive exact guard errors while owner controls work", async ({ browser }) => {
  const owner = await ownerPage(browser)
  const unrelatedContext = await browser.newContext({ baseURL: localOrigin() })
  const unrelated = await unrelatedContext.newPage()
  const signedOutContext = await browser.newContext({ baseURL: localOrigin() })
  const signedOut = await signedOutContext.newPage()
  try {
    await owner.goto("/admin")
    await expect(owner).toHaveURL(/\/admin(?:\/|$)/)
    await signedOut.goto("/admin")
    await expect(signedOut).not.toHaveURL(/\/admin(?:\/|$)/)
    const signedOutToken = await signedOutContext.request.get(`${localOrigin()}/api/auth/convex/token`)
    expect(signedOutToken.ok()).toBe(false)

    await unrelated.goto("/sign-in")
    await unrelated.getByLabel((await pageTranslator(unrelated))("auth.signIn.form.emailLabel")).fill(required("FR6_E2E_B_EMAIL"))
    await unrelated.getByLabel((await pageTranslator(unrelated))("auth.signIn.form.passwordLabel")).fill(required("FR6_E2E_B_PASSWORD"))
    await unrelated.getByRole("button", { name: (await pageTranslator(unrelated))("auth.signIn.form.submit") }).click()
    await unrelated.goto("/admin")
    await expect(unrelated).not.toHaveURL(/\/admin(?:\/|$)/)

    const ownerClient = await clientFor(owner)
    const otherClient = await clientFor(unrelated)
    const anonymous = anonymousClient()
    const pageId = required("FR6_E2E_AUTH_PAGE_ID") as Id<"pages">
    const lifecycleGeneration = requiredNumber("FR6_E2E_AUTH_PAGE_LIFECYCLE_GENERATION")

    const editable = await ownerClient.query(api.cms.pages.getForEdit, { id: pageId })
    expect(editable).not.toBeNull()
    expect(await otherClient.query(api.cms.pages.getForEdit, { id: pageId })).toBeNull()
    expect(await anonymous.query(api.cms.pages.getForEdit, { id: pageId })).toBeNull()
    expect(await ownerClient.query(api.cms.publication.getAdminAuthority, {})).toBe("snapshot_active")
    await expectConvexDenial(otherClient.query(api.cms.publication.getAdminAuthority, {}), "CMS_OWNER_REQUIRED")
    await expectConvexDenial(anonymous.query(api.cms.publication.getAdminAuthority, {}), "UNAUTHENTICATED")
    await expectConvexDenial(
      otherClient.mutation(api.cms.publication.softDeletePage, {
        pageId,
        expectedLifecycleGeneration: lifecycleGeneration,
      }),
      "CMS_OWNER_REQUIRED"
    )
    await expectConvexDenial(
      anonymous.mutation(api.cms.publication.softDeletePage, {
        pageId,
        expectedLifecycleGeneration: lifecycleGeneration,
      }),
      "UNAUTHENTICATED"
    )
    expect(await ownerClient.query(api.cms.pages.getForEdit, { id: pageId })).toEqual(editable)

    const menu = await ownerClient.query(api.cms.menus.getCanonical, { slug: "primary" })
    expect(menu).not.toBeNull()
    if (!menu) throw new Error("The primary Menu fixture is missing")
    await expectConvexDenial(otherClient.query(api.cms.menus.getCanonical, { slug: "primary" }), "CMS_OWNER_REQUIRED")
    await expectConvexDenial(anonymous.query(api.cms.menus.getCanonical, { slug: "primary" }), "UNAUTHENTICATED")
    await expectConvexDenial(
      otherClient.mutation(api.cms.menus.saveCanonical, { slug: "primary", locale: "en", nav: menu.nav }),
      "CMS_OWNER_REQUIRED"
    )
    await expectConvexDenial(
      anonymous.mutation(api.cms.menus.saveCanonical, { slug: "primary", locale: "en", nav: menu.nav }),
      "UNAUTHENTICATED"
    )
    expect(await ownerClient.query(api.cms.menus.getCanonical, { slug: "primary" })).toEqual(menu)
    await ownerClient.mutation(api.cms.menus.saveCanonical, { slug: "primary", locale: "en", nav: menu.nav })

    const state = await ownerClient.query(api.cms.language.getLanguageState, {})
    expect(state.kind).toBe("current")
    await expectConvexDenial(otherClient.query(api.cms.language.getLanguageState, {}), "CMS_OWNER_REQUIRED")
    await expectConvexDenial(anonymous.query(api.cms.language.getLanguageState, {}), "UNAUTHENTICATED")
    await expectConvexDenial(ownerClient.query(api.cms.redirects.list, {}), "CMS_MODULE_DISABLED")
    await expectConvexDenial(otherClient.query(api.cms.redirects.list, {}), "CMS_OWNER_REQUIRED")
    await expectConvexDenial(anonymous.query(api.cms.redirects.list, {}), "UNAUTHENTICATED")
  } finally {
    await owner.context().close()
    await unrelatedContext.close()
    await signedOutContext.close()
  }
})
