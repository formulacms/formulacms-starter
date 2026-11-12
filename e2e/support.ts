import { expect, type APIRequestContext, type Browser, type Page } from "playwright/test"
import { ConvexHttpClient } from "convex/browser"
import { ConvexError } from "convex/values"
import { createTranslator } from "next-intl"
// Playwright loads specs as ES modules here ("type": "module"), and Node
// refuses a JSON import without this attribute.
import en from "../messages/admin/en.json" with { type: "json" }
import fr from "../messages/admin/fr.json" with { type: "json" }
import { selectE2ERun, stageStartState, type DisposableCaseName } from "./selection"

export { en, fr }
// The admin passes these same display names (capitalised endonyms) into its
// locale-name placeholders.
export { getLocaleDisplayName } from "../lib/i18n/config"

export type AdminLocale = "en" | "fr"

/** The admin bundle the page resolved, read from `<html lang>`. */
export async function adminLocale(page: Page): Promise<AdminLocale> {
  return (await page.locator("html").getAttribute("lang")) === "fr" ? "fr" : "en"
}

export function adminMessages(locale: AdminLocale): typeof en {
  return locale === "fr" ? fr : en
}

/** Formats admin copy exactly as next-intl renders it (ICU placeholders and plurals). */
export function adminTranslator(locale: AdminLocale) {
  return createTranslator({ locale, messages: adminMessages(locale) })
}

export async function pageTranslator(page: Page) {
  return adminTranslator(await adminLocale(page))
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for this E2E scenario`)
  return value
}

export function requiredNumber(name: string): number {
  const value = Number(required(name))
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value
}

export function localOrigin(): string {
  return new URL(process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3000").origin
}

export function localPath(name: string): string {
  const path = required(name)
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`${name} must be an app-local absolute path`)
  }
  return path
}

export async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in")
  const messages = adminMessages(await adminLocale(page))
  await expect(page.getByRole("heading", { name: messages.auth.signIn.form.title })).toBeVisible()
  await page.getByLabel(messages.auth.signIn.form.emailLabel).fill(email)
  await page.getByLabel(messages.auth.signIn.form.passwordLabel).fill(password)
  await page.getByRole("button", { name: messages.auth.signIn.form.submit }).click()
  await expect(page).toHaveURL(/\/admin(?:\/|$)/)
}

export async function ownerPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: localOrigin() })
  const page = await context.newPage()
  await signIn(page, required("FR6_E2E_OWNER_EMAIL"), required("FR6_E2E_OWNER_PASSWORD"))
  return page
}

export async function assertNotFoundWithNoindex(request: APIRequestContext, path: string) {
  const response = await request.get(path, { failOnStatusCode: false })
  expect([200, 404]).toContain(response.status())
  const body = await response.text()
  expect(body).toMatch(/<meta[^>]+name=["']robots["'][^>]+noindex|<meta[^>]+content=["'][^"']*noindex/)
  return response
}

export async function assertPublicPath(request: APIRequestContext, path: string, marker: string) {
  const response = await request.get(path, { failOnStatusCode: false })
  expect(response.ok()).toBe(true)
  expect(await response.text()).toContain(marker)
  return response
}

export async function sitemap(request: APIRequestContext): Promise<string> {
  const response = await request.get("/sitemap.xml")
  expect(response.ok()).toBe(true)
  return response.text()
}

/**
 * Allowlisted P7 evidence for one public path. The recorder keeps response
 * metadata and derived booleans only; callers retain the HTML in memory for
 * assertions but never attach it as evidence.
 */
export async function publicLifecycleProbe(request: APIRequestContext, path: string) {
  const html = await request.get(path, {
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  const rsc = await request.get(path, {
    headers: { RSC: "1" },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  const body = await html.text()
  const headers = html.headers()
  const sitemapXml = await sitemap(request)
  return {
    status: html.status(),
    rscStatus: rsc.status(),
    location: headers.location ?? null,
    cache: headers["x-nextjs-cache"] ?? null,
    cacheControl: headers["cache-control"] ?? null,
    lang: body.match(/<html[^>]*\blang=["']([^"']+)["']/i)?.[1] ?? null,
    noindex: /<meta[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(body),
    inSitemap: sitemapXml.includes(new URL(path, localOrigin()).href),
    body,
  }
}

export function publicLifecycleEvidence(
  probe: Awaited<ReturnType<typeof publicLifecycleProbe>>
) {
  const { body, ...evidence } = probe
  void body
  return evidence
}

export function requireDisposable(expectedStart: string) {
  if (process.env.FORMULACMS_DISPOSABLE_TARGET !== "1") {
    throw new Error("Disposable E2E specs require FORMULACMS_DISPOSABLE_TARGET=1")
  }
  if (process.env.FR6_E2E_START_STATE !== expectedStart) {
    throw new Error(`Disposable E2E spec requires recognized start state: ${expectedStart}`)
  }
}

/**
 * Staged disposable specs run one stage per invocation. The environment must
 * select this exact case and stage, with the stage's start-state token.
 */
export function requireDisposableStage(caseName: DisposableCaseName, stage: string) {
  const selection = selectE2ERun(process.env)
  if (
    selection.family !== "disposable" ||
    selection.caseName !== caseName ||
    selection.stage !== stage
  ) {
    throw new Error(
      `This spec is stage ${stage} of the ${caseName} case; set FR6_E2E_DISPOSABLE_CASE=${caseName} and FR6_E2E_STAGE=${stage}`
    )
  }
  const expected = stageStartState(caseName, stage)
  if (selection.startState !== expected) {
    throw new Error(`Stage ${stage} requires FR6_E2E_START_STATE=${expected}`)
  }
}

export async function assertOwnerServer(page: Page) {
  await page.goto("/admin")
  await expect(page).toHaveURL(/\/admin(?:\/|$)/)
  await expect(page.locator("html")).toHaveAttribute("lang", /^(en|fr)$/)
}

function localConvexClient() {
  const url = new URL(required("NEXT_PUBLIC_CONVEX_URL"))
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL must identify the local test backend")
  }
  return new ConvexHttpClient(url.origin)
}

export async function clientFor(page: Page): Promise<ConvexHttpClient> {
  const response = await page.context().request.get(`${localOrigin()}/api/auth/convex/token`)
  expect(response.ok()).toBe(true)
  const data: unknown = await response.json()
  if (!data || typeof data !== "object" || !("token" in data) || typeof data.token !== "string") {
    throw new Error("The authenticated session did not receive a Convex token")
  }
  const client = localConvexClient()
  client.setAuth(data.token)
  return client
}

export function anonymousClient(): ConvexHttpClient {
  return localConvexClient()
}

export async function expectConvexDenial(action: Promise<unknown>, code: string) {
  let caught: unknown
  try {
    await action
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ConvexError)
  expect((caught as ConvexError<string>).data).toBe(code)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    )
  }
  return value
}

/** Stable comparison for owner-control snapshots that contain only Convex values. */
export function controlSnapshot(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/**
 * Assert both the exact Convex refusal and that the caller-selected control
 * rows did not move. The action is a thunk so the before snapshot is complete
 * before the attempted write starts.
 */
export async function expectConvexDenialWithoutChange(
  readControl: () => Promise<unknown>,
  action: () => Promise<unknown>,
  code: string
) {
  const before = controlSnapshot(await readControl())
  await expectConvexDenial(action(), code)
  expect(controlSnapshot(await readControl())).toBe(before)
}
