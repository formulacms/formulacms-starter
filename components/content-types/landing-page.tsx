import { DefaultBlockBodyContent } from "@/components/blocks/_shared/default-block-body"
import type { BlockBodyRendererProps } from "./types"

/** Public renderer for the routable `landing-page` content type. */
export function LandingPageRenderer(props: BlockBodyRendererProps) {
  if (props.page.pageType !== "landing-page") return null
  return (
    <div>
      <DefaultBlockBodyContent {...props} />
    </div>
  )
}
