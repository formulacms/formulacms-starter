"use client";

// Next.js requires error boundaries to be Client Components.
// Props: `error` (the thrown value) and `reset` (retriggers the segment render).
// No stack-trace dump — only show generic messaging in all environments to
// avoid leaking implementation details to public users.

import { useEffect } from "react";
import Link from "next/link";
import { usePresentationLocale } from "@/components/public/presentation-locale";
import { localePath } from "@/components/public/navigation/locale-path";
import { getPublicMessages } from "@/lib/i18n/public-messages";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  // Same presentation language as the layout (M05 M20).
  const { locale, defaultLocale } = usePresentationLocale();
  const messages = getPublicMessages(locale);

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section
      aria-labelledby="error-heading"
      className="flex min-h-96 flex-col items-center justify-center gap-stack px-gutter py-section text-center"
    >
      <span className="text-caption text-on-surface-muted uppercase tracking-widest">
        {messages.error.eyebrow}
      </span>

      <h1
        id="error-heading"
        className="text-title text-on-surface"
      >
        {messages.error.title}
      </h1>

      <p className="text-lead text-on-surface-muted max-w-prose-content">
        {messages.error.body}
      </p>

      <div className="mt-stack flex flex-wrap items-center justify-center gap-stack">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center justify-center rounded-md bg-brand px-6 py-3 text-body font-medium text-brand-foreground transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {messages.error.retry}
        </button>

        <Link
          href={localePath(locale, defaultLocale, "/")}
          className="inline-flex items-center justify-center rounded-md border border-border px-6 py-3 text-body font-medium text-on-surface transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {messages.home}
        </Link>
      </div>
    </section>
  );
}
