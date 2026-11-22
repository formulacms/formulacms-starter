import { DefaultBlockBodyContent } from "@/components/blocks/_shared/default-block-body"
import type { BlockBodyRendererProps } from "./types"

/** Public renderer for the routable `page` content type. */
export function PageRenderer(props: BlockBodyRendererProps) {
  if (props.page.pageType !== "page") return null
  return (
    <div>
      <DefaultBlockBodyContent {...props} />
    </div>
  )
}
