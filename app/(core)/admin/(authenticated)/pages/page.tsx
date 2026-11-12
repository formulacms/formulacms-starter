import { connection } from "next/server"
import Link from "next/link"
import { getTranslations } from "next-intl/server"
import { PlusCircle } from "lucide-react"
import { PagesListClient } from "@/components/admin/pages-list-client"

export default async function PagesPage() {
  await connection()
  const t = await getTranslations("pages.list")

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t("heading")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Link
          href="/admin/pages/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <PlusCircle className="size-4" />
          {t("newContent")}
        </Link>
      </div>

      <PagesListClient />
    </div>
  )
}
