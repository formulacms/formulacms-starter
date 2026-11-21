import {
  contentTypeDefs,
  isActiveContentType,
  type ContentType,
} from "@/convex/lib/contentTypes"
import type { SliceBodyDoc } from "@/convex/lib/pages/sliceBodyContent"

/**
 * Content types that reach the private live preview frame: every active
 * content type with a block body, derived from the content-type registry so
 * no second list can drift (owner, 2026-11-20: every content type has a live
 * preview). The enforcement test in `live-preview-page-type.test.ts` fails when
 * a registered type is refused or lacks a block-body renderer.
 *
 * This module imports descriptors only, never the renderers, so the parent
 * editor bundle stays free of the child document's renderers. The client
 * frame, the bridge, the frame route and its server action share it.
 */
export type LivePreviewPageType = ContentType

export function supportsLivePreviewFrame(
  pageType: unknown
): pageType is LivePreviewPageType {
  return (
    typeof pageType === "string" &&
    // Active implies registered: the active set is checked against the registry.
    isActiveContentType(pageType) &&
    contentTypeDefs[pageType as ContentType].capabilities.sliceBody === true
  )
}

/**
 * Narrows a stored page row to the types that have a live preview frame. The
 * gate requires the block-body capability, so the row is a block-body arm.
 */
export function isLivePreviewPage(page: {
  pageType: string
  content?: Record<string, unknown>
}): page is SliceBodyDoc {
  return supportsLivePreviewFrame(page.pageType)
}
