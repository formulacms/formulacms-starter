import type { Doc } from "../../_generated/dataModel"
import { contentTypeDefs } from "../contentTypes"
import type { PublicPage } from "../contentTypes/publicProjection"
import type { Block } from "../blocks"

/**
 * Type guard + content-shape alias for the block-body arms of the
 * `pages` table union (plan 029 C10 task 8 continuation).
 *
 * Adding `testimonial` (`blockBody: false`) to the discriminated union
 * widens `pages.content[locale]` from four `{title, ..., blocks: [...]}`
 * arms to a union that also admits `{title, quote}`. Callers that read
 * `.blocks` / `.metaTitle` / `.metaDescription` without first narrowing
 * by `pageType` lose typecheck.
 *
 * The fix — used at every cascade site — is one of:
 *   1. `if (!hasBlockBody(page)) continue|return`, or
 *   2. re-cast a single `content[locale]` read via
 *      {@link BlockBodyContent} when the caller has already established
 *      it isn't a pure-form arm (search's bag-adapter pattern).
 *
 * This helper is descriptor-driven: adding a type changes the generated
 * registry, and every consumer inherits the capability without maintaining a
 * second page-type allow-list.
 */

/**
 * The block-body arm of the `Doc<"pages">` union — every arm whose
 * descriptor has `capabilities.blockBody: true`. The structural intersection
 * keeps this alias open to newly generated page-type literals while still
 * making the universal block-body fields statically visible to consumers.
 */
type BlockBodyShape = {
  title: string
  metaTitle?: string
  metaDescription?: string
  blocks: Block[]
}

type KeepBlockBodyArm<T> = T extends {
  content?: Record<string, infer Localized>
}
  ? Localized extends BlockBodyShape
    ? Omit<T, "content"> & {
        content?: Record<string, Localized & BlockBodyShape>
      }
    : never
  : never

export type BlockBodyDoc = KeepBlockBodyArm<Doc<"pages">>

/** Block-body arm of the strict anonymous page projection. */
export type PublicBlockBodyPage = KeepBlockBodyArm<PublicPage>

/** Shared renderer input: authenticated preview or strict public projection. */
export type RenderableBlockBodyPage = BlockBodyDoc | PublicBlockBodyPage

/**
 * The `content[locale]` shape of a block-body arm — the value stored
 * under a locale key on a block-bodied page. Same fields three of the
 * four descriptors already expose (title / metaTitle / metaDescription
 * / blocks, plus author's extra localized fields).
 */
export type BlockBodyContent = NonNullable<BlockBodyDoc["content"]>[string]

export type PublicBlockBodyContent =
  NonNullable<PublicBlockBodyPage["content"]>[string]

export type RenderableBlockBodyContent =
  | BlockBodyContent
  | PublicBlockBodyContent

/**
 * True when `page` is a block-body arm — i.e. its `pageType` is one of
 * the flavors whose descriptor sets `capabilities.blockBody: true`. Use
 * this at the top of any consumer that walks `content[locale].blocks`
 * or reads `.metaTitle` / `.metaDescription` and doesn't already
 * discriminate on `pageType`.
 *
 * Written as a positive test (`!== "testimonial"`) — negative would
 * still work today but a positive check reads as an allow-list against
 * a small enumerated set and is what the narrowing depends on.
 */
export function hasBlockBody<
  T extends { pageType: string; content?: Record<string, unknown> },
>(
  page: T
): page is KeepBlockBodyArm<T> {
  return (
    contentTypeDefs[page.pageType as keyof typeof contentTypeDefs]?.capabilities
      .blockBody === true
  )
}
