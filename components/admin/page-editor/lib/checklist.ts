import type { PrePublishChecklistItem } from "./types"

export const CHECKLIST_FIELD_MESSAGE_KEYS = {
  name: "name",
  socials: "socials",
  authorIds: "authorIds",
  tags: "tags",
  category: "category",
  featured: "featured",
  promoteToFront: "promoteToFront",
  title: "title",
  metaTitle: "metaTitle",
  metaDescription: "metaDescription",
  roleTitle: "roleTitle",
} as const

export function checklistItemKey(item: PrePublishChecklistItem): string {
  return `${item.code}:${item.locales?.join(",") ?? ""}`
}

export function checklistItemsKey(items: PrePublishChecklistItem[]): string {
  return items.map(checklistItemKey).sort().join("|")
}

export function publishChecklistCountLabel(
  blockerCount: number,
  warningCount: number
): string {
  if (blockerCount > 0) {
    return `${blockerCount} blocker${blockerCount === 1 ? "" : "s"}`
  }
  if (warningCount > 0) {
    return `${warningCount} warning${warningCount === 1 ? "" : "s"}`
  }
  return "Ready"
}
type ChecklistMessageKey =
  keyof typeof import("@/messages/admin/en.json")["editor"]["prePublish"]["items"]
type KnownChecklistCode =
  import("@/convex/lib/publishing/checklist").PrePublishChecklistItem["code"]

// The closed server union makes every newly introduced code require a client
// translation. Unknown future codes alone use the compatibility message.
const CHECKLIST_MESSAGE_KEYS = {
  missing_default_locale_title: "missingDefaultTitle",
  missing_default_locale_content: "missingDefaultContent",
  missing_seo_title: "missingSeoTitle",
  missing_seo_description: "missingSeoDescription",
  missing_enabled_locale_translation: "missingTranslation",
  missing_required_slice_field: "missingSliceField",
  missing_required_field: "missingRequiredField",
  missing_image_alt_text: "missingImageAlt",
  broken_internal_link: "missingTarget",
  archived_relation_target: "unpublishedTarget",
} as const satisfies Record<KnownChecklistCode, ChecklistMessageKey>

export function translateChecklistItem(
  item: PrePublishChecklistItem,
  t: (key: ChecklistMessageKey, values?: Record<string, string>) => string,
  labels: {
    contentType?: (type: string) => string
    field?: (field: string) => string
  } = {}
): string {
  if (!Object.hasOwn(CHECKLIST_MESSAGE_KEYS, item.code)) return item.message
  const code = item.code as KnownChecklistCode
  let key: ChecklistMessageKey = CHECKLIST_MESSAGE_KEYS[code]
  const params = item.params
  const locale =
    item.locales?.map((value) => value.toUpperCase()).join(", ") || t("locale")
  const scope = item.locales?.length ? `${locale} ` : ""
  const contentType = params?.contentType
    ? labels.contentType?.(params.contentType) ?? params.contentType
    : t("contentType")
  const sliceType = params?.sliceType ?? t("sliceType")
  const rawField = params?.fieldName ?? item.field
  const field = rawField ? labels.field?.(rawField) ?? rawField : t("field")
  const context = params?.contentType
    ? contentType
    : params?.sliceType
      ? sliceType
      : t("content")

  switch (code) {
    case "missing_required_field":
      if (params?.variant === "body" || item.field === "body") {
        key = "missingBody"
      }
      break
    case "missing_required_slice_field":
      if (params?.variant === "image") key = "missingSliceImage"
      if (params?.variant === "relation") key = "missingSliceRelation"
      break
    case "broken_internal_link":
      if (params?.variant === "missing_link_target") key = "missingLinkTarget"
      if (params?.variant === "disallowed_type") key = "disallowedTarget"
      break
    case "archived_relation_target":
      if (params?.contentType) {
        key = params.localeSpecific
          ? "unpublishedDescriptorTargetLocales"
          : "unpublishedDescriptorTarget"
      } else if (params?.localeSpecific) key = "unpublishedTargetLocales"
      break
  }

  return t(key, {
    locale,
    scope,
    contentType,
    sliceType,
    field,
    context,
    title: params?.targetTitle ?? t("untitled"),
  })
}
