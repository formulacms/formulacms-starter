"use client"

import type {
  ShownBlock,
  ShownNavItem,
  ShownTarget,
} from "@/lib/admin/menu/public-visibility"
import { getPublicMessages } from "@/lib/i18n/public-messages"
import { usePresentationLocale } from "@/components/public/presentation-locale"
import { resolveNavigationPathname } from "@/lib/i18n/presentation-locale"
import { useId, useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu } from "lucide-react"
import { VisuallyHidden } from "@radix-ui/react-visually-hidden"
import {
  dynamicListSourceKey,
  isColumnPanel,
  type MenuCardsBySource,
} from "@/convex/lib/menu"
import { HeaderAuthControls } from "@/components/public/header-auth-controls"
import { cn } from "@/lib/utils"
import { MenuIcon } from "@/components/menu-icons"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

interface MobileNavProps {
  items: ShownNavItem[]
  logoSlot?: React.ReactNode
  cardsBySource?: MenuCardsBySource
}

function normalizePath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] || "/"
  return withoutQuery.length > 1
    ? withoutQuery.replace(/\/+$/, "")
    : withoutQuery
}

function TargetLink({
  target,
  pathname,
  onNavigate,
  className,
  children,
}: {
  target: ShownTarget
  pathname: string
  onNavigate: () => void
  className?: string
  children: React.ReactNode
}) {
  // Only destinations admitted by decideMenu reach this link renderer.
  const href = target.url
  const current =
    Boolean(pathname) &&
    href.startsWith("/") &&
    normalizePath(href) === normalizePath(pathname)
  const shared = {
    className,
    onClick: onNavigate,
    "aria-current": current ? ("page" as const) : undefined,
  }
  return target.type === "external" ? (
    <a
      href={href}
      {...shared}
      {...((target.openInNewTab ?? true)
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
    >
      {children}
    </a>
  ) : (
    <Link href={href} {...shared}>
      {children}
    </Link>
  )
}

function MobileBlock({
  block,
  pathname,
  onNavigate,
  cardsBySource,
}: {
  block: ShownBlock
  pathname: string
  onNavigate: () => void
  cardsBySource: MenuCardsBySource
}) {
  const headingId = `mobile-menu-block-${useId().replace(/:/g, "")}`
  if (block.kind === "featured") {
    if (block.link)
      return (
        <div>
          <MobileBlock
            block={{ ...block, link: undefined }}
            pathname={pathname}
            onNavigate={onNavigate}
            cardsBySource={cardsBySource}
          />
          <TargetLink
            target={block.link.target}
            pathname={pathname}
            onNavigate={onNavigate}
          >
            {block.link.label}
          </TargetLink>
        </div>
      )
    const content = (
      <>
        {block.image?.url && (
          <span className="relative block aspect-video w-full">
            <Image
              src={block.image?.url}
              alt={block.image.alt}
              fill
              sizes="90vw"
              className="object-cover"
            />
          </span>
        )}
        <span className="block p-2 font-medium">
          {block.heading}
          {block.description && (
            <span className="block text-xs text-on-surface-muted">
              {block.description}
            </span>
          )}
        </span>
      </>
    )
    const className = cn("block overflow-hidden rounded-md border")
    return block.target ? (
      <TargetLink
        target={block.target}
        pathname={pathname}
        onNavigate={onNavigate}
        className={className}
      >
        {content}
      </TargetLink>
    ) : (
      <div className={className}>{content}</div>
    )
  }

  if (block.kind === "dynamicList") {
    const cards = cardsBySource[dynamicListSourceKey(block.source)] ?? []
    return (
      <section aria-labelledby={block.heading ? headingId : undefined}>
        {block.heading && (
          <h3
            id={headingId}
            className="mb-stack text-caption font-semibold tracking-wider text-on-surface-muted uppercase"
          >
            {block.heading}
          </h3>
        )}
        <ul className="space-y-stack">
          {cards.map((card) => (
            <li key={card.pageId}>
              {card.href ? (
                <Link
                  href={card.href}
                  onClick={onNavigate}
                  className="block text-body font-medium text-on-surface hover:text-brand"
                >
                  {card.title}
                  {card.excerpt && (
                    <span className="block text-caption font-normal text-on-surface-muted">
                      {card.excerpt}
                    </span>
                  )}
                </Link>
              ) : (
                <span className="block text-body font-medium">
                  {card.title}
                </span>
              )}
            </li>
          ))}
        </ul>
        {block.seeAll && (
          <TargetLink
            target={block.seeAll.target}
            pathname={pathname}
            onNavigate={onNavigate}
            className="mt-stack inline-block text-body font-semibold text-brand"
          >
            {block.seeAll.label}
          </TargetLink>
        )}
      </section>
    )
  }

  return (
    <section aria-labelledby={block.heading ? headingId : undefined}>
      {block.heading && (
        <h3
          id={headingId}
          className="mb-stack text-caption font-semibold tracking-wider text-on-surface-muted uppercase"
        >
          {block.heading}
        </h3>
      )}
      <ul
        aria-labelledby={block.heading ? headingId : undefined}
        className="space-y-stack"
      >
        {block.links.map((link) => (
          <li key={link.id}>
            <TargetLink
              target={link.target}
              pathname={pathname}
              onNavigate={onNavigate}
              className="flex items-start gap-2 text-body font-medium text-on-surface hover:text-brand"
            >
              {link.icon && (
                <MenuIcon name={link.icon} className="mt-0.5 size-4 shrink-0" />
              )}
              <span>
                <span className="block">{link.label}</span>
                {link.description && (
                  <span className="block text-caption font-normal text-on-surface-muted">
                    {link.description}
                  </span>
                )}
              </span>
            </TargetLink>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function MobileNav({
  items,
  logoSlot,
  cardsBySource = {},
}: MobileNavProps) {
  const presentation = usePresentationLocale()
  const messages = getPublicMessages(presentation.locale).chrome
  const [open, setOpen] = useState(false)
  const routePathname = usePathname()
  const pathname = resolveNavigationPathname(routePathname, presentation)
  const close = () => setOpen(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="icon" variant="outline" aria-label={messages.openMenu}>
          <Menu className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        closeLabel={messages.close}
        className="overflow-y-auto bg-surface px-gutter py-gutter"
      >
        <VisuallyHidden>
          <SheetTitle>{messages.navigationMenu}</SheetTitle>
        </VisuallyHidden>
        {logoSlot && <div className="mb-stack">{logoSlot}</div>}
        <nav aria-label={messages.siteNavigation} className="mt-section">
          <ul className="flex flex-col gap-stack">
            {items.map((item) =>
              item.panel ? (
                <li key={item.id}>
                  <Accordion type="single" collapsible>
                    <AccordionItem value={item.id}>
                      <AccordionTrigger className="text-lead">
                        {item.label}
                      </AccordionTrigger>
                      <AccordionContent className="space-y-gutter">
                        {item.target && (
                          <TargetLink
                            target={item.target}
                            pathname={pathname}
                            onNavigate={close}
                            className="block text-body font-semibold text-on-surface hover:text-brand"
                          >
                            {item.label}
                          </TargetLink>
                        )}
                        {isColumnPanel(item.panel) ? (
                          <div className="flex flex-col gap-gutter">
                            {item.panel.columns.map((column) => (
                              <div key={column.id}>
                                {column.blocks.map((block) => (
                                  <MobileBlock
                                    key={block.id}
                                    block={block}
                                    pathname={pathname}
                                    onNavigate={close}
                                    cardsBySource={cardsBySource}
                                  />
                                ))}
                              </div>
                            ))}
                          </div>
                        ) : (
                          item.panel.blocks.map((block) => (
                            <MobileBlock
                              key={block.id}
                              block={block}
                              pathname={pathname}
                              onNavigate={close}
                              cardsBySource={cardsBySource}
                            />
                          ))
                        )}
                        {item.panel.footer && (
                          <div className="space-y-gutter border-t pt-gutter">
                            {item.panel.footer.blocks.map((block) => (
                              <MobileBlock
                                key={block.id}
                                block={block}
                                pathname={pathname}
                                onNavigate={close}
                                cardsBySource={cardsBySource}
                              />
                            ))}
                          </div>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </li>
              ) : (
                <li key={item.id}>
                  <TargetLink
                    target={item.target}
                    pathname={pathname}
                    onNavigate={close}
                    className="text-lead font-medium text-on-surface hover:text-brand"
                  >
                    {item.label}
                  </TargetLink>
                </li>
              )
            )}
          </ul>
        </nav>
        <div className="mt-section border-t border-border pt-gutter">
          <HeaderAuthControls variant="mobile" onNavigate={close} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
