import { dynamicListSourceKey, type MenuCardsBySource } from "@/convex/lib/menu"

export const placeholderTarget = {
  type: "placeholder" as const,
  url: "#" as const,
}
export const postSource = { pageType: "post", limit: 2 }
export function postCards({
  pageId = "post",
  title = "Post",
  href = "/post",
  excerpt,
}: {
  pageId?: string
  title?: string
  href?: string
  excerpt?: string
} = {}): MenuCardsBySource {
  return {
    [dynamicListSourceKey(postSource)]: [
      {
        pageId: pageId as never,
        pageType: "post",
        title,
        href,
        ...(excerpt ? { excerpt } : {}),
      },
    ],
  }
}
