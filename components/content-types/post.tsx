import {
  resolvePageOutline,
  pageHeadingModeFor,
} from "@/lib/slices/page-outline"
import { getPublicMessages } from "@/lib/i18n/public-messages"
import Image from "next/image"
import { SliceZone } from "@/components/slices/slice-zone"
import { postContentType } from "@/convex/lib/contentTypes/post"
import { publicFieldsOf } from "@/convex/lib/contentTypes/exposure"
import { formatBylineNames } from "./byline"
import type { SliceBodyRendererProps } from "./types"

/**
 * Public renderer for `post` — descriptor-driven, ADR-0038 exposure-gated.
 *
 * Renders the multi-author byline the outer route pre-resolved (plan 029
 * C10 §Q6 task 14): names join via `formatBylineNames`
 * ("By A" / "By A and B" / "By A, B, and C" / "By A, B, C, and N others").
 * The lead author's (index 0) avatar and role title are shown alongside
 * the name list — a single shared avatar/role reads cleanly for the
 * common one-author case and doesn't misattribute a role to a group when
 * there are several authors, so role title is only shown when there's
 * exactly one.
 *
 * `tags` is admin-only per the descriptor ("Internal Labels" per plan 029
 * §Recommended editor seam) and the `publicFieldsOf` lookup fail-closed
 * drops it from any rendered surface.
 *
 * The editorial flags (`featured`, `promoteToFront`) drive the
 * reference-card badge and blog-listing order — not the post detail
 * page's own visual surface. They're intentionally not rendered here.
 */
export function PostRenderer({
  content,
  slices,
  ctx,
  locale,
  bylines,
}: SliceBodyRendererProps) {
  const publicShared = publicFieldsOf(postContentType.sharedFields)
  // `tags` is admin-only, so it never appears in this map — this is the
  // ADR-0038 fail-closed enforcement.
  const showByline = "authorIds" in publicShared && bylines.length > 0
  const lead = bylines[0]
  const bylineText = formatBylineNames(
    bylines.map((b) => b.name),
    locale
  )

  const outline = resolvePageOutline({
    slices,
    locale: ctx.locale,
    mode: pageHeadingModeFor("post"),
  })
  return (
    <div>
      {slices.length === 0 ? (
        <div className="px-6 py-10">
          <h1 className="text-3xl font-semibold">{content.title}</h1>
          <p className="mt-2 text-muted-foreground">
            {getPublicMessages(locale).chrome.noContent}
          </p>
        </div>
      ) : (
        <>
          {outline.hostRendersFallbackH1 && (
            <h1 className="sr-only">{content.title}</h1>
          )}
          {showByline && lead && (
            <div className="mx-auto flex max-w-content items-center gap-3 px-gutter pt-gutter">
              {lead.avatarUrl && (
                <Image
                  src={lead.avatarUrl}
                  alt=""
                  width={40}
                  height={40}
                  className="size-10 shrink-0 rounded-full object-cover"
                />
              )}
              <div className="text-sm leading-tight">
                <p className="font-medium">{bylineText}</p>
                {bylines.length === 1 && lead.roleTitle && (
                  <p className="text-muted-foreground">{lead.roleTitle}</p>
                )}
              </div>
            </div>
          )}
          <SliceZone slices={slices} ctx={ctx} outline={outline} />
        </>
      )}
    </div>
  )
}
