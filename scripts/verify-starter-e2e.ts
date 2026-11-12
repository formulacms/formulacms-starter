import { chromium, type Browser, type Locator, type Page } from "playwright"
import { getPublicMessages } from "../lib/i18n/public-messages"
import {
  adminMessagesForResolvedLocale,
  setupMessagesForResolvedLocale,
} from "./lib/browser-admin-messages"
import { assertAuthoritativeSetupComplete } from "./lib/browser-setup-authority"

const baseUrl = normalizeBaseUrl(
  process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"
)
const onboardingMode = parseOnboardingMode(
  process.env.STARTER_E2E_ONBOARDING ?? "skip"
)
const navigationTimeoutMs = Number(
  process.env.STARTER_E2E_NAV_TIMEOUT_MS ?? 60_000
)
const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const ownerClaim = process.env.STARTER_E2E_OWNER_CLAIM

type OnboardingMode = "skip" | "single"

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "")
}

function parseOnboardingMode(value: string): OnboardingMode {
  if (value === "skip" || value === "single") {
    return value
  }
  throw new Error("STARTER_E2E_ONBOARDING must be one of: skip, single")
}

function url(path: string) {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`
}

async function assertServerReachable() {
  try {
    await fetch(baseUrl, { redirect: "manual" })
  } catch {
    throw new Error(
      `Could not reach ${baseUrl}. Start Next and Convex before running check:e2e.`
    )
  }
}

async function waitForSettled(page: Page) {
  await page.waitForLoadState("domcontentloaded")
  await page.waitForLoadState("networkidle").catch(() => null)
}

async function assertVisible(
  locator: Locator,
  message: string,
  timeout = 15_000
) {
  try {
    await locator.waitFor({ state: "visible", timeout })
  } catch {
    throw new Error(message)
  }
}

async function pageLocale(page: Page) {
  const locale = await page.locator("html").getAttribute("lang")
  if (!locale) {
    throw new Error("Browser verification requires a resolved <html lang>.")
  }
  return locale
}

// Match the translated progress template without encoding the step count.
function stepHeading(page: Page, template: string, name: string) {
  const pattern = template
    .replace("{current}", name)
    .replace("{step}", "\\d+")
    .replace("{total}", "\\d+")
  return page.getByText(new RegExp("^" + pattern + "$"))
}

async function runOnboarding(page: Page) {
  if (!ownerClaim) {
    throw new Error(
      "STARTER_E2E_OWNER_CLAIM must match FORMULACMS_OWNER_CLAIM for onboarding verification."
    )
  }
  await page.goto(url("/setup"))
  await waitForSettled(page)
  const setup = setupMessagesForResolvedLocale(await pageLocale(page)).setup

  await assertVisible(
    page.getByRole("heading", { name: setup.wizard.title }),
    "Onboarding e2e requires a fresh deployment where /setup renders the wizard. Run this mode against a reset disposable deployment."
  )

  // Setup opens on the language step: accept the prefilled choices.
  await page.getByRole("button", { name: setup.actions.continue }).click()
  await page.getByLabel(setup.fields.name).fill("Starter E2E")
  await page
    .getByLabel(setup.fields.signInEmail)
    .fill(`starter-e2e-${unique}@example.com`)
  await page.getByLabel(setup.fields.newPassword).fill("starter-e2e-password")
  await page
    .getByLabel(setup.fields.confirmPassword)
    .fill("starter-e2e-password")
  await page.getByLabel(setup.fields.ownerCode).fill(ownerClaim)
  await page.getByRole("button", { name: setup.actions.createAccount }).click()

  await assertVisible(
    stepHeading(page, setup.wizard.progress, setup.steps.identity),
    "Onboarding did not advance to site identity.",
    20_000
  )
  await page.getByLabel(setup.fields.siteName).fill("Starter E2E")
  await page.getByLabel(setup.fields.siteUrl).fill(baseUrl)
  await page
    .getByLabel(setup.fields.siteDescription)
    .fill("Automated starter verification site.")
  // Setup is one atomic bootstrap: it saves the one site language, creates a
  // private draft home and marks setup complete. Email and AI live in Settings.
  await page.getByRole("button", { name: setup.actions.finishSetup }).click()
  await page.waitForURL(/\/admin(?:\/)?$/, { timeout: 20_000 })

  // Setup publishes nothing, so a fresh site has no public home yet.
  await page.goto(url("/"))
  await waitForSettled(page)
  await assertVisible(
    page.getByRole("heading", {
      name: getPublicMessages(await pageLocale(page)).notFound.title,
    }),
    "A fresh site's home should show the not-found page until something is published."
  )

  await publishDraftHome(page)
}

// The owner's first publish: the private draft home that setup created goes
// public at "/", so later public checks run against a published home.
async function publishDraftHome(page: Page) {
  await page.goto(url("/admin/pages"))
  await waitForSettled(page)
  const homeLink = page
    .locator('a[href^="/admin/pages/"]')
    .filter({ hasText: "Starter E2E" })
    .first()
  await assertVisible(homeLink, "The draft home is missing from the page list.")
  await homeLink.click()
  await waitForSettled(page)
  const editor = adminMessagesForResolvedLocale(await pageLocale(page)).editor

  const publish = page.getByRole("button", {
    name: editor.page.publish,
    exact: true,
  })
  await assertVisible(publish, "The draft home editor has no Publish button.")
  await publish.click()
  // An empty home publishes with warnings (no sections or SEO text yet).
  const publishAnyway = page.getByRole("button", {
    name: editor.page.prePublish.publishAnyway,
  })
  if (await publishAnyway.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await publishAnyway.click()
  }
  await assertVisible(
    page.getByRole("button", { name: editor.page.publishChanges }),
    "Publishing the draft home did not finish.",
    20_000
  )

  await page.goto(url("/"))
  await waitForSettled(page)
  if (
    (await page
      .getByRole("heading", {
        name: getPublicMessages(await pageLocale(page)).notFound.title,
      })
      .count()) > 0
  ) {
    throw new Error("The published home still shows the not-found page.")
  }
}

async function runForgotPasswordFlow(page: Page) {
  await page.goto(url("/forgot-password"))
  await waitForSettled(page)
  assertAuthoritativeSetupComplete(page.url(), "check:e2e")
  const forgotPassword = adminMessagesForResolvedLocale(await pageLocale(page))
    .auth.forgotPassword
  await assertVisible(
    page.getByRole("heading", { name: forgotPassword.title }),
    "Forgot-password page heading did not render."
  )
  await page
    .getByLabel(forgotPassword.emailLabel)
    .fill(`unknown-${unique}@example.com`)
  await page.getByRole("button", { name: forgotPassword.sendResetLink }).click()
  await assertVisible(
    page.getByText(forgotPassword.confirmation),
    "Forgot-password flow did not show neutral confirmation.",
    20_000
  )
}

async function withPage<T>(
  browser: Browser,
  run: (page: Page) => Promise<T>
): Promise<T> {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultNavigationTimeout(navigationTimeoutMs)
  page.setDefaultTimeout(navigationTimeoutMs)
  try {
    return await run(page)
  } finally {
    await context.close()
  }
}

async function main() {
  await assertServerReachable()
  const browser = await chromium.launch({ headless: true })
  try {
    if (onboardingMode === "single") {
      await withPage(browser, runOnboarding)
    }
    await withPage(browser, runForgotPasswordFlow)
  } finally {
    await browser.close()
  }

  const onboarding =
    onboardingMode === "skip" ? "onboarding skipped" : "single onboarding"
  console.log(`✓ Starter e2e passed (${onboarding}, forgot-password).`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
