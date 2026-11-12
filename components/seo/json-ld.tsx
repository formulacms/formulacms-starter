import type { Doc } from "@/convex/_generated/dataModel";
import { seoTypesForContentType } from "@/convex/lib/contentTypes/routing";

type Crumb = { name: string; url: string };

/**
 * Serialize a value for injection into an HTML `<script>` tag. `JSON.stringify`
 * does NOT HTML-escape, so a `</script>` (or a bare `<`) in the data — e.g. an
 * editor-supplied page title or `seo.structuredData` blob — would close the
 * script element early and let the rest run as markup (stored XSS). Escaping
 * `<` blocks the `</script>` and `<!--` breakouts; `>` and `&` are escaped for
 * completeness, and U+2028/U+2029 are escaped because they terminate JS string
 * literals. Output is still valid JSON (these are standard JSON unicode escapes).
 */
function htmlSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Structured data (schema.org JSON-LD) for a public CMS page. Emits a `@graph`
 * with a `WebPage`/`Article` node + a `BreadcrumbList` (localized titles and
 * absolute URLs), plus any author-supplied `seo.structuredData` verbatim.
 * Server component: rendered into the page body, not `<head>`.
 */
export function PageJsonLd({
  siteUrl,
  canonicalPath,
  title,
  description,
  pageType,
  publishedAt,
  updatedAt,
  ogImage,
  breadcrumb,
  customStructuredData,
  authors,
}: {
  siteUrl: string;
  canonicalPath: string;
  title: string;
  description?: string;
  pageType: Doc<"pages">["pageType"];
  publishedAt?: number;
  updatedAt?: number;
  ogImage?: string;
  breadcrumb: Crumb[];
  customStructuredData?: string;
  /**
   * Resolved public byline (plan 029 C10 §Q6) — post's `authorIds` in
   * byline order. Emits `author` as a `Person` array, never a bare
   * object, so a single-author post stays consistent with a multi-author
   * one. Omitted entirely when empty (non-post types, or a post with no
   * publicly resolvable author).
   */
  authors?: { name: string }[];
}) {
  const abs = (p: string) => {
    try {
      return new URL(p, siteUrl).toString();
    } catch {
      return p;
    }
  };
  const pageUrl = abs(canonicalPath);

  const primary: Record<string, unknown> = {
    "@type": seoTypesForContentType(pageType).schemaOrgType,
    "@id": `${pageUrl}#page`,
    url: pageUrl,
    name: title,
    ...(description ? { description } : {}),
    ...(ogImage ? { image: abs(ogImage) } : {}),
    ...(publishedAt
      ? { datePublished: new Date(publishedAt).toISOString() }
      : {}),
    ...(updatedAt ? { dateModified: new Date(updatedAt).toISOString() } : {}),
    ...(authors && authors.length > 0
      ? {
          author: authors.map((a) => ({
            "@type": "Person",
            name: a.name,
          })),
        }
      : {}),
  };

  const graph: Record<string, unknown>[] = [primary];

  // Only emit a breadcrumb trail when there's an actual hierarchy.
  if (breadcrumb.length > 1) {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: breadcrumb.map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: c.name,
        item: abs(c.url),
      })),
    });
  }

  const jsonLd = { "@context": "https://schema.org", "@graph": graph };

  // Author-supplied structured data, if it parses, rendered as its own block.
  let custom: unknown;
  if (customStructuredData) {
    try {
      custom = JSON.parse(customStructuredData);
    } catch {
      custom = undefined;
    }
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: htmlSafeJson(jsonLd) }}
      />
      {custom !== undefined && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: htmlSafeJson(custom) }}
        />
      )}
    </>
  );
}
