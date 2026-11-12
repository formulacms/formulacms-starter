"use client"

import { useState } from "react"
import { useMutation, useQuery, usePaginatedQuery } from "convex/react"
import { ConvexError } from "convex/values"
import { ArrowRight, ExternalLink, Loader2, Plus, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { toast } from "sonner"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"

type StatusCode = 301 | 302
type FromMode = "page" | "custom"
type ToMode = "page" | "external"

type RedirectsManagerProps = {
  onModuleDisabled: () => void
}

// Mounted only after the route's status read reports Redirects on (M01c), so
// its readers and mutations never open while the module is off.
export function RedirectsManager({ onModuleDisabled }: RedirectsManagerProps) {
  const displayError = useCaughtError()
  const t = useTranslations("inventory.redirects")
  const paginatedRedirects = usePaginatedQuery(
    api.cms.redirects.listPaginated,
    {},
    { initialNumItems: 50 }
  )
  const redirects = paginatedRedirects.results
  const siteConfig = useQuery(api.cms.settings.getSiteConfig)
  const allLocalizedUrls = useQuery(
    api.cms.pages.getAllLocalizedPageUrls,
    siteConfig ? { languageVersion: siteConfig.languageVersion } : "skip"
  )
  // The route projection below is the publication proof. Summaries provide
  // labels without reopening legacy Page publication fields after cutover.
  const pages = useQuery(api.cms.pages.listSummaries, {})

  const createRedirect = useMutation(api.cms.redirects.create)
  const removeRedirect = useMutation(api.cms.redirects.remove)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [fromMode, setFromMode] = useState<FromMode>("page")
  const [toMode, setToMode] = useState<ToMode>("page")
  const [fromPageLocaleKey, setFromPageLocaleKey] = useState<string>("")
  const [customFromPath, setCustomFromPath] = useState("")
  const [toPageId, setToPageId] = useState<string>("")
  const [externalUrl, setExternalUrl] = useState("")
  // Locale is REQUIRED — a redirect always targets one locale. `localePick` is
  // null until the user picks; the displayed/persisted value derives down to
  // the site default. Derivation avoids a useEffect+setState cascade when
  // siteConfig loads or when `enabledLocales` shifts under us.
  const [localePick, setLocalePick] = useState<string | null>(null)
  const [statusCode, setStatusCode] = useState<StatusCode>(301)
  const [isCreating, setIsCreating] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] =
    useState<Id<"redirects"> | null>(null)

  const enabledLocales = siteConfig?.enabledLocales ?? []
  const defaultLocale = siteConfig?.defaultLocale ?? "en"

  const locale =
    localePick && enabledLocales.includes(localePick)
      ? localePick
      : defaultLocale

  // From-picker options for the selected locale. `getAllLocalizedPageUrls`
  // already filters to published pages and excludes locales a page isn't
  // translated into, so this is just a per-locale slice. React Compiler caches
  // these — no useMemo needed.
  type FromOption = {
    key: string
    pageId: Id<"pages">
    locale: string
    url: string
    title: string
    pathNoLocale: string
  }
  const fromOptions: FromOption[] = []
  if (allLocalizedUrls && pages && locale) {
    const pageById = new Map(pages.map((p) => [p._id, p]))
    for (const row of allLocalizedUrls) {
      if (row.locale !== locale) continue
      const page = pageById.get(row.pageId)
      if (!page) continue
      const title =
        page.localizedTitles[locale] ??
        page.localizedTitles[defaultLocale] ??
        page.slug
      fromOptions.push({
        key: `${row.pageId}:${locale}`,
        pageId: row.pageId,
        locale,
        url: row.url,
        title,
        pathNoLocale: stripLocalePrefix(row.url, locale, defaultLocale),
      })
    }
    fromOptions.sort((a, b) => a.title.localeCompare(b.title))
  }

  // Destination: only pages translated into the selected locale (else the
  // visitor would land on a fallback URL, which is rarely the editor's intent).
  // Single-pass filter+map instead of `.filter().map().sort()`.
  type ToPageOption = { pageId: Id<"pages">; title: string; slug: string }
  const toPageOptions: ToPageOption[] = []
  if (pages && allLocalizedUrls && locale) {
    const pageById = new Map(pages.map((page) => [page._id, page]))
    for (const route of allLocalizedUrls) {
      if (route.locale !== locale) continue
      const p = pageById.get(route.pageId)
      if (!p) continue
      toPageOptions.push({
        pageId: p._id,
        title:
          p.localizedTitles[locale] ??
          p.localizedTitles[defaultLocale] ??
          p.slug,
        slug: stripLocalePrefix(route.url, locale, defaultLocale),
      })
    }
    toPageOptions.sort((a, b) => a.title.localeCompare(b.title))
  }

  const isLoading =
    paginatedRedirects.status === "LoadingFirstPage" ||
    pages === undefined ||
    siteConfig === undefined ||
    allLocalizedUrls === undefined
  const canLoadMore = paginatedRedirects.status === "CanLoadMore"
  const isLoadingMore = paginatedRedirects.status === "LoadingMore"

  function resetForm() {
    setFromMode("page")
    setToMode("page")
    setFromPageLocaleKey("")
    setCustomFromPath("")
    setToPageId("")
    setExternalUrl("")
    setLocalePick(null)
    setStatusCode(301)
  }

  async function handleCreate() {
    if (!locale) {
      toast.error(t("pickLocale"))
      return
    }

    let fromPath = ""
    if (fromMode === "page") {
      const opt = fromOptions.find((o) => o.key === fromPageLocaleKey)
      if (!opt) {
        toast.error(t("pickSourcePage"))
        return
      }
      fromPath = opt.pathNoLocale
    } else {
      fromPath = customFromPath.trim()
      if (!fromPath.startsWith("/")) {
        toast.error(t("sourceSlash"))
        return
      }
    }

    const args: {
      fromPath: string
      toPath?: string
      toPageId?: Id<"pages">
      locale: string
      statusCode: StatusCode
    } = {
      fromPath,
      locale,
      statusCode,
    }

    if (toMode === "page") {
      if (!toPageId) {
        toast.error(t("pickDestinationPage"))
        return
      }
      args.toPageId = toPageId as Id<"pages">
    } else {
      const url = externalUrl.trim()
      if (!url) {
        toast.error(t("enterDestination"))
        return
      }
      if (!/^https?:\/\//i.test(url) && !url.startsWith("/")) {
        toast.error(t("destinationInvalid"))
        return
      }
      args.toPath = url
    }

    // No try/finally: React Compiler can't lower a try-with-finalizer yet, and
    // the success/catch branches both terminate normally, so resetting the
    // creating flag once at the end is equivalent.
    setIsCreating(true)
    try {
      await createRedirect(args)
      toast.success(t("created"))
      resetForm()
      setDialogOpen(false)
    } catch (err) {
      if (isRedirectsDisabledError(err)) {
        onModuleDisabled()
      } else {
        toast.error(displayError(err, t("genericError")))
      }
    }
    setIsCreating(false)
  }

  async function handleDelete(id: Id<"redirects">, label: string) {
    if (!confirm(t("deleteConfirm", { label }))) return
    setPendingDeleteId(id)
    try {
      await removeRedirect({ id })
      toast.success(t("deleted"))
    } catch (err) {
      if (isRedirectsDisabledError(err)) {
        onModuleDisabled()
      } else {
        toast.error(displayError(err, t("genericError")))
      }
    }
    setPendingDeleteId(null)
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("subtitle")}
          </p>
        </div>
        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open)
            if (!open) resetForm()
          }}
        >
          <DialogTrigger asChild>
            <Button disabled={isLoading}>
              <Plus className="size-4" />
              {t("add")}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("add")}</DialogTitle>
              <DialogDescription>
                {t("dialogDescription")}
              </DialogDescription>
              <p className="text-xs text-muted-foreground">
                {t("activationDelay")}
              </p>
            </DialogHeader>

            <div className="space-y-5 py-1">
              {/* Locale (drives the page menus, so we put it first) */}
              <section className="space-y-2">
                <label
                  htmlFor="redirect-locale"
                  className="text-sm font-medium"
                >
                  {t("locale")}
                </label>
                <Select value={locale} onValueChange={setLocalePick}>
                  <SelectTrigger id="redirect-locale">
                    <SelectValue placeholder={t("localePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {enabledLocales.map((l) => (
                      <SelectItem key={l} value={l}>
                        {l}
                        {l === defaultLocale ? ` ${t("default")}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </section>

              {/* From (heads a Tabs group, not one control — span, not label) */}
              <section className="space-y-2">
                <span className="text-sm font-medium">{t("from")}</span>
                <Tabs
                  value={fromMode}
                  onValueChange={(v) => setFromMode(v as FromMode)}
                >
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="page">{t("existingPage")}</TabsTrigger>
                    <TabsTrigger value="custom">{t("customPath")}</TabsTrigger>
                  </TabsList>
                  <TabsContent value="page" className="mt-2">
                    <Select
                      value={fromPageLocaleKey}
                      onValueChange={setFromPageLocaleKey}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("pageUrlPlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        {fromOptions.length === 0 ? (
                          <div className="px-2 py-1.5 text-sm text-muted-foreground">
                            {t("noPublishedPages")}
                          </div>
                        ) : (
                          fromOptions.map((opt) => (
                            <SelectItem key={opt.key} value={opt.key}>
                              <span className="font-medium">{opt.title}</span>
                              <span className="ml-2 text-muted-foreground">
                                {opt.url}
                              </span>
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </TabsContent>
                  <TabsContent value="custom" className="mt-2">
                    <Input
                      value={customFromPath}
                      onChange={(e) => setCustomFromPath(e.target.value)}
                      placeholder={t("customPathPlaceholder")}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("customPathHelp")}
                    </p>
                  </TabsContent>
                </Tabs>
              </section>

              {/* To */}
              <section className="space-y-2">
                <span className="text-sm font-medium">{t("to")}</span>
                <Tabs
                  value={toMode}
                  onValueChange={(v) => setToMode(v as ToMode)}
                >
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="page">{t("existingPage")}</TabsTrigger>
                    <TabsTrigger value="external">{t("externalUrl")}</TabsTrigger>
                  </TabsList>
                  <TabsContent value="page" className="mt-2">
                    <Select value={toPageId} onValueChange={setToPageId}>
                      <SelectTrigger>
                        <SelectValue placeholder={t("destinationPlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        {toPageOptions.length === 0 ? (
                          <div className="px-2 py-1.5 text-sm text-muted-foreground">
                            {t("noPublishedPages")}
                          </div>
                        ) : (
                          toPageOptions.map((opt) => (
                            <SelectItem key={opt.pageId} value={opt.pageId}>
                              <span className="font-medium">{opt.title}</span>
                              <span className="ml-2 text-muted-foreground">
                                /{opt.slug}
                              </span>
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("pageDestinationHelp")}
                    </p>
                  </TabsContent>
                  <TabsContent value="external" className="mt-2">
                    <Input
                      value={externalUrl}
                      onChange={(e) => setExternalUrl(e.target.value)}
                      placeholder={t("externalPlaceholder")}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </TabsContent>
                </Tabs>
              </section>

              {/* Status */}
              <section className="space-y-2">
                <label
                  htmlFor="redirect-status"
                  className="text-sm font-medium"
                >
                  {t("status")}
                </label>
                <Select
                  value={String(statusCode)}
                  onValueChange={(v) => setStatusCode(Number(v) as StatusCode)}
                >
                  <SelectTrigger id="redirect-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="301">{t("permanent")}</SelectItem>
                    <SelectItem value="302">{t("temporary")}</SelectItem>
                  </SelectContent>
                </Select>
              </section>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDialogOpen(false)}
                disabled={isCreating}
              >
                {t("cancel")}
              </Button>
              <Button onClick={handleCreate} disabled={isCreating}>
                {isCreating && <Loader2 className="size-4 animate-spin" />}
                {t("create")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md border">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("loading")}
          </div>
        ) : redirects.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {t("empty")}
          </div>
        ) : (
          <ul className="divide-y">
            {redirects.map((r) => {
              const isDeleting = pendingDeleteId === r._id
              const isPageBacked = r.toPageId != null
              const isExternal =
                !isPageBacked && /^https?:\/\//i.test(r.toLabel)
              return (
                <li
                  key={r._id}
                  className="flex items-center gap-3 px-4 py-3 text-sm"
                >
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {r.fromPath}
                  </code>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 items-center gap-1.5">
                    {isPageBacked && r.toPageTitle ? (
                      <>
                        <span className="truncate font-medium">
                          {r.toPageTitle}
                        </span>
                        <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                          {r.toLabel}
                        </code>
                      </>
                    ) : (
                      <>
                        <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                          {r.toLabel}
                        </code>
                        {isExternal && (
                          <ExternalLink className="size-3 text-muted-foreground" />
                        )}
                      </>
                    )}
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    <span className="rounded border px-2 py-0.5 text-xs text-muted-foreground">
                      {r.locale ?? defaultLocale}
                    </span>
                    <span className="rounded border px-2 py-0.5 text-xs text-muted-foreground">
                      {r.statusCode}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        handleDelete(r._id, `${r.fromPath} → ${r.toLabel}`)
                      }
                      disabled={isDeleting}
                      aria-label={t("deleteLabel", { path: r.fromPath })}
                    >
                      {isDeleting ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {canLoadMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => paginatedRedirects.loadMore(50)}
            disabled={isLoadingMore}
          >
            {isLoadingMore && <Loader2 className="size-4 animate-spin" />}
            {isLoadingMore ? t("loadingMore") : t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  )
}

function stripLocalePrefix(
  url: string,
  locale: string,
  defaultLocale: string
): string {
  if (locale === defaultLocale) return url || "/"
  const prefix = `/${locale}`
  if (url === prefix) return "/"
  if (url.startsWith(`${prefix}/`)) return url.slice(prefix.length)
  return url || "/"
}


export function isRedirectsDisabledError(error: unknown): boolean {
  if (error instanceof ConvexError && error.data === "CMS_MODULE_DISABLED") {
    return true
  }
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .split(/\r?\n/)
    .some((line) => line.trim() === "Uncaught ConvexError: CMS_MODULE_DISABLED")
}
