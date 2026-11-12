import { fieldHeadingLevel } from "@/lib/slices/page-outline"
import { type RichTextProfile } from "@/convex/lib/richtext/profiles"
import { richTextToDocument } from "@/lib/rich-text/render"
import { type SliceRenderContext } from "@/lib/slices/links"
import { renderStaticRichTextDocument } from "@/lib/rich-text/static-render"
import { cn } from "@/lib/utils"
import { BASIC_PARAGRAPH_GAP } from "@/lib/rich-text/basic-text-paste"

export { isRenderableRichTextImageSource } from "@/lib/rich-text/render"

/** Render profile-constrained rich text as React elements, never raw HTML. */
export function RichTextContent({
  value,
  profile,
  ctx,
  className,
  fieldPath,
}: {
  value: string
  profile: RichTextProfile
  ctx?: SliceRenderContext
  className?: string
  fieldPath?: string
}) {
  const document = richTextToDocument(value, profile, ctx)
  const headingFloor =
    profile !== "inline" && ctx?.outline
      ? fieldHeadingLevel(ctx.outline, fieldPath ?? "primary.body")
      : undefined
  const linkClasses =
    "[&_a]:font-medium [&_a]:underline [&_a]:underline-offset-4 [&_a]:transition-colors [&_a]:hover:text-brand [&_a]:focus-visible:outline [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-2"

  const classes =
    profile === "inline"
      ? cn(linkClasses, className)
      : cn(
          "prose max-w-none prose-neutral dark:prose-invert",
          linkClasses,
          className,
          profile === "basic" && BASIC_PARAGRAPH_GAP
        )
  const rendered =
    profile === "inline" ? (
      <span className={classes}>
        {renderStaticRichTextDocument(document, profile, { headingFloor })}
      </span>
    ) : (
      <div className={classes}>
        {renderStaticRichTextDocument(document, profile, { headingFloor })}
      </div>
    )
  return fieldPath && ctx?.previewRichText
    ? ctx.previewRichText({
        fieldPath,
        value,
        profile,
        className: classes,
        rendered,
      })
    : rendered
}
