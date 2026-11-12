"use client";

// Public loading skeleton — displayed by Next.js while the page segment
// (and its async Server Component data fetches) are resolving. Shimmers match
// the typical page composition: a hero-height block followed by a few content
// section shimmers. All surfaces bind to design-system tokens (no hardcoded
// colors). Uses Tailwind's `animate-pulse` for the shimmer effect. Its
// accessible name follows the layout's presentation language (M05 M20).

import { usePresentationLocale } from "@/components/public/presentation-locale";
import { getPublicMessages } from "@/lib/i18n/public-messages";

function Shimmer({ className }: { className: string }) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-surface-2 ${className}`}
    />
  );
}

export default function Loading() {
  const { locale } = usePresentationLocale();

  return (
    <div aria-busy="true" aria-label={getPublicMessages(locale).loading}>
      {/* Hero shimmer */}
      <div className="relative w-full bg-surface-2">
        <Shimmer className="h-96 w-full rounded-none" />
        {/* Overlay text lines */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-stack px-gutter">
          <Shimmer className="h-8 w-2/3 max-w-content" />
          <Shimmer className="h-5 w-1/2 max-w-content" />
          <Shimmer className="mt-stack h-11 w-36" />
        </div>
      </div>

      {/* Content section shimmers */}
      <div className="mx-auto max-w-content px-gutter py-section flex flex-col gap-section">
        {/* Section 1: heading + three text lines */}
        <div className="flex flex-col gap-stack">
          <Shimmer className="h-7 w-1/3" />
          <Shimmer className="h-4 w-full" />
          <Shimmer className="h-4 w-full" />
          <Shimmer className="h-4 w-3/4" />
        </div>

        {/* Section 2: three card shimmers in a row */}
        <div className="grid grid-cols-1 gap-gutter md:grid-cols-3">
          <Shimmer className="h-40" />
          <Shimmer className="h-40" />
          <Shimmer className="h-40" />
        </div>

        {/* Section 3: a two-column text + image shimmer */}
        <div className="grid grid-cols-1 gap-gutter md:grid-cols-2">
          <div className="flex flex-col gap-stack">
            <Shimmer className="h-6 w-1/2" />
            <Shimmer className="h-4 w-full" />
            <Shimmer className="h-4 w-full" />
            <Shimmer className="h-4 w-2/3" />
          </div>
          <Shimmer className="h-52" />
        </div>
      </div>
    </div>
  );
}
