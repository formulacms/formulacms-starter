"use client"

import { Component, type ReactNode } from "react"
import Link from "next/link"
import { useQuery } from "convex/react"
import { useTranslations } from "next-intl"
import { api } from "@/convex/_generated/api"
import {
  adminContentTypes,
  adminContentTypeDetail,
} from "@/lib/admin/content-types"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useArchivedContentTypes } from "./use-archived-content-types"

function contentTypePluralMessageKey(type: string) {
  switch (type) {
    case "author":
      return "author.plural" as const
    case "landing-page":
      return "landing-page.plural" as const
    case "page":
      return "page.plural" as const
    case "post":
      return "post.plural" as const
    default:
      return null
  }
}

function CapabilityChips({
  capabilities,
}: {
  capabilities: {
    sliceBody: boolean
    revisions: boolean
    scheduling: boolean
    presence: boolean
    requiresBodyContent: boolean
  }
}) {
  const t = useTranslations("inventory.contentTypes")
  const enabled = [
    capabilities.sliceBody ? t("capabilities.sliceBody") : null,
    capabilities.revisions ? t("capabilities.revisions") : null,
    capabilities.scheduling ? t("capabilities.scheduling") : null,
    capabilities.presence ? t("capabilities.presence") : null,
    capabilities.requiresBodyContent ? t("capabilities.requiredBody") : null,
  ].filter((value): value is string => value !== null)

  return (
    <div className="flex flex-wrap gap-1.5">
      {enabled.length > 0 ? (
        enabled.map((value) => (
          <Badge key={value} variant="secondary" className="text-xs">
            {value}
          </Badge>
        ))
      ) : (
        <Badge variant="outline" className="text-xs">
          {t("referenceOnly")}
        </Badge>
      )}
    </div>
  )
}

function ContentTypeCatalogUnavailable() {
  const t = useTranslations("inventory.contentTypes")

  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm"
    >
      <p className="font-medium">{t("unavailableTitle")}</p>
      <p className="mt-1 text-muted-foreground">
        {t("unavailableDescription")}
      </p>
    </div>
  )
}

class ContentTypeCatalogErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    return this.state.hasError ? (
      <ContentTypeCatalogUnavailable />
    ) : (
      this.props.children
    )
  }
}

function ContentTypeCatalogContent({
  starterContentTypes,
}: {
  starterContentTypes: ReadonlySet<string> | null
}) {
  const t = useTranslations("inventory.contentTypes")
  const tContentType = useTranslations("sidebar.contentType")
  const usage = useQuery(api.cms.contentTypes.getContentTypeUsage, {})
  const archivedContentTypes = useArchivedContentTypes()
  const usageByType = new Map((usage ?? []).map((item) => [item.type, item]))

  if (usage === undefined || archivedContentTypes.status === "loading") {
    return (
      <div className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
        {t("loading")}
      </div>
    )
  }

  const archivedTypes = archivedContentTypes.archived
  const activeSummaries = adminContentTypes().filter(
    (summary) => !archivedTypes.has(summary.type)
  )
  const archivedSummaries = adminContentTypes().filter((summary) =>
    archivedTypes.has(summary.type)
  )

  function renderCards(summaries: ReturnType<typeof adminContentTypes>) {
    return summaries.length > 0 ? (
      <div className="grid gap-4 md:grid-cols-2">
        {summaries.map((summary) => {
          const detail = adminContentTypeDetail(summary.type)
          if (!detail) return null
          const pluralKey = contentTypePluralMessageKey(detail.type)
          const pluralLabel = pluralKey
            ? tContentType(pluralKey)
            : detail.plural
          const itemUsage = usageByType.get(detail.type)
          const usageText = !itemUsage
            ? t("usageUnavailable")
            : itemUsage.capped
              ? t("usageCapped")
              : t("usageCount", { count: itemUsage.count })
          return (
            <Link
              key={detail.type}
              href={`/admin/content-types/${detail.type}`}
            >
              <Card className="h-full transition-colors hover:border-foreground/30">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle>{pluralLabel}</CardTitle>
                      <CardDescription className="mt-1 font-mono text-xs">
                        {detail.type}
                      </CardDescription>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Badge
                        variant={detail.routable ? "secondary" : "outline"}
                      >
                        {detail.routable
                          ? `/${detail.pathPrefix || "root"}`
                          : t("nonRoutable")}
                      </Badge>
                      {archivedTypes.has(detail.type) && (
                        <Badge variant="secondary">{t("archived")}</Badge>
                      )}
                      {starterContentTypes?.has(detail.type) && (
                        <Badge variant="outline">{t("inStarter")}</Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <CapabilityChips capabilities={detail.capabilities} />
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {t("fieldCount", { count: detail.fieldCount })}
                    </span>
                    <span>{usageText}</span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>
    ) : (
      <p className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
        {t("empty")}
      </p>
    )
  }

  return (
    <Tabs defaultValue="active" className="space-y-4">
      <TabsList>
        <TabsTrigger value="active">
          {t("active")}
          <Badge
            variant="secondary"
            className="ml-1.5 rounded-full tabular-nums"
          >
            {activeSummaries.length}
          </Badge>
        </TabsTrigger>
        <TabsTrigger value="archived">
          {t("archived")}
          <Badge
            variant="secondary"
            className="ml-1.5 rounded-full tabular-nums"
          >
            {archivedSummaries.length}
          </Badge>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="active">{renderCards(activeSummaries)}</TabsContent>
      <TabsContent value="archived">
        {renderCards(archivedSummaries)}
      </TabsContent>
    </Tabs>
  )
}

export function ContentTypeCatalog({
  starterContentTypes = null,
}: {
  starterContentTypes?: ReadonlySet<string> | null
}) {
  return (
    <ContentTypeCatalogErrorBoundary>
      <ContentTypeCatalogContent starterContentTypes={starterContentTypes} />
    </ContentTypeCatalogErrorBoundary>
  )
}
