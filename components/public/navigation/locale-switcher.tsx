"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Globe, Check } from "lucide-react"
import { usePresentationLocale } from "@/components/public/presentation-locale"
import { getPublicMessages } from "@/lib/i18n/public-messages"

interface LocaleSwitcherProps {
  currentLocale: string
  enabledLocales: string[]
  defaultLocale: string
  languageVersion: number
}

function LocaleSwitcherButtonContent({ locale }: { locale: string }) {
  return (
    <>
      <Globe className="size-4" aria-hidden="true" />
      <span>{locale.toUpperCase()}</span>
    </>
  )
}

function LocaleSwitcherFallback({
  currentLocale,
  enabledLocales,
}: Pick<LocaleSwitcherProps, "currentLocale" | "enabledLocales">) {
  if (enabledLocales.length < 2) return null

  return (
    <span
      aria-hidden="true"
      className="inline-flex h-9 min-w-16 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium"
    >
      <LocaleSwitcherButtonContent locale={currentLocale} />
    </span>
  )
}

/**
 * Inner component that calls useSearchParams(). Must be wrapped in <Suspense>
 * to avoid deopt-to-client-rendering for the entire page above it.
 */
function LocaleSwitcherInner({
  currentLocale,
  enabledLocales,
  defaultLocale,
  languageVersion,
}: LocaleSwitcherProps) {
  const { publicPath } = usePresentationLocale()
  const routePathname = usePathname()
  const pathname = publicPath === undefined ? routePathname : (publicPath ?? "")
  const searchParams = useSearchParams()

  // Only resolve translated URLs once the menu has actually been opened.
  //
  // This component renders in the public site header, so it is on EVERY public
  // page. Both queries below are client subscriptions: they bypass the
  // `unstable_cache` layer in lib/cms/cache.ts that wraps the server render
  // path, and `resolveLocalizedPathQuery` on a non-default locale scans up to
  // 500 full page documents (its read set is effectively the whole `pages`
  // table, so any page write invalidates it for every path and locale). On
  // Convex's free plan, database I/O is the binding constraint — fetching this
  // on render made routine editing re-pay a table scan across every live path.
  //
  // Latching on first open (rather than tracking `open`) keeps the result warm
  // so reopening the menu does not refetch. Until availability resolves the
  // options are non-interactive ("Checking…"): a guessed URL is never a link
  // (M05 C5, M21).
  const [hasOpened, setHasOpened] = useState(false)
  const messages = getPublicMessages(currentLocale).languageSwitcher

  // Strip the locale prefix to get the locale-relative path the resolver wants
  // ("/" for home). The default locale carries no prefix.
  let relPath = pathname || "/"
  if (
    currentLocale !== defaultLocale &&
    relPath.startsWith(`/${currentLocale}`)
  ) {
    relPath = relPath.slice(currentLocale.length + 1) || "/"
  }

  // Which page is at this path (in the current locale)? Then its navigation
  // alternates: every enabled locale with a current routable version.
  const pageId = useQuery(
    api.cms.pages.resolveLocalizedPathQuery,
    hasOpened && publicPath !== null
      ? { path: relPath, locale: currentLocale, languageVersion }
      : "skip"
  )
  const alternates = useQuery(
    api.cms.pages.getPublicLocaleAlternates,
    pageId ? { pageId, languageVersion } : "skip"
  )
  const homeAlternates = useQuery(
    api.cms.pages.getPublicHomeLocaleAlternates,
    hasOpened && pageId === null ? { languageVersion } : "skip"
  )
  const checking =
    pageId === undefined ||
    (pageId === null ? homeAlternates === undefined : alternates === undefined)

  function hrefFor(locale: string): string | null {
    // A non-Page route offers only published Homes. A Page offers only its
    // own reachable published versions; unavailable languages stay disabled.
    const entries = pageId === null ? homeAlternates : alternates
    const base = entries?.find((entry) => entry.locale === locale)?.url ?? null
    if (base === null) return null
    // Plain links to the resolver's own URL. The default language is the
    // unprefixed address (the proxy keeps it so whatever the browser sends),
    // so nothing is remembered and no cookie is written.
    const target = base
    const qs = publicPath === undefined ? searchParams?.toString() : undefined
    return qs ? `${target}?${qs}` : target
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => open && !hasOpened && setHasOpened(true)}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-9 min-w-16 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
          aria-label={`${messages.label}, ${currentLocale.toUpperCase()}`}
        >
          <LocaleSwitcherButtonContent locale={currentLocale} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-busy={checking}>
        {checking && (
          <p
            role="status"
            className="px-2 py-1.5 text-xs text-on-surface-muted"
          >
            {messages.checking}
          </p>
        )}
        {enabledLocales.map((locale) => {
          const href = checking ? null : hrefFor(locale)
          const option = (
            <>
              <Check
                className={
                  locale === currentLocale
                    ? "size-4 opacity-100"
                    : "size-4 opacity-0"
                }
              />
              {locale.toUpperCase()}
            </>
          )
          return href ? (
            <DropdownMenuItem key={locale} asChild>
              <Link
                href={href}
                prefetch={false}
                hrefLang={locale}
              >
                {option}
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem key={locale} disabled>
              <span aria-disabled="true">
                {option}
                {!checking && (
                  <span className="sr-only">, {messages.unavailable}</span>
                )}
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Exported wrapper — provides the required Suspense boundary so that
 * useSearchParams() inside LocaleSwitcherInner does not deopt the page above.
 */
export function LocaleSwitcher(props: LocaleSwitcherProps) {
  // Single-locale sites render nothing — and, importantly, never mount
  // LocaleSwitcherInner, so they never open its Convex subscriptions.
  //
  // This check MUST live here rather than inside Inner. React forbids
  // conditional hooks, so when it sat inside Inner it necessarily ran AFTER
  // the two useQuery calls: a single-locale install paid for both queries on
  // every public page view and then returned null.
  if (props.enabledLocales.length < 2) return null

  return (
    <Suspense fallback={<LocaleSwitcherFallback {...props} />}>
      <LocaleSwitcherInner {...props} />
    </Suspense>
  )
}
