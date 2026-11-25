import { isContactHref } from "@/convex/lib/linkSchemes"
import type { ShownTarget } from "@/lib/admin/menu/public-visibility"

/** Phone and email links never open a new tab; web links default to one. */
export function opensInNewTab(target: ShownTarget): boolean {
  return (
    target.type === "external" &&
    !isContactHref(target.url.trim()) &&
    (target.openInNewTab ?? true)
  )
}
