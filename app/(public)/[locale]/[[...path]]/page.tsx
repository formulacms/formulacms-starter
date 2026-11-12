import { PreviewBanner } from "@/components/public/preview-banner"
import { cache } from "react"
import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { notFound, redirect } from "next/navigation"
import { cookies, draftMode } from "next/headers"
import type { Metadata } from "next"
import type { Id } from "@/convex/_generated/dataModel"
import type { Slice } from "@/convex/lib/slices"
import {
  collectImageStorageIds,
  applyFreshImageUrls,
} from "@/lib/slices/media-urls"
import { buildSliceRenderContext } from "@/lib/slices/render-context"
import { toPublicPath } from "@/lib/pages/url"
import {
  isRoutableContentType,
  seoTypesForContentType,
} from "@/convex/lib/contentTypes/routing"
import type { ContentType } from "@/convex/lib/contentTypes"
import { getContentTypeRenderer } from "@/components/content-types"
import { PageJsonLd } from "@/components/seo/json-ld"
import { resolveSiteUrl } from "@/lib/seo/site-url"
import { resolveOpenGraphImage } from "@/lib/seo/open-graph"
import { cachedCmsRead, requiredCmsRead, CMS_TAGS } from "@/lib/cms/cache"
import {
  PublicLanguageVersionUnavailableError,
  readFreshConfig,
  withVersionPinnedConfig,
} from "@/lib/cms/versioned-read"
import { fetchAuthMutation } from "@/lib/auth-server"
import { PREVIEW_SESSION_COOKIE } from "@/lib/preview-session"
import { hasSliceBody } from "@/convex/lib/pages/sliceBodyContent"
import { postContentType } from "@/convex/lib/contentTypes/post"
import { publicFieldsOf } from "@/convex/lib/contentTypes/exposure"
import { selectPublicLocaleContent } from "@/lib/pages/public-locale-content"
import { getPublicPreviewFallback } from "@/lib/i18n/public-messages"

export const dynamicParams = true
export const revalidate = 300

// Only private preview keeps the historical config fallback. Public routing
// needs authoritative locales/version so an outage cannot invent a 404.
const LOCALE_FALLBACK = {
  onboardingCompletedAt: null as number | null,
  defaultLocale: "en",
  enabledLocales: ["en"],
  homePageId: null as Id<"pages"> | null,
  siteUrl: "",
  timezone: "UTC",
  languageVersion: 0,
}

// Per-request memoized loaders: React `cache()` dedupes these across
// generateMetadata + the page component (same request); the read wrappers add
// the cross-request Data Cache that lets these no-store Convex reads prerender
// (see lib/cms/cache.ts).
const loadConfig = cache((preview = false) => {
  const run = () => fetchQuery(api.cms.settings.getSiteConfig, {})
  return preview
    ? cachedCmsRead(run, ["cms-config"], LOCALE_FALLBACK, [CMS_TAGS.settings])
    : requiredCmsRead(run, ["cms-config"], [CMS_TAGS.settings])
})
const loadFreshConfig = cache((staleVersion: number) =>
  readFreshConfig(
    () => fetchQuery(api.cms.settings.getSiteConfig, {}),
    staleVersion
  )
)
// Content-path reads: in Draft Mode (`preview`) bypass the cache so editors see
// the live draft, never a stale published copy. Otherwise cache by path/id.
const loadPageId = cache(
  (
    fullPath: string,
    locale: string,
    languageVersion: number,
    preview: boolean,
    sessionToken?: string
  ) => {
    const run = () =>
      preview
        ? fetchAuthMutation(api.cms.preview.resolvePreviewPath, {
            path: fullPath,
            locale,
            allowFallback: true,
            sessionToken,
          }).then((result) => result?.pageId ?? null)
        : fetchQuery(api.cms.pages.resolveLocalizedPathQuery, {
            path: fullPath,
            locale,
            languageVersion,
          })
    return preview
      ? run().catch(() => null)
      : requiredCmsRead(
          run,
          ["cms-pageid", locale, String(languageVersion), fullPath],
          [CMS_TAGS.pages]
        )
  }
)
const loadPreviewPage = cache(
  (id: Id<"pages">, locale: string, sessionToken: string) =>
    fetchAuthMutation(api.cms.preview.getPreviewPage, {
      pageId: id,
      locale,
      allowFallback: true,
      sessionToken,
    })
      .then((result) => result?.page ?? null)
      .catch(() => null)
)
const loadPublicPage = cache(
  (id: Id<"pages">, locale: string, languageVersion: number) =>
    requiredCmsRead(
      () =>
        fetchQuery(api.cms.pages.getPublicPageById, {
          id,
          locale,
          languageVersion,
        }),
      ["cms-page", id, locale, String(languageVersion)],
      [CMS_TAGS.pages]
    )
)
// Navigation alternates (M05 C5): one entry per enabled locale with a current
// routable version; `indexable` marks the SEO alternates.
const loadLocaleAlternates = cache(
  (pageId: Id<"pages">, languageVersion: number, preview = false) => {
    const run = () =>
      fetchQuery(api.cms.pages.getPublicLocaleAlternates, {
        pageId,
        languageVersion,
      })
    const key = [
      "cms-locale-alternates",
      String(pageId),
      String(languageVersion),
    ]
    return preview
      ? cachedCmsRead(run, key, [], [CMS_TAGS.pages])
      : requiredCmsRead(run, key, [CMS_TAGS.pages])
  }
)
const loadBrandingUrls = cache(() =>
  cachedCmsRead(
    () => fetchQuery(api.cms.settings.getBrandingUrls, {}),
    ["cms-branding-urls"],
    { logo: null, favicon: null, og: null },
    [CMS_TAGS.settings]
  )
)
// Site description in the visitor's language (M05 A5): the fallback for a Page
// without its own description. The read is pinned to the config's language
// version and answers for this one language only. A version change is
// rethrown to the pinned retry; any other failure just means no fallback.
const loadSiteDescription = cache((locale: string, languageVersion: number) =>
  cachedCmsRead(
    () =>
      fetchQuery(api.cms.settings.getPublicChrome, {
        locale,
        languageVersion,
      }).then((chrome) => chrome.siteDescription ?? null),
    ["cms-site-description", locale, String(languageVersion)],
    null as string | null,
    [CMS_TAGS.settings]
  )
)
const loadByline = cache(
  (authorPageId: Id<"pages">, locale: string, languageVersion: number) =>
    cachedCmsRead(
      () =>
        fetchQuery(api.cms.pages.getPublicByline, {
          authorPageId,
          locale,
          languageVersion,
        }),
      ["cms-byline", String(authorPageId), locale, String(languageVersion)],
      null,
      [CMS_TAGS.pages]
    )
)
const loadStorageUrls = cache((storageIds: Id<"_storage">[]) =>
  storageIds.length === 0
    ? Promise.resolve({} as Record<string, string>)
    : cachedCmsRead(
        () =>
          fetchQuery(api.cms.media.getStorageUrls, {
            storageIds,
          }),
        ["cms-storage-urls", ...storageIds.map(String).toSorted()],
        {} as Record<string, string>,
        [CMS_TAGS.media]
      )
)

type CmsPageProps = {
  params: Promise<{ locale: string; path?: string[] }>
}

function normalizeRoutePath(
  path: string[] | undefined,
  locale: string,
  defaultLocale: string
) {
  if (locale === defaultLocale && path?.[0] === locale) {
    return path.slice(1)
  }
  return path
}

async function refreshSliceImageUrls(slices: Slice[]): Promise<Slice[]> {
  const ids = new Set<Id<"_storage">>()
  collectImageStorageIds(slices, ids)
  if (ids.size === 0) return slices

  const urls = await loadStorageUrls([...ids])
  if (Object.keys(urls).length === 0) return slices
  return applyFreshImageUrls(slices, urls) as Slice[]
}

// Keep a complete route inventory for builds/tools. Published rendering remains
// ISR/cacheable; Draft Mode bypasses the published-data cache per request.
export async function generateStaticParams(): Promise<
  { locale: string; path: string[] }[]
> {
  try {
    return await withVersionPinnedConfig({
      loadConfig: () => fetchQuery(api.cms.settings.getSiteConfig, {}),
      loadFreshConfig: () => fetchQuery(api.cms.settings.getSiteConfig, {}),
      run: async (config) => {
        const allLocalizedUrls = await fetchQuery(
          api.cms.pages.getAllLocalizedPageUrls,
          { languageVersion: config.languageVersion }
        )
        const params: { locale: string; path: string[] }[] = []
        for (const { locale, url } of allLocalizedUrls) {
          let segments = url.split("/").filter(Boolean)
          // Non-default URLs carry a leading locale segment; the route param
          // `path` excludes it. (The default locale is unprefixed already.)
          if (locale !== config.defaultLocale && segments[0] === locale) {
            segments = segments.slice(1)
          }
          params.push({ locale, path: segments })
        }
        return params
      },
    })
  } catch (error) {
    if (error instanceof PublicLanguageVersionUnavailableError) throw error
    return []
  }
}

async function generateMetadataForConfig(
  { locale, path }: Awaited<CmsPageProps["params"]>,
  config: Awaited<ReturnType<typeof loadConfig>>
): Promise<Metadata> {
  if (!config.enabledLocales.includes(locale)) return {}

  const routePath = normalizeRoutePath(path, locale, config.defaultLocale)
  const slug = routePath?.[routePath.length - 1] ?? ""
  const fullPath =
    routePath && routePath.length > 0 ? `/${routePath.join("/")}` : "/"

  // Metadata always reflects published content (cached); Draft Mode only
  // affects the rendered body in the page component below.
  const pageId = await loadPageId(
    fullPath,
    locale,
    config.languageVersion,
    false
  )
  if (!pageId) return {}

  const page = await loadPublicPage(
    pageId as Id<"pages">,
    locale,
    config.languageVersion
  )
  if (!page) return {}
  // Plan 028 C3: non-routable content types have no public web presence —
  // don't leak metadata for them even if a caller somehow lands on the URL.
  if (!isRoutableContentType(page.pageType)) return {}
  // Every routable content type is slice-bodied today (only testimonial is
  // pure-form and it's non-routable). The narrow makes the closed-union
  // `metaTitle` / `metaDescription` access below statically visible;
  // treat the impossible case as "no metadata to publish".
  if (!hasSliceBody(page)) return {}

  // `getPublicPageById` supplies a selected snapshot after cutover. Keep
  // metadata locale-strict at this final consumer too: it must never invoke
  // the legacy/default-locale selection helper for a public request.
  const localeContent = page.content[locale]
  if (!localeContent) return {}
  const title = localeContent?.metaTitle ?? localeContent?.title ?? slug
  // The Page's own description wins; without one, the site description in the
  // visitor's language; without that, none (never another language's).
  const description =
    localeContent?.metaDescription ??
    page.seo?.metaDescription ??
    (await loadSiteDescription(locale, config.languageVersion)) ??
    undefined

  // Canonical is the rendered locale's own URL. hreflang lists only SEO
  // alternates (indexable versions), and only when this version is itself
  // indexable; x-default points at the default language's indexable version.
  // Relative paths resolve to absolute against metadataBase (M05 C5, M21).
  const alternates = await loadLocaleAlternates(
    pageId as Id<"pages">,
    config.languageVersion
  )
  const canonicalPath = alternates.find((entry) => entry.locale === locale)?.url
  if (!canonicalPath) return {}
  const languages: Record<string, string> = {}
  if (config.enabledLocales.length > 1 && !(page.seo?.noIndex ?? false)) {
    for (const entry of alternates) {
      if (entry.indexable) languages[entry.locale] = entry.url
    }
    const defaultUrl = languages[config.defaultLocale]
    if (defaultUrl) languages["x-default"] = defaultUrl
  }

  const [brandingUrls] = await Promise.all([loadBrandingUrls()])
  const siteUrl = resolveSiteUrl(config.siteUrl)
  const ogImage = resolveOpenGraphImage({
    pageImage: page.seo?.ogImage,
    siteDefaultImage: brandingUrls.og,
    siteUrl,
    alt: page.seo?.ogTitle ?? title,
  })

  return {
    metadataBase: new URL(siteUrl),
    title,
    description,
    alternates: {
      canonical: canonicalPath,
      languages: Object.keys(languages).length > 0 ? languages : undefined,
    },
    openGraph: {
      type: seoTypesForContentType(page.pageType).ogType,
      title: page.seo?.ogTitle ?? title,
      description: page.seo?.ogDescription ?? description,
      url: canonicalPath,
      locale,
      images: [ogImage],
    },
    twitter: {
      card: page.seo?.twitterCard ?? "summary_large_image",
      title: page.seo?.ogTitle ?? title,
      description: page.seo?.ogDescription ?? description,
      images: [ogImage],
    },
    robots: {
      index: !(page.seo?.noIndex ?? false),
      follow: !(page.seo?.noFollow ?? false),
    },
  }
}

export async function generateMetadata({
  params,
}: CmsPageProps): Promise<Metadata> {
  const routeParams = await params
  return withVersionPinnedConfig({
    loadConfig: () => loadConfig(false),
    loadFreshConfig,
    refreshWhen: (config) =>
      !config.enabledLocales.includes(routeParams.locale),
    run: (config) => generateMetadataForConfig(routeParams, config),
  })
}

async function renderCmsPage(
  { locale, path }: Awaited<CmsPageProps["params"]>,
  config: Awaited<ReturnType<typeof loadConfig>>
) {
  // Middleware normally guarantees a valid locale; guard defensively.
  if (!config.enabledLocales.includes(locale)) {
    notFound()
  }

  // Next 16 can retain the default-locale rewrite target in the catch-all
  // params during an ISR render: /services -> /en/services arrives as
  // { locale: "en", path: ["en", "services"] }. Compare and resolve against
  // the visible locale-relative path so the canonical guard cannot redirect back to
  // the URL that was just requested.
  const routePath = normalizeRoutePath(path, locale, config.defaultLocale)
  const fullPath =
    routePath && routePath.length > 0 ? `/${routePath.join("/")}` : "/"

  // Authenticated editors can preview drafts via /api/preview (Draft Mode).
  // Everyone else only ever sees published pages. Read it first so the page
  // lookups below can bypass the published-content cache in preview.
  const isPreview = (await draftMode()).isEnabled
  const previewSessionToken = isPreview
    ? (await cookies()).get(PREVIEW_SESSION_COOKIE)?.value
    : undefined
  if (isPreview && !previewSessionToken) notFound()

  // CMS-managed redirects fire in `proxy.ts` before this handler runs, with
  // native 301/302 status codes. Nothing to do here.

  // Look up the page (shared with generateMetadata via React cache()).
  const pageId = await loadPageId(
    fullPath,
    locale,
    config.languageVersion,
    isPreview,
    previewSessionToken
  )

  if (!pageId) {
    notFound()
  }

  const page = isPreview
    ? await loadPreviewPage(pageId as Id<"pages">, locale, previewSessionToken!)
    : await loadPublicPage(
        pageId as Id<"pages">,
        locale,
        config.languageVersion
      )

  if (
    !page ||
    (isPreview && "deletedAt" in page && page.deletedAt !== undefined)
  ) {
    notFound()
  }
  // Plan 028 C3: non-routable content types (no `descriptor.routing`) have no
  // public renderer entry. Belt-and-braces — `resolveLocalizedPathQuery`
  // already filters them at lookup — but a Draft Mode direct-navigation flow
  // could reach this line with one, and its slug is still globally unique.
  if (!isRoutableContentType(page.pageType)) {
    notFound()
  }
  // Every routable content type is slice-bodied today (only testimonial
  // is pure-form and it's non-routable). Narrows `page` to the slice-body
  // arm union so `content[locale].slices` / `.metaTitle` /
  // `.metaDescription` reads below are statically visible.
  if (!hasSliceBody(page)) {
    notFound()
  }

  // Public rendering is locale-strict. Authenticated Draft Mode preview keeps
  // the deliberate default-locale fallback so editors can inspect incomplete
  // locale work without exposing that fallback to visitors or metadata.
  // Keep this before the canonical guard: an unavailable locale must not redirect
  // to a URL derived from another locale's Page.
  const publicLocaleContent = page.content?.[locale]
  const localeSelection = isPreview
    ? selectPublicLocaleContent(
        page.content,
        locale,
        config.defaultLocale,
        true
      )
    : publicLocaleContent
      ? {
          content: publicLocaleContent,
          renderLocale: locale,
          isFallback: false,
        }
      : null
  if (!localeSelection) notFound()
  const { content, renderLocale } = localeSelection

  // Canonical-URL guard. `resolveLocalizedPathQuery` matches on the leaf slug
  // alone, so a nested page is also reachable at its bare slug and under any
  // wrong parent (e.g. /leadership and /anything/leadership both serve the
  // /company/leadership page). Temporarily redirect every non-canonical path to the one
  // canonical path — closes the duplicate-content hole and transparently handles
  // re-parented/moved pages. The canonical leaf is the base slug, so the target
  // always resolves via the same lookup (no redirect loop).
  const canonicalPublic = (
    await loadLocaleAlternates(page._id, config.languageVersion, isPreview)
  ).find((entry) => entry.locale === locale)?.url
  if (!canonicalPublic) {
    // A Draft Mode preview may deliberately fall back to the default locale
    // for an untranslated requested locale. That is never a public URL, so it
    // has no public canonical target to redirect to; render the private
    // preview in place instead. Public requests remain strict above.
    if (!isPreview) notFound()
  } else {
    const requestedPublic = toPublicPath(fullPath, locale, config.defaultLocale)
    if (canonicalPublic !== requestedPublic) {
      redirect(canonicalPublic)
    }
  }

  const slices = await refreshSliceImageUrls(content.slices ?? [])

  // Public bylines: only for posts with assigned authors. `getPublicByline`
  // returns `null` for draft/archived/soft-deleted author pages, so drafts
  // never leak through a published post (plan 028 §C1/C2 decision #4).
  //
  // Plan 029 C10 §Q6 task 14: `authorIds` is an ordered list — index 0 is
  // the lead author by convention. Resolve every id in parallel (each hits
  // the per-request `loadByline` cache) and drop unresolvable ones,
  // preserving byline order.
  //
  // ADR-0038 exposure gate applied HERE (once) rather than per-consumer:
  // `bylines` feeds both `PostRenderer` (visible HTML) and `PageJsonLd`
  // (structured data) below, so gating it at the source keeps both
  // surfaces fail-closed together instead of relying on each consumer to
  // re-implement the same check.
  const authorIdsIsPublic =
    "authorIds" in publicFieldsOf(postContentType.sharedFields)
  const authorPageIds =
    page.pageType === "post" && authorIdsIsPublic
      ? (page.authorIds ?? [])
          .map((a) => a.pageId)
          .filter((id): id is Id<"pages"> => id !== undefined)
      : []
  const resolvedBylines = await Promise.all(
    authorPageIds.map((id) => loadByline(id, locale, config.languageVersion))
  )
  const bylines = resolvedBylines.filter((b) => b !== null)

  const ctx = await buildSliceRenderContext({
    slices,
    renderLocale,
    presentationLocale: locale,
    defaultLocale: config.defaultLocale,
    isPreview,
    languageVersion: config.languageVersion,
  })

  // Structured data for indexable pages (skipped in preview / when noindex).
  const showJsonLd = !isPreview && !(page.seo?.noIndex ?? false)
  // Same description rule as the meta tag: the Page's own, else the site
  // description in the visitor's language, else none.
  const jsonLdDescription = showJsonLd
    ? (content.metaDescription ??
      page.seo?.metaDescription ??
      (await loadSiteDescription(locale, config.languageVersion)) ??
      undefined)
    : undefined
  const breadcrumb = showJsonLd
    ? await cachedCmsRead(
        () =>
          fetchQuery(api.cms.pages.getLocalizedBreadcrumb, {
            pageId: page._id,
            locale: renderLocale,
            languageVersion: config.languageVersion,
          }),
        [
          "cms-breadcrumb",
          renderLocale,
          String(config.languageVersion),
          String(page._id),
        ],
        [] as { name: string; url: string }[],
        [CMS_TAGS.pages]
      )
    : []
  const brandingUrls = showJsonLd ? await loadBrandingUrls() : null
  const jsonLdImage = showJsonLd
    ? resolveOpenGraphImage({
        pageImage: page.seo?.ogImage,
        siteDefaultImage: brandingUrls?.og,
        siteUrl: config.siteUrl,
        alt: content.metaTitle ?? content.title,
      }).url
    : undefined
  // Plan 029 C10 task 12: descriptor-driven renderer registry. The catch-all
  // route only reaches this line for `hasSliceBody` types, so the entry is
  // always `kind: "sliceBody"` — asserted below for TS narrowing.
  const renderer = getContentTypeRenderer(page.pageType as ContentType)
  if (renderer.kind !== "sliceBody") notFound()
  const RenderContentType = renderer.Component

  return (
    <>
      {showJsonLd && canonicalPublic !== undefined && (
        <PageJsonLd
          siteUrl={resolveSiteUrl(config.siteUrl)}
          canonicalPath={canonicalPublic}
          title={content.metaTitle ?? content.title}
          description={jsonLdDescription}
          pageType={page.pageType}
          publishedAt={page.publishedAt}
          updatedAt={page.updatedAt}
          ogImage={jsonLdImage}
          breadcrumb={breadcrumb}
          customStructuredData={page.seo?.structuredData}
          authors={bylines}
        />
      )}
      {isPreview && (
        <PreviewBanner
          locale={locale}
          status={"status" in page ? page.status : "published"}
          exitHref={buildExitHref(fullPath, locale, config.defaultLocale)}
        />
      )}
      {isPreview && localeSelection.isFallback && (
        <p className="px-6 py-2 text-sm text-muted-foreground">
          {getPublicPreviewFallback(locale, config.defaultLocale)}
        </p>
      )}
      <RenderContentType
        page={page}
        content={content}
        slices={slices}
        ctx={ctx}
        locale={locale}
        renderLocale={renderLocale}
        defaultLocale={config.defaultLocale}
        bylines={bylines}
      />
    </>
  )
}

export default async function CmsPage({ params }: CmsPageProps) {
  const routeParams = await params
  const isPreview = (await draftMode()).isEnabled
  return withVersionPinnedConfig({
    loadConfig: () => loadConfig(isPreview),
    loadFreshConfig,
    refreshWhen: (config) =>
      !config.enabledLocales.includes(routeParams.locale),
    run: (config) => renderCmsPage(routeParams, config),
  })
}

function buildExitHref(
  fullPath: string,
  locale: string,
  defaultLocale: string
) {
  const target = toPublicPath(fullPath, locale, defaultLocale)
  return `/api/preview/exit?path=${encodeURIComponent(target)}`
}
