import type { Id } from "@/convex/_generated/dataModel"

/** Usage row shared by source services and the optional catalog UI. */
export type SliceUsageDetail = {
  pageId: Id<"pages">
  title: string
  slug: string
  locales: string[]
  count: number
  /** A trashed Page still retains its Slice references. */
  deleted?: boolean
}
