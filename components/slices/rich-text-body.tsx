import type { RichTextBodySlice } from "@/convex/lib/slices/richTextBody"
import { isOutlineFieldVisible } from "@/lib/slices/page-outline"

import { richTextBodyDef } from "@/convex/lib/slices/richTextBody"
import type { SliceRenderContext } from "@/lib/slices/links"
import { bindSliceFields, RichText } from "@/components/slice-kit"

export function RichTextBody({
  slice,
  ctx,
}: {
  slice: RichTextBodySlice
  ctx?: SliceRenderContext
}) {
  const fields = bindSliceFields(richTextBodyDef, slice)
  if (
    !isOutlineFieldVisible(slice.primary.body, {
      kind: "body",
      profile: "full",
    })
  )
    return null
  const content = (
    <section className="mx-auto max-w-prose-content px-gutter py-section">
      <RichText fields={fields} ctx={ctx} fieldPath="primary.body" />
    </section>
  )
  return ctx?.previewKitSlice ? ctx?.previewKitSlice(content) : content
}
