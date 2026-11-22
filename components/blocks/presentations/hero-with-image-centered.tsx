import { isOutlineFieldVisible } from "@/lib/blocks/page-outline"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import type { HeroWithImageBlock } from "@/convex/lib/blocks/heroWithImage"
import { heroWithImageDef } from "@/convex/lib/blocks/heroWithImage"
import type { BlockRenderContext } from "@/lib/blocks/links"
import {
  bindBlockFields,
  Buttons,
  KitImage,
  RichText,
  Text,
} from "@/components/block-kit"
import { blockLinkAttrs } from "../render-helpers"

/** Centered composition of the unchanged Hero with Image content contract. */
export function HeroWithImageCentered({
  block,
  ctx,
}: {
  block: HeroWithImageBlock
  ctx: BlockRenderContext
}) {
  const { primary } = block
  const fields = bindBlockFields(heroWithImageDef, block)
  const hasTitle = isOutlineFieldVisible(primary.title)
  const headingId = `${block.id}-heading`
  const eyebrowLink = blockLinkAttrs(primary.eyebrowLink, ctx)
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
      {eyebrowLink && <ArrowRight aria-hidden className="size-4 shrink-0" />}
    </>
  ) : null

  const content = (
    <section
      aria-label={hasTitle ? ctx.regionLabel : undefined}
      aria-labelledby={hasTitle && !ctx.regionLabel ? headingId : undefined}
      className="bg-surface px-gutter py-section"
    >
      <div className="mx-auto flex max-w-content flex-col items-center text-center">
        {announcement &&
          (eyebrowLink ? (
            <Link
              href={eyebrowLink.href}
              download={eyebrowLink.download}
              target={eyebrowLink.target}
              rel={eyebrowLink.rel}
              className="inline-flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-brand/25 bg-brand/5 py-1 pr-2 pl-1 text-caption font-medium text-brand transition-colors hover:bg-brand/10 focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {announcement}
            </Link>
          ) : (
            <div className="inline-flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-brand/25 bg-brand/5 py-1 pr-2 pl-1 text-caption font-medium text-brand">
              {announcement}
            </div>
          ))}

        {hasTitle && (
          <RichText
            fields={fields}
            fieldPath="primary.title"
            id={headingId}
            className="mt-6 max-w-3xl font-public-heading text-display font-semibold tracking-tight text-balance text-on-surface"
            ctx={ctx}
          />
        )}

        {!fields.isEmpty("primary.description") && (
          <RichText
            fields={fields}
            fieldPath="primary.description"
            className="mt-stack max-w-prose-content text-lead text-on-surface-muted [&>.prose]:[font-size:inherit] [&>.prose]:[line-height:inherit] [&>.prose]:[color:inherit]"
            ctx={ctx}
          />
        )}

        <Buttons
          fields={fields}
          fieldPath="items"
          ctx={ctx}
          className="mt-8 justify-center"
        />

        {!fields.isEmpty("primary.image") && (
          <div className="mt-12 w-full overflow-hidden rounded-2xl border border-border">
            <KitImage
              fields={fields}
              fieldPath="primary.image"
              altFallback=""
              className="aspect-video w-full object-cover"
              priority
              sizes="(min-width: 1280px) 1152px, 100vw"
              ctx={ctx}
            />
          </div>
        )}
      </div>
    </section>
  )
  return ctx.previewKitBlock ? ctx.previewKitBlock(content) : content
}
