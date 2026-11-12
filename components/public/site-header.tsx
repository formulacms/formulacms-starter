import { decideMenu } from "@/lib/admin/menu/public-visibility"
import { getPublicMessages } from "@/lib/i18n/public-messages"
import Image from "next/image"
import Link from "next/link"
import { MainNav } from "@/components/public/navigation/main-nav"
import { LocaleSwitcher } from "@/components/public/navigation/locale-switcher"
import { MobileNav } from "@/components/public/mobile-nav"
import { HeaderAuthControls } from "@/components/public/header-auth-controls"
import type {
  CanonicalResolvedNavItem,
  MenuCardsBySource,
} from "@/convex/lib/menu"

interface SiteHeaderProps {
  logoUrl: string | null
  siteName?: string
  mainMenuItems: CanonicalResolvedNavItem[]
  locale: string
  defaultLocale: string
  enabledLocales: string[]
  languageVersion: number
  cardsBySource?: MenuCardsBySource
}

export function SiteHeader({
  logoUrl,
  siteName,
  mainMenuItems: rawMainMenuItems,
  locale,
  defaultLocale,
  enabledLocales,
  languageVersion,
  cardsBySource = {},
}: SiteHeaderProps) {
  const mainMenuItems = decideMenu(rawMainMenuItems, cardsBySource).items
  const messages = getPublicMessages(locale).chrome
  const homeHref = defaultLocale === locale ? "/" : `/${locale}`

  const logoSlot = (
    <Link href={homeHref} aria-label={siteName ?? messages.homeLabel}>
      {logoUrl ? (
        <Image
          src={logoUrl}
          alt={siteName ?? messages.siteLogo}
          width={120}
          height={32}
          className="h-8 w-[120px] object-contain object-left"
          preload
        />
      ) : (
        <span className="text-heading font-semibold text-on-surface">
          {siteName ?? ""}
        </span>
      )}
    </Link>
  )

  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-content items-center justify-between gap-gutter px-gutter py-gutter">
        {/* Logo */}
        {logoSlot}

        {/* Desktop nav */}
        <div className="hidden md:flex md:flex-1 md:items-center md:gap-gutter">
          {rawMainMenuItems.length > 0 && (
            <MainNav items={mainMenuItems} cardsBySource={cardsBySource} />
          )}
        </div>

        {/* Right side: locale switcher + mobile toggle */}
        <div className="flex min-h-9 shrink-0 items-center justify-end gap-stack">
          <div className="hidden md:block">
            <HeaderAuthControls />
          </div>
          <LocaleSwitcher
            currentLocale={locale}
            enabledLocales={enabledLocales}
            defaultLocale={defaultLocale}
            languageVersion={languageVersion}
          />
          <div className="md:hidden">
            <MobileNav
              items={mainMenuItems}
              logoSlot={logoSlot}
              cardsBySource={cardsBySource}
            />
          </div>
        </div>
      </div>
    </header>
  )
}
