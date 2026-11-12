import { connection } from "next/server"
import { getTranslations } from "next-intl/server"
import { TrashList } from "@/components/admin/trash-list"

export const dynamic = "force-dynamic"

export default async function TrashPage() {
  await connection()
  const t = await getTranslations("inventory.trash")

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <TrashList />
    </div>
  )
}
