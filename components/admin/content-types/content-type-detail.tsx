"use client"

import Link from "next/link"
import { useQuery } from "convex/react"
import { ArrowLeft } from "lucide-react"
import { useTranslations } from "next-intl"
import { api } from "@/convex/_generated/api"
import { adminContentTypeSingularMessageKey } from "@/lib/admin/content-types"
import type {
  AdminContentTypeDetail,
  AdminContentTypeField,
} from "@/lib/admin/content-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useArchivedContentTypes } from "./use-archived-content-types"
import { ContentTypeLifecyclePanel } from "./content-type-lifecycle-panel"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

function fieldLabelMessageKey(key: string) {
  switch (key) {
    case "name":
      return "fieldLabels.name" as const
    case "socials":
      return "fieldLabels.socials" as const
    case "authorIds":
      return "fieldLabels.authorIds" as const
    case "tags":
      return "fieldLabels.tags" as const
    case "category":
      return "fieldLabels.category" as const
    case "featured":
      return "fieldLabels.featured" as const
    case "promoteToFront":
      return "fieldLabels.promoteToFront" as const
    case "title":
      return "fieldLabels.title" as const
    case "metaTitle":
      return "fieldLabels.metaTitle" as const
    case "metaDescription":
      return "fieldLabels.metaDescription" as const
    case "roleTitle":
      return "fieldLabels.roleTitle" as const
    default:
      return null
  }
}

function FieldList({
  title,
  fields,
}: {
  title: string
  fields: AdminContentTypeField[]
}) {
  const t = useTranslations("inventory.contentTypes")

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noFields")}</p>
        ) : (
          <div className="divide-y rounded-md border">
            {fields.map((field) => (
              <div
                key={field.key}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {fieldLabelMessageKey(field.key)
                      ? t(fieldLabelMessageKey(field.key)!)
                      : field.label}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {field.key} · {field.kind}
                  </p>
                </div>
                <Badge
                  variant={
                    field.exposure === "Shown on the site"
                      ? "secondary"
                      : "outline"
                  }
                >
                  {field.exposure === "Shown on the site"
                    ? t("exposure.public")
                    : t("exposure.admin")}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function CapabilityList({
  capabilities,
}: {
  capabilities: AdminContentTypeDetail["capabilities"]
}) {
  const t = useTranslations("inventory.contentTypes")
  const items = [
    [t("capabilities.sliceBody"), capabilities.sliceBody],
    [t("capabilities.revisions"), capabilities.revisions],
    [t("capabilities.scheduling"), capabilities.scheduling],
    [t("capabilities.presence"), capabilities.presence],
    [t("capabilities.requiredBody"), capabilities.requiresBodyContent],
  ] as const

  return (
    <div className="flex flex-wrap gap-2">
      {items.map(([label, enabled]) => (
        <Badge key={label} variant={enabled ? "secondary" : "outline"}>
          {label}: {enabled ? t("status.yes") : t("status.no")}
        </Badge>
      ))}
    </div>
  )
}

export function ContentTypeDetail({
  detail,
  starter,
}: {
  detail: AdminContentTypeDetail
  starter: { included: boolean } | null
}) {
  const t = useTranslations("inventory.contentTypes")
  const tContentType = useTranslations("sidebar.contentType")
  const usage = useQuery(api.cms.contentTypes.getContentTypeUsage, {})
  const archivedContentTypes = useArchivedContentTypes()
  const archived =
    archivedContentTypes.status === "ready"
      ? archivedContentTypes.archived.has(detail.type)
      : null
  const usageItem = usage?.find((item) => item.type === detail.type)
  const singularKey = adminContentTypeSingularMessageKey(detail.type)
  const singularLabel = singularKey
    ? tContentType(singularKey)
    : detail.singular
  const usageText =
    usage === undefined
      ? t("loadingUsage")
      : usageItem?.capped
        ? t("usageCapped")
        : t("usageCount", { count: usageItem?.count ?? 0 })

  return (
    <div className="max-w-4xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/admin/content-types">
          <ArrowLeft className="size-4" />
          {t("title")}
        </Link>
      </Button>

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{singularLabel}</h1>
          <Badge variant="outline" className="font-mono">
            {detail.type}
          </Badge>
          <Badge variant={archived ? "secondary" : "default"}>
            {archived === null
              ? t("status.lifecycleLoading")
              : archived
                ? t("archived")
                : t("active")}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {detail.routable
            ? t("routableAt", {
                prefix: detail.pathPrefix || "",
                slug: "<slug>",
              })
            : t("nonRoutableDescription")}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("usage")}</CardTitle>
          <CardDescription>
            {t("usageDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{usageText}</p>
        </CardContent>
      </Card>

      <ContentTypeLifecyclePanel
        type={detail.type}
        label={singularLabel}
        archived={archived}
        starter={starter}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("capabilitiesHeading")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CapabilityList capabilities={detail.capabilities} />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <FieldList title={t("sharedFields")} fields={detail.sharedFields} />
        <FieldList title={t("localizedFields")} fields={detail.localizedFields} />
      </div>
    </div>
  )
}
