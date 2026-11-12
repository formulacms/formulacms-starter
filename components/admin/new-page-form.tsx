"use client"

import { usePageAddressMessages } from "@/lib/admin/page-address-messages"

import { useState } from "react"
import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useMutation, useQuery, useConvex } from "convex/react"
import { api } from "@/convex/_generated/api"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { getContentDefault } from "@/lib/i18n/content-defaults"
import { toast } from "sonner"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import Link from "next/link"
import { FileText } from "lucide-react"
import {
  ImportMarkdownDialog,
  type MarkdownImportData,
} from "./import-markdown-dialog"
import { stashPageDraftHandoff } from "./page-editor/lib/page-draft-handoff"
import { getLocaleDisplayName, type Locale } from "@/lib/i18n/config"
import {
  adminContentTypeSingularMessageKey,
  adminContentTypes,
} from "@/lib/admin/content-types"
import { CONTENT_TYPES, type ContentType } from "@/convex/lib/contentTypes"
import { validate } from "convex-helpers/validators"
import {
  INSTALLED_SLICE_TYPES,
  installedSliceValidator,
} from "@/convex/lib/slices"
import { useArchivedContentTypes } from "./content-types/use-archived-content-types"
import {
  ADMIN_AI_WRITING_BROWSER_BINDING,
  type AdminAiWritingNewPageHostResult,
  type AdminAiWritingRouteData,
} from "./contributions/ai-writing"

function createNewPageSchema(titleRequired: string) {
  return z.object({
    title: z.string().trim().min(1, titleRequired),
  })
}

type NewPageValues = z.input<ReturnType<typeof createNewPageSchema>>

export function NewPageForm({
  aiWritingRouteData,
}: {
  aiWritingRouteData?: AdminAiWritingRouteData
}) {
  const router = useRouter()
  const displayError = useCaughtError()
  const tPages = useTranslations("pages")
  const tNew = useTranslations("pages.newForm")
  const tContentType = useTranslations("sidebar.contentType")
  const createPage = useMutation(api.cms.pages.create)
  const convex = useConvex()
  const siteConfig = useQuery(api.cms.settings.getSiteConfig)
  const owner = useQuery(api.cms.owner.getOwnerSession)
  const enabledLocales = siteConfig?.enabledLocales ?? ["en"]
  const defaultLocale = siteConfig?.defaultLocale ?? "en"
  const addressMessages = usePageAddressMessages(defaultLocale)

  const contentTypes = adminContentTypes()
  const archivedContentTypes = useArchivedContentTypes()
  const searchParams = useSearchParams()
  const requestedType = searchParams.get("type")
  const initialType: ContentType = (() => {
    if (
      requestedType &&
      (CONTENT_TYPES as readonly string[]).includes(requestedType)
    ) {
      return requestedType as ContentType
    }
    return (
      contentTypes.find((t) => t.type === "page")?.type ??
      contentTypes[0]?.type ??
      "page"
    )
  })()

  const form = useForm<NewPageValues>({
    resolver: zodResolver(
      createNewPageSchema(tNew("validation.titleRequired"))
    ),
    defaultValues: { title: "" },
  })
  // The title also feeds the starter-hero and import flows, which are buttons
  // beside the form rather than submits of it, so they need the live value.
  const title = useWatch({ control: form.control, name: "title" })
  const [preferredPageType, setPreferredPageType] =
    useState<ContentType>(initialType)
  // Null until the user picks; falls back to the site default (which may load
  // after first render), so derive the effective value rather than syncing it.
  const [picked, setPicked] = useState<Locale | null>(null)
  const locale =
    picked && enabledLocales.includes(picked) ? picked : defaultLocale
  const [isCreating, setIsCreating] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const ownerResolved = owner !== undefined && owner !== null
  const visibleContentTypes = contentTypes.filter((contentType) => {
    if (
      archivedContentTypes.status !== "ready" ||
      archivedContentTypes.archived.has(contentType.type)
    ) {
      return false
    }
    if (!ownerResolved) {
      return false
    }
    return true
  })
  const pageType =
    visibleContentTypes.find(
      (contentType) => contentType.type === preferredPageType
    )?.type ??
    visibleContentTypes[0]?.type ??
    preferredPageType
  const currentTypeEntry = visibleContentTypes.find(
    (contentType) => contentType.type === pageType
  )
  const currentTypeMessageKey = currentTypeEntry
    ? adminContentTypeSingularMessageKey(currentTypeEntry.type)
    : null
  const currentTypeLabel = currentTypeEntry
    ? currentTypeMessageKey && tContentType.has(currentTypeMessageKey)
      ? tContentType(currentTypeMessageKey)
      : currentTypeEntry.singular
    : tContentType("page.singular")
  const canCreateSelected =
    archivedContentTypes.status === "ready" &&
    !archivedContentTypes.archived.has(pageType) &&
    ownerResolved
  const canSubmit = canCreateSelected && title.trim().length > 0
  const canImportMarkdown = (
    INSTALLED_SLICE_TYPES as readonly string[]
  ).includes("rich-text-body")

  async function createShellPage() {
    if (!canSubmit) return
    return createPage({
      pageType,
      status: "draft",
      title: title.trim(),
      defaultLocale: locale,
      content: {
        [locale]: { title: title.trim(), slices: [] },
      },
    })
  }

  const handleSubmit = form.handleSubmit(async () => {
    setIsCreating(true)
    try {
      const id = await createShellPage()
      if (!id) return
      const allocation = await convex
        .query(api.cms.publication.addressAvailability, { pageId: id, locale })
        .catch(() => null)
      toast.success(
        addressMessages.allocation(
          allocation?.entries[0],
          "S2a",
          tNew("created"),
          pageType
        )
      )
      router.push(`/admin/pages/${id}`)
    } catch (err) {
      toast.error(displayError(err, tNew("createFailed")))
      setIsCreating(false)
    }
  })

  async function handleMarkdownImport(data: MarkdownImportData) {
    if (
      !(INSTALLED_SLICE_TYPES as readonly string[]).includes(
        "rich-text-body"
      ) ||
      !canCreateSelected
    ) {
      toast.error(tNew("availabilityNotConfirmed"))
      return
    }
    const importedSlice: unknown = {
      id: crypto.randomUUID(),
      type: "rich-text-body",
      enabled: true,
      primary: { body: data.body },
    }
    if (!validate(installedSliceValidator, importedSlice)) {
      toast.error(tNew("availabilityNotConfirmed"))
      return
    }
    setIsCreating(true)
    try {
      const effectiveTitle =
        data.title || title.trim() || getContentDefault(locale, "importedPage")
      const id = await createPage({
        pageType,
        status: "draft",
        title: effectiveTitle,
        defaultLocale: locale,
        content: {
          [locale]: { title: effectiveTitle, slices: [] },
        },
      })
      if (!id) {
        setIsCreating(false)
        return
      }
      stashPageDraftHandoff(id, {
        slices: [importedSlice],
      })
      toast.success(tNew("createdFromMarkdown"))
      router.push(`/admin/pages/${id}`)
    } catch (err) {
      toast.error(displayError(err, tNew("createFailed")))
      setIsCreating(false)
    }
  }

  function renderForm(participant: AdminAiWritingNewPageHostResult | null) {
    const participantBusy = participant?.busy ?? false

    return (
      <>
        <div>
          <h1 className="text-2xl font-semibold">
            {tNew("heading", { type: currentTypeLabel.toLowerCase() })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tNew("description", { type: currentTypeLabel.toLowerCase() })}
          </p>
        </div>
        <Form {...form}>
          <form
            onSubmit={handleSubmit}
            className="divide-y rounded-lg border bg-card"
            noValidate
          >
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem className="space-y-1.5 p-4">
                  <FormLabel>{tNew("titleLabel")}</FormLabel>
                  <FormControl>
                    <Input placeholder={tNew("titlePlaceholder")} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-1.5 p-4">
              <label
                htmlFor="new-page-type"
                className="block text-sm font-medium"
              >
                {tPages("contentType.label")}
              </label>
              <select
                id="new-page-type"
                value={pageType}
                onChange={(e) => {
                  setPreferredPageType(e.target.value as ContentType)
                }}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
              >
                {visibleContentTypes.map((t) => {
                  const messageKey = adminContentTypeSingularMessageKey(t.type)
                  const label =
                    messageKey && tContentType.has(messageKey)
                      ? tContentType(messageKey)
                      : t.singular
                  return (
                    <option key={t.type} value={t.type}>
                      {t.routable
                        ? label
                        : `${label} — ${tPages("contentType.noPublicUrl")}`}
                    </option>
                  )
                })}
              </select>
              {!canCreateSelected && (
                <p
                  role="alert"
                  className="text-xs text-amber-700 dark:text-amber-300"
                >
                  {archivedContentTypes.status !== "ready"
                    ? tNew("availabilityLoading")
                    : tNew("unavailable")}
                </p>
              )}
              {archivedContentTypes.status === "loading" && (
                <p role="status" className="text-xs text-muted-foreground">
                  {tNew("availabilityChecking")}
                </p>
              )}
            </div>

            <div className="space-y-1.5 p-4">
              <label
                htmlFor="new-page-locale"
                className="block text-sm font-medium"
              >
                {tNew("languageLabel")}
              </label>
              <select
                id="new-page-locale"
                value={locale}
                onChange={(e) => setPicked(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
              >
                {enabledLocales.map((code) => (
                  <option key={code} value={code}>
                    {getLocaleDisplayName(code)}
                    {code === defaultLocale ? tNew("defaultLanguage") : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {tNew("languageHelp")}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 p-4">
              <button
                type="submit"
                disabled={isCreating || participantBusy || !canSubmit}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isCreating
                  ? tNew("creating")
                  : tNew("create", {
                      type: currentTypeLabel.toLowerCase(),
                    })}
              </button>
              {pageType !== "author" && participant?.starterHeroControl}
              {pageType !== "author" && participant?.pageWizardControl}
              {pageType !== "author" && canImportMarkdown && (
                <button
                  type="button"
                  onClick={() => setImportOpen(true)}
                  disabled={isCreating || participantBusy || !canCreateSelected}
                  className="inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FileText className="size-4" />
                  {tNew("importMarkdown")}
                </button>
              )}
              <Link
                href="/admin/pages"
                className="rounded-md border px-4 py-2 text-sm transition-colors hover:bg-accent"
              >
                {tNew("cancel")}
              </Link>
            </div>
          </form>
        </Form>
        {canImportMarkdown && (
          <ImportMarkdownDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            onImport={handleMarkdownImport}
          />
        )}
      </>
    )
  }

  const NewPageSlot = ADMIN_AI_WRITING_BROWSER_BINDING?.NewPageSlot
  return NewPageSlot && aiWritingRouteData !== undefined ? (
    <NewPageSlot
      routeData={aiWritingRouteData}
      title={title}
      locale={locale}
      pageType={pageType}
      canSubmit={canSubmit}
      canCreateSelected={canCreateSelected}
      isCreating={isCreating}
      createShellPage={createShellPage}
    >
      {renderForm}
    </NewPageSlot>
  ) : (
    renderForm(null)
  )
}
