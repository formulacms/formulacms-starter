import {
  bindBlockFields,
  RichText,
  Text,
  Accordion,
} from "@/components/block-kit"
import { faqSimpleDef } from "@/convex/lib/blocks/faqSimple"
import {
  fieldHeadingLevel,
  isOutlineFieldVisible,
} from "@/lib/blocks/page-outline"
import { getPublicMessages } from "@/lib/i18n/public-messages"
import type { FaqSimpleBlock } from "@/convex/lib/blocks/faqSimple"
import type { BlockRenderContext } from "@/lib/blocks/links"
import { stableItemKeys } from "@/lib/blocks/keys"
import { richTextToPlainText } from "@/convex/lib/richtext/pmText"
import { readFieldText } from "@/convex/lib/richtext/transitions"

/**
 * FAQ Simple renderer — section heading with optional eyebrow + body, followed
 * by a single-column accordion of FAQ items. Rewritten token-bound from the
 * `faq-02` shadcn block (ADR-0016, ADR-0020).
 *
 * Design source: stacked layout with heading on the left and accordion panel
 * on the right at md+ breakpoint. All spacing, type, and color bind to the
 * ADR-0020 semantic design-system tokens — no raw Tailwind scale values.
 *
 * CSS drops (not modelled as fields):
 *   - Accordion defaultOpen behavior → JS-only; open-first-item is renderer default.
 *   - Font sizes, tracking, padding, gap → replaced with design-system tokens.
 *   - Panel max-width (`max-w-xl`) → max-w-prose-content token.
 *   - Layout split (left/right) → CSS breakpoint classes, no structural-intent field.
 *
 * Token discipline: ALL sizing, color, and spacing bind to ADR-0020 tokens
 * (`bg-surface`, `text-title`, `text-lead`, `text-body`, `text-caption`,
 * `text-brand`, `text-on-surface`, `text-on-surface-muted`, `py-section`,
 * `px-gutter`, `gap-stack`, `gap-gutter`, `mt-stack`, `max-w-content`,
 * `max-w-prose-content`). No raw Tailwind scale values.
 */
export function FaqSimple({
  block,
  ctx,
}: {
  block: FaqSimpleBlock
  ctx: BlockRenderContext
}) {
  const { primary } = block
  const fields = bindBlockFields(faqSimpleDef, block)
  const questionValues = block.items.map((item) =>
    readFieldText(
      { blockType: "faq-simple", fieldPath: "items.question" },
      item.question
    )
  )
  const itemKeys = stableItemKeys(
    block.items,
    (item, index) => item.itemId ?? questionValues[index]
  )
  const headingId = `${block.id}-heading`
  const headingText = richTextToPlainText(primary.heading)
  const content = (
    <section
      aria-labelledby={
        isOutlineFieldVisible(primary.heading) ? headingId : undefined
      }
      className="bg-surface px-gutter py-section"
    >
      <div className="mx-auto max-w-content">
        <div className="flex flex-col gap-stack md:flex-row md:items-start md:gap-gutter">
          {/* Section header */}
          <div className="shrink-0">
            {primary.eyebrow && (
              <p className="text-caption font-semibold text-brand">
                <Text
                  fields={fields}
                  fieldPath="primary.eyebrow"
                  as="span"
                  ctx={ctx}
                />
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
              <div className="mt-stack text-lead text-on-surface-muted">
                <RichText fields={fields} fieldPath="primary.body" ctx={ctx} />
              </div>
            )}
          </div>

          {/* Accordion panel */}
          <div className="max-w-prose-content overflow-hidden">
            <Accordion
              label={getPublicMessages(ctx.presentationLocale ?? ctx.locale)
                .chrome.faqQuestions.replace(
                  "{heading}",
                  isOutlineFieldVisible(primary.heading) ? headingText : ""
                )
                .trim()}
              rows={block.items.map((item, index) => ({
                key: itemKeys[index],
                headingLevel: fieldHeadingLevel(
                  ctx.outline,
                  `items[${index}].question`,
                  3
                ),
                title: fields.isEmpty(`items[${index}].question`) ? null : (
                  <RichText
                    fields={fields}
                    fieldPath={`items[${index}].question`}
                    host="inline"
                    ctx={ctx}
                  />
                ),
                answer: isOutlineFieldVisible(item.answer, {
                  kind: "body",
                  profile: "basic",
                }) ? (
                  <RichText
                    fields={fields}
                    fieldPath={`items[${index}].answer`}
                    ctx={ctx}
                  />
                ) : null,
              }))}
            />
          </div>
        </div>
      </div>
    </section>
  )
  return ctx.previewKitBlock ? ctx.previewKitBlock(content) : content
}
