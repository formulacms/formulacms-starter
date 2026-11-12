import { getPublicMessages } from "@/lib/i18n/public-messages"

/** Fixed public preview chrome follows presentation language, including fallback drafts. */
export function PreviewBanner({
  locale,
  status,
  exitHref,
}: {
  locale: string
  status: string
  exitHref: string
}) {
  const messages = getPublicMessages(locale).chrome
  const [beforeStatus, afterStatus] = messages.previewShowing.split("{status}")
  const statusLabel =
    status === "draft"
      ? messages.draft
      : status === "published"
        ? messages.published
        : status === "archived"
          ? messages.archived
          : status

  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-3 bg-amber-500 px-4 py-1.5 text-xs font-medium text-amber-950">
      <span>
        {beforeStatus}
        <strong>{statusLabel}</strong>
        {afterStatus}
      </span>
      <a
        href={exitHref}
        className="underline underline-offset-2 hover:no-underline"
      >
        {messages.exitPreview}
      </a>
    </div>
  )
}
