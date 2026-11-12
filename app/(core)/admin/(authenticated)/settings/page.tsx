import { getTranslations } from "next-intl/server";
import { GeneralSettings } from "@/components/admin/general-settings";
import { ADMIN_AUTHORING_TOOLS_BROWSER_BINDING } from "@/components/admin/contributions/authoring-tools";

export default async function SettingsPage() {
  const t = await getTranslations("settings.general");

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("subtitle")}
        </p>
      </div>
      <GeneralSettings />
      {ADMIN_AUTHORING_TOOLS_BROWSER_BINDING && (
        <ADMIN_AUTHORING_TOOLS_BROWSER_BINDING.SettingsDesignSystemEntry />
      )}
    </div>
  );
}
