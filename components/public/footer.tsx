import {
  decideMenu,
  type ShownBlock,
  type ShownTarget,
} from "@/lib/admin/menu/public-visibility"
import { getPublicMessages } from "@/lib/i18n/public-messages"
import Image from "next/image"
import Link from "next/link"
import {
  Mail,
  Phone,
  MapPin,
  Globe,
  MessageCircle,
  Rss,
  Code,
} from "lucide-react"
import { Separator } from "@/components/ui/separator"
import {
  dynamicListSourceKey,
  isColumnPanel,
  type CanonicalResolvedNavItem,
  type MenuCardsBySource,
} from "@/convex/lib/menu"
import { cn } from "@/lib/utils"
import { MenuIcon } from "@/components/menu-icons"

const columnClass = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
} as const

function FooterTargetLink({
  target,
  className,
  children,
}: {
  target: ShownTarget
  className?: string
  children: React.ReactNode
}) {
  // Only destinations admitted by decideMenu reach this link renderer.
  return target.type === "external" ? (
    <a
      href={target.url}
      className={className}
      {...((target.openInNewTab ?? true)
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
    >
      {children}
    </a>
  ) : (
    <Link href={target.url} className={className}>
      {children}
    </Link>
  )
}

function FooterBlock({
  block,
  cardsBySource,
}: {
  block: ShownBlock
  cardsBySource: MenuCardsBySource
}) {
  if (block.kind === "featured") {
    if (block.link)
      return (
        <div>
          <FooterBlock
            block={{ ...block, link: undefined }}
            cardsBySource={cardsBySource}
          />
          <FooterTargetLink target={block.link.target}>
            {block.link.label}
          </FooterTargetLink>
        </div>
      )
    const content = (
      <>
        {block.heading}
        {block.description && (
          <span className="mt-1 block text-caption">{block.description}</span>
        )}
      </>
    )
    const className = cn(
      "block text-body text-on-surface-muted hover:text-on-surface"
    )
    return block.target ? (
      <FooterTargetLink target={block.target} className={className}>
        {content}
      </FooterTargetLink>
    ) : (
      <div className={className}>{content}</div>
    )
  }
  if (block.kind === "dynamicList") {
    const cards = cardsBySource[dynamicListSourceKey(block.source)] ?? []
    return (
      <section>
        {block.heading && (
          <h2 className="mb-stack text-body font-semibold text-on-surface">
            {block.heading}
          </h2>
        )}
        <ul className="space-y-stack">
          {cards.map((card) => (
            <li key={card.pageId}>
              {card.href ? (
                <Link
                  href={card.href}
                  className="text-body text-on-surface-muted hover:text-on-surface"
                >
                  {card.title}
                </Link>
              ) : (
                <span className="text-body text-on-surface-muted">
                  {card.title}
                </span>
              )}
            </li>
          ))}
        </ul>
        {block.seeAll && (
          <FooterTargetLink
            target={block.seeAll.target}
            className="mt-stack inline-block text-body font-semibold text-brand hover:underline"
          >
            {block.seeAll.label}
          </FooterTargetLink>
        )}
      </section>
    )
  }
  return (
    <section>
      {block.heading && (
        <h2 className="mb-stack text-body font-semibold text-on-surface">
          {block.heading}
        </h2>
      )}
      <ul className="space-y-stack">
        {block.links.map((link) => (
          <li key={link.id}>
            <FooterTargetLink
              target={link.target}
              className="flex items-start gap-2 text-body text-on-surface-muted hover:text-on-surface"
            >
              {link.icon && (
                <MenuIcon name={link.icon} className="mt-0.5 size-4 shrink-0" />
              )}
              <span>
                {link.label}
                {link.description && (
                  <span className="block text-caption">{link.description}</span>
                )}
              </span>
            </FooterTargetLink>
          </li>
        ))}
      </ul>
    </section>
  )
}

export type ChromeData = {
  siteName?: string
  contactEmail?: string
  contactPhone?: string
  contactAddress?: string
  socialFacebook?: string
  socialInstagram?: string
  socialX?: string
  socialLinkedin?: string
}

interface FooterProps {
  footerMenu: { nav: CanonicalResolvedNavItem[] } | null
  chrome: ChromeData | null
  logoUrl: string | null
  locale: string
  defaultLocale: string
  cardsBySource?: MenuCardsBySource
}

export function Footer({
  footerMenu,
  chrome,
  logoUrl,
  locale,
  defaultLocale,
  cardsBySource = {},
}: FooterProps) {
  const messages = getPublicMessages(locale).chrome
  const homeHref = defaultLocale === locale ? "/" : `/${locale}`
  const siteName = chrome?.siteName

  const navItems = decideMenu(footerMenu?.nav ?? [], cardsBySource).items

  const hasContact =
    !!chrome?.contactEmail || !!chrome?.contactPhone || !!chrome?.contactAddress
  const hasSocial =
    !!chrome?.socialFacebook ||
    !!chrome?.socialInstagram ||
    !!chrome?.socialX ||
    !!chrome?.socialLinkedin

  return (
    <footer className="border-t border-border bg-surface-2">
      <div className="mx-auto max-w-content px-gutter py-section">
        <div className="grid grid-cols-1 gap-section md:grid-cols-2 lg:grid-cols-3">
          {/* Brand + contact column */}
          <div className="flex flex-col gap-stack">
            <Link
              href={homeHref}
              aria-label={siteName ?? messages.homeLabel}
              className="inline-block"
            >
              {logoUrl ? (
                <Image
                  src={logoUrl}
                  alt={siteName ?? messages.siteLogo}
                  width={120}
                  height={32}
                  className="w-auto object-contain"
                />
              ) : siteName ? (
                <span className="text-heading font-semibold text-on-surface">
                  {siteName}
                </span>
              ) : null}
            </Link>

            {hasContact && (
              <address className="flex flex-col gap-stack text-caption text-on-surface-muted not-italic">
                {chrome?.contactEmail && (
                  <a
                    href={`mailto:${chrome.contactEmail}`}
                    className="flex items-center gap-stack hover:text-on-surface"
                  >
                    <Mail className="size-4 shrink-0" />
                    <span>{chrome.contactEmail}</span>
                  </a>
                )}
                {chrome?.contactPhone && (
                  <a
                    href={`tel:${chrome.contactPhone}`}
                    className="flex items-center gap-stack hover:text-on-surface"
                  >
                    <Phone className="size-4 shrink-0" />
                    <span>{chrome.contactPhone}</span>
                  </a>
                )}
                {chrome?.contactAddress && (
                  <p className="flex items-start gap-stack">
                    <MapPin className="size-4 shrink-0 translate-y-px" />
                    <span>{chrome.contactAddress}</span>
                  </p>
                )}
              </address>
            )}
          </div>

          {/* Footer nav links */}
          {navItems.length > 0 && (
            <nav
              aria-label={messages.footerNavigation}
              className="flex flex-col gap-stack lg:col-span-2"
            >
              <ul className="grid gap-gutter md:grid-cols-2">
                {navItems.map((item) => {
                  return (
                    <li key={item.id} className="space-y-gutter">
                      {item.target ? (
                        <FooterTargetLink
                          target={item.target}
                          className="text-body font-semibold text-on-surface hover:text-brand"
                        >
                          {item.label}
                        </FooterTargetLink>
                      ) : (
                        <h2 className="text-body font-semibold text-on-surface hover:text-brand">
                          {item.label}
                        </h2>
                      )}
                      {item.panel && (
                        <>
                          <div className="grid gap-gutter sm:grid-cols-2">
                            {isColumnPanel(item.panel) ? (
                              <div
                                className={`col-span-full grid gap-gutter ${columnClass[(item.panel.columns.length || 1) as 1 | 2 | 3 | 4]}`}
                              >
                                {item.panel.columns.map((column) => (
                                  <div key={column.id}>
                                    {column.blocks.map((block) => (
                                      <FooterBlock
                                        key={block.id}
                                        block={block}
                                        cardsBySource={cardsBySource}
                                      />
                                    ))}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              item.panel.blocks.map((block) => (
                                <FooterBlock
                                  key={block.id}
                                  block={block}
                                  cardsBySource={cardsBySource}
                                />
                              ))
                            )}
                          </div>
                          {item.panel.footer && (
                            <div className="grid gap-gutter border-t pt-gutter sm:grid-cols-2">
                              {item.panel.footer.blocks.map((block) => (
                                <FooterBlock
                                  key={block.id}
                                  block={block}
                                  cardsBySource={cardsBySource}
                                />
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
            </nav>
          )}
        </div>

        <Separator className="my-gutter" />

        {/* Bottom bar: copyright + social icons */}
        <div className="flex flex-col gap-stack md:flex-row md:items-center md:justify-between">
          <span
            className="text-caption text-on-surface-muted"
            suppressHydrationWarning
          >
            &copy; {new Date().getFullYear()}
            {siteName ? ` ${siteName}` : ""}. {messages.rightsReserved}
          </span>

          {hasSocial && (
            <div className="flex flex-wrap items-center gap-gutter text-on-surface-muted">
              {chrome?.socialFacebook && (
                <a
                  href={chrome.socialFacebook}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Facebook"
                  className="hover:text-on-surface"
                >
                  <Globe className="size-5" />
                </a>
              )}
              {chrome?.socialInstagram && (
                <a
                  href={chrome.socialInstagram}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Instagram"
                  className="hover:text-on-surface"
                >
                  <MessageCircle className="size-5" />
                </a>
              )}
              {chrome?.socialX && (
                <a
                  href={chrome.socialX}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="X"
                  className="hover:text-on-surface"
                >
                  <Rss className="size-5" />
                </a>
              )}
              {chrome?.socialLinkedin && (
                <a
                  href={chrome.socialLinkedin}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="LinkedIn"
                  className="hover:text-on-surface"
                >
                  <Code className="size-5" />
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </footer>
  )
}
