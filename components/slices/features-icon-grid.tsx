import { bindSliceFields, RichText, Text } from "@/components/slice-kit"
import { featuresIconGridDef } from "@/convex/lib/slices/featuresIconGrid"
import { isOutlineFieldVisible } from "@/lib/slices/page-outline"
import type { FeaturesIconGridSlice } from "@/convex/lib/slices/featuresIconGrid"
import type { SliceRenderContext } from "@/lib/slices/links"
import { SliceIcon } from "./render-helpers"
import { stableItemKeys } from "@/lib/slices/keys"
import { richTextToPlainText } from "@/convex/lib/richtext/pmText"

/**
 * Features Icon Grid renderer — responsive 3-column feature card grid,
 * rewritten token-bound from the `features-12` shadcn block (ADR-0016, ADR-0020).
 *
 * Design source: optional eyebrow → centered heading → optional body intro →
 * 3-column bordered card grid, each card with an optional icon, title, and
 * short description.
 *
 * CSS drops (not modelled as fields):
 *   - Card hover states, shadows → CSS decoration only.
 *   - Decorative striped header cell from source block → dropped.
 *   - "Learn more" per-card link → static UI chrome, not editorial content; dropped.
 *   - Icon background color / icon size → CSS (`bg-brand/10`, `size-8`).
 *   - Grid column count → CSS breakpoint classes.
 *
 * Token discipline: ALL sizing, color, and spacing utilities bind to the
 * ADR-0020 design-system tokens (`text-title`, `text-lead`, `text-body`,
 * `text-caption`, `py-section`, `px-gutter`, `mt-stack`, `mt-section`,
 * `gap-gutter`, `gap-stack`, `max-w-wide`, `max-w-prose-content`,
 * `bg-surface`, `bg-surface-3`, `text-brand`, `text-on-surface`,
 * `text-on-surface-muted`, `border-border`). No raw Tailwind scale values.
 */
export function FeaturesIconGrid({
  slice,
  ctx,
}: {
  slice: FeaturesIconGridSlice
  ctx: SliceRenderContext
}) {
  const { primary } = slice
  const fields = bindSliceFields(featuresIconGridDef, slice)
  const itemKeys = stableItemKeys(slice.items, (item) =>
    richTextToPlainText(item.title)
  )
  const headingId = `${slice.id}-heading`
  const content = (
    <section
      aria-labelledby={
        isOutlineFieldVisible(primary.heading) ? headingId : undefined
      }
      className="bg-surface px-gutter py-section"
    >
      <div className="mx-auto max-w-wide">
        {/* Section header — centered */}
        <div className="text-center">
          {primary.eyebrow && (
            <p className="text-caption font-semibold text-brand">
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
          {isOutlineFieldVisible(primary.heading) && (
            <RichText
              fields={fields}
              fieldPath="primary.heading"
              id={headingId}
              className="mt-stack text-title font-medium tracking-tight text-balance"
              ctx={ctx}
            />
          )}
          {primary.body && (
            <div className="mx-auto mt-stack max-w-prose-content text-lead text-on-surface-muted [&>div>.prose]:[font-size:inherit] [&>div>.prose]:[line-height:inherit] [&>div>.prose]:[color:inherit]">
              <RichText fields={fields} fieldPath="primary.body" ctx={ctx} />
            </div>
          )}
        </div>

        {/* Feature card grid */}
        <div className="mt-section grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:grid-cols-3">
          {slice.items.map((item, index) => (
            <div
              key={itemKeys[index]}
              className="rounded-lg border border-border bg-surface-3 p-gutter block sm:row-span-2 sm:grid sm:grid-rows-subgrid sm:gap-y-0"
            >
              <div className="flex min-w-0 items-start gap-stack">
                {item.icon && (
                  <span
                    aria-hidden
                    className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand"
                  >
                    <SliceIcon name={item.icon} className="size-5" />
                  </span>
                )}
                {isOutlineFieldVisible(item.title) && (
                  <RichText
                    fields={fields}
                    fieldPath={`items[${index}].title`}
                    className="text-lead font-semibold text-on-surface min-w-0 self-stretch wrap-break-word"
                    ctx={ctx}
                  />
                )}
              </div>
              <div className="mt-stack text-body text-on-surface-muted [&>div>.prose]:[font-size:inherit] [&>div>.prose]:[line-height:inherit] [&>div>.prose]:[color:inherit] min-w-0">
                <RichText
                  fields={fields}
                  fieldPath={`items[${index}].body`}
                  ctx={ctx}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
  return ctx.previewKitSlice ? ctx.previewKitSlice(content) : content
}
