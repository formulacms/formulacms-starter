"use client"

import { createContext, useContext, type ReactNode } from "react"
import { FALLBACK_LOCALE } from "@/lib/i18n/config"

export type PresentationLocale = {
  /** The resolved presentation language (M05 M20). */
  locale: string
  /** The default language, which is served without a path prefix. */
  defaultLocale: string
  /** Frame-only canonical Page path; null suppresses unpublished navigation state. */
  publicPath?: string | null
}

const PresentationLocaleContext = createContext<PresentationLocale | null>(null)

/**
 * Carries the layout's resolved presentation language to the client screens
 * rendered inside it (not-found, error, loading), which receive no route
 * params. They must never re-derive the language from the pathname.
 */
export function PresentationLocaleProvider({
  value,
  children,
}: {
  value: PresentationLocale
  children: ReactNode
}) {
  return (
    <PresentationLocaleContext value={value}>
      {children}
    </PresentationLocaleContext>
  )
}

export function usePresentationLocale(): PresentationLocale {
  // The public layout always provides the value; the fallback only covers a
  // screen rendered outside it.
  return (
    useContext(PresentationLocaleContext) ?? {
      locale: FALLBACK_LOCALE,
      defaultLocale: FALLBACK_LOCALE,
    }
  )
}
