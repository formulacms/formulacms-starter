import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { getPublicMessages } from "../lib/i18n/public-messages"
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright"
import { assertAuthoritativeSetupComplete } from "./lib/browser-setup-authority"
import {
  expectedLanguageLinks,
  expectedStarterAppLocaleContract,
  inferLocaleContract,
  languageLinkFailures,
  localeContractMismatch,
  sameOriginPath,
  type StarterAppLanguageLinks,
} from "./lib/starter-app-contract"

type ViewportName = "desktop" | "mobile"

// A fresh install publishes nothing: setup creates a private draft home, so
// "/" shows the not-found page until the owner publishes. Once something is
// published at "/", the published-home contract applies instead.
type HomeContract = "unpublished" | "published"

type PageSnapshot = {
  path: string
  finalPath: string
  htmlLang: string
  title: string
  robots: string
  notFound: boolean
  canonicalPath: string | null
  alternates: Record<string, string>
}

type LocaleContract = {
  defaultLocale: string
  locales: string[]
}

type LanguageExpectation = {
  contract: LocaleContract
  links: StarterAppLanguageLinks
}

type CheckedPage = {
  label: string
  requestedPath: string
  finalPath: string
  viewport: ViewportName
  homeContract: HomeContract
  status: number | null
  expectedLocale: string | null
  htmlLang: string
  title: string
  canonicalPath: string | null
}

type CheckedRedirect = {
  source: string
  expectedTarget: string
  status: number
  locationPath: string | null
}

type HomeContractReport = {
  contract: HomeContract
  source: "explicit" | "inferred"
}

const startedAt = new Date()
const baseUrl = normalizeBaseUrl(
  process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"
)
const allowRemote = process.env.STARTER_APP_QA_ALLOW_REMOTE === "1"
const navigationTimeoutMs = Number(
  process.env.STARTER_APP_QA_NAV_TIMEOUT_MS ?? 60_000
)
const reportPath = process.env.STARTER_APP_QA_REPORT
const expectedLocaleContract = expectedStarterAppLocaleContract(
  process.env.STARTER_APP_QA_DEFAULT_LOCALE,
  process.env.STARTER_APP_QA_LOCALES
)
const requestedHomeContract = parseHomeContract(process.env.STARTER_APP_QA_HOME)
const failures: string[] = []
const checkedPages: CheckedPage[] = []
const checkedRedirects: CheckedRedirect[] = []

const viewports: Record<ViewportName, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
}

function parseHomeContract(value: string | undefined): HomeContract | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  if (trimmed === "unpublished" || trimmed === "published") return trimmed
  throw new Error("STARTER_APP_QA_HOME must be one of: unpublished, published.")
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "")
}

function normalizePath(value: string) {
  const path = value.startsWith("/") ? value : `/${value}`
  return path === "/" ? "/" : path.replace(/\/+$/, "")
}

function pathFromUrl(value: string, label: string, field: string) {
  if (!value.trim()) {
    failures.push(`${label}: missing ${field}.`)
    return null
  }
  try {
    return sameOriginPath(value, baseUrl)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${label}: ${field} is not a valid public URL: ${message}`)
    return null
  }
}

function assertLocalBaseUrl() {
  const url = new URL(baseUrl)
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
  if (!allowRemote && !localHosts.has(url.hostname)) {
    throw new Error(
      `check:app-creation is localhost-first. PUBLIC_BASE_URL is ${baseUrl}; set STARTER_APP_QA_ALLOW_REMOTE=1 to opt into a non-local host.`
    )
  }
}

function writeReport(
  status: "passed" | "failed",
  details: {
    error?: string
    contract?: LocaleContract
    home?: HomeContractReport
  } = {}
) {
  if (!reportPath) return
  const finishedAt = new Date()
  const report = {
    name: "starter-app-creation",
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    baseUrl,
    localOnly: !allowRemote,
    homeContract: details.home ?? null,
    contract: details.contract ?? null,
    error: details.error ?? null,
    failures,
    checkedPages,
    checkedRedirects,
  }
  try {
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `Could not write app-creation report to ${reportPath}: ${message}`
    )
  }
}

function createRouteLabel(viewport: ViewportName, path: string) {
  return `${viewport} ${path}`
}

async function assertServerReachable() {
  let response: Response
  try {
    response = await fetch(baseUrl, { redirect: "manual" })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Public server is not reachable at ${baseUrl}. Run \`pnpm build:local\` and \`pnpm start\`, then rerun \`pnpm check:app-creation\`. ${message}`
    )
  }

  const location = response.headers.get("location")
  if (location) {
    assertAuthoritativeSetupComplete(
      new URL(location, baseUrl).toString(),
      "check:app-creation"
    )
  }
}

async function createPublicContext(browser: Browser, viewport: ViewportName) {
  return browser.newContext({
    baseURL: baseUrl,
    viewport: viewports[viewport],
  })
}

function attachPageHealthListeners(
  page: Page,
  label: string,
  homeContract: HomeContract
) {
  page.on("console", (message) => {
    if (message.type() !== "error") return
    // A not-found document may be served with HTTP 404; the browser logs that
    // status for the document itself, which is the expected outcome here.
    if (
      homeContract === "unpublished" &&
      /status of 404/.test(message.text())
    ) {
      return
    }
    failures.push(`${label}: browser console error: ${message.text()}`)
  })
  page.on("pageerror", (error) => {
    failures.push(`${label}: page error: ${error.message}`)
  })
  page.on("requestfailed", (request) => {
    if (!request.url().includes("/_next/")) return
    failures.push(
      `${label}: client chunk request failed: ${request.url()} (${request.failure()?.errorText ?? "unknown error"})`
    )
  })
  page.on("response", (response) => {
    if (!response.url().includes("/_next/")) return
    if (response.status() >= 400) {
      failures.push(
        `${label}: client chunk returned HTTP ${response.status()}: ${response.url()}`
      )
    }
  })
}

async function readSnapshot(page: Page, requestedPath: string, label: string) {
  const raw = await page.evaluate(() => ({
    htmlLang: document.documentElement.lang,
    title: document.title,
    robots: Array.from(document.querySelectorAll('meta[name="robots"]'))
      .map((meta) => meta.getAttribute("content") ?? "")
      .join(","),
    notFound: document.getElementById("not-found-heading") !== null,
    canonical:
      document.querySelector('link[rel="canonical"]')?.getAttribute("href") ??
      "",
    alternates: Array.from(
      document.querySelectorAll('link[rel="alternate"][hreflang]')
    ).map((link) => ({
      hreflang: link.getAttribute("hreflang") ?? "",
      href: link.getAttribute("href") ?? "",
    })),
  }))

  const alternates: Record<string, string> = {}
  for (const alternate of raw.alternates) {
    if (!alternate.hreflang.trim()) {
      failures.push(`${label}: alternate link is missing hreflang.`)
      continue
    }
    const path = pathFromUrl(
      alternate.href,
      label,
      `alternate ${alternate.hreflang} URL`
    )
    if (path) alternates[alternate.hreflang] = path
  }

  return {
    path: requestedPath,
    finalPath: normalizePath(new URL(page.url()).pathname),
    htmlLang: raw.htmlLang.trim(),
    title: raw.title.trim(),
    robots: raw.robots,
    notFound: raw.notFound,
    canonicalPath: raw.canonical.trim()
      ? pathFromUrl(raw.canonical, label, "canonical URL")
      : null,
    alternates,
  } satisfies PageSnapshot
}

function validateLanguage(
  snapshot: PageSnapshot,
  label: string,
  expectedLocale: string | null
) {
  if (!snapshot.htmlLang) {
    failures.push(`${label}: <html> is missing lang.`)
  } else if (expectedLocale && snapshot.htmlLang !== expectedLocale) {
    failures.push(
      `${label}: expected <html lang="${expectedLocale}">, saw "${snapshot.htmlLang}".`
    )
  }
}

// The public not-found page has no document title today; the report records
// the title so that gap stays visible without failing the fresh-install check.
function validateUnpublishedPage(
  snapshot: PageSnapshot,
  label: string,
  expectedLocale: string | null
) {
  validateLanguage(snapshot, label, expectedLocale)
  if (!snapshot.notFound) {
    failures.push(
      `${label}: expected the not-found page because nothing is published yet; a draft or other content is public.`
    )
  }
  if (!/\bnoindex\b/.test(snapshot.robots)) {
    failures.push(
      `${label}: the not-found page must ask search engines not to index it (robots "${snapshot.robots || "(missing)"}").`
    )
  }
  if (snapshot.canonicalPath !== null) {
    failures.push(
      `${label}: the not-found page exposes canonical ${snapshot.canonicalPath}.`
    )
  }
  const alternateLocales = Object.keys(snapshot.alternates)
  if (alternateLocales.length > 0) {
    failures.push(
      `${label}: the not-found page exposes hreflang alternates ${alternateLocales.join(", ")}.`
    )
  }
}

function validatePublishedMetadata(
  snapshot: PageSnapshot,
  label: string,
  expectedLocale: string | null,
  expectation: LanguageExpectation | null
) {
  validateLanguage(snapshot, label, expectedLocale)
  if (!snapshot.title) {
    failures.push(`${label}: document.title is empty.`)
  }
  if (snapshot.notFound) {
    failures.push(`${label}: shows the not-found page.`)
  }
  if (snapshot.canonicalPath !== snapshot.finalPath) {
    failures.push(
      `${label}: canonical path ${snapshot.canonicalPath ?? "(missing)"} does not match ${snapshot.finalPath}.`
    )
  }

  if (!expectation) return
  failures.push(
    ...languageLinkFailures(
      snapshot,
      label,
      expectedLocale,
      expectation.contract,
      expectation.links
    )
  )
}

async function checkViewportHealth(page: Page, label: string) {
  const result = await page.evaluate(() => {
    const root = document.documentElement
    const body = document.body
    const viewportWidth = Math.max(root.clientWidth, window.innerWidth)
    const scrollWidth = Math.max(root.scrollWidth, body?.scrollWidth ?? 0)
    const imageIssues = Array.from(document.images).flatMap((image) => {
      const descriptor =
        image.alt || image.getAttribute("src") || image.outerHTML.slice(0, 80)
      if (!image.complete || image.naturalWidth > 0) return []
      return [`${descriptor}: image failed to load`]
    })

    return {
      overflow: Math.max(0, scrollWidth - viewportWidth),
      imageIssues,
    }
  })

  if (result.overflow > 1) {
    failures.push(
      `${label}: page has ${result.overflow}px horizontal overflow.`
    )
  }
  for (const issue of result.imageIssues) {
    failures.push(`${label}: ${issue}`)
  }
}

async function linkPaths(
  page: Page,
  selector: string,
  label: string,
  surface: string
) {
  const hrefs = await page.$$eval(selector, (links) =>
    links.map((link) => (link as HTMLAnchorElement).href)
  )
  return hrefs.flatMap((href) => {
    const path = pathFromUrl(href, label, `${surface} link`)
    return path ? [path] : []
  })
}

function assertIncludesPaths(
  label: string,
  surface: string,
  actualPaths: string[],
  expectedPaths: string[]
) {
  const actual = new Set(actualPaths.map(normalizePath))
  for (const expected of expectedPaths.map(normalizePath)) {
    if (!actual.has(expected)) {
      failures.push(
        `${label}: ${surface} is missing localized link ${expected}. Saw: ${[...actual].join(", ") || "(none)"}`
      )
    }
  }
}

async function checkLanguageSwitcher(
  page: Page,
  label: string,
  snapshot: PageSnapshot,
  contract: LocaleContract
) {
  if (contract.locales.length < 2) return

  const trigger = page.getByRole("button", {
    name: getPublicMessages(snapshot.htmlLang).languageSwitcher.label,
  })
  if ((await trigger.count()) === 0) {
    failures.push(`${label}: missing language switcher trigger.`)
    return
  }

  const expectedPaths = contract.locales.flatMap((locale) => {
    const path = snapshot.alternates[locale]
    return path ? [path] : []
  })

  await trigger.first().click()
  try {
    await page.waitForSelector('[data-slot="dropdown-menu-content"]', {
      state: "visible",
      timeout: 5_000,
    })
    const actualPaths = await linkPaths(
      page,
      '[data-slot="dropdown-menu-content"] a[href]',
      label,
      "language switcher"
    )
    assertIncludesPaths(label, "language switcher", actualPaths, expectedPaths)
  } catch {
    const actualPaths = await linkPaths(
      page,
      '[data-slot="dropdown-menu-content"] a[href]',
      label,
      "language switcher"
    ).catch(() => [])
    failures.push(
      `${label}: language switcher did not expose translated URLs ${expectedPaths.join(", ")}. Saw: ${actualPaths.join(", ") || "(none)"}`
    )
  }

  await page.keyboard.press("Escape")
}

async function navigate(page: Page, path: string) {
  const response = await page.goto(path, {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs,
  })
  await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => null)
  await page
    .waitForLoadState("networkidle", { timeout: 5_000 })
    .catch(() => null)
  await page.waitForTimeout(500)
  return response
}

async function visitPage<T>(
  browser: Browser,
  path: string,
  viewport: ViewportName,
  options: { homeContract: HomeContract; expectedLocale: string | null },
  inspect: (page: Page, snapshot: PageSnapshot, label: string) => Promise<T>
) {
  const context: BrowserContext = await createPublicContext(browser, viewport)
  const page = await context.newPage()
  const requestedPath = normalizePath(path)
  const label = createRouteLabel(viewport, requestedPath)
  page.setDefaultNavigationTimeout(navigationTimeoutMs)
  page.setDefaultTimeout(navigationTimeoutMs)
  attachPageHealthListeners(page, label, options.homeContract)

  try {
    const response = await navigate(page, requestedPath)
    assertAuthoritativeSetupComplete(page.url(), "check:app-creation")
    const status = response?.status() ?? null

    if (status === null) {
      failures.push(`${label}: navigation produced no response.`)
    } else if (options.homeContract === "unpublished") {
      // The not-found page is currently streamed with HTTP 200; a true 404 is
      // also correct. Anything else is a failure.
      if (status !== 200 && status !== 404) {
        failures.push(
          `${label}: expected HTTP 200 or 404 for the not-found page, saw ${status}.`
        )
      }
    } else if (status >= 400) {
      failures.push(`${label}: HTTP ${status}.`)
    }

    const finalPath =
      pathFromUrl(page.url(), label, "final navigation URL") ??
      normalizePath(new URL(page.url()).pathname)
    if (finalPath !== requestedPath) {
      failures.push(
        `${label}: unexpectedly navigated to ${finalPath}; expected the requested route to be canonical.`
      )
    }

    const snapshot = await readSnapshot(page, requestedPath, label)
    checkedPages.push({
      label,
      requestedPath,
      finalPath: snapshot.finalPath,
      viewport,
      homeContract: options.homeContract,
      status,
      expectedLocale: options.expectedLocale,
      htmlLang: snapshot.htmlLang,
      title: snapshot.title,
      canonicalPath: snapshot.canonicalPath,
    })
    const result = await inspect(page, snapshot, label)
    await checkViewportHealth(page, label)
    return result
  } finally {
    await context.close()
  }
}

async function detectHomeContract(browser: Browser): Promise<HomeContract> {
  const context = await createPublicContext(browser, "desktop")
  const page = await context.newPage()
  page.setDefaultNavigationTimeout(navigationTimeoutMs)
  try {
    await navigate(page, "/")
    const notFound = await page.evaluate(
      () => document.getElementById("not-found-heading") !== null
    )
    return notFound ? "unpublished" : "published"
  } finally {
    await context.close()
  }
}

async function checkDefaultPrefixStrip(source: string, expectedTarget: string) {
  const label = `redirect ${source}`
  const response = await fetch(`${baseUrl}${source}`, {
    redirect: "manual",
  })
  if (response.status !== 307) {
    failures.push(`${label}: expected HTTP 307, saw ${response.status}.`)
    return
  }
  const location = response.headers.get("location")
  const locationPath = location
    ? pathFromUrl(location, label, "Location header")
    : null
  checkedRedirects.push({
    source,
    expectedTarget,
    status: response.status,
    locationPath,
  })
  if (locationPath !== normalizePath(expectedTarget)) {
    failures.push(
      `${label}: expected Location ${expectedTarget}, saw ${locationPath ?? "(missing)"}.`
    )
  }
}

// The default locale is served unprefixed, so its prefixed URL redirects to
// the unprefixed one (next-intl's 307 strip) whether or not anything is published.
async function checkDefaultLocaleRedirect(defaultLocale: string) {
  await checkDefaultPrefixStrip(`/${defaultLocale}`, "/")
}

async function checkUnpublishedSite(browser: Browser) {
  const expectedLocale = expectedLocaleContract?.defaultLocale ?? null
  const options = { homeContract: "unpublished" as const, expectedLocale }
  const inspect = async (
    _page: Page,
    snapshot: PageSnapshot,
    label: string
  ) => {
    validateUnpublishedPage(snapshot, label, expectedLocale)
    return snapshot
  }

  const root = await visitPage(browser, "/", "desktop", options, inspect)
  await visitPage(browser, "/", "mobile", options, inspect)
  // Setup stores its private draft home under the "home" slug; that URL must
  // not expose the draft either.
  await visitPage(browser, "/home", "desktop", options, inspect)

  const defaultLocale = expectedLocale ?? root.htmlLang
  if (defaultLocale) await checkDefaultLocaleRedirect(defaultLocale)
}

async function checkPublishedSite(browser: Browser) {
  const options = { homeContract: "published" as const }
  const expectedLanguages = expectedLocaleContract
    ? {
        contract: expectedLocaleContract,
        links: expectedLanguageLinks(expectedLocaleContract),
      }
    : null
  const root = await visitPage(
    browser,
    "/",
    "desktop",
    {
      ...options,
      expectedLocale: expectedLocaleContract?.defaultLocale ?? null,
    },
    async (_page, snapshot, label) => {
      validatePublishedMetadata(
        snapshot,
        label,
        expectedLocaleContract?.defaultLocale ?? null,
        expectedLanguages
      )
      return snapshot
    }
  )
  const inferred = inferLocaleContract(root)
  failures.push(...inferred.failures)
  if (expectedLocaleContract) {
    const mismatch = localeContractMismatch(
      expectedLocaleContract,
      inferred.contract
    )
    if (mismatch) failures.push(`/: locale contract mismatch: ${mismatch}.`)
  }
  const languages = expectedLanguages ?? {
    contract: inferred.contract,
    links: inferred.links,
  }
  const contract = languages.contract
  await checkDefaultLocaleRedirect(contract.defaultLocale)

  const routeExpectations = new Map<string, string>()
  routeExpectations.set("/", contract.defaultLocale)
  for (const locale of contract.locales) {
    const localizedPath = root.alternates[locale]
    if (localizedPath) routeExpectations.set(localizedPath, locale)
  }

  for (const [path, locale] of routeExpectations) {
    for (const viewport of ["desktop", "mobile"] as const) {
      await visitPage(
        browser,
        path,
        viewport,
        { ...options, expectedLocale: locale },
        async (page, snapshot, label) => {
          validatePublishedMetadata(snapshot, label, locale, languages)
          if (viewport === "desktop") {
            await checkLanguageSwitcher(page, label, snapshot, contract)
          }
        }
      )
    }
  }
  return contract
}

async function main() {
  assertLocalBaseUrl()
  await assertServerReachable()

  const browser = await chromium.launch({ headless: true })
  let contract: LocaleContract | undefined
  let home: HomeContractReport | undefined
  try {
    home = requestedHomeContract
      ? { contract: requestedHomeContract, source: "explicit" }
      : { contract: await detectHomeContract(browser), source: "inferred" }

    if (home.contract === "unpublished") {
      await checkUnpublishedSite(browser)
      contract = expectedLocaleContract ?? undefined
    } else {
      contract = await checkPublishedSite(browser)
    }
  } finally {
    await browser.close()
  }

  if (failures.length > 0) {
    writeReport("failed", { contract, home })
    console.error(
      `App creation QA failed (${home.contract} home, ${home.source}):`
    )
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    process.exit(1)
  }

  writeReport("passed", { contract, home })
  const coverage =
    home.contract === "unpublished"
      ? "a never-published site (not-found home with no public draft), the locale redirect"
      : "the published home page, language switcher, locale redirect, metadata"
  console.log(
    `✓ App creation QA passed at ${baseUrl} for ${coverage}, images, chunks, and overflow (${home.source} ${home.contract} home).`
  )
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  writeReport("failed", { error: message })
  console.error(message)
  process.exit(1)
})
