/** Public renderer registry for the curated starter content-type catalog. */

import type { ContentType } from "@/convex/lib/contentTypes"
// @content-type-codegen:content-type-renderer-imports:start
import { LandingPageRenderer } from "./landing-page"
import { PageRenderer } from "./page"
import { PostRenderer } from "./post"
import { AuthorRenderer } from "./author"
// @content-type-codegen:content-type-renderer-imports:end
import type { ContentTypeRenderer } from "./types"

// @content-type-codegen:content-type-renderers:start
const contentTypeRenderers: Partial<
  Record<ContentType, ContentTypeRenderer>
> = {
  "landing-page": { kind: "sliceBody", Component: LandingPageRenderer },
  page: { kind: "sliceBody", Component: PageRenderer },
  post: { kind: "sliceBody", Component: PostRenderer },
  author: { kind: "sliceBody", Component: AuthorRenderer },
}
// @content-type-codegen:content-type-renderers:end

export function getContentTypeRenderer(type: ContentType): ContentTypeRenderer {
  const renderer = contentTypeRenderers[type]
  if (!renderer) {
    throw new Error(`No public renderer is shipped for content type: ${type}`)
  }
  return renderer
}

export type {
  ContentTypeRenderer,
  SliceBodyRendererProps,
  PureFormRendererProps,
  PublicByline,
} from "./types"
