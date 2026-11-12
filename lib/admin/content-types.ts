import {
  contentTypeDefs,
  CONTENT_TYPES,
  type ContentType,
  type DescriptorFieldMap,
} from "@/convex/lib/contentTypes"

/**
 * Admin-surface facade over the content-type descriptor registry (plan 028 C4).
 *
 * Every registry-driven admin surface — the New-Page dialog, pages-list filter
 * chips, content-type catalog, and command palette "New <type>" entries —
 * reads from this module so a new descriptor lights up all of them at once.
 *
 * Labels come from `descriptor.label` (English source strings per ADR-0037);
 * the sidebar translates them via the next-intl dictionary at consumption time
 * using the `contentType.<slug>.{singular,plural}` key convention below.
 */

export type AdminContentType = {
  type: ContentType
  singular: string
  plural: string
  routable: boolean
  /** Slug the sidebar/command-palette pass to next-intl for translation. */
  dictionaryKey: string
}

export type AdminContentTypeField = {
  key: string
  label: string
  kind: string
  exposure: "Shown on the site" | "Admin only"
}

export type AdminContentTypeDetail = AdminContentType & {
  pathPrefix: string | null
  capabilities: {
    sliceBody: boolean
    revisions: boolean
    scheduling: boolean
    presence: boolean
    requiresBodyContent: boolean
  }
  sharedFields: AdminContentTypeField[]
  localizedFields: AdminContentTypeField[]
  fieldCount: number
}

type AdminMessages = typeof import("../../messages/admin/en.json")
type AdminContentTypeDictionaryKey = Extract<
  keyof AdminMessages["sidebar"]["contentType"],
  string
>
type AdminContentTypeSingularMessageKey =
  `${AdminContentTypeDictionaryKey}.singular`

const ADMIN_CONTENT_TYPE_SINGULAR_MESSAGE_KEYS = {
  author: "author.singular",
  "landing-page": "landing-page.singular",
  page: "page.singular",
  post: "post.singular",
} as const satisfies Record<
  AdminContentTypeDictionaryKey,
  AdminContentTypeSingularMessageKey
>

/** Return a typed next-intl key only when that content type has reviewed copy. */
export function adminContentTypeSingularMessageKey(
  type: string
): AdminContentTypeSingularMessageKey | null {
  switch (type) {
    case "author":
      return ADMIN_CONTENT_TYPE_SINGULAR_MESSAGE_KEYS.author
    case "landing-page":
      return ADMIN_CONTENT_TYPE_SINGULAR_MESSAGE_KEYS["landing-page"]
    case "page":
      return ADMIN_CONTENT_TYPE_SINGULAR_MESSAGE_KEYS.page
    case "post":
      return ADMIN_CONTENT_TYPE_SINGULAR_MESSAGE_KEYS.post
    default:
      return null
  }
}

export type MenuContentTypeOptionKey =
  | "contentTypeOptions.author"
  | "contentTypeOptions.job"
  | "contentTypeOptions.landingPage"
  | "contentTypeOptions.page"
  | "contentTypeOptions.post"
  | "contentTypeOptions.testimonial"

function menuContentTypeOptionKey(
  type: string
): MenuContentTypeOptionKey | null {
  switch (type) {
    case "author":
      return "contentTypeOptions.author"
    case "job":
      return "contentTypeOptions.job"
    case "landing-page":
      return "contentTypeOptions.landingPage"
    case "page":
      return "contentTypeOptions.page"
    case "post":
      return "contentTypeOptions.post"
    case "testimonial":
      return "contentTypeOptions.testimonial"
    default:
      return null
  }
}

/**
 * Label for the Menus editor's content-type select. Shipped types keep their
 * reviewed `menus.items.contentTypeOptions.*` copy; an owner-written type
 * shows its descriptor's plural label, or its singular label when that is empty.
 */
export function menuContentTypeOptionLabel(
  contentType: { type: string; singular: string; plural: string },
  translate: (key: MenuContentTypeOptionKey) => string
): string {
  const key = menuContentTypeOptionKey(contentType.type)
  return key ? translate(key) : contentType.plural || contentType.singular
}

const summaries: readonly AdminContentType[] = CONTENT_TYPES.map((type) => {
  const def = contentTypeDefs[type]
  return {
    type,
    singular: def.label.singular,
    plural: def.label.plural,
    routable: def.routing !== undefined,
    dictionaryKey: type,
  }
})

export function adminContentTypes(): readonly AdminContentType[] {
  return summaries
}

export function adminContentTypeLabel(type: ContentType): {
  singular: string
  plural: string
} {
  const def = contentTypeDefs[type]
  return { singular: def.label.singular, plural: def.label.plural }
}

/**
 * Descriptor field-map accessors for the C8 generic Content panel. Both
 * accessors return the raw `Primitive` maps declared on the descriptor —
 * `Primitive` is a pure-TS shape (no Convex runtime), so importing them
 * client-side is safe. The generic panel walks these via `FieldsEditor`.
 *
 * Callers apply {@link isSystemOwnedSharedField} /
 * {@link isSystemOwnedLocalizedField} to filter out fields a system panel
 * already owns; this facade does not filter — the descriptor stays the
 * source of truth about what fields exist, the ownership map controls
 * where they render.
 */
export function adminContentTypeSharedFields(
  type: ContentType
): DescriptorFieldMap {
  return contentTypeDefs[type].sharedFields
}

export function adminContentTypeLocalizedFields(
  type: ContentType
): DescriptorFieldMap {
  return contentTypeDefs[type].localizedFields
}

export function adminContentTypeCapabilities(type: ContentType): {
  sliceBody: boolean
} {
  const { sliceBody } = contentTypeDefs[type].capabilities
  return { sliceBody }
}

function fieldLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function projectFields(fields: DescriptorFieldMap): AdminContentTypeField[] {
  return Object.entries(fields).map(([key, field]) => ({
    key,
    label: fieldLabel(key),
    kind: field.kind,
    exposure: field.config.public === true ? "Shown on the site" : "Admin only",
  }))
}

/**
 * Client-safe detail projection for the active Content Types catalog.
 * Validators, primitive functions, and nested descriptor implementation
 * details stay on the server-side registry; the admin receives only the
 * editorial metadata it needs to render the catalog.
 */
export function adminContentTypeDetail(
  type: string
): AdminContentTypeDetail | null {
  if (!(CONTENT_TYPES as readonly string[]).includes(type)) return null
  const contentType = type as ContentType
  const descriptor = contentTypeDefs[contentType]
  const sharedFields = projectFields(descriptor.sharedFields)
  const localizedFields = projectFields(descriptor.localizedFields)

  return {
    ...summaries.find((summary) => summary.type === contentType)!,
    pathPrefix: descriptor.routing?.pathPrefix ?? null,
    capabilities: descriptor.capabilities,
    sharedFields,
    localizedFields,
    fieldCount: sharedFields.length + localizedFields.length,
  }
}
