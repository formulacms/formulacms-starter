"use client"

import { usePageAddressMessages } from "@/lib/admin/page-address-messages"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useConvex, useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type {
  AdminPageLocale,
  SnapshotAdminPageRow,
} from "@/convex/cms/publication"
import { revalidatePagePaths } from "@/app/(core)/admin/(authenticated)/pages/actions"
import { useConfirm } from "@/components/providers/confirm-provider"
import {
  confirmCurrentPrePublishReadiness,
  usePrePublishReadinessCopy,
} from "@/components/admin/page-editor/lib/pre-publish-readiness"
import {
  sourcePublicationWarning,
  type SourcePublicationNotice,
} from "@/components/admin/page-editor/language-notice"
import { pageSaveErrorMessage } from "@/components/admin/page-editor/hooks/use-page-save"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { rowErrorKind } from "./pages-list-errors"

/** The tokens a Publish needs, captured when the row action is chosen. */
export type PublishTarget = {
  pageId: Id<"pages">
  locale: string
  pageType?: string
  expectedDraftGeneration: number
  expectedSharedDraftGeneration: number
  expectedPublicGeneration: number
  expectedLifecycleGeneration: number
  expectedReleaseGeneration: number
}

/** The tokens an Unpublish needs, captured when the row action is chosen. */
export type UnpublishTarget = {
  pageId: Id<"pages">
  locale: string
  expectedSnapshotId: Id<"pagePublishedSnapshots">
  expectedPublicGeneration: number
  expectedLifecycleGeneration: number
}

type RowPage = Pick<
  SnapshotAdminPageRow,
  "_id" | "lifecycleGeneration" | "sharedDraftGeneration"
> & { pageType?: string }

export function publishTargetFor(
  page: RowPage,
  entry: AdminPageLocale
): PublishTarget {
  return {
    pageId: page._id,
    ...(page.pageType ? { pageType: page.pageType } : {}),
    locale: entry.locale,
    expectedDraftGeneration: entry.draftGeneration,
    expectedSharedDraftGeneration: page.sharedDraftGeneration,
    expectedPublicGeneration: entry.publicGeneration,
    expectedLifecycleGeneration: page.lifecycleGeneration,
    expectedReleaseGeneration: entry.releaseGeneration,
  }
}

export function unpublishTargetFor(
  page: RowPage,
  entry: AdminPageLocale
): UnpublishTarget | null {
  if (!entry.currentSnapshotId) return null
  return {
    pageId: page._id,
    locale: entry.locale,
    expectedSnapshotId: entry.currentSnapshotId,
    expectedPublicGeneration: entry.publicGeneration,
    expectedLifecycleGeneration: page.lifecycleGeneration,
  }
}

export function rowActionKey(pageId: string, locale: string): string {
  return `${pageId}:${locale}`
}

/**
 * Per-language Publish and Unpublish for a Pages list row (snapshot sites).
 * Every call carries the exact token tuple captured when the action was
 * chosen; a stale refusal is reported, never retried, and no generation is
 * guessed locally (the reactive list brings the new values).
 */
export function usePageRowActions() {
  const router = useRouter()
  const convex = useConvex()
  const confirm = useConfirm()
  const t = useTranslations("pages.list")
  const tSave = useTranslations("editor.pageSave")
  const displayError = useCaughtError()
  const config = useQuery(api.cms.settings.getSiteConfig)
  const addressMessages = usePageAddressMessages(config?.defaultLocale ?? "en")
  const readiness = usePrePublishReadinessCopy()
  const publishLocale = useMutation(api.cms.publication.publishLocale)
  const withdrawLocale = useMutation(api.cms.publication.withdrawLocale)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const pendingRef = useRef(new Set<string>())
  const [acknowledged, setAcknowledged] = useState<Record<string, string>>({})

  function begin(key: string): boolean {
    if (pendingRef.current.has(key)) return false
    pendingRef.current.add(key)
    setPending(new Set(pendingRef.current))
    return true
  }
  function end(key: string) {
    pendingRef.current.delete(key)
    setPending(new Set(pendingRef.current))
  }

  function failureMessage(
    error: unknown,
    fallback: string,
    pageType?: string
  ): string {
    const address = addressMessages.publish(error, fallback, pageType)
    if (address !== fallback) return address
    switch (rowErrorKind(error)) {
      case "stale":
        return tSave("changedElsewhere")
      case "ancestryInUse":
        return t("toast.ancestryInUse")
      case "homeMustBeRoot":
        return t("toast.homeMustBeRoot")
      case "releaseReplacement":
        return t("toast.releaseReplacement")
      default:
        // Anything else is worded as the editor words it (linked pages that
        // are not published in this language, and so on).
        return pageSaveErrorMessage(error, displayError(error, fallback), {
          PUBLICATION_REFERENCE_TARGET_LOCALE_UNAVAILABLE: tSave(
            "publication.targetLocaleUnavailable"
          ),
          PUBLICATION_REFERENCE_TARGET_MISSING: tSave(
            "publication.targetMissing"
          ),
          PUBLICATION_REFERENCE_LIMIT: tSave("publication.referenceLimit"),
          SLUG_REQUIRED: tSave("slugRequired"),
          PAGE_HOME_LIFECYCLE_REFUSED: tSave("homeArchiveRefused"),
        })
    }
  }

  function openEditor(pageId: string, locale: string) {
    router.push(`/admin/pages/${pageId}?locale=${locale}`)
  }

  async function ready(target: PublishTarget): Promise<boolean> {
    const key = rowActionKey(target.pageId, target.locale)
    let notice: SourcePublicationNotice
    try {
      notice = await convex.query(api.cms.language.getSourcePublicationNotice, {
        pageId: target.pageId,
      })
    } catch {
      // Fail closed: without the notice the language-change warning is unknown.
      toast.error(readiness.copy.loadFailed)
      return false
    }
    return confirmCurrentPrePublishReadiness({
      convex,
      pageId: target.pageId,
      locale: target.locale,
      languageWarning: sourcePublicationWarning(
        notice,
        readiness.languageChange
      ),
      confirm,
      acknowledgedWarningKey: acknowledged[key] ?? null,
      acknowledgeWarnings: (warningKey) =>
        setAcknowledged((current) => ({ ...current, [key]: warningKey })),
      itemMessage: readiness.itemMessage,
      copy: readiness.copy,
      onBlockers: (count) =>
        toast.error(readiness.copy.resolveBlockers(count), {
          action: {
            label: t("toast.openEditor"),
            onClick: () => openEditor(target.pageId, target.locale),
          },
        }),
    })
  }

  async function publish(target: PublishTarget) {
    const key = rowActionKey(target.pageId, target.locale)
    if (!begin(key)) return
    try {
      if (await ready(target)) {
        await publishLocale({
          pageId: target.pageId,
          locale: target.locale,
          expectedDraftGeneration: target.expectedDraftGeneration,
          expectedSharedDraftGeneration: target.expectedSharedDraftGeneration,
          expectedPublicGeneration: target.expectedPublicGeneration,
          expectedLifecycleGeneration: target.expectedLifecycleGeneration,
          expectedReleaseGeneration: target.expectedReleaseGeneration,
        })
        await revalidatePagePaths(target.pageId).catch(() => undefined)
        toast.success(
          t("toast.published", { locale: target.locale.toUpperCase() })
        )
        router.refresh()
      }
    } catch (error) {
      toast.error(
        failureMessage(error, t("toast.publishFailed"), target.pageType)
      )
    }
    end(key)
  }

  async function unpublish(target: UnpublishTarget) {
    const key = rowActionKey(target.pageId, target.locale)
    if (!begin(key)) return
    try {
      await withdrawLocale({
        pageId: target.pageId,
        locale: target.locale,
        expectedSnapshotId: target.expectedSnapshotId,
        expectedPublicGeneration: target.expectedPublicGeneration,
        expectedLifecycleGeneration: target.expectedLifecycleGeneration,
      })
      await revalidatePagePaths(target.pageId).catch(() => undefined)
      toast.success(
        t("toast.unpublished", { locale: target.locale.toUpperCase() })
      )
      router.refresh()
    } catch (error) {
      toast.error(failureMessage(error, t("toast.unpublishFailed")))
    }
    end(key)
  }

  return { pending, publish, unpublish, openEditor }
}
