import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { useTranslations } from "next-intl"
import type { PrePublishChecklist, PrePublishChecklistItem } from "../lib/types"
import { adminContentTypeSingularMessageKey } from "@/lib/admin/content-types"
import {
  checklistItemKey,
  CHECKLIST_FIELD_MESSAGE_KEYS,
  translateChecklistItem,
} from "../lib/checklist"

export function PrePublishChecklistContent({
  checklist,
  warningsAcknowledged,
}: {
  checklist?: PrePublishChecklist
  warningsAcknowledged: boolean
}) {
  const t = useTranslations("editor.prePublish")
  const tContentType = useTranslations("sidebar.contentType")
  const tField = useTranslations("inventory.contentTypes.fieldLabels")
  const itemMessage = (item: PrePublishChecklistItem) =>
    translateChecklistItem(item, (key, values) => t(`items.${key}`, values), {
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
    })

  if (!checklist) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }

  const hasBlockers = checklist.blockers.length > 0
  const hasWarnings = checklist.warnings.length > 0

  if (!hasBlockers && !hasWarnings) {
    return (
      <div className="flex items-center gap-2 text-sm text-emerald-700">
        <CheckCircle2 className="size-4 shrink-0" />
        <span className="font-medium">{t("ready")}</span>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {hasBlockers && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-destructive uppercase">
            {t("blockers")}
          </div>
          <div className="space-y-1.5">
            {checklist.blockers.map((item) => (
              <div
                key={checklistItemKey(item)}
                className="flex gap-2 text-sm text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{itemMessage(item)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {hasWarnings && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-amber-700 uppercase">
            {t("warnings")}
          </div>
          <div className="space-y-1.5">
            {checklist.warnings.map((item) => (
              <div
                key={checklistItemKey(item)}
                className="flex gap-2 text-sm text-amber-700"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{itemMessage(item)}</span>
              </div>
            ))}
          </div>
          {warningsAcknowledged && (
            <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
              <CheckCircle2 className="size-3.5" />
              {t("acknowledged")}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
