"use client"

import { useTranslations } from "next-intl"
import { caughtErrorMessage } from "./caught-error"

export function useCaughtError() {
  const t = useTranslations("caughtErrors")
  return (error: unknown, fallback: string) =>
    caughtErrorMessage(error, t, fallback)
}
