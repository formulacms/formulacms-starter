import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { getTranslations } from "next-intl/server"
import { ADMIN_AI_SETTINGS_SERVER_BINDING } from "@/components/admin/contributions/ai-settings.server"
import { CreateBlockBrief } from "@/components/admin/blocks/create-block-brief"
import { Button } from "@/components/ui/button"
import { getBlockCatalog } from "@/lib/blocks/catalog"
import { resolveBlockVerificationScenario } from "@/lib/blocks/verification"
import { CreateBlockRoute } from "./create-block-route"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("blocks.create")
  return {
    title: t("metadata.title"),
    description: t("metadata.description"),
  }
}

export default async function AdminCreateBlockPage({
  searchParams,
}: {
  searchParams?: Promise<{ verify?: string | string[] }>
}) {
  if (process.env.NODE_ENV === "production") notFound()

  const catalog = getBlockCatalog()
  const verificationScenario = resolveBlockVerificationScenario(
    (await searchParams)?.verify
  )
  // The AI settings binding owns the readiness read (shared with the Blocks
  // list); any failed read means "not ready" and the page never errors.
  const devAiReady =
    verificationScenario !== null ||
    ((await ADMIN_AI_SETTINGS_SERVER_BINDING?.resolveBlockCreatorReady()) ??
      false)
  const t = await getTranslations("blocks.create")

  return (
    <CreateBlockRoute>
      <div className="max-w-6xl space-y-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/admin/blocks">
            <ArrowLeft className="size-4" />
            {t("page.back")}
          </Link>
        </Button>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{t("page.title")}</h1>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t("page.description")}
          </p>
        </div>

        <CreateBlockBrief
          catalog={catalog}
          devAiReady={devAiReady}
          verificationScenario={verificationScenario ?? undefined}
        />
      </div>
    </CreateBlockRoute>
  )
}
