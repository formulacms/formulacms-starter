"use client"

import type {
  ShownBlock,
  ShownNavItem,
  ShownTarget,
} from "@/lib/admin/menu/public-visibility"
import { getPublicMessages } from "@/lib/i18n/public-messages"
import { usePresentationLocale } from "@/components/public/presentation-locale"
import { resolveNavigationPathname } from "@/lib/i18n/presentation-locale"
import { useId } from "react"
import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  dynamicListSourceKey,
  isColumnPanel,
  type MenuCardsBySource,
} from "@/convex/lib/menu"
import { MenuIcon } from "@/components/menu-icons"
import { cn } from "@/lib/utils"
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu"

function normalizePath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] || "/"
  return withoutQuery.length > 1
    ? withoutQuery.replace(/\/+$/, "")
    : withoutQuery
}

function isCurrentHref(href: string, pathname: string): boolean {
  return (
    Boolean(pathname) &&
    href.startsWith("/") &&
    normalizePath(href) === normalizePath(pathname)
  )
}

function TargetLink({
  target,
  pathname,
  className,
  children,
}: {
  target: ShownTarget
  pathname: string
  className?: string
  children: React.ReactNode
}) {
  // Only destinations admitted by decideMenu reach this link renderer.
  const href = target.url
  const current = isCurrentHref(href, pathname)
  const shared = {
    className,
    "aria-current": current ? ("page" as const) : undefined,
  }
  return (
    <NavigationMenuLink asChild active={current}>
      {target.type === "external" ? (
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
      )}
    </NavigationMenuLink>
  )
}

const spanClass = {
  1: "col-span-1",
  2: "col-span-2",
  3: "col-span-3",
  4: "col-span-4",
} as const

const panelWidthClass = {
  1: "w-64 md:w-64",
  2: "w-128 md:w-128",
  3: "w-192 md:w-192",
  4: "w-256 md:w-256",
} as const

const columnClass = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
} as const

function PanelBlock({
  block,
  pathname,
  cardsBySource,
}: {
  block: ShownBlock
  pathname: string
  cardsBySource: MenuCardsBySource
}) {
  const headingId = `menu-block-${useId().replace(/:/g, "")}`
  if (block.kind === "featured") {
    if (block.link)
      return (
        <div>
          <PanelBlock
            block={{ ...block, link: undefined }}
            pathname={pathname}
            cardsBySource={cardsBySource}
          />
          <TargetLink target={block.link.target} pathname={pathname}>
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
              sizes="(max-width: 768px) 100vw, 320px"
              className="object-cover"
            />
          </span>
        )}
        <span className="block px-3 py-2 text-sm font-medium">
          {block.heading}
          {block.description && (
            <span className="mt-1 block text-xs text-on-surface-muted">
              {block.description}
            </span>
          )}
        </span>
      </>
    )
    const className = cn(
      "block overflow-hidden rounded-md border hover:opacity-90",
      spanClass[block.span ?? 1]
    )
    return block.target ? (
      <TargetLink
        target={block.target}
        pathname={pathname}
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
      <section
        className={spanClass[block.span ?? 1]}
        role="group"
        aria-labelledby={block.heading ? headingId : undefined}
      >
        {block.heading && (
          <h2
            id={headingId}
            className="mb-2 text-xs font-semibold tracking-wider text-on-surface-muted uppercase"
          >
            {block.heading}
          </h2>
        )}
        <ul className="space-y-1">
          {cards.map((card) => (
            <li key={card.pageId}>
              {card.href ? (
                <Link
                  href={card.href}
                  className="block rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                >
                  <span className="block font-medium">{card.title}</span>
                  {card.excerpt && (
                    <span className="block text-xs text-on-surface-muted">
                      {card.excerpt}
                    </span>
                  )}
                </Link>
              ) : (
                <span className="block px-2 py-1.5 text-sm">{card.title}</span>
              )}
            </li>
          ))}
        </ul>
        {block.seeAll && (
          <TargetLink
            target={block.seeAll.target}
            pathname={pathname}
            className="mt-2 inline-block text-sm font-medium text-brand hover:underline"
          >
            {block.seeAll.label}
          </TargetLink>
        )}
      </section>
    )
  }

  return (
    <section
      className={spanClass[block.span ?? 1]}
      role="group"
      aria-labelledby={block.heading ? headingId : undefined}
    >
      {block.heading && (
        <h2
          id={headingId}
          className="mb-2 text-xs font-semibold tracking-wider text-on-surface-muted uppercase"
        >
          {block.heading}
        </h2>
      )}
      <ul className="space-y-1">
        {block.links.map((link) => (
          <li key={link.id}>
            <TargetLink
              target={link.target}
              pathname={pathname}
              className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            >
              {link.icon && (
                <MenuIcon name={link.icon} className="mt-0.5 size-4 shrink-0" />
              )}
              <span>
                <span className="block">{link.label}</span>
                {link.description && (
                  <span className="block text-xs text-on-surface-muted">
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

function PanelRegion({
  blocks,
  columns,
  pathname,
  className,
  cardsBySource,
}: {
  blocks: ShownBlock[]
  columns: 1 | 2 | 3 | 4
  pathname: string
  className?: string
  cardsBySource: MenuCardsBySource
}) {
  return (
    <div className={cn("grid gap-6", columnClass[columns], className)}>
      {blocks.map((block) => (
        <PanelBlock
          key={block.id}
          block={block}
          pathname={pathname}
          cardsBySource={cardsBySource}
        />
      ))}
    </div>
  )
}

export function MainNav({
  items,
  cardsBySource = {},
}: {
  items: ShownNavItem[]
  cardsBySource?: MenuCardsBySource
}) {
  const presentation = usePresentationLocale()
  const messages = getPublicMessages(presentation.locale).chrome
  const routePathname = usePathname()
  const pathname = resolveNavigationPathname(routePathname, presentation)

  return (
    <NavigationMenu
      viewport={false}
      aria-label={messages.mainNavigation}
      className="max-w-none justify-start"
    >
      <NavigationMenuList className="justify-start">
        {items.map((item) =>
          item.panel ? (
            <NavigationMenuItem key={item.id}>
              <NavigationMenuTrigger>{item.label}</NavigationMenuTrigger>
              <NavigationMenuContent
                style={{
                  maxWidth:
                    "min(var(--container-content), calc(100vw - (var(--spacing-gutter) * 2)))",
                }}
                className={cn(
                  "end-0 start-auto z-50 min-w-64 border bg-surface-3 p-4 text-on-surface shadow-md",
                  "max-w-content",
                  panelWidthClass[
                    isColumnPanel(item.panel)
                      ? ((item.panel.columns.length || 1) as 1 | 2 | 3 | 4)
                      : item.panel.columns
                  ]
                )}
              >
                {item.target && (
                  <TargetLink
                    target={item.target}
                    pathname={pathname}
                    className="mb-4 block font-medium"
                  >
                    {item.label}
                  </TargetLink>
                )}
                {isColumnPanel(item.panel) ? (
                  <div
                    className={cn(
                      "grid gap-6",
                      columnClass[
                        (item.panel.columns.length || 1) as 1 | 2 | 3 | 4
                      ]
                    )}
                  >
                    {item.panel.columns.map((column) => (
                      <div key={column.id}>
                        {column.blocks.map((block) => (
                          <PanelBlock
                            key={block.id}
                            block={block}
                            pathname={pathname}
                            cardsBySource={cardsBySource}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <PanelRegion
                    blocks={item.panel.blocks}
                    columns={item.panel.columns}
                    pathname={pathname}
                    cardsBySource={cardsBySource}
                  />
                )}
                {item.panel.footer && (
                  <PanelRegion
                    blocks={item.panel.footer.blocks}
                    columns={isColumnPanel(item.panel) ? 1 : item.panel.columns}
                    pathname={pathname}
                    className="mt-4 border-t pt-4"
                    cardsBySource={cardsBySource}
                  />
                )}
              </NavigationMenuContent>
            </NavigationMenuItem>
          ) : (
            <NavigationMenuItem key={item.id}>
              <TargetLink
                target={item.target}
                pathname={pathname}
                className="rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
              >
                {item.label}
              </TargetLink>
            </NavigationMenuItem>
          )
        )}
      </NavigationMenuList>
    </NavigationMenu>
  )
}
