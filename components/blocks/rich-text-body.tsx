import type { RichTextBodyBlock } from "@/convex/lib/blocks/richTextBody"
import { isOutlineFieldVisible } from "@/lib/blocks/page-outline"

import { richTextBodyDef } from "@/convex/lib/blocks/richTextBody"
import type { BlockRenderContext } from "@/lib/blocks/links"
import { bindBlockFields, RichText } from "@/components/block-kit"

export function RichTextBody({
  block,
  ctx,
}: {
  block: RichTextBodyBlock
  ctx?: BlockRenderContext
}) {
  const fields = bindBlockFields(richTextBodyDef, block)
  if (
    !isOutlineFieldVisible(block.primary.body, {
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
  return ctx?.previewKitBlock ? ctx?.previewKitBlock(content) : content
}
