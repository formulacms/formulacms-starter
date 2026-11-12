import { isOutlineFieldVisible } from "@/lib/slices/page-outline"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import type { HeroWithImageSlice } from "@/convex/lib/slices/heroWithImage"
import { heroWithImageDef } from "@/convex/lib/slices/heroWithImage"
import type { SliceRenderContext } from "@/lib/slices/links"
import {
  bindSliceFields,
  Buttons,
  KitImage,
  RichText,
  Text,
} from "@/components/slice-kit"
import { sliceLinkAttrs } from "./render-helpers"

export function HeroWithImage({
  slice,
  ctx,
}: {
  slice: HeroWithImageSlice
  ctx: SliceRenderContext
}) {
  const { primary } = slice
  const fields = bindSliceFields(heroWithImageDef, slice)
  const hasTitle = isOutlineFieldVisible(primary.title)
  const headingId = `${slice.id}-heading`
  const eyebrowLink = sliceLinkAttrs(primary.eyebrowLink, ctx)
  const hasEyebrow = !fields.isEmpty("primary.eyebrow")
  const announcement = hasEyebrow ? (
    <>
      <span className="rounded-full border border-brand/25 bg-surface px-2.5 py-0.5">
        <Text fields={fields} fieldPath="primary.eyebrow" as="span" ctx={ctx} />
      </span>
      {eyebrowLink && !fields.isEmpty("primary.eyebrowLinkLabel") && (
        <span>
          <Text
            fields={fields}
            fieldPath="primary.eyebrowLinkLabel"
            as="span"
            ctx={ctx}
          />
        </span>
      )}
      {eyebrowLink && <ArrowRight aria-hidden className="size-4" />}
    </>
  ) : null

  const content = (
    <section
      aria-label={hasTitle ? ctx.regionLabel : undefined}
      aria-labelledby={hasTitle && !ctx.regionLabel ? headingId : undefined}
      className="bg-background p-2"
    >
      <div className="relative overflow-hidden rounded-2xl border bg-surface lg:flex lg:min-h-180 lg:items-center">
        <div className="w-full px-4 py-16 md:px-8 lg:py-24">
          <div className="flex flex-col items-start md:max-w-3xl lg:w-1/2 lg:pr-8">
            {announcement &&
              (eyebrowLink ? (
                <Link
                  href={eyebrowLink.href}
                  download={eyebrowLink.download}
                  target={eyebrowLink.target}
                  rel={eyebrowLink.rel}
                  className="inline-flex w-max items-center gap-2 rounded-full border border-brand/25 bg-brand/5 py-1 pr-2 pl-1 text-caption font-medium text-brand transition-colors hover:bg-brand/10 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {announcement}
                </Link>
              ) : (
                <div className="inline-flex w-max items-center gap-2 rounded-full border border-brand/25 bg-brand/5 py-1 pr-2 pl-1 text-caption font-medium text-brand">
                  {announcement}
                </div>
              ))}

            {hasTitle && (
              <RichText
                fields={fields}
                fieldPath="primary.title"
                id={headingId}
                className="mt-6 w-full max-w-sm min-w-0 font-public-heading text-display font-semibold tracking-tight [overflow-wrap:anywhere] text-on-surface"
                ctx={ctx}
              />
            )}

            {!fields.isEmpty("primary.description") && (
              <RichText
                fields={fields}
                fieldPath="primary.description"
                className="mt-6 max-w-xl text-lead text-on-surface-muted [&>.prose]:[font-size:inherit] [&>.prose]:[line-height:inherit] [&>.prose]:[color:inherit]"
                ctx={ctx}
              />
            )}

            <Buttons
              fields={fields}
              fieldPath="items"
              ctx={ctx}
              className="mt-12 [&>a]:h-12 [&>a]:px-5 [&>a]:text-base [&>span]:h-12 [&>span]:px-5 [&>span]:text-base"
            />
          </div>
        </div>

        <div className="relative mt-16 h-70 w-full md:h-96 lg:absolute lg:inset-y-0 lg:end-0 lg:mt-0 lg:h-full lg:w-1/2">
          <KitImage
            fields={fields}
            fieldPath="primary.image"
            altFallback=""
            className="size-full object-cover"
            frame="cover"
            priority
            sizes="(min-width: 1024px) 50vw, 100vw"
            ctx={ctx}
          />
        </div>
      </div>
    </section>
  )
  return ctx.previewKitSlice ? ctx.previewKitSlice(content) : content
}
