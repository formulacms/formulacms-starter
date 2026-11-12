import type { ReactNode } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

// JSX twins of the approved sibling-list mockup's text helpers.
export function RowTitle({
  children,
  locale,
  href,
  muted = false,
}: {
  children: ReactNode
  locale?: string
  href?: string
  muted?: boolean
}) {
  const className = cn(
    "block min-w-0 text-sm font-medium wrap-break-word",
    href && "hover:underline",
    muted && "text-muted-foreground"
  )
  return href ? (
    <Link href={href} lang={locale} dir="auto" className={className}>
      {children}
    </Link>
  ) : (
    <p lang={locale} dir="auto" className={className}>
      {children}
    </p>
  )
}

export function RowUrlName({ value, locale }: { value: string; locale?: string }) {
  const split = value.lastIndexOf("-")
  const boundedTail =
    value.length > 32 && split >= 0 && value.length - split - 1 <= 12
  return (
    <span
      className="flex min-w-0 max-w-full text-xs text-muted-foreground"
      lang={locale}
      dir="auto"
      title={value}
    >
      <span className="min-w-0 truncate">
        {boundedTail ? value.slice(0, split) : value}
      </span>
      {boundedTail && (
        <span className="shrink-0 max-w-1/2 truncate">{value.slice(split)}</span>
      )}
    </span>
  )
}

export function WrappingBadge({
  children,
  icon,
  muted = false,
}: {
  children: string
  icon?: ReactNode
  muted?: boolean
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-auto min-h-5 shrink overflow-visible whitespace-normal max-w-full wrap-break-word",
        muted && "text-muted-foreground"
      )}
    >
      {icon}
      {icon ? <span className="min-w-0">{children}</span> : children}
    </Badge>
  )
}
