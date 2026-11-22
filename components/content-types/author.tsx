import {
  resolvePageOutline,
  pageHeadingModeFor,
} from "@/lib/blocks/page-outline"
import { getPublicMessages } from "@/lib/i18n/public-messages"
import { BlockList } from "@/components/blocks/block-list"
import type { Doc } from "@/convex/_generated/dataModel"
import { authorContentType } from "@/convex/lib/contentTypes/author"
import { publicFieldsOf } from "@/convex/lib/contentTypes/exposure"
import type { BlockBodyRendererProps } from "./types"

type AuthorArm = Doc<"pages"> & { pageType: "author" }
type AuthorContent = NonNullable<AuthorArm["content"]>[string]

/**
 * Public renderer for `author` — a routable content type whose top-of-page
 * surface is the author's own identity block (name / role / socials),
 * followed by the descriptor's shared block canvas.
 *
 * ADR-0038 exposure enforcement is done by lookup — the renderer never
 * hand-lists descriptor keys. `publicFieldsOf` returns the descriptor's
 * `.public()`-marked entries, and each field is only rendered when
 * present in the filtered map. A future `.public()` deletion silently
 * drops the field from the DOM instead of surfacing admin-only data.
 */
export function AuthorRenderer({
  page,
  content,
  blocks,
  ctx,
  locale,
}: BlockBodyRendererProps) {
  if (page.pageType !== "author") return null
  // `page` narrows on the guard above. `content` cannot — it arrives as its
  // own prop, typed as the union across every block-body arm, and `roleTitle`
  // exists only on this one. That cast is load-bearing; the one on `page` was
  // not, and hid future type errors on the author arm.
  const authorContent = content as AuthorContent

  const publicShared = publicFieldsOf(authorContentType.sharedFields)
  const publicLocalized = publicFieldsOf(authorContentType.localizedFields)

  const name = "name" in publicShared ? page.name : undefined
  const roleTitle =
    "roleTitle" in publicLocalized ? authorContent.roleTitle : undefined
  const socials = "socials" in publicShared ? page.socials : undefined
  const heading = name && name.length > 0 ? name : authorContent.title

  const outline = resolvePageOutline({
    blocks,
    locale: ctx.locale,
    mode: pageHeadingModeFor("author"),
  })
  return (
    <div>
      <header className="mx-auto max-w-content px-gutter pt-gutter">
        <h1 className="text-3xl font-semibold">{heading}</h1>
        {roleTitle && <p className="mt-1 text-muted-foreground">{roleTitle}</p>}
        {socials && socials.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-3 text-sm">
            {socials.map((social) => (
              <li key={`${social.platform}::${social.url}`}>
                <a
                  href={social.url}
                  rel="noopener noreferrer nofollow"
                  target="_blank"
                  className="underline underline-offset-4 hover:no-underline"
                >
                  {social.platform}
                </a>
              </li>
            ))}
          </ul>
        )}
      </header>
      {blocks.length > 0 ? (
        <BlockList blocks={blocks} ctx={ctx} outline={outline} />
      ) : (
        <p className="mx-auto max-w-content px-gutter py-section text-muted-foreground">
          {getPublicMessages(locale).chrome.noContent}
        </p>
      )}
    </div>
  )
}
