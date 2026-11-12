"use client"

import type { ReactNode } from "react"
import { NextIntlClientProvider } from "next-intl"
import type englishMessages from "@/messages/admin/en.json"

export type SimMessages = Pick<
  typeof englishMessages,
  "accessibility" | "caughtErrors"
> & {
  slices: Pick<(typeof englishMessages)["slices"], "design">
}

export function SimIntlProvider({
  children,
  messages,
}: {
  children: ReactNode
  messages: SimMessages
}) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  )
}
