import { getTranslations } from "next-intl/server"
import { EmailSettings } from "@/components/admin/email-settings"

export default async function EmailSettingsPage() {
  const t = await getTranslations("settings.email")

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("subtitle")}
        </p>
      </div>
      <EmailSettings />
    </div>
  )
}
