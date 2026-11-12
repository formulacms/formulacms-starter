import type { Doc } from "../../_generated/dataModel"
import { contentTypeDefs } from "../contentTypes"
import type { PublicPage } from "../contentTypes/publicProjection"
import type { Slice } from "../slices"

/**
 * Type guard + content-shape alias for the slice-body arms of the
 * `pages` table union (plan 029 C10 task 8 continuation).
 *
 * Adding `testimonial` (`sliceBody: false`) to the discriminated union
 * widens `pages.content[locale]` from four `{title, ..., slices: [...]}`
 * arms to a union that also admits `{title, quote}`. Callers that read
 * `.slices` / `.metaTitle` / `.metaDescription` without first narrowing
 * by `pageType` lose typecheck.
 *
 * The fix — used at every cascade site — is one of:
 *   1. `if (!hasSliceBody(page)) continue|return`, or
 *   2. re-cast a single `content[locale]` read via
 *      {@link SliceBodyContent} when the caller has already established
 *      it isn't a pure-form arm (search's bag-adapter pattern).
 *
 * This helper is descriptor-driven: adding a type changes the generated
 * registry, and every consumer inherits the capability without maintaining a
 * second page-type allow-list.
 */

/**
 * The slice-body arm of the `Doc<"pages">` union — every arm whose
 * descriptor has `capabilities.sliceBody: true`. The structural intersection
 * keeps this alias open to newly generated page-type literals while still
 * making the universal slice-body fields statically visible to consumers.
 */
type SliceBodyShape = {
  title: string
  metaTitle?: string
  metaDescription?: string
  slices: Slice[]
}

type KeepSliceBodyArm<T> = T extends {
  content?: Record<string, infer Localized>
}
  ? Localized extends SliceBodyShape
    ? Omit<T, "content"> & {
        content?: Record<string, Localized & SliceBodyShape>
      }
    : never
  : never

export type SliceBodyDoc = KeepSliceBodyArm<Doc<"pages">>

/** Slice-body arm of the strict anonymous page projection. */
export type PublicSliceBodyPage = KeepSliceBodyArm<PublicPage>

/** Shared renderer input: authenticated preview or strict public projection. */
export type RenderableSliceBodyPage = SliceBodyDoc | PublicSliceBodyPage

/**
 * The `content[locale]` shape of a slice-body arm — the value stored
 * under a locale key on a slice-bodied page. Same fields three of the
 * four descriptors already expose (title / metaTitle / metaDescription
 * / slices, plus author's extra localized fields).
 */
export type SliceBodyContent = NonNullable<SliceBodyDoc["content"]>[string]

export type PublicSliceBodyContent =
  NonNullable<PublicSliceBodyPage["content"]>[string]

export type RenderableSliceBodyContent =
  | SliceBodyContent
  | PublicSliceBodyContent

/**
 * True when `page` is a slice-body arm — i.e. its `pageType` is one of
 * the flavors whose descriptor sets `capabilities.sliceBody: true`. Use
 * this at the top of any consumer that walks `content[locale].slices`
 * or reads `.metaTitle` / `.metaDescription` and doesn't already
 * discriminate on `pageType`.
 *
 * Written as a positive test (`!== "testimonial"`) — negative would
 * still work today but a positive check reads as an allow-list against
 * a small enumerated set and is what the narrowing depends on.
 */
export function hasSliceBody<
  T extends { pageType: string; content?: Record<string, unknown> },
>(
  page: T
): page is KeepSliceBodyArm<T> {
  return (
    contentTypeDefs[page.pageType as keyof typeof contentTypeDefs]?.capabilities
      .sliceBody === true
  )
}
