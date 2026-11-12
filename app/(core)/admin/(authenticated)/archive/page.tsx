import { connection } from "next/server"
import { getTranslations } from "next-intl/server"
import { ArchiveList } from "@/components/admin/archive-list"

export default async function ArchivePage() {
  await connection()
  const t = await getTranslations("inventory.archive")

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("subtitle")}
        </p>
      </div>
      <ArchiveList />
    </div>
  )
}
