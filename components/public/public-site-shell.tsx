import type { ComponentProps, ReactNode } from "react"
import { SiteHeader } from "./site-header"
import { Footer } from "./footer"
import { PublicSurface } from "@/components/ui/public-surface"

export type PublicSiteShellProps = {
  header: ComponentProps<typeof SiteHeader>
  footer: ComponentProps<typeof Footer>
  children: ReactNode
}

/** The same layout wrappers and chrome are used by public Pages and previews. */
export function PublicSiteShell({
  header,
  footer,
  children,
}: PublicSiteShellProps) {
  return (
    <PublicSurface className="flex min-h-screen flex-col">
      <SiteHeader {...header} />
      <main className="flex-1">{children}</main>
      <Footer {...footer} />
    </PublicSurface>
  )
}
