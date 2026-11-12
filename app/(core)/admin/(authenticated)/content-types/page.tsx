import { connection } from "next/server"
import { notFound } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { api } from "@/convex/_generated/api"
import { fetchAuthQuery } from "@/lib/auth-server"
import { ContentTypeCatalog } from "@/components/admin/content-types/content-type-catalog"
import { getStarterCurationState } from "@/lib/content-types/starter-curation"

export default async function ContentTypesPage() {
  await connection()
  const [owner, t] = await Promise.all([
    fetchAuthQuery(api.cms.owner.getOwnerSession, {}),
    getTranslations("inventory.contentTypes"),
  ])
  if (!owner) notFound()

  const starterState =
    owner.role === "admin" ? await getStarterCurationState() : null
  const starterContentTypes =
    starterState?.available === true ? new Set(starterState.contentTypes) : null

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("subtitle")}
        </p>
      </div>
      <ContentTypeCatalog starterContentTypes={starterContentTypes} />
    </div>
  )
}
