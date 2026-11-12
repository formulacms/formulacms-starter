/**
 * Content types that reach the private live preview frame. `page` and
 * `landing-page` share the slice-body renderer with the same props. Post and
 * Author stay out: their renderer needs route-resolved bylines that the frame
 * does not supply.
 *
 * This module has no server-only imports, so the client frame, the bridge, the
 * frame route and its server action all share this one predicate.
 */
export const LIVE_PREVIEW_PAGE_TYPES = ["landing-page", "page"] as const
export type LivePreviewPageType = (typeof LIVE_PREVIEW_PAGE_TYPES)[number]

export function supportsLivePreviewFrame(
  pageType: unknown
): pageType is LivePreviewPageType {
  return (
    typeof pageType === "string" &&
    (LIVE_PREVIEW_PAGE_TYPES as readonly string[]).includes(pageType)
  )
}

/** Narrows a stored page row to the types that have a live preview frame. */
export function isLivePreviewPage<T extends { pageType: string }>(
  page: T
): page is Extract<T, { pageType: LivePreviewPageType }> {
  return supportsLivePreviewFrame(page.pageType)
}
