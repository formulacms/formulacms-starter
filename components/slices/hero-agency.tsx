import {
  bindSliceFields,
  RichText,
  Text,
  Buttons,
} from "@/components/slice-kit"
import { heroAgencyDef } from "@/convex/lib/slices/heroAgency"
import { isOutlineFieldVisible } from "@/lib/slices/page-outline"
import type { HeroAgencySlice } from "@/convex/lib/slices/heroAgency"
import type { SliceRenderContext } from "@/lib/slices/links"

// TODO(ADR-0016): scaffolded renderer; close-enough first pass from snapshot.
// Replace with the designed JSX/Tailwind after reviewing the generated model.
export function HeroAgency({
  slice,
  ctx,
}: {
  slice: HeroAgencySlice
  ctx: SliceRenderContext
}) {
  const { primary } = slice
  const fields = bindSliceFields(heroAgencyDef, slice)
  const headingId = `${slice.id}-heading`
  const content = (
    <section
      aria-label={
        isOutlineFieldVisible(primary.title) ? ctx.regionLabel : undefined
      }
      aria-labelledby={
        isOutlineFieldVisible(primary.title) && !ctx.regionLabel
          ? headingId
          : undefined
      }
      className="bg-surface px-gutter py-section"
    >
      <div className="mx-auto flex max-w-5xl flex-col items-start gap-4 text-left">
        {primary.eyebrow && (
          <p className="text-caption font-medium tracking-widest text-on-surface-muted uppercase">
            {
              <Text
                fields={fields}
                fieldPath="primary.eyebrow"
                as="span"
                ctx={ctx}
              />
            }
          </p>
        )}
        {isOutlineFieldVisible(primary.title) && (
          <RichText
            fields={fields}
            fieldPath="primary.title"
            id={headingId}
            className="max-w-4xl font-public-heading text-display font-black tracking-tight text-on-surface"
            ctx={ctx}
          />
        )}
        {primary.description && (
          <RichText
            fields={fields}
            fieldPath="primary.description"
            ctx={ctx}
            className="max-w-xl text-body text-on-surface-muted [&>.prose]:[font-size:inherit] [&>.prose]:[line-height:inherit] [&>.prose]:[color:inherit]"
          />
        )}
        <Buttons fields={fields} fieldPath="items" ctx={ctx} className="pt-3" />
      </div>
    </section>
  )
  return ctx.previewKitSlice ? ctx.previewKitSlice(content) : content
}
