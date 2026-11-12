import { getLocale, getTranslations } from "next-intl/server";
import { AccountLanguagePicker } from "@/components/admin/settings/account-language-picker";
import { getLocaleDisplayName } from "@/lib/i18n/config";
import { ADMIN_DICTIONARY_LOCALES } from "@/lib/i18n/admin-dictionaries";

export default async function AccountSettingsPage() {
  const [currentLocale, t] = await Promise.all([
    getLocale(),
    getTranslations("settings.account"),
  ]);
  const localeOptions = ADMIN_DICTIONARY_LOCALES.map((code) => ({
    code,
    label: getLocaleDisplayName(code),
  }));

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t("subtitle")}</p>
      </div>

      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-medium mb-1">{t("adminLanguage")}</h2>
          <p className="text-xs text-muted-foreground mb-3">
            {t("adminLanguageDescription")}
          </p>
          <AccountLanguagePicker
            key={currentLocale}
            currentLocale={currentLocale}
            localeOptions={localeOptions}
          />
        </div>
      </div>
    </div>
  );
}
