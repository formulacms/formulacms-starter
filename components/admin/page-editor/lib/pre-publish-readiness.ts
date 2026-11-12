"use client"

import type { useConvex } from "convex/react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { useConfirm } from "@/components/providers/confirm-provider"
import { adminContentTypeSingularMessageKey } from "@/lib/admin/content-types"
import {
  CHECKLIST_FIELD_MESSAGE_KEYS,
  checklistItemsKey,
  translateChecklistItem,
} from "./checklist"
import type { PrePublishChecklist } from "./types"
import type {
  LanguageChangeTranslator,
  sourcePublicationWarning,
} from "../language-notice"

export type PrePublishReadinessCopy = {
  loadFailed: string
  resolveBlockers(count: number): string
  reviewFirst: string
  warningsTitle: string
  publishAnyway: string
}

/**
 * The editor's readiness flow, shared with the Pages list row so a row Publish
 * cannot be weaker than the editor's: re-query the checklist right now, fail
 * closed when it cannot be read, stop on blockers, ask about the language-change
 * warning, then ask about checklist warnings (once per identical set).
 *
 * This is client parity, not server enforcement: the server does not run the
 * checklist on publish yet.
 */
export async function confirmCurrentPrePublishReadiness({
  convex,
  pageId,
  locale,
  languageWarning,
  confirm,
  acknowledgedWarningKey,
  acknowledgeWarnings,
  itemMessage,
  copy,
  onBlockers,
}: {
  convex: ReturnType<typeof useConvex>
  pageId: Id<"pages">
  locale: string
  languageWarning: ReturnType<typeof sourcePublicationWarning>
  confirm: ReturnType<typeof useConfirm>
  acknowledgedWarningKey: string | null
  acknowledgeWarnings(key: string): void
  itemMessage(item: PrePublishChecklist["warnings"][number]): string
  copy: PrePublishReadinessCopy
  /** Replaces the default blocker toast (the Pages list adds an action). */
  onBlockers?(count: number): void
}): Promise<boolean> {
  // `publish()` saves first. Read again after that mutation instead of
  // trusting the subscription value captured before the save, so a newly
  // selected relation cannot slip past the client-side readiness gate.
  const latestChecklist = await convex
    .query(api.cms.pages.getPrePublishChecklist, { pageId, locale })
    .then((checklist) => checklist as PrePublishChecklist)
    .catch(() => null)
  if (!latestChecklist) {
    toast.error(copy.loadFailed)
    return false
  }

  if (latestChecklist.blockers.length > 0) {
    if (onBlockers) onBlockers(latestChecklist.blockers.length)
    else toast.error(copy.resolveBlockers(latestChecklist.blockers.length))
    return false
  }

  if (
    languageWarning &&
    !(await confirm({ ...languageWarning, cancelText: copy.reviewFirst }))
  ) {
    return false
  }

  if (latestChecklist.warnings.length === 0) return true
  const latestWarningKey = checklistItemsKey(latestChecklist.warnings)
  if (acknowledgedWarningKey === latestWarningKey) return true

  const ok = await confirm({
    title: copy.warningsTitle,
    description: latestChecklist.warnings.map(itemMessage).join("\n"),
    confirmText: copy.publishAnyway,
    cancelText: copy.reviewFirst,
  })
  if (ok) acknowledgeWarnings(latestWarningKey)
  return ok
}

/** The translated pieces both callers hand to `confirmCurrentPrePublishReadiness`. */
export function usePrePublishReadinessCopy(): {
  itemMessage(item: PrePublishChecklist["warnings"][number]): string
  copy: PrePublishReadinessCopy
  languageChange: LanguageChangeTranslator
} {
  const t = useTranslations("editor.page")
  const tLanguageChange = useTranslations("editor.page.languageChange")
  const tChecklist = useTranslations("editor.prePublish")
  const tContentType = useTranslations("sidebar.contentType")
  const tField = useTranslations("inventory.contentTypes.fieldLabels")
  return {
    languageChange: tLanguageChange,
    itemMessage: (item) =>
      translateChecklistItem(
        item,
        (key, values) => tChecklist(`items.${key}`, values),
        {
          contentType: (type) => {
            const key = adminContentTypeSingularMessageKey(type)
            return key ? tContentType(key) : type
          },
          field: (field) => {
            const root = field.match(/^[^.\[]+/)?.[0]
            return root && Object.hasOwn(CHECKLIST_FIELD_MESSAGE_KEYS, root)
              ? tField(
                  CHECKLIST_FIELD_MESSAGE_KEYS[
                    root as keyof typeof CHECKLIST_FIELD_MESSAGE_KEYS
                  ]
                ) + field.slice(root.length)
              : field
          },
        }
      ),
    copy: {
      loadFailed: t("prePublish.loadFailed"),
      resolveBlockers: (count) => t("prePublish.resolveBlockers", { count }),
      reviewFirst: t("prePublish.reviewFirst"),
      warningsTitle: t("prePublish.warningsTitle"),
      publishAnyway: t("prePublish.publishAnyway"),
    },
  }
}
