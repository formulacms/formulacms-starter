import type { Doc } from "@/convex/_generated/dataModel"
import type { PublicPage } from "@/convex/lib/contentTypes/publicProjection"
import type { Block } from "@/convex/lib/blocks"
import type {
  RenderableBlockBodyContent,
  RenderableBlockBodyPage,
} from "@/convex/lib/pages/blockBodyContent"
import type { BlockRenderContext } from "@/lib/blocks/links"

/**
 * One resolved author card, returned per-id by `api.cms.pages.getPublicByline`.
 * Reproduced here because the public byline is a shared renderer surface and
 * colocating the shape with the renderers documents the contract in one
 * place.
 */
export type PublicByline = {
  name: string
  roleTitle?: string
  avatarUrl: string | null
}

/**
 * Common props passed to a block-body content-type renderer. The wiring
 * point (`app/(public)/[locale]/[[...path]]/page.tsx`) has already
 * resolved `content`, `blocks` (with fresh image URLs), `ctx` (relation +
 * link cards), and — when the type is `post` — `bylines`: one resolved
 * card per entry in `page.authorIds`, in byline order (index 0 = lead
 * author, plan 029 C10 §Q6), with draft/archived/deleted authors dropped.
 * Empty array = no author assigned or none publicly resolvable.
 */
export type BlockBodyRendererProps = {
  page: RenderableBlockBodyPage
  content: RenderableBlockBodyContent
  blocks: Block[]
  ctx: BlockRenderContext
  locale: string
  renderLocale: string
  defaultLocale: string
  bylines: PublicByline[]
}

/**
 * Props for a pure-form renderer — a type whose descriptor sets
 * `blockBody: false`, so there is no block canvas, no `ctx`, and no
 * pre-resolved `content`.
 *
 * `page` is the whole `Doc<"pages">` union rather than one arm, and the
 * renderer narrows it with `if (page.pageType !== "<type>") return null` the
 * way every block-body renderer already does. Pinning it to a single arm
 * (as this did while `testimonial` was the only pure-form type) makes the
 * registry's `pureForm` entry unassignable for the second one — the props are
 * checked contravariantly, so a component accepting a narrower `page` is not a
 * valid `Component`. That made the arm testimonial-only by construction.
 */
export type PureFormRendererProps = {
  page: Doc<"pages"> | PublicPage
  locale: string
  renderLocale: string
  defaultLocale: string
}

/**
 * Discriminated per-arm renderer entry. `kind` mirrors the descriptor's
 * `capabilities.blockBody` — the catch-all route consumes `blockBody`
 * only (non-routable types 404 upstream via `isRoutableContentType`), but
 * the `pureForm` arm lives in the registry so future non-catch-all
 * consumers (relation-card renderers) can call it uniformly.
 */
export type ContentTypeRenderer =
  | {
      kind: "blockBody"
      Component: (props: BlockBodyRendererProps) => React.ReactElement | null
    }
  | {
      kind: "pureForm"
      Component: (props: PureFormRendererProps) => React.ReactElement | null
    }
