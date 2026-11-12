// Cache-tag contract shared between the Next.js cache layer (lib/cms/cache.ts,
// app/api/revalidate) and the Convex revalidation actions (convex/cms/
// revalidate.ts). Type-level tags — one per cached content type — so an edit
// invalidates only the reads it can actually affect:
//   - pages    → page content/structure, localized URLs, breadcrumbs, link
//                resolution, redirects (any cross-page read shares this tag, so
//                publishing page B correctly refreshes page A's cached link to it)
//   - menus    → resolved navigation (link targets resolve to page paths)
//   - settings → site config (default locale, enabled locales, homepage)
//   - media    → storage URL resolution for public image fields
//
// MUST stay free of `next/*` and Node-only imports so the Convex bundler can
// import it via a relative path (`@/` aliases don't resolve under Convex).
export const CMS_TAGS = {
  pages: "cms:pages",
  menus: "cms:menus",
  settings: "cms:settings",
  media: "cms:media",
} as const;

export type CmsTag = (typeof CMS_TAGS)[keyof typeof CMS_TAGS];

export const ALL_CMS_TAGS: readonly CmsTag[] = Object.values(CMS_TAGS);
