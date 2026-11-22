"use client"

import {
  LivePreviewFrame,
  type PageLivePreviewProps,
} from "./live-preview-frame"

/** Parent host deliberately excludes the child document's block renderers. */
export function PageLivePreview(props: PageLivePreviewProps) {
  return <LivePreviewFrame {...props} />
}
