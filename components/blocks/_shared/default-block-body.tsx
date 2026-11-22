import {
  resolvePageOutline,
  pageHeadingModeFor,
} from "@/lib/blocks/page-outline"
import { getPublicMessages } from "@/lib/i18n/public-messages"
import { BlockList } from "@/components/blocks/block-list"
import type { BlockBodyRendererProps } from "@/components/content-types/types"

/** Shared block-body renderer used by the starter's page adapters. */
export function DefaultBlockBodyRenderer({
  content,
  blocks,
  ctx,
}: BlockBodyRendererProps) {
  return (
    <div>
      <DefaultBlockBodyContent content={content} blocks={blocks} ctx={ctx} />
    </div>
  )
}

export function DefaultBlockBodyContent({
  content,
  blocks,
  ctx,
}: Pick<BlockBodyRendererProps, "content" | "blocks" | "ctx">) {
  const outline = resolvePageOutline({
    blocks,
    locale: ctx.locale,
    mode: pageHeadingModeFor("page"),
  })
  return blocks.length === 0 ? (
    <div className="px-6 py-10">
      <h1 className="text-3xl font-semibold">{content.title}</h1>
      <p className="mt-2 text-muted-foreground">
        {
          getPublicMessages(ctx.presentationLocale ?? ctx.locale).chrome
            .noContent
        }
      </p>
    </div>
  ) : (
    <>
      {outline.hostRendersFallbackH1 && (
        <h1 className="sr-only">{content.title}</h1>
      )}
      <BlockList blocks={blocks} ctx={ctx} outline={outline} />
    </>
  )
}
