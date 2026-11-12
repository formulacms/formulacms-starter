import { getTranslations } from "next-intl/server"
import Link from "next/link"
import Image from "next/image"
import { notFound } from "next/navigation"
import { connection } from "next/server"
import { ArrowLeft, ExternalLink, WandSparkles } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { fetchAuthQuery } from "@/lib/auth-server"
import { isLocalDevelopment } from "@/lib/assert-local-dev"
import { getSliceCatalogItem } from "@/lib/slices/catalog"
import { type SliceType } from "@/lib/slices/builder"
import { getSliceReference } from "@/lib/slices/authoring/reference"
import { getStarterShipList } from "@/lib/slices/starter-ship"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { SlicePresentationPanel } from "@/components/admin/slices/slice-presentation-panel"
import { SliceLifecyclePanel } from "@/components/admin/slices/slice-lifecycle-panel"
import { SliceWorkbenchPanel } from "@/app/(sim)/slice-sim/[type]/slice-workbench-panel"

export default async function AdminSliceDetailPage({
  params,
}: {
  params: Promise<{ type: string }>
}) {
  if (process.env.NODE_ENV === "production") notFound()

  await connection()
  const { type } = await params
  const item = getSliceCatalogItem(type)
  if (!item) notFound()

  const t = await getTranslations("slices.catalog")
  const sliceType: string = item.type
  const sampleHref = `/slice-sim/${item.type}`
  const canMutate = isLocalDevelopment()
  const lifecycleSummaryPromise = fetchAuthQuery(
    api.cms.sliceLibrary.getSliceUsageSummary,
    { type: item.type }
  ).catch(() => null)
  const sourceReferencePromise = canMutate
    ? getSliceReference(item.type)
    : Promise.resolve(null)
  const shipListPromise = canMutate
    ? getStarterShipList()
    : Promise.resolve(null)
  const [lifecycleSummary, sourceReference, shipList] = await Promise.all([
    lifecycleSummaryPromise,
    sourceReferencePromise,
    shipListPromise,
  ])
  const starterState = shipList
    ? shipList.includes(item.type)
      ? "included"
      : "not-included"
    : null

  return (
    <div className="min-w-0 space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/admin/slices">
          <ArrowLeft className="size-4" />
          {t("title")}
        </Link>
      </Button>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{item.label}</h1>
            <Badge variant="outline" className="font-mono">
              {item.type}
            </Badge>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {item.description}
          </p>
        </div>
        {sampleHref && (
          <Button asChild size="sm">
            <Link href={sampleHref} target="_blank">
              <WandSparkles className="size-4" />
              {t("openSimulator")}
              <ExternalLink className="size-4" />
            </Link>
          </Button>
        )}
      </div>

      {canMutate && (
        <section aria-label={t("editor")} className="min-w-0">
          <SliceWorkbenchPanel
            type={item.type as SliceType}
            label={item.label}
          />
        </section>
      )}

      {canMutate && sliceType === "hero-with-image" && (
        <SlicePresentationPanel key={item.type} type={item.type} />
      )}

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <div className="contents">
          <SliceLifecyclePanel
            type={item.type}
            label={item.label}
            origin={item.origin}
            summary={lifecycleSummary}
            starterState={starterState}
            canMutate={canMutate}
            canShip={shipList !== null && canMutate}
          />

          {sourceReference && (
            <Card>
              <CardHeader>
                <CardTitle>{t("reference")}</CardTitle>
                <CardDescription>{t("referenceDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="relative aspect-video overflow-hidden rounded-lg border bg-muted/30">
                  <Image
                    src={sourceReference.url}
                    alt={t("referenceAlt", { label: item.label })}
                    fill
                    sizes="(min-width: 1024px) 33vw, 100vw"
                    className="object-contain"
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* No field-model card here on purpose: the stored content shape is
              reference material for agents, which read it from the descriptor
              in convex/lib/slices, not from this page. */}
        </div>
      </div>
    </div>
  )
}
