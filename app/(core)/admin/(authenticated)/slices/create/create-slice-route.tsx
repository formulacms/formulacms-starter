"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { OptionalModuleRoute } from "@/components/admin/optional-module-route"

/** Create slice opens only with the AI module on; off returns to Modules
 *  with the same notice as Settings › AI. */
export function CreateSliceRoute({ children }: { children: ReactNode }) {
  const t = useTranslations("settings.aiScreen")
  return (
    <OptionalModuleRoute
      moduleId="ai"
      title={t("title")}
      offNotice={t("offNotice")}
      errorText={t("errorTitle")}
      errorDescription={t("errorDescription")}
      retryLabel={t("retry")}
      needsSetup="render"
    >
      {children}
    </OptionalModuleRoute>
  )
}
