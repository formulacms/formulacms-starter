import {
  LIVE_ROW_FIELD_NAMES,
  LOCALIZED_CONTENT_FIELD_NAMES,
  STAGING_ROW_FIELD_NAMES,
} from "../../../convex/lib/pages/storageFields"
import { POST_ONLY_SHARED_FIELDS } from "../../../convex/lib/definitions/check"

export type ContentFieldSpec =
  | {
      kind: "text"
      optional?: boolean
      public?: boolean
      config?: {
        multiline?: boolean
        maxLength?: number
        placeholder?: string
        editorial?: boolean
      }
    }
  | {
      kind: "richText"
      optional?: boolean
      public?: boolean
      config: {
        profile: "inline" | "basic" | "full"
        placeholder?: string
      }
    }
  | {
      kind:
        | "image"
        | "link"
        | "geopoint"
      optional?: boolean
      public?: boolean
    }
  | {
      kind: "boolean"
      optional?: boolean
      public?: boolean
      config: { label?: string; description?: string; default: boolean }
    }
  | {
      kind: "select"
      optional?: boolean
      public?: boolean
      config: {
        options: [string, string, ...string[]]
        default: string
        labels?: Record<string, string>
      }
    }
  | {
      kind: "number"
      optional?: boolean
      public?: boolean
      config: { min?: number; max?: number; step?: number; default: number }
    }
  | {
      kind: "date" | "datetime" | "embed"
      optional?: boolean
      public?: boolean
      config?: { placeholder?: string }
    }
  | {
      kind: "table"
      optional?: boolean
      public?: boolean
      config?: { minColumns?: number; maxColumns?: number }
    }
  | {
      kind: "relation"
      optional?: boolean
      public?: boolean
      config: { pageTypes: [string, ...string[]]; tag?: string }
    }
  | {
      kind: "group"
      optional?: boolean
      public?: boolean
      fields: Record<string, ContentFieldSpec>
    }
  | {
      kind: "list"
      optional?: boolean
      public?: boolean
      item: ContentFieldSpec
      config?: { min?: number; max?: number }
    }

export type ContentTypeCapabilitiesSpec = {
  blockBody: boolean
  revisions: boolean
  scheduling: boolean
  presence: boolean
  requiresBodyContent: boolean
}

export type ContentTypeSpec = {
  type: string
  labels: Record<string, { singular: string; plural: string }>
  /**
   * Which public renderer the type gets. `default` (the omitted value for a
   * block-body type) wires the shared block-body fallback and writes no file.
   * `custom` emits a renderer stub the author then tunes — ask for it when the
   * type has fields the shared fallback would leave invisible on the page.
   */
  renderer?: "default" | "custom"
  routing?: { pathPrefix: string }
  capabilities: ContentTypeCapabilitiesSpec
  sharedFields: Record<string, ContentFieldSpec>
  localizedFields: Record<string, ContentFieldSpec>
  referenceCard: {
    title: { scope: "shared" | "localized"; field: string }
    subtitle?: { scope: "shared" | "localized"; field: string }
  }
  seo?: {
    schemaOrgType?: string
    ogType?: "website" | "article" | "profile"
  }
  aiHint?: { purpose: string; fields: string }
}

type JsonRecord = Record<string, unknown>

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const IDENT = /^[A-Za-z][A-Za-z0-9]*$/
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
// Derived from the field objects the schema stores (the leaf module), so a new
// storage field is reserved as soon as it exists. A shared field must avoid the
// live page row and the staging row; a localized field must avoid the fields
// every language already stores.
const RESERVED_SHARED_FIELDS: ReadonlySet<string> = new Set([
  ...LIVE_ROW_FIELD_NAMES,
  ...STAGING_ROW_FIELD_NAMES,
])

function fail(message: string): never {
  throw new Error(`Invalid content-type spec: ${message}`)
}

function isRecord(value: unknown): value is JsonRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
}

function requiredString(
  value: JsonRecord,
  key: string,
  path = key
): string {
  const candidate = value[key]
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    fail(`${path} must be a non-empty string`)
  }
  return candidate.trim()
}

function optionalString(
  value: JsonRecord,
  key: string
): string | undefined {
  const candidate = value[key]
  if (candidate === undefined) return undefined
  if (typeof candidate !== "string") fail(`${key} must be a string`)
  return candidate
}

function optionalNumber(
  value: JsonRecord,
  key: string
): number | undefined {
  const candidate = value[key]
  if (candidate === undefined) return undefined
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    fail(`${key} must be a finite number`)
  }
  return candidate
}

function flags(value: JsonRecord, path: string) {
  const optional = value.optional
  const publicField = value.public
  if (optional !== undefined && typeof optional !== "boolean") {
    fail(`${path}.optional must be boolean`)
  }
  if (publicField !== undefined && typeof publicField !== "boolean") {
    fail(`${path}.public must be boolean`)
  }
  return {
    ...(optional === true ? { optional: true } : {}),
    ...(publicField === true ? { public: true } : {}),
  }
}

function parseField(value: unknown, path: string): ContentFieldSpec {
  if (!isRecord(value)) fail(`${path} must be an object`)
  const rawKind = requiredString(value, "kind", `${path}.kind`)
  const kind = rawKind === "rich-text" ? "richText" : rawKind
  const modifiers = flags(value, path)

  switch (kind) {
    case "text": {
      if (value.config === undefined) return { kind, ...modifiers }
      if (!isRecord(value.config)) fail(`${path}.config must be an object`)
      const multiline = value.config.multiline
      const editorial = value.config.editorial
      if (multiline !== undefined && typeof multiline !== "boolean") {
        fail(`${path}.config.multiline must be boolean`)
      }
      if (editorial !== undefined && typeof editorial !== "boolean") {
        fail(`${path}.config.editorial must be boolean`)
      }
      return {
        kind,
        ...modifiers,
        config: {
          ...(multiline === undefined ? {} : { multiline }),
          ...(editorial === undefined ? {} : { editorial }),
          ...(optionalNumber(value.config, "maxLength") === undefined
            ? {}
            : { maxLength: optionalNumber(value.config, "maxLength") }),
          ...(optionalString(value.config, "placeholder") === undefined
            ? {}
            : { placeholder: optionalString(value.config, "placeholder") }),
        },
      }
    }
    case "richText": {
      if (!isRecord(value.config)) fail(`${path}.config is required`)
      const profile = requiredString(
        value.config,
        "profile",
        `${path}.config.profile`
      )
      if (profile !== "inline" && profile !== "basic" && profile !== "full") {
        fail(`${path}.config.profile must be inline, basic, or full`)
      }
      return {
        kind,
        ...modifiers,
        config: {
          profile,
          ...(optionalString(value.config, "placeholder") === undefined
            ? {}
            : { placeholder: optionalString(value.config, "placeholder") }),
        },
      }
    }
    case "image":
    case "link":
    case "geopoint":
      return { kind, ...modifiers }
    case "boolean": {
      if (!isRecord(value.config)) fail(`${path}.config is required`)
      if (typeof value.config.default !== "boolean") {
        fail(`${path}.config.default must be boolean`)
      }
      return {
        kind,
        ...modifiers,
        config: {
          default: value.config.default,
          ...(optionalString(value.config, "label") === undefined
            ? {}
            : { label: optionalString(value.config, "label") }),
          ...(optionalString(value.config, "description") === undefined
            ? {}
            : { description: optionalString(value.config, "description") }),
        },
      }
    }
    case "select": {
      if (!isRecord(value.config)) fail(`${path}.config is required`)
      const options = value.config.options
      if (
        !Array.isArray(options) ||
        options.length < 2 ||
        !options.every(
          (option) => typeof option === "string" && option.length > 0
        )
      ) {
        fail(`${path}.config.options must contain at least two strings`)
      }
      const defaultValue = requiredString(
        value.config,
        "default",
        `${path}.config.default`
      )
      if (!options.includes(defaultValue)) {
        fail(`${path}.config.default must be one of config.options`)
      }
      let labels: Record<string, string> | undefined
      if (value.config.labels !== undefined) {
        if (!isRecord(value.config.labels)) {
          fail(`${path}.config.labels must be an object`)
        }
        labels = {}
        for (const [key, label] of Object.entries(value.config.labels)) {
          if (typeof label !== "string") {
            fail(`${path}.config.labels.${key} must be a string`)
          }
          labels[key] = label
        }
      }
      return {
        kind,
        ...modifiers,
        config: {
          options: options as [string, string, ...string[]],
          default: defaultValue,
          ...(labels ? { labels } : {}),
        },
      }
    }
    case "number": {
      if (!isRecord(value.config)) fail(`${path}.config is required`)
      const defaultValue = optionalNumber(value.config, "default")
      if (defaultValue === undefined) {
        fail(`${path}.config.default must be a finite number`)
      }
      return {
        kind,
        ...modifiers,
        config: {
          default: defaultValue,
          ...(optionalNumber(value.config, "min") === undefined
            ? {}
            : { min: optionalNumber(value.config, "min") }),
          ...(optionalNumber(value.config, "max") === undefined
            ? {}
            : { max: optionalNumber(value.config, "max") }),
          ...(optionalNumber(value.config, "step") === undefined
            ? {}
            : { step: optionalNumber(value.config, "step") }),
        },
      }
    }
    case "date":
    case "datetime":
    case "embed": {
      if (value.config === undefined) return { kind, ...modifiers }
      if (!isRecord(value.config)) fail(`${path}.config must be an object`)
      const placeholder = optionalString(value.config, "placeholder")
      return {
        kind,
        ...modifiers,
        ...(placeholder === undefined ? {} : { config: { placeholder } }),
      }
    }
    case "table": {
      if (value.config === undefined) return { kind, ...modifiers }
      if (!isRecord(value.config)) fail(`${path}.config must be an object`)
      const minColumns = optionalNumber(value.config, "minColumns")
      const maxColumns = optionalNumber(value.config, "maxColumns")
      if (
        minColumns !== undefined &&
        maxColumns !== undefined &&
        minColumns > maxColumns
      ) {
        fail(`${path}.config.minColumns must be <= maxColumns`)
      }
      return {
        kind,
        ...modifiers,
        config: {
          ...(minColumns === undefined ? {} : { minColumns }),
          ...(maxColumns === undefined ? {} : { maxColumns }),
        },
      }
    }
    case "relation": {
      if (!isRecord(value.config)) fail(`${path}.config is required`)
      const pageTypes = value.config.pageTypes
      if (
        !Array.isArray(pageTypes) ||
        pageTypes.length === 0 ||
        !pageTypes.every(
          (pageType) => typeof pageType === "string" && KEBAB.test(pageType)
        )
      ) {
        fail(`${path}.config.pageTypes must contain content-type slugs`)
      }
      return {
        kind,
        ...modifiers,
        config: {
          pageTypes: pageTypes as [string, ...string[]],
          ...(optionalString(value.config, "tag") === undefined
            ? {}
            : { tag: optionalString(value.config, "tag") }),
        },
      }
    }
    case "group": {
      if (!isRecord(value.fields)) fail(`${path}.fields is required`)
      const fields = parseFieldMap(value.fields, `${path}.fields`)
      if (Object.keys(fields).length === 0) {
        fail(`${path}.fields must not be empty`)
      }
      return { kind, ...modifiers, fields }
    }
    case "list": {
      if (value.item === undefined) fail(`${path}.item is required`)
      let config: { min?: number; max?: number } | undefined
      if (value.config !== undefined) {
        if (!isRecord(value.config)) fail(`${path}.config must be an object`)
        const min = optionalNumber(value.config, "min")
        const max = optionalNumber(value.config, "max")
        if (min !== undefined && max !== undefined && min > max) {
          fail(`${path}.config.min must be <= max`)
        }
        config = {
          ...(min === undefined ? {} : { min }),
          ...(max === undefined ? {} : { max }),
        }
      }
      return {
        kind,
        ...modifiers,
        item: parseField(value.item, `${path}.item`),
        ...(config && Object.keys(config).length > 0 ? { config } : {}),
      }
    }
    default:
      fail(`${path}.kind "${rawKind}" is not a supported field primitive`)
  }
}

function parseFieldMap(
  value: JsonRecord,
  path: string
): Record<string, ContentFieldSpec> {
  const result: Record<string, ContentFieldSpec> = {}
  for (const [name, field] of Object.entries(value)) {
    if (!IDENT.test(name)) {
      fail(`${path}.${name} must use a camelCase field name`)
    }
    result[name] = parseField(field, `${path}.${name}`)
  }
  return result
}

function parseLabels(
  value: unknown
): Record<string, { singular: string; plural: string }> {
  if (!isRecord(value)) fail("labels must be an object")
  const labels: Record<string, { singular: string; plural: string }> = {}
  for (const [locale, entry] of Object.entries(value)) {
    if (!LOCALE.test(locale)) fail(`labels.${locale} is not a locale key`)
    if (!isRecord(entry)) fail(`labels.${locale} must be an object`)
    labels[locale] = {
      singular: requiredString(
        entry,
        "singular",
        `labels.${locale}.singular`
      ),
      plural: requiredString(entry, "plural", `labels.${locale}.plural`),
    }
  }
  if (!labels.en) fail("labels.en is required")
  return labels
}

function parseCapabilities(value: unknown): ContentTypeCapabilitiesSpec {
  if (!isRecord(value)) fail("capabilities must be an object")
  const keys: Array<keyof ContentTypeCapabilitiesSpec> = [
    "blockBody",
    "revisions",
    "scheduling",
    "presence",
    "requiresBodyContent",
  ]
  const result = {} as ContentTypeCapabilitiesSpec
  for (const key of keys) {
    if (typeof value[key] !== "boolean") {
      fail(`capabilities.${key} must be boolean`)
    }
    result[key] = value[key]
  }
  if (!result.blockBody && result.requiresBodyContent) {
    fail("requiresBodyContent cannot be true when blockBody is false")
  }
  return result
}

function parsePointer(
  value: unknown,
  path: string,
  sharedFields: Record<string, ContentFieldSpec>,
  localizedFields: Record<string, ContentFieldSpec>
): { scope: "shared" | "localized"; field: string } {
  if (!isRecord(value)) fail(`${path} must be an object`)
  const scope = requiredString(value, "scope", `${path}.scope`)
  if (scope !== "shared" && scope !== "localized") {
    fail(`${path}.scope must be shared or localized`)
  }
  const field = requiredString(value, "field", `${path}.field`)
  const fields = scope === "shared" ? sharedFields : localizedFields
  if (!(field in fields)) fail(`${path}.field does not exist in ${scope}Fields`)
  const target = fields[field]!
  if (
    target.kind !== "text" &&
    target.kind !== "select" &&
    target.kind !== "date" &&
    target.kind !== "datetime"
  ) {
    fail(
      `${path}.field must reference a string-valued field (text, select, date, or datetime)`
    )
  }
  return { scope, field }
}

function validateRelations(
  fields: Record<string, ContentFieldSpec>,
  type: string,
  path: string
): void {
  const visit = (field: ContentFieldSpec, fieldPath: string): void => {
    if (field.kind === "relation") {
      for (const target of field.config.pageTypes) {
        if (target === type) continue
        if (!KEBAB.test(target)) {
          fail(`${fieldPath}.config.pageTypes contains an invalid slug`)
        }
      }
    }
    if (field.kind === "group") {
      for (const [name, child] of Object.entries(field.fields)) {
        visit(child, `${fieldPath}.${name}`)
      }
    }
    if (field.kind === "list") visit(field.item, `${fieldPath}[]`)
  }
  for (const [name, field] of Object.entries(fields)) {
    visit(field, `${path}.${name}`)
  }
}

function parseContentTypeSpec(value: unknown): ContentTypeSpec {
  if (!isRecord(value)) fail("root must be an object")
  const type = requiredString(value, "type")
  if (!KEBAB.test(type)) fail("type must be kebab-case")

  const labels = parseLabels(value.labels)
  const capabilities = parseCapabilities(value.capabilities)

  if (!isRecord(value.sharedFields)) fail("sharedFields must be an object")
  if (!isRecord(value.localizedFields)) {
    fail("localizedFields must be an object")
  }
  const sharedFields = parseFieldMap(value.sharedFields, "sharedFields")
  const localizedFields = parseFieldMap(
    value.localizedFields,
    "localizedFields"
  )
  for (const field of Object.keys(sharedFields)) {
    if (RESERVED_SHARED_FIELDS.has(field)) {
      fail(`sharedFields.${field} conflicts with a system field`)
    }
  }
  // The load-time check refuses the same fields (`post-only-field`); refusing
  // here stops `content-type:new` before it writes a file.
  if (type !== "post") {
    for (const field of POST_ONLY_SHARED_FIELDS) {
      if (field in sharedFields) {
        fail(
          `sharedFields.${field}: the admin editor supports this field only on "post"; rename the field.`
        )
      }
    }
  }
  for (const field of Object.keys(localizedFields)) {
    if (LOCALIZED_CONTENT_FIELD_NAMES.has(field)) {
      fail(
        `localizedFields.${field} conflicts with a field every language already stores`
      )
    }
  }
  const title = localizedFields.title
  if (!title || title.kind !== "text" || title.optional) {
    fail("localizedFields.title must be a required text field")
  }
  validateRelations(sharedFields, type, "sharedFields")
  validateRelations(localizedFields, type, "localizedFields")

  let renderer: ContentTypeSpec["renderer"]
  if (value.renderer !== undefined) {
    if (value.renderer !== "default" && value.renderer !== "custom") {
      fail("renderer must be default or custom")
    }
    renderer = value.renderer
  }

  let routing: ContentTypeSpec["routing"]
  if (value.routing !== undefined) {
    if (!isRecord(value.routing)) fail("routing must be an object")
    const pathPrefix = requiredString(
      value.routing,
      "pathPrefix",
      "routing.pathPrefix"
    )
    if (!KEBAB.test(pathPrefix)) {
      fail("routing.pathPrefix must be a non-empty kebab-case URL segment")
    }
    routing = { pathPrefix }
  }

  if (!isRecord(value.referenceCard)) {
    fail("referenceCard must be an object")
  }
  const referenceCard = {
    title: parsePointer(
      value.referenceCard.title,
      "referenceCard.title",
      sharedFields,
      localizedFields
    ),
    ...(value.referenceCard.subtitle === undefined
      ? {}
      : {
          subtitle: parsePointer(
            value.referenceCard.subtitle,
            "referenceCard.subtitle",
            sharedFields,
            localizedFields
          ),
        }),
  }

  let seo: ContentTypeSpec["seo"]
  if (value.seo !== undefined) {
    if (!isRecord(value.seo)) fail("seo must be an object")
    const schemaOrgType = optionalString(value.seo, "schemaOrgType")
    const ogType = optionalString(value.seo, "ogType")
    if (
      ogType !== undefined &&
      ogType !== "website" &&
      ogType !== "article" &&
      ogType !== "profile"
    ) {
      fail("seo.ogType must be website, article, or profile")
    }
    seo = {
      ...(schemaOrgType === undefined ? {} : { schemaOrgType }),
      ...(ogType === undefined ? {} : { ogType }),
    }
  }

  let aiHint: ContentTypeSpec["aiHint"]
  if (value.aiHint !== undefined) {
    if (!isRecord(value.aiHint)) fail("aiHint must be an object")
    aiHint = {
      purpose: requiredString(
        value.aiHint,
        "purpose",
        "aiHint.purpose"
      ),
      fields: requiredString(value.aiHint, "fields", "aiHint.fields"),
    }
  }

  return {
    type,
    labels,
    ...(renderer ? { renderer } : {}),
    ...(routing ? { routing } : {}),
    capabilities,
    sharedFields,
    localizedFields,
    referenceCard,
    ...(seo && Object.keys(seo).length > 0 ? { seo } : {}),
    ...(aiHint ? { aiHint } : {}),
  }
}

export function parseContentTypeSpecJson(json: string): ContentTypeSpec {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    fail(
      `file is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  return parseContentTypeSpec(value)
}
