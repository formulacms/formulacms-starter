import {
  resolvePageOutline,
  pageHeadingModeFor,
} from "@/lib/slices/page-outline"
import { getPublicMessages } from "@/lib/i18n/public-messages"
import { SliceZone } from "@/components/slices/slice-zone"
import type { SliceBodyRendererProps } from "@/components/content-types/types"

/** Shared slice-body renderer used by the starter's page adapters. */
export function DefaultSliceBodyRenderer({
  content,
  slices,
  ctx,
}: SliceBodyRendererProps) {
  return (
    <div>
      <DefaultSliceBodyContent content={content} slices={slices} ctx={ctx} />
    </div>
  )
}

export function DefaultSliceBodyContent({
  content,
  slices,
  ctx,
}: Pick<SliceBodyRendererProps, "content" | "slices" | "ctx">) {
  const outline = resolvePageOutline({
    slices,
    locale: ctx.locale,
    mode: pageHeadingModeFor("page"),
  })
  return slices.length === 0 ? (
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
      <SliceZone slices={slices} ctx={ctx} outline={outline} />
    </>
  )
}
