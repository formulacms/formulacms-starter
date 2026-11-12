import type { Metadata } from "next"
import type { ReactNode } from "react"
import { fontClassName } from "@/lib/fonts"
import { getLocaleDirection } from "@/lib/i18n/config"
import "../../../../../../globals.css"

export const metadata: Metadata = { robots: { index: false, follow: false } }

/** An independent document gives the preview its own real CSS viewport. */
export default async function LiveFrameLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  return (
    <html
      lang={locale}
      dir={getLocaleDirection(locale)}
      className={`${fontClassName} motion-safe:scroll-smooth`}
    >
      <body>{children}</body>
    </html>
  )
}
