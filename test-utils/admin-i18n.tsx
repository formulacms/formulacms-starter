import type { ReactNode } from "react"
import {
  render as testingLibraryRender,
  type RenderOptions,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"

type AdminLocale = "en" | "fr"

const messages = { en, fr } as const

export function AdminI18nProvider({
  children,
  locale = "en",
}: {
  children: ReactNode
  locale?: AdminLocale
}) {
  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale]}>
      {children}
    </NextIntlClientProvider>
  )
}

export function render(
  ui: ReactNode,
  {
    locale = "en",
    ...options
  }: Omit<RenderOptions, "wrapper"> & { locale?: AdminLocale } = {}
) {
  return testingLibraryRender(ui, {
    wrapper: ({ children }) => (
      <AdminI18nProvider locale={locale}>{children}</AdminI18nProvider>
    ),
    ...options,
  })
}
