"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { OptionalModuleRoute, OptionalModuleOffRoute } from "@/components/admin/optional-module-route"
import { RedirectsManager } from "./redirects-manager"

export default function RedirectsPage() {
  const t = useTranslations("inventory.redirects")
  return (
    <OptionalModuleRoute moduleId="redirects" title={t("title")} offNotice={t("moduleOffNotice")}
      errorText={t("loadFailed")} errorDescription={t("loadFailedDescription")} retryLabel={t("retry")}
      needsSetup="render" loading={
        <div className="flex max-w-5xl items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />{t("loading")}
        </div>
      }>
      <EnabledRedirectsRoute />
    </OptionalModuleRoute>
  )
}

function EnabledRedirectsRoute() {
  const t = useTranslations("inventory.redirects")
  const [disabled, setDisabled] = useState(false)
  if (disabled) return <OptionalModuleOffRoute notice={t("moduleOffNotice")} />
  return <RedirectsManager onModuleDisabled={() => setDisabled(true)} />
}
