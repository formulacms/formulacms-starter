import type { MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import {
  clearMediaReferencesForPage,
  refreshMediaReferencesForPage,
} from "./mediaReferences"
import {
  clearDocumentReferencesForPage,
  refreshDocumentReferencesForPage,
} from "./documentReferences"
import {
  getStagingByPageId,
  overlayStagingOnPage,
} from "./publishing/staging"

/**
 * Unified page-reference maintenance. `pages` documents fan out into two
 * back-reference tables today (`mediaReferences` for image/media links,
 * `documentReferences` for `relation()` fields) and may gain more. Every save
 * / restore / cascade path must keep them in lockstep, so save call sites reach
 * for these wrappers rather than the per-table helpers.
 *
 * Add a new reference kind by wiring it here — the ~10 existing call sites in
 * `convex/cms/pages.ts` inherit it automatically.
 *
 * ADR-0041 Deploy 2 PR B: for non-published pages the working copy lives on
 * `pageStaging` (Deploy 2 PR B item 3 seeds create/duplicate straight to
 * staging with `pages.content` empty). Overlay staging before scanning so
 * media / relation fan-out reflects what an editor is actually working on
 * — otherwise a draft using a media asset never shows up in
 * `media.usage`, and a draft with a `relation()` never blocks deletion of
 * its target page. Published pages keep the raw `pages.content` view so
 * staged unpublished edits do not silently retarget references before
 * they publish.
 */
export async function refreshPageReferences(
  ctx: MutationCtx,
  page: Doc<"pages">,
): Promise<void> {
  const workingCopy =
    page.status === "published"
      ? page
      : overlayStagingOnPage(page, await getStagingByPageId(ctx, page._id))
  await refreshMediaReferencesForPage(ctx, workingCopy)
  await refreshDocumentReferencesForPage(ctx, workingCopy)
}

export async function clearPageReferences(
  ctx: MutationCtx,
  pageId: Id<"pages">,
): Promise<void> {
  await clearMediaReferencesForPage(ctx, pageId)
  await clearDocumentReferencesForPage(ctx, pageId)
}
