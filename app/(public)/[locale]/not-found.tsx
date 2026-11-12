"use client"

import Link from "next/link"
import { usePresentationLocale } from "@/components/public/presentation-locale"
import { localePath } from "@/components/public/navigation/locale-path"
import { getPublicMessages } from "@/lib/i18n/public-messages"

// M05 M20: the not-found response speaks one language, the layout's resolved
// presentation language. The home link follows the same prefix rule as every
// public URL: the default language is unprefixed, the others are prefixed.
export default function NotFound() {
  const { locale, defaultLocale } = usePresentationLocale()
  const messages = getPublicMessages(locale)

  return (
    <section
      aria-labelledby="not-found-heading"
      className="flex min-h-96 flex-col items-center justify-center gap-stack px-gutter py-section text-center"
    >
      <span className="text-caption tracking-widest text-on-surface-muted uppercase">
        404
      </span>

      <h1 id="not-found-heading" className="text-title text-on-surface">
        {messages.notFound.title}
      </h1>

      <p className="max-w-prose-content text-lead text-on-surface-muted">
        {messages.notFound.body}
      </p>

      <Link
        href={localePath(locale, defaultLocale, "/")}
        className="mt-stack inline-flex items-center justify-center rounded-md bg-brand px-6 py-3 text-body font-medium text-brand-foreground transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {messages.home}
      </Link>
    </section>
  )
}
