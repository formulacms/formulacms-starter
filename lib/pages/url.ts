import type { Doc, Id } from "@/convex/_generated/dataModel";
import { buildLocaleRelativePath } from "@/convex/lib/contentTypes/routing";

/**
 * A site-relative URL path for a CMS page. Branded so a raw string can't be
 * passed where a validated path is expected — every public path is built by the
 * helpers below, giving one source of truth for the URL shape
 * `/<locale?>/<localized-parent-slugs>/<localized-leaf>`.
 */
export type LocalizedPath = string & { readonly __brand: "LocalizedPath" };

const HOME = "/" as LocalizedPath;

/**
 * Assemble the locale-relative body path (no locale prefix) from its parts.
 * `ancestry` is the already-joined parent chain (e.g. "/company" or
 * "/mes-produits"); empty/undefined means a root-level page.
 */
export function buildLocalizedPath(parts: {
  slug: string;
  ancestry?: string;
  isHome?: boolean;
}): LocalizedPath {
  if (parts.isHome) return HOME;
  const ancestry = parts.ancestry || "";
  return (
    ancestry ? `${ancestry}/${parts.slug}` : `/${parts.slug}`
  ) as LocalizedPath;
}

/**
 * The one canonical, locale-relative path a page is served at *in `locale`*
 * (no locale prefix — `toPublicPath` adds that). The canonical leaf is this
 * locale's slug (`localizedSlugs[locale]`, falling back to base `slug`) and the
 * ancestry is the locale's ancestry (`localizedAncestryPaths[locale]`, falling
 * back to base `ancestryPath`). Routing resolves by leaf slug alone, so any
 * non-canonical path 308-redirects here. The designated home page → "/".
 *
 * Delegates the `pageType`-aware body build to
 * `convex/lib/contentTypes/routing.ts` (plan 028 C3) so this Next.js consumer,
 * `localizedUrlsForPage` in `convex/cms/pages.ts`, `urlForPageInLocale` in
 * `convex/cms/redirects.ts`, and `publicPathForPage` in `convex/cms/menus.ts`
 * share one source of truth for pathPrefix + ancestry rules.
 * `url.test.ts` asserts cross-module agreement.
 */
export function canonicalPathForPage(
  page: Pick<
    Doc<"pages">,
    | "_id"
    | "slug"
    | "pageType"
    | "ancestryPath"
    | "localizedSlugs"
    | "localizedAncestryPaths"
  >,
  homePageId: Id<"pages"> | null,
  locale: string,
  defaultLocale: string,
): LocalizedPath {
  if (homePageId && page._id === homePageId) return HOME;
  const slug =
    (locale !== defaultLocale && page.localizedSlugs?.[locale]) || page.slug;
  const ancestry =
    (locale !== defaultLocale && page.localizedAncestryPaths?.[locale]) ||
    page.ancestryPath ||
    "";
  const body = buildLocaleRelativePath({
    pageType: page.pageType,
    slug,
    ancestry,
  });
  // Callers gate on `isRoutableContentType` upstream (public renderer's
  // routability 404 in `app/(public)/[locale]/[[...path]]/page.tsx`, sitemap
  // filter in `listPublishedForSitemap`) — if we somehow reach this line for
  // a non-routable doc, throw loudly rather than silently manufacture a URL
  // that has no matching public route. A quiet fallback to `/<slug>` would
  // let a caller compare against a bogus canonical or set `<link
  // rel="canonical">` to it.
  if (body === null) {
    throw new Error(
      `canonicalPathForPage called for non-routable pageType "${page.pageType}" — caller must gate on isRoutableContentType first`,
    );
  }
  return body as LocalizedPath;
}

/**
 * Apply the locale-prefix rule: default locale unprefixed, others prefixed.
 * The home path "/" carries no body, so a non-default home is "/fr", not "/fr/".
 */
export function toPublicPath(
  path: string,
  locale: string,
  defaultLocale: string,
): LocalizedPath {
  const prefix = locale === defaultLocale ? "" : `/${locale}`;
  const body = path === "/" ? "" : path;
  return (`${prefix}${body}` || "/") as LocalizedPath;
}
