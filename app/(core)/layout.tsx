import "../globals.css"
import "react-image-crop/dist/ReactCrop.css"
import { NextIntlClientProvider } from "next-intl"
import { getLocale, getMessages, getTranslations } from "next-intl/server"
import { ThemeProvider } from "@/components/theme-provider"
import { Providers } from "@/components/providers"
import { ConfirmProvider } from "@/components/providers/confirm-provider"
import { Toaster } from "sonner"
import { fontClassName } from "@/lib/fonts"
import { getLocaleDirection } from "@/lib/i18n/config"
import { DevelopmentInstanceBadge } from "@/components/development-instance-badge"
import { HydrationExtensionAttributeCleanup } from "@/components/hydration-extension-attribute-cleanup"

// Root layout for the non-localized app surface: admin, setup wizard, and auth
// pages. These never carry a locale prefix, so the document language is driven
// by a per-user preference resolved in `i18n/request.ts` (resolveAdminLocale)
// rather than a URL segment. The public localized site has its own root layout
// in `(public)/[locale]`.
export default async function CoreLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()])
  const direction = getLocaleDirection(locale)
  const t = await getTranslations("accessibility")

  return (
    <html
      lang={locale}
      dir={direction}
      suppressHydrationWarning
      className={fontClassName}
    >
      {/* data-admin-ui scopes the grey disabled-control look to admin, setup and
          sign-in (see globals.css); the public layout never sets it. */}
      <body suppressHydrationWarning data-admin-ui="">
        <HydrationExtensionAttributeCleanup />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>
            <ConfirmProvider>
              <ThemeProvider>{children}</ThemeProvider>
              <Toaster
                richColors
                closeButton
                duration={5000}
                containerAriaLabel={t("notifications")}
                toastOptions={{ closeButtonAriaLabel: t("closeToast") }}
              />
              <DevelopmentInstanceBadge />
            </ConfirmProvider>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
