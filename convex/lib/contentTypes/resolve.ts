import type { QueryCtx } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { contentTypeDefs, type ContentType } from "./index"
import type { ReferenceCard } from "./types"

/**
 * Central reference-card resolver (plan 028 C2, ADR-0037 §4).
 *
 * The single dispatch point between "an `Id<'pages'>` and a locale" and the
 * `ReferenceCard` shape that pickers, back-reference lists, breadcrumbs, menus,
 * and JSON-LD generators consume. Every consumer routes through here so
 * per-type card composition lives in one place — the descriptor's
 * `referenceCard(doc, locale)` implementation — and no consumer re-derives the
 * "is this doc referenceable?" logic.
 *
 * Semantics (ADR-0037 §4, plan-028 decision #4):
 *   - Draft / archived targets resolve to a card WITHOUT an `href`. Public
 *     renderers filter by presence-of-href, so drafts never leak through a
 *     published page's relations.
 *   - Non-routable content types (no `routing.pathPrefix`) return a card
 *     without an `href` regardless of status — they exist only as reference
 *     targets, not as URLs.
 *   - An unknown / unregistered `pageType` returns `null` (the descriptor is
 *     the source of truth for "which types exist"). Callers surface a
 *     placeholder rather than crashing.
 *
 * Two entry points:
 *   - {@link resolveReferenceCardForDoc} — sync, callers that already hold the
 *     doc (searchTargets iterating a paginated result, `getReferenceCard` after
 *     its permission-gate db.get, breadcrumbs on a rendered page). This is
 *     the primary API.
 *   - {@link resolveReferenceCardById} — async, callers that only have an
 *     `Id<"pages">` and don't need to inspect the doc themselves. Fetches
 *     then delegates.
 */

export async function resolveReferenceCardById(
  ctx: QueryCtx,
  docId: Id<"pages">,
  locale: string,
): Promise<ReferenceCard | null> {
  const doc = await ctx.db.get(docId)
  return doc ? resolveReferenceCardForDoc(doc, locale) : null
}

export function resolveReferenceCardForDoc(
  doc: Doc<"pages">,
  locale: string,
): ReferenceCard | null {
  if (doc.deletedAt !== undefined) return null
  const descriptor = contentTypeDefs[doc.pageType as ContentType]
  if (!descriptor) return null

  const card = descriptor.referenceCard(doc, locale)

  // Belt-and-braces: enforce the "no href on non-published or non-routable"
  // invariant here rather than trusting every descriptor to remember. The
  // descriptor is welcome to add its own routing suffix; we strip href when
  // status or capability says no.
  const isRoutable = descriptor.routing !== undefined
  const isPublished = doc.status === "published"
  if (!isRoutable || !isPublished) {
    if (card.href !== undefined) {
      const { href, ...rest } = card
      void href
      return rest
    }
  }
  return card
}
