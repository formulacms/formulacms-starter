import type { ReactNode } from "react"
import type { Metadata } from "next"
import { Toaster } from "sonner"
import { ThemeProvider } from "@/components/theme-provider"
import { fontClassName } from "@/lib/fonts"
import { HydrationExtensionAttributeCleanup } from "@/components/hydration-extension-attribute-cleanup"
import englishMessages from "@/messages/admin/en.json"
import { SimIntlProvider } from "./intl-provider"
import "../globals.css"

// Root layout for the slice simulator (ADR-0016). Its own route group so the
// rendered slice loads the production CSS/theme/fonts (faithful preview +
// stable screenshots) with no public nav/footer or admin chrome bleeding in.
// It follows the selected site theme, so the preview exercises both modes.
export const metadata: Metadata = {
  title: "Block simulator",
  robots: { index: false, follow: false },
}

// Preview-only demo brand. Its light and dark values live in globals.css so
// it stays legible in both modes without changing the production token layer.

export default function SimLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={fontClassName}>
      <body suppressHydrationWarning className="sim-demo-brand">
        <HydrationExtensionAttributeCleanup />
        <ThemeProvider>
          <SimIntlProvider
            messages={{
              accessibility: englishMessages.accessibility,
              slices: { design: englishMessages.slices.design },
              caughtErrors: englishMessages.caughtErrors,
            }}
          >
            {children}
          </SimIntlProvider>
        </ThemeProvider>
        <Toaster richColors closeButton duration={5000} />
      </body>
    </html>
  )
}
