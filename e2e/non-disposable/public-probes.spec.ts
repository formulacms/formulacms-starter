import { expect, test, type APIResponse } from "playwright/test"
import { localOrigin, localPath, required, sitemap } from "../support"

async function probe(response: APIResponse) {
  const body = await response.text()
  const headers = response.headers()
  return {
    status: response.status(),
    location: headers.location ?? null,
    lang: body.match(/<html[^>]*\blang=["']([^"']+)["']/i)?.[1] ?? null,
    noindex: /<meta[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(body),
    notFoundMarker: /404|not found|page could not be found/i.test(body),
    canonical: body.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] ?? null,
    hreflangCount: (body.match(/\bhreflang=/gi) ?? []).length,
    cache: headers["x-nextjs-cache"] ?? null,
    cacheControl: headers["cache-control"] ?? null,
    body,
  }
}

/**
 * Public probe fields from revision 6 §5.1 item 3. Preconditions: a built
 * English app with a published Page at FR6_E2E_PROBE_PATH and a rendered
 * primary Menu link with the named label and href; the not-found path has no
 * route claim. Postcondition: read-only. The operator owns the fixtures.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("public page, menu, sitemap, and not-found probes retain their evidence fields", async ({ request }, testInfo) => {
  const pagePath = localPath("FR6_E2E_PROBE_PATH")
  const missingPath = localPath("FR6_E2E_PROBE_NOT_FOUND_PATH")
  const menuLabel = required("FR6_E2E_PROBE_MENU_LABEL")
  const menuHref = localPath("FR6_E2E_PROBE_MENU_HREF")
  const redirectPath = localPath("FR6_E2E_PROBE_REDIRECT_PATH")
  const redirectLocation = localPath("FR6_E2E_PROBE_REDIRECT_LOCATION")
  const published = await probe(await request.get(pagePath, { maxRedirects: 0, failOnStatusCode: false }))
  expect(published.status).toBe(200)
  expect(published.lang).toBe("en")
  expect(published.noindex).toBe(false)
  expect(published.canonical).toBe(new URL(pagePath, localOrigin()).href)
  expect(published.body).toContain(menuLabel)
  expect(published.body).toContain(`href="${menuHref}"`)
  const warmPublished = await probe(await request.get(pagePath, { maxRedirects: 0, failOnStatusCode: false }))
  expect(warmPublished.status).toBe(200)
  expect(warmPublished.body).toContain(menuLabel)

  const missing = await probe(await request.get(missingPath, { maxRedirects: 0, failOnStatusCode: false }))
  expect(missing.status).toBe(404)
  expect(missing.noindex).toBe(true)
  expect(missing.notFoundMarker).toBe(true)
  const redirected = await probe(await request.get(redirectPath, { maxRedirects: 0, failOnStatusCode: false }))
  expect([301, 302, 307, 308]).toContain(redirected.status)
  expect(redirected.location).toBe(new URL(redirectLocation, localOrigin()).href)
  const sitemapXml = await sitemap(request)
  expect(sitemapXml).toContain(new URL(pagePath, localOrigin()).href)
  expect(sitemapXml).not.toContain(new URL(missingPath, localOrigin()).href)

  const { body: publishedBody, ...publishedFields } = published
  const { body: warmPublishedBody, ...warmPublishedFields } = warmPublished
  const { body: missingBody, ...missingFields } = missing
  const { body: redirectedBody, ...redirectedFields } = redirected
  await testInfo.attach("public-probe-fields", {
    body: JSON.stringify({ published: publishedFields, warmPublished: warmPublishedFields, missing: missingFields, redirected: redirectedFields, menuLabel, menuHref, sitemapUrls: [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]) }),
    contentType: "application/json",
  })
  void publishedBody
  void warmPublishedBody
  void missingBody
  void redirectedBody
})
