import { connection } from "next/server";
import { api } from "@/convex/_generated/api";
import { fetchAuthQuery } from "@/lib/auth-server";
import Link from "next/link";
import { FileText, Image, PlusCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatLocalDate } from "@/lib/i18n/local-date-format";
import { getFormatter, getTranslations } from "next-intl/server";

const DASHBOARD_QUERY_TIMEOUT_MS = 1_500;

async function withDashboardFallback<T>(
  promise: Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        setTimeout(() => resolve(fallback), DASHBOARD_QUERY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return fallback;
  }
}

export default async function AdminDashboardPage() {
  await connection();

  const [pages, media, t, format, tType, tStatus] = await Promise.all([
    // `listSummaries`, not `list`: the dashboard needs a count plus ten titles,
    // and `list` ships full page documents (every slice body, every locale) to
    // do it. Same rows, a fraction of the payload.
    withDashboardFallback(fetchAuthQuery(api.cms.pages.listSummaries, {}), []),
    withDashboardFallback(fetchAuthQuery(api.cms.media.list, { limit: 1000 }), []),
    getTranslations("dashboard"),
    getFormatter(),
    getTranslations("sidebar.contentType"),
    getTranslations("pages.list.status"),
  ]);

  const recentPages = pages
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10);

  const stats = [
    { label: t("stats.pages"), count: pages.length, icon: FileText, href: "/admin/pages" },
    { label: t("stats.mediaFiles"), count: media.length, icon: Image, href: "/admin/media" },
  ];

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t("subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {stats.map((stat) => (
          <Link key={stat.label} href={stat.href}>
            <Card className="hover:bg-accent/30 transition-colors">
              <CardContent className="flex items-center gap-4 pt-6">
                <div className="p-2.5 rounded-lg bg-primary/10">
                  <stat.icon className="size-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{format.number(stat.count)}</p>
                  <p className="text-sm text-muted-foreground">{stat.label}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base font-medium">{t("quickActions")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link
            href="/admin/pages/new"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <PlusCircle className="size-4" />
            {t("actions.newPage")}
          </Link>
          <Link
            href="/admin/media"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium hover:bg-accent transition-colors"
          >
            {t("actions.uploadMedia")}
          </Link>
          <Link
            href="/admin/settings"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium hover:bg-accent transition-colors"
          >
            {t("actions.settings")}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base font-medium">{t("recentlyUpdated")}</CardTitle>
          {recentPages.length > 0 && (
            <Link href="/admin/pages" className="text-xs text-muted-foreground hover:text-foreground">
              {t("viewAll")}
            </Link>
          )}
        </CardHeader>
        <CardContent>
          {recentPages.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t("noPages")}{" "}
              <Link href="/admin/pages/new" className="underline">
                {t("createFirstPage")}
              </Link>
            </p>
          ) : (
            <div className="divide-y">
              {recentPages.map((page) => {
                // Was hardcoded to en/fr/ar, so a page authored only in any
                // other enabled locale rendered as "Untitled". `localizedTitles`
                // is locale-agnostic — take the first non-empty title.
                const title =
                  Object.values(page.localizedTitles).find((value) =>
                    value?.trim(),
                  ) || t("untitled");
                const contentTypeKey =
                  page.pageType === "page" ? "page.singular" :
                  page.pageType === "landing-page" ? "landing-page.singular" :
                  page.pageType === "post" ? "post.singular" :
                  page.pageType === "author" ? "author.singular" : null;
                return (
                  <div key={page._id} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Link
                        href={`/admin/pages/${page._id}`}
                        className="text-sm font-medium truncate hover:underline"
                      >
                        {title}
                      </Link>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {contentTypeKey !== null && tType.has(contentTypeKey) ? tType(contentTypeKey) : page.pageType}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-4">
                      <Badge
                        variant={page.status === "published" ? "default" : "secondary"}
                        className="text-xs"
                      >
                        {tStatus.has(page.status) ? tStatus(page.status) : page.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground hidden sm:block">
                        {formatLocalDate(format, page.updatedAt)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
