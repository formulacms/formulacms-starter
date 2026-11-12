import { DefaultSliceBodyContent } from "@/components/slices/_shared/default-slice-body"
import type { SliceBodyRendererProps } from "./types"

/** Public renderer for the routable `landing-page` content type. */
export function LandingPageRenderer(props: SliceBodyRendererProps) {
  if (props.page.pageType !== "landing-page") return null
  return (
    <div>
      <DefaultSliceBodyContent {...props} />
    </div>
  )
}
