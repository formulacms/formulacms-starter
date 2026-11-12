import { DefaultSliceBodyContent } from "@/components/slices/_shared/default-slice-body"
import type { SliceBodyRendererProps } from "./types"

/** Public renderer for the routable `page` content type. */
export function PageRenderer(props: SliceBodyRendererProps) {
  if (props.page.pageType !== "page") return null
  return (
    <div>
      <DefaultSliceBodyContent {...props} />
    </div>
  )
}
