"use client"

import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import Link from "next/link"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Menu as MenuIcon, ArrowRight } from "lucide-react"
import { useTranslations } from "next-intl"

function MenuCard({ slug }: { slug: "primary" | "footer" }) {
  const t = useTranslations("menus.list")
  const menu = useQuery(api.cms.menus.getCanonical, { slug })
  return (
    <Link href={`/admin/menus/${slug}`}>
      <Card className="h-full cursor-pointer transition-colors hover:border-primary">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MenuIcon className="size-5" />
            {t(`defaults.${slug}.name`)}
          </CardTitle>
          <CardDescription>{t(`defaults.${slug}.description`)}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {menu === undefined
                ? t("loadingAccess")
                : menu?.nav.length
                  ? t("configured")
                  : t("notConfigured")}
            </span>
            <ArrowRight className="size-4 text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

export default function MenusPage() {
  const t = useTranslations("menus.list")
  const owner = useQuery(api.cms.owner.getOwnerSession)
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      {owner === undefined ? (
        <p className="text-sm text-muted-foreground">{t("loadingAccess")}</p>
      ) : !owner ? (
        <p className="text-sm text-muted-foreground">{t("noAccess")}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <MenuCard slug="primary" />
          <MenuCard slug="footer" />
        </div>
      )}
    </div>
  )
}
