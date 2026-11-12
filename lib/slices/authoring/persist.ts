import { resolveFieldContract } from "../../../convex/lib/richtext/contracts"
import type { RichTextContractConfig } from "../../../convex/lib/richtext/contracts"
import { validateStrict } from "../../../convex/lib/richtext/strict"
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { validate } from "convex-helpers/validators"
import * as LucideIcons from "lucide-react"
import {
  scaffoldSlice,
  specToPrimitive,
  type FieldSpec,
  type SliceSpec,
} from "./scaffold"
import { analyzeSliceUpdate } from "./update-safety"
import type { Primitive } from "@/convex/lib/slices"
import {
  canonicalizeRendererBody,
  spacingRemStepFromCss,
  type CanonicalizedClass,
} from "./canonicalize"
import { sliceTypeToSpec } from "./despec"
import type { SliceType } from "@/convex/lib/slices"
import { isPageType, type PageType } from "@/convex/lib/pages/types"
import {
  MANIFEST_PATH,
  manifestToRegistrations,
  readManifest,
  syncRegistration,
  writeManifest,
  type SliceManifestEntry,
} from "./registration"
import { sliceReferencePaths } from "./reference"
import { SLICE_GROUPS, type SliceOrigin } from "@/lib/slices/builder"
import {
  comparisonSnapshotFilename,
  thumbnailFilename,
} from "@/lib/slices/thumbnails"
import { fromCamel, toCamel, toPascal } from "./naming"
import {
  assertAuthoringPath,
  assertAuthoringPaths,
  projectRoot,
  rootFile,
} from "./paths"
import { RENDERER_UNSAFE_RULES, type RendererRule } from "./renderer-safety"
import {
  validateContractRendererHeadings,
  validateRendererHeadings,
} from "./renderer-heading-rule"
import type {
  RendererFieldContractResolution,
  RendererHeadingFieldAccess,
} from "./renderer-heading-rule"
import { assertNewSlicePolicy } from "./factory-policy"
import { validateRendererBindings } from "./renderer-binding-rule"
import { withFileRollback } from "./file-rollback"
import { assertSeedFreeRetirement } from "./retirement-source"
import {
  getStarterShipList,
  removeStarterShippedIfPresent,
  STARTER_SHIP_LIST_PATH,
} from "@/lib/slices/starter-ship"

type JsonRecord = Record<string, unknown>

export type PersistedSlice = {
  type: string
  label: string
  files: string[]
  unrenderedFields?: string[]
  /** Classes rewritten into the compliant Tailwind dialect on the way to disk.
   *  Surfaced so the rewrite is REPORTED, never silent — the file a reviewer
   *  reads must not differ from the model's output without anyone saying so. */
  canonicalized?: CanonicalizedClass[]
}

export type RenamedSlice = PersistedSlice

export type UpdatedSlice = PersistedSlice & { unrenderedFields: string[] }
export type UpdatedSliceRenderer = PersistedSlice

export type DeletedSlice = {
  type: string
  files: string[]
}

export type SliceReferenceCleanup = {
  removedTypes: string[]
  files: string[]
}

export type SlicePersistenceStage =
  | "descriptor"
  | "renderer"
  | "manifest"
  | "registration:index"
  | "registration:builder"
  | "registration:slice-zone"
  | "registration:slice-sim"
  | "registration:tweak-loc-types"
  | "cleanup"

export type SlicePersistencePreviewFile = {
  path: string
  action: "create" | "update" | "conflict"
}

export type SlicePersistencePreview = {
  type: string
  label: string
  rendererBody: string | null
  files: SlicePersistencePreviewFile[]
  conflicts: string[]
  unrenderedFields: string[]
  canonicalized: CanonicalizedClass[]
}

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const ICON = /^[A-Z][A-Za-z0-9]*$/
// Derived from the picker registry so model-emitted JSON gets the same gate that
// hand-typed SLICE_METADATA entries get from tsc — adding a group to
// `SLICE_GROUPS` admits it here with no second edit.
const ALLOWED_GROUPS = new Set<string>(SLICE_GROUPS.map((group) => group.id))
const GROUP_KEYWORDS: Array<[string, string[]]> = [
  ["heroes", ["hero", "headline", "masthead", "banner"]],
  [
    "cta",
    [
      "call to action",
      "call-to-action",
      "cta",
      "sign up",
      "signup",
      "subscribe",
      "get started",
      "newsletter",
    ],
  ],
  ["faq", ["faq", "frequently asked", "question", "accordion"]],
  ["features", ["feature", "benefit", "service", "logo", "proof"]],
]
const INDEX_PATH = "convex/lib/slices/index.ts"
const SLICE_REFERENCE_CLEANUP_FILES = [
  "components/admin/new-page-ai-wizard.tsx",
  "convex/lib/agents/pageContext.ts",
  "convex/agents/contentWriter.ts",
  "convex/agents/contentWriter.test.ts",
  "lib/slices/builder.test.ts",
  "lib/slices/authoring/eval/classification.ts",
] as const

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function fail(message: string): never {
  throw new Error(`Invalid SliceSpec: ${message}`)
}

function failSlice(message: string): never {
  throw new Error(`Invalid block operation: ${message}`)
}

function assertPrimitiveHasValidDefault(def: Primitive, path: string): void {
  if (def.default === undefined) {
    fail(`${path} must have a schema-valid default`)
  }

  try {
    validate(def.validator, def.default, { throw: true })
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ""
    fail(`${path} default does not satisfy its validator${detail}`)
  }

  if (def.kind === "richText" && typeof def.default === "string") {
    const checked = validateStrict(resolveFieldContract(def.config), def.default)
    if (!checked.ok) fail(`${path} default does not satisfy its rich-text profile: ${checked.error}`)
  }

  if (def.kind === "group") {
    const fields = def.config.fields as Record<string, Primitive>
    for (const [key, child] of Object.entries(fields)) {
      assertPrimitiveHasValidDefault(child, `${path}.${key}`)
    }
  }

  if (def.kind === "list") {
    assertPrimitiveHasValidDefault(def.config.item as Primitive, `${path}[]`)
  }
}

const RENDERER_BODY_MAX_BYTES = 12_000
/** Shape rules for a JSX *body fragment* — meaningless for a whole file, so
 *  they stay here rather than moving to the shared table below. */
const RENDERER_BODY_SHAPE: RendererRule[] = [
  {
    re: /\bimport\s/,
    msg: "imports are added by the scaffolder, not the model",
  },
  { re: /\bexport\s/, msg: "no top-level exports — only the JSX body" },
  { re: /\bfunction\s/, msg: "no inline function declarations" },
  {
    re: /\bon[A-Z]\w*\s*=\s*\{/,
    msg: "no event handlers in Server Component renderers",
  },
  { re: /<script\b/i, msg: "no <script> tags" },
  { re: /<style\b/i, msg: "no inline <style> tags — use Tailwind classes" },
]

// The unsafe-API half is shared with the post-write verify gate, so a body it
// would reject can't slip through this cheaper check first and cost a write +
// typecheck + rollback to learn the same thing.
const RENDERER_BODY_FORBIDDEN: RendererRule[] = [
  ...RENDERER_BODY_SHAPE,
  ...RENDERER_UNSAFE_RULES,
]

/** Reject obviously unsafe / out-of-contract bodies before scaffolding writes
 *  them. tsc + verify-slice catch the rest. */
function fieldSpecAtAccess(
  spec: SliceSpec,
  access: RendererHeadingFieldAccess
): FieldSpec | undefined {
  let field: FieldSpec | undefined =
    access.root === "primary" ? spec.primary : spec.items?.item

  const unwrapLists = (candidate: FieldSpec | undefined) => {
    let current = candidate
    while (current?.kind === "list") current = current.item
    return current
  }

  for (const segment of access.path) {
    field = unwrapLists(field)
    if (field?.kind !== "group") return undefined
    field = field.fields[segment]
  }

  return unwrapLists(field)
}

function assertRendererBodyIsSafe(
  body: string,
  spec: SliceSpec,
  newCreation = false
): void {
  const trimmed = body.trim()
  if (!trimmed) fail("renderer body is empty")
  if (trimmed.length > RENDERER_BODY_MAX_BYTES) {
    fail(
      `renderer body is too large (${trimmed.length} > ${RENDERER_BODY_MAX_BYTES} bytes)`
    )
  }
  if (!trimmed.startsWith("<section")) {
    fail("renderer body must start with <section as its single root element")
  }
  for (const rule of RENDERER_BODY_FORBIDDEN) {
    if (rule.re.test(trimmed)) fail(`renderer body rejected: ${rule.msg}`)
  }
  if (!newCreation) {
    for (const reason of validateRendererHeadings(trimmed, (access) => {
      const field = fieldSpecAtAccess(spec, access)
      return field?.kind === "richText" &&
        resolveFieldContract(field.config).contract === "inline"
    })) {
      fail(`renderer body rejected: ${reason}`)
    }
  }
  const contractFailures = validateContractRendererHeadings(
    trimmed,
    (access) => {
      const field = fieldSpecAtAccess(spec, access)
      if (!field) return { state: "unresolved" }
      if (field.kind !== "richText") return { state: "resolved" }
      return {
        state: "resolved",
        contract: resolveFieldContract(field.config).contract,
      } satisfies RendererFieldContractResolution
    },
    newCreation
  )
  if (contractFailures.length > 0) {
    fail(`renderer body rejected: ${contractFailures.join("; ")}`)
  }
}

function assertSliceSpecHasValidDefaults(spec: SliceSpec): void {
  assertPrimitiveHasValidDefault(specToPrimitive(spec.primary), "primary")
  if (!spec.items) return
  assertPrimitiveHasValidDefault(
    specToPrimitive({
      kind: "list",
      item: spec.items.item,
      config: { min: spec.items.min, max: spec.items.max },
    }),
    "items"
  )
}

function reqString(obj: JsonRecord, key: string): string {
  const value = obj[key]
  if (typeof value !== "string" || !value.trim()) {
    fail(`${key} must be a non-empty string`)
  }
  return value.trim()
}

function optString(obj: JsonRecord, key: string): string | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") fail(`${key} must be a string`)
  return value
}

function optNumber(obj: JsonRecord, key: string): number | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${key} must be a non-negative number`)
  }
  return value
}

function optBoolean(obj: JsonRecord, key: string): boolean | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") fail(`${key} must be a boolean`)
  return value
}

function optionalFlag(obj: JsonRecord): { optional?: true } {
  return obj.optional === true ? { optional: true } : {}
}

function validateFieldName(name: string): void {
  if (!IDENT.test(name)) {
    fail(`field name "${name}" must be a TypeScript identifier`)
  }
}

function validateSliceType(type: string): string {
  const trimmed = type.trim()
  if (!KEBAB.test(trimmed)) failSlice("type must be kebab-case")
  return trimmed
}

function validateSliceLabel(label: string): string {
  const trimmed = label.trim()
  if (!trimmed) failSlice("label must be a non-empty string")
  if (trimmed.length > 80) failSlice("label must be 80 characters or less")
  return trimmed
}

function normalizeKind(kind: string): string {
  if (kind === "rich-text" || kind === "rich_text" || kind === "richtext") {
    return "richText"
  }
  return kind
}

function richTextProfile(config: JsonRecord, path: string) {
  const explicit = config.profile
  if (explicit !== undefined) {
    if (
      typeof explicit === "string" &&
      ["inline", "basic", "full"].includes(explicit)
    ) {
      return explicit as "inline" | "basic" | "full"
    }
    fail(`${path}.config.profile must be inline, basic, or full`)
  }
  if (config.inline === true) return "inline"
  if (config.basic === true) return "basic"
  if (config.full === true) return "full"
  fail(`${path}.config.profile must be inline, basic, or full`)
}

function relationPageTypes(
  config: JsonRecord,
  path: string
): [PageType, ...PageType[]] {
  const pageTypes = config.pageTypes
  if (
    !Array.isArray(pageTypes) ||
    pageTypes.length === 0 ||
    !pageTypes.every((item) => typeof item === "string" && isPageType(item))
  ) {
    fail(`${path}.config.pageTypes must name at least one existing pageType`)
  }
  return pageTypes as [PageType, ...PageType[]]
}

function validateFieldSpec(rawInput: unknown, path: string): FieldSpec {
  if (!isRecord(rawInput)) fail(`${path} must be an object`)
  if (Object.hasOwn(rawInput, "as")) {
    fail(`${path}.as is not supported; use a rich-text heading contract`)
  }
  if (isRecord(rawInput.config) && Object.hasOwn(rawInput.config, "as")) {
    fail(`${path}.config.as is not supported; use a rich-text heading contract`)
  }

  // Models routinely emit `{ kind: "button" }` instead of the documented
  // `{ kind: "ref", ref: "button" }` shape — accept both so a prompt slip
  // doesn't tank the whole spec.
  const raw: JsonRecord =
    rawInput.kind === "button" && rawInput.ref === undefined
      ? { ...rawInput, kind: "ref", ref: "button" }
      : rawInput

  const kind = normalizeKind(reqString(raw, "kind"))
  switch (kind) {
    case "text": {
      const config = raw.config
      if (config === undefined) return { kind, ...optionalFlag(raw) }
      if (!isRecord(config)) fail(`${path}.config must be an object`)
      return {
        kind,
        ...optionalFlag(raw),
        config: {
          multiline:
            typeof config.multiline === "boolean"
              ? config.multiline
              : undefined,
          maxLength: optNumber(config, "maxLength"),
          placeholder: optString(config, "placeholder"),
          // The default (translatable) is omitted.
          translatable:
            optBoolean(config, "translatable") === false ? false : undefined,
        },
      }
    }
    case "richText": {
      if (!isRecord(raw.config)) fail(`${path}.config is required`)
      const config: RichTextContractConfig & { placeholder?: string } = {}
      if (
        raw.config.contract !== undefined &&
        !["title", "inline", "basic", "full"].includes(
          String(raw.config.contract)
        )
      )
        fail(`${path}.config.contract is invalid`)
      if (raw.config.contract !== undefined) {
        config.contract = raw.config
          .contract as RichTextContractConfig["contract"]
      }
      // Keep both explicit declarations so the shared resolver can refuse a
      // conflict instead of silently dropping the legacy alias at admission.
      if (
        raw.config.profile !== undefined ||
        raw.config.contract === undefined
      ) {
        config.profile = richTextProfile(raw.config, path)
      }
      if (raw.config.heading !== undefined) {
        if (
          !isRecord(raw.config.heading) ||
          !["sliceTitle", "itemTitle"].includes(String(raw.config.heading.role))
        )
          fail(`${path}.config.heading.role is invalid`)
        if (
          raw.config.heading.parent !== undefined &&
          typeof raw.config.heading.parent !== "string"
        )
          fail(`${path}.config.heading.parent must be a string`)
        config.heading = {
          role: raw.config.heading.role as "sliceTitle" | "itemTitle",
          ...(typeof raw.config.heading.parent === "string"
            ? { parent: raw.config.heading.parent }
            : {}),
        }
      }
      if (raw.config.headingFloor !== undefined) {
        if (
          !isRecord(raw.config.headingFloor) ||
          typeof raw.config.headingFloor.parent !== "string"
        )
          fail(`${path}.config.headingFloor.parent is required`)
        config.headingFloor = { parent: raw.config.headingFloor.parent }
      }
      config.placeholder = optString(raw.config, "placeholder")
      resolveFieldContract(config)
      return { kind, ...optionalFlag(raw), config }
    }
    case "image":
    case "link":
      return { kind, ...optionalFlag(raw) }
    case "relation": {
      if (!isRecord(raw.config)) fail(`${path}.config is required`)
      return {
        kind,
        ...optionalFlag(raw),
        config: {
          pageTypes: relationPageTypes(raw.config, path),
          tag: optString(raw.config, "tag"),
        },
      }
    }
    case "boolean": {
      if (!isRecord(raw.config)) fail(`${path}.config is required`)
      if (typeof raw.config.default !== "boolean") {
        fail(`${path}.config.default must be boolean`)
      }
      return {
        kind,
        ...optionalFlag(raw),
        config: {
          label: optString(raw.config, "label"),
          description: optString(raw.config, "description"),
          default: raw.config.default,
        },
      }
    }
    case "select": {
      if (!isRecord(raw.config)) fail(`${path}.config is required`)
      if (
        !Array.isArray(raw.config.options) ||
        raw.config.options.length < 2 ||
        !raw.config.options.every((item) => typeof item === "string")
      ) {
        fail(`${path}.config.options must contain at least two strings`)
      }
      const options = raw.config.options.map((item) => item.trim())
      const defaultValue = reqString(raw.config, "default")
      if (!options.includes(defaultValue)) {
        fail(`${path}.config.default must be one of options`)
      }
      const labels: Record<string, string> | undefined = isRecord(
        raw.config.labels
      )
        ? Object.fromEntries(
            Object.entries(raw.config.labels).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
        : undefined
      return {
        kind,
        ...optionalFlag(raw),
        config: { options, default: defaultValue, labels },
      }
    }
    case "number": {
      if (!isRecord(raw.config)) fail(`${path}.config is required`)
      const defaultValue = optNumber(raw.config, "default")
      if (defaultValue === undefined) {
        fail(`${path}.config.default must be a number`)
      }
      return {
        kind,
        ...optionalFlag(raw),
        config: {
          min: optNumber(raw.config, "min"),
          max: optNumber(raw.config, "max"),
          step: optNumber(raw.config, "step"),
          default: defaultValue,
        },
      }
    }
    case "date":
    case "datetime": {
      const config = raw.config
      if (config === undefined) return { kind, ...optionalFlag(raw) }
      if (!isRecord(config)) fail(`${path}.config must be an object`)
      return {
        kind,
        ...optionalFlag(raw),
        config: { placeholder: optString(config, "placeholder") },
      }
    }
    case "geopoint":
      return { kind, ...optionalFlag(raw) }
    case "embed": {
      const config = raw.config
      if (config === undefined) return { kind, ...optionalFlag(raw) }
      if (!isRecord(config)) fail(`${path}.config must be an object`)
      return {
        kind,
        ...optionalFlag(raw),
        config: { placeholder: optString(config, "placeholder") },
      }
    }
    case "table": {
      const config = raw.config
      if (config === undefined) return { kind, ...optionalFlag(raw) }
      if (!isRecord(config)) fail(`${path}.config must be an object`)
      const minColumns = optNumber(config, "minColumns")
      const maxColumns = optNumber(config, "maxColumns")
      if (
        minColumns !== undefined &&
        maxColumns !== undefined &&
        minColumns > maxColumns
      ) {
        fail(`${path}.config.minColumns must be <= maxColumns`)
      }
      return {
        kind,
        ...optionalFlag(raw),
        config: { minColumns, maxColumns },
      }
    }
    case "group": {
      if (!isRecord(raw.fields)) fail(`${path}.fields is required`)
      const fields: Record<string, FieldSpec> = {}
      for (const [name, child] of Object.entries(raw.fields)) {
        validateFieldName(name)
        fields[name] = validateFieldSpec(child, `${path}.fields.${name}`)
      }
      if (Object.keys(fields).length === 0) {
        fail(`${path}.fields must not be empty`)
      }
      return { kind, ...optionalFlag(raw), fields }
    }
    case "list": {
      if (raw.item === undefined) fail(`${path}.item is required`)
      const min = isRecord(raw.config)
        ? optNumber(raw.config, "min")
        : undefined
      const max = isRecord(raw.config)
        ? optNumber(raw.config, "max")
        : undefined
      return {
        kind,
        ...optionalFlag(raw),
        item: validateFieldSpec(raw.item, `${path}.item`),
        config:
          min === undefined && max === undefined ? undefined : { min, max },
      }
    }
    case "ref": {
      const ref = reqString(raw, "ref")
      if (ref !== "button") fail(`${path}.ref must be "button"`)
      return { kind, ref, ...optionalFlag(raw) }
    }
    default:
      fail(`${path}.kind "${kind}" is not a supported field primitive`)
  }
}

function hasOwn(obj: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/** Preview values are emitted as source, so reject values JSON.stringify would
 * silently drop or rewrite before the primitive validator sees them. */
function assertJsonPreviewValue(
  value: unknown,
  path: string,
  seen = new WeakSet<object>()
): void {
  if (value === null) return
  if (typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") {
    if (Number.isFinite(value)) return
    fail(`${path} must contain only finite JSON numbers`)
  }
  if (typeof value !== "object") {
    fail(`${path} must contain only JSON values`)
  }
  if (seen.has(value)) fail(`${path} must not contain circular data`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertJsonPreviewValue(item, `${path}[${index}]`, seen)
    )
  } else {
    for (const [key, child] of Object.entries(value as JsonRecord)) {
      assertJsonPreviewValue(child, `${path}.${key}`, seen)
    }
  }
  seen.delete(value)
}

function validatePreviewBounds(
  field: FieldSpec,
  value: unknown,
  path: string
): void {
  if (field.kind === "text" && typeof value === "string") {
    const maxLength = field.config?.maxLength
    if (maxLength !== undefined && value.length > maxLength) {
      fail(`${path} exceeds maxLength ${maxLength}`)
    }
  }

  if (field.kind === "number" && typeof value === "number") {
    if (field.config.min !== undefined && value < field.config.min) {
      fail(`${path} is below min ${field.config.min}`)
    }
    if (field.config.max !== undefined && value > field.config.max) {
      fail(`${path} exceeds max ${field.config.max}`)
    }
  }

  if (field.kind === "list" && Array.isArray(value)) {
    const min = field.config?.min
    const max = field.config?.max
    if (min !== undefined && value.length < min) {
      fail(`${path} contains fewer than min ${min} items`)
    }
    if (max !== undefined && value.length > max) {
      fail(`${path} contains more than max ${max} items`)
    }
  }

  if (field.kind === "table" && isRecord(value)) {
    const min = field.config?.minColumns
    const max = field.config?.maxColumns
    const assertColumns = (row: unknown, rowPath: string): void => {
      if (!Array.isArray(row)) return
      if (min !== undefined && row.length < min) {
        fail(`${rowPath} contains fewer than minColumns ${min}`)
      }
      if (max !== undefined && row.length > max) {
        fail(`${rowPath} contains more than maxColumns ${max}`)
      }
    }
    if (hasOwn(value, "headerRow")) {
      assertColumns(value.headerRow, `${path}.headerRow`)
    }
    if (Array.isArray(value.rows)) {
      value.rows.forEach((row, index) =>
        assertColumns(row, `${path}.rows[${index}]`)
      )
    }
  }
}

function validatePreviewValue(
  field: FieldSpec,
  value: unknown,
  path: string
): void {
  assertJsonPreviewValue(value, path)
  if (field.kind === "group" && isRecord(value)) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(field.fields, key)) {
        fail(`${path}.${key} is not declared by the group field`)
      }
    }
  }
  try {
    validate(specToPrimitive(field).validator, value, { throw: true })
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ""
    fail(`${path} does not satisfy its field validator${detail}`)
  }

  validatePreviewBounds(field, value, path)

  if (field.kind === "richText" && typeof value === "string") {
    const resolved = resolveFieldContract(field.config)
    const result = validateStrict(resolved, value)
    if (!result.ok)
      fail(`${path} does not satisfy its rich-text profile: ${result.error}`)
  }

  if (field.kind === "group" && isRecord(value)) {
    for (const [key, child] of Object.entries(field.fields)) {
      if (hasOwn(value, key)) {
        validatePreviewValue(child, value[key], `${path}.${key}`)
      }
    }
  }

  if (field.kind === "list" && Array.isArray(value)) {
    value.forEach((item, index) =>
      validatePreviewValue(field.item, item, `${path}[${index}]`)
    )
  }
}

/** Validate only supplied preview values; omitted values are synthesized later. */
export function assertSliceSpecPreview(spec: SliceSpec): void {
  const preview = spec.preview
  if (preview === undefined) return

  if (!isRecord(preview)) fail("preview must be an object")
  for (const key of Object.keys(preview)) {
    if (key !== "primary" && key !== "items") {
      fail(`preview.${key} is not supported`)
    }
  }
  if (hasOwn(preview, "primary")) {
    validatePreviewValue(spec.primary, preview.primary, "preview.primary")
  }
  if (hasOwn(preview, "items")) {
    if (!spec.items) fail("preview.items is not allowed without items")
    validatePreviewValue(
      {
        kind: "list",
        item: spec.items.item,
        config: { min: spec.items.min, max: spec.items.max },
      },
      preview.items,
      "preview.items"
    )
  }
}

function validateSliceSpec(raw: unknown): SliceSpec {
  if (!isRecord(raw)) fail("root must be an object")

  const type = reqString(raw, "type")
  if (!KEBAB.test(type)) fail("type must be kebab-case")
  const label = reqString(raw, "label")
  const description = reqString(raw, "description")

  const icon = reqString(raw, "icon")
  if (!ICON.test(icon)) fail("icon must be a lucide-react PascalCase export")
  if (!(icon in LucideIcons)) {
    fail(`icon "${icon}" is not exported by lucide-react`)
  }

  const group =
    raw.group === undefined
      ? inferSliceGroup({ type, label, description })
      : reqString(raw, "group")
  if (!ALLOWED_GROUPS.has(group)) {
    fail(
      `group "${group}" is not one of: ${[...ALLOWED_GROUPS].join(", ")}. ` +
        `Choose an existing group, or add a governed taxonomy value in a reviewed change.`
    )
  }

  const primary = validateFieldSpec(raw.primary, "primary")
  if (primary.kind !== "group") fail("primary must be a group field")

  let items: SliceSpec["items"]
  if (raw.items !== undefined) {
    if (!isRecord(raw.items)) fail("items must be an object")
    items = {
      item: validateFieldSpec(raw.items.item, "items.item"),
      min: optNumber(raw.items, "min"),
      max: optNumber(raw.items, "max"),
    }
  }

  let aiHint: SliceSpec["aiHint"]
  if (raw.aiHint !== undefined) {
    if (!isRecord(raw.aiHint)) fail("aiHint must be an object")
    const fields = raw.aiHint.fields
    aiHint = {
      purpose: optString(raw.aiHint, "purpose"),
      fields:
        fields === undefined
          ? undefined
          : Array.isArray(fields) &&
              fields.every((item) => typeof item === "string")
            ? fields
            : fail("aiHint.fields must be an array of strings"),
    }
  }

  const spec: SliceSpec = {
    type,
    label,
    description,
    icon,
    group,
    primary,
    items,
    preview:
      raw.preview === undefined
        ? undefined
        : isRecord(raw.preview)
          ? {
              ...(hasOwn(raw.preview, "primary")
                ? { primary: raw.preview.primary }
                : {}),
              ...(hasOwn(raw.preview, "items")
                ? { items: raw.preview.items }
                : {}),
            }
          : fail("preview must be an object"),
    aiHint,
  }
  assertSliceSpecPreview(spec)
  return spec
}

function inferSliceGroup({
  type,
  label,
  description,
}: {
  type: string
  label: string
  description: string
}): string {
  const haystack = `${type} ${label} ${description}`.toLowerCase()
  for (const [group, keywords] of GROUP_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return group
  }
  return "misc"
}

export function parseSliceSpecJson(specJson: string): SliceSpec {
  try {
    return validateSliceSpec(JSON.parse(specJson))
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail("JSON could not be parsed")
    }
    throw error
  }
}

function toSingularCamel(type: string): string {
  const camel = toCamel(type)
  return camel.endsWith("s") ? camel.slice(0, -1) : camel
}

function toSingularPascal(type: string): string {
  const pascal = toPascal(type)
  return pascal.endsWith("s") ? pascal.slice(0, -1) : pascal
}

function toScreamingSnake(type: string): string {
  return type.replace(/-/g, "_").toUpperCase()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readSource(root: string, file: string): Promise<string> {
  return readFile(rootFile(root, file), "utf8")
}

async function writeNewSource(
  root: string,
  file: string,
  source: string
): Promise<void> {
  const target = rootFile(root, file)
  await mkdir(dirname(target), { recursive: true })
  assertAuthoringPath(root, target)
  await writeFile(target, source, { flag: "wx" })
}

async function writeExistingSource(
  root: string,
  file: string,
  source: string
): Promise<void> {
  await writeFile(rootFile(root, file), source)
}

async function removeSourceIfExists(root: string, file: string): Promise<void> {
  const target = rootFile(root, file)
  if (await fileExists(target)) {
    assertAuthoringPath(root, target)
    await unlink(target)
  }
}

function registeredSliceTypes(source: string): Set<string> {
  // The registry is the single source of registered types;
  // `REGISTERED_SLICE_TYPES` derives from its keys, so read those directly.
  const match = source.match(
    /export const sliceDefs = \{([\s\S]*?)\n\} as const/
  )
  const entries = match?.[1]?.match(/^\s*"([^"]+)":/gm) ?? []
  return new Set(
    entries
      .map((entry) => entry.match(/"([^"]+)"/)?.[1])
      .filter((t): t is string => Boolean(t))
  )
}

function assertSafeSliceUpdate(
  prev: SliceSpec,
  next: SliceSpec,
  usageCount: number
): void {
  if (usageCount === 0) return
  const blocker = analyzeSliceUpdate(prev, next).blockers[0]
  if (blocker) failSlice(blocker.operationMessage)
}

/** Shared preflight/final admission: CLI dry-run, creation and the retained
 * admin action all pass through these persistence entry points. */
function assertGeneratedFieldCoverage(spec: SliceSpec, source: string): void {
  const failures = validateRendererBindings(
    source,
    spec.type,
    {
      primary: specToPrimitive(spec.primary),
      ...(spec.items
        ? {
            items: specToPrimitive({
              kind: "list",
              item: spec.items.item,
              config: { min: spec.items.min, max: spec.items.max },
            }),
          }
        : {}),
    },
    true
  )
  if (failures.length) throw new Error(failures.join("\n"))
}

function topLevelFields(spec: SliceSpec): Map<string, "primary" | "item"> {
  const fields = new Map<string, "primary" | "item">()
  for (const key of Object.keys(spec.primary.fields)) fields.set(key, "primary")
  if (spec.items?.item.kind === "group") {
    for (const key of Object.keys(spec.items.item.fields))
      fields.set(key, "item")
  } else if (spec.items) {
    fields.set("items", "item")
  }
  return fields
}

function addedTopLevelFields(
  prev: SliceSpec,
  next: SliceSpec
): { name: string; scope: "primary" | "item" }[] {
  const before = topLevelFields(prev)
  const after = topLevelFields(next)
  return [...after.entries()]
    .filter(([name]) => !before.has(name))
    .map(([name, scope]) => ({ name, scope }))
}

function unrenderedTopLevelFields(
  fields: { name: string; scope: "primary" | "item" }[],
  rendererSource: string
): string[] {
  return fields
    .filter(({ name, scope }) => {
      const accesses =
        scope === "primary"
          ? [`primary.${name}`]
          : name === "items"
            ? ["slice.items"]
            : [`item.${name}`]
      // The current scaffold binds the whole button list through the typed kit.
      const boundButtonList =
        scope === "item" &&
        name === "items" &&
        /<Buttons\b[^>]*\bfields=\{fields\}[^>]*\bfieldPath=(["'])items\1/s.test(
          rendererSource
        )
      return (
        !boundButtonList &&
        !accesses.some((access) => rendererSource.includes(access))
      )
    })
    .map(({ name }) => name)
}

function referencedSliceTypes(source: string): Set<string> {
  const types = new Set<string>()
  for (const match of source.matchAll(
    /\bcase\s+["']([a-z][a-z0-9-]*)["']\s*:/g
  )) {
    types.add(match[1]!)
  }
  for (const match of source.matchAll(
    /\bassembleSlice\(\s*["']([a-z][a-z0-9-]*)["']/g
  )) {
    types.add(match[1]!)
  }
  for (const match of source.matchAll(
    /\bcreateDefaultSlice\(\s*["']([a-z][a-z0-9-]*)["']/g
  )) {
    types.add(match[1]!)
  }
  for (const match of source.matchAll(
    /\bshipped:\s*\{\s*slice:\s*["']([a-z][a-z0-9-]*)["']/g
  )) {
    types.add(match[1]!)
  }
  for (const match of source.matchAll(/\bsliceDefs\.([a-z][A-Za-z0-9]*)\b/g)) {
    types.add(fromCamel(match[1]!))
  }
  return types
}

function removeSwitchCases(source: string, type: string): string {
  const quotedType = escapeRegExp(type)
  return source.replace(
    new RegExp(
      `\\n\\s*case\\s+["']${quotedType}["']\\s*:[\\s\\S]*?(?=\\n\\s*(?:case\\s+["']|default\\s*:))`,
      "g"
    ),
    ""
  )
}

function removeAssembleSliceCalls(source: string, type: string): string {
  return source.replace(
    new RegExp(
      `\\n\\s*assembleSlice\\(\\s*["']${escapeRegExp(type)}["'][^\\n]*\\),?`,
      "g"
    ),
    ""
  )
}

function removeTestBlocksNamingSlice(source: string, type: string): string {
  return source.replace(
    new RegExp(
      `\\n\\s*test\\(\\s*["'][^"']*\\b${escapeRegExp(type)}\\b[^"']*["'][\\s\\S]*?\\n\\s*\\}\\)(?=\\n\\s*(?:test\\(|\\}\\)|$))`,
      "g"
    ),
    ""
  )
}

function removeResponseFixture(source: string, type: string): string {
  return source.replace(
    new RegExp(
      `\\nconst ${toScreamingSnake(type)}_RESPONSE = \`[\\s\\S]*?\`\\n`,
      "g"
    ),
    "\n"
  )
}

function removeTypeImport(source: string, type: string): string {
  const pascal = escapeRegExp(toPascal(type))
  const singularPascal = escapeRegExp(toSingularPascal(type))
  return source
    .replace(
      new RegExp(`,\\s*(?:${pascal}|${singularPascal})(?:Item)?\\b`, "g"),
      ""
    )
    .replace(
      new RegExp(`\\b(?:${pascal}|${singularPascal})(?:Item)?\\s*,\\s*`, "g"),
      ""
    )
}

function removeTypeSpecificFunctions(source: string, type: string): string {
  const camel = escapeRegExp(toCamel(type))
  const singularCamel = escapeRegExp(toSingularCamel(type))
  const pascal = escapeRegExp(toPascal(type))
  const singularPascal = escapeRegExp(toSingularPascal(type))
  return source.replace(
    new RegExp(
      `\\nfunction\\s+(?:${camel}\\w*|${singularCamel}\\w*|\\w*${pascal}\\w*|\\w*${singularPascal}\\w*)\\s*\\([\\s\\S]*?\\n\\}(?=\\n\\n(?:function|/\\*\\*|export|const|$))`,
      "g"
    ),
    ""
  )
}

function removeClassificationFixtures(source: string, type: string): string {
  return source.replace(
    new RegExp(
      `\\n\\s*\\{[\\s\\S]*?shipped:\\s*\\{\\s*slice:\\s*["']${escapeRegExp(type)}["'][\\s\\S]*?\\n\\s*\\},(?=\\n\\s*(?:\\{|//|\\]))`,
      "g"
    ),
    ""
  )
}

function cleanupSourceForSliceType(source: string, type: string): string {
  let next = removeSwitchCases(source, type)
  next = removeAssembleSliceCalls(next, type)
  next = removeTestBlocksNamingSlice(next, type)
  next = removeResponseFixture(next, type)
  next = removeTypeImport(next, type)
  next = removeTypeSpecificFunctions(next, type)
  next = removeClassificationFixtures(next, type)
  return next
}

export async function cleanupRetiredSliceReferences(
  root = projectRoot(),
  options: {
    dryRun?: boolean
    registeredTypes?: ReadonlySet<string>
  } = {}
): Promise<SliceReferenceCleanup> {
  const registered =
    options.registeredTypes ??
    registeredSliceTypes(await readSource(root, INDEX_PATH))
  const sourceByFile = await Promise.all(
    SLICE_REFERENCE_CLEANUP_FILES.map(async (file) => {
      if (!(await fileExists(rootFile(root, file)))) return undefined
      return { file, source: await readSource(root, file) }
    })
  )
  const existingSources = sourceByFile.filter(
    (
      item
    ): item is {
      file: (typeof SLICE_REFERENCE_CLEANUP_FILES)[number]
      source: string
    } => item !== undefined
  )
  const retired = new Set<string>()
  for (const { source } of existingSources) {
    for (const type of referencedSliceTypes(source)) {
      if (!registered.has(type)) retired.add(type)
    }
  }

  const files: string[] = []
  for (const { file, source } of existingSources) {
    let next = source
    for (const type of retired) {
      next = cleanupSourceForSliceType(next, type)
    }
    if (next !== source) {
      if (!options.dryRun) await writeExistingSource(root, file, next)
      files.push(file)
    }
  }

  return { removedTypes: [...retired].sort(), files }
}

/**
 * Which side of the catalog's provenance split a newly authored slice lands on.
 *
 * The question is *which repository the funnel ran in*, not who ran it: a slice
 * authored in the engine is part of what formulacms ships and belongs under
 * "System slices", while one authored in a starter or an agency fork is the
 * owner's own and belongs under "Your slices". `scripts/starter/ship-list.json`
 * is the documented engine-vs-starter signal (see `lib/slices/starter-ship.ts`)
 * — it is deliberately kept off the generator's output allowlist, so it never
 * resolves anywhere but the engine.
 *
 * Returns `undefined` rather than `"system"` in the engine so shipped entries
 * stay origin-free in the manifest; `manifestToRegistrations` already reads an
 * absent origin as "system".
 */
async function authoredSliceOrigin(
  root: string
): Promise<SliceOrigin | undefined> {
  return (await getStarterShipList(root)) === null ? "user" : undefined
}

/** The manifest's view of a slice — its slug plus the picker metadata the
 *  generated `SLICE_METADATA` projects (ADR-0021). */
function specToManifestEntry(
  spec: SliceSpec,
  origin: SliceOrigin | undefined
): SliceManifestEntry {
  return {
    type: spec.type,
    label: spec.label,
    description: spec.description,
    icon: spec.icon,
    group: spec.group,
    ...(origin ? { origin } : {}),
  }
}

/** The spacing step THIS site actually uses. ADR-0020 gives every site its own
 *  token layer, and a fork may redefine `--spacing` — in which case `min-h-96`
 *  is no longer 24rem and the rewrite must stand down rather than resize the
 *  design behind the author's back. A globals.css we cannot read is treated the
 *  same way: decline, don't guess. */
async function siteSpacingRemStep(root: string): Promise<number | null> {
  try {
    return spacingRemStepFromCss(
      await readFile(rootFile(root, "app/globals.css"), "utf8")
    )
  } catch {
    return null
  }
}

export function sliceCreationPersistencePaths(spec: SliceSpec): string[] {
  const scaffold = scaffoldSlice(spec)
  return [
    scaffold.descriptorPath,
    scaffold.rendererPath,
    MANIFEST_PATH,
    INDEX_PATH,
    "lib/slices/builder.ts",
    "components/slices/slice-zone-registry.tsx",
    "components/slices/slice-sim-registry.tsx",
    "components/slices/tweak-loc-modules.d.ts",
    ...SLICE_REFERENCE_CLEANUP_FILES,
  ]
}

export async function previewSliceSpecPersistence(
  spec: SliceSpec,
  options: { rendererBody?: string; root?: string } = {}
): Promise<SlicePersistencePreview> {
  assertNewSlicePolicy(spec)
  const root = options.root ?? projectRoot()
  assertSliceSpecHasValidDefaults(spec)
  assertSliceSpecPreview(spec)
  const canonical =
    options.rendererBody === undefined
      ? undefined
      : canonicalizeRendererBody(options.rendererBody, {
          spacingRemStep: await siteSpacingRemStep(root),
        })
  const rendererBody = canonical?.body
  if (rendererBody !== undefined) {
    assertRendererBodyIsSafe(rendererBody, spec, true)
  }
  const scaffold = scaffoldSlice(spec, {
    customRendererBody: rendererBody,
  })
  assertGeneratedFieldCoverage(spec, scaffold.rendererSource)
  const descriptorExists = await fileExists(
    rootFile(root, scaffold.descriptorPath)
  )
  const rendererExists = await fileExists(rootFile(root, scaffold.rendererPath))
  const entries = await readManifest(root)
  const manifestConflict = entries.some((entry) => entry.type === spec.type)
  const conflicts = [
    ...(descriptorExists
      ? [`Descriptor already exists: ${scaffold.descriptorPath}`]
      : []),
    ...(rendererExists
      ? [`Renderer already exists: ${scaffold.rendererPath}`]
      : []),
    ...(manifestConflict
      ? [`Slice "${spec.type}" is already registered.`]
      : []),
  ]
  const next = manifestConflict
    ? entries
    : [...entries, specToManifestEntry(spec, await authoredSliceOrigin(root))]
  const synced = manifestConflict
    ? { files: [] }
    : await syncRegistration(manifestToRegistrations(next), {
        root,
        dryRun: true,
      })
  const cleanup = await cleanupRetiredSliceReferences(root, {
    dryRun: true,
    registeredTypes: new Set(next.map((entry) => entry.type)),
  })
  const unrenderedFields = unrenderedTopLevelFields(
    [...topLevelFields(spec).entries()].map(([name, scope]) => ({
      name,
      scope,
    })),
    scaffold.rendererSource
  )

  return {
    type: spec.type,
    label: spec.label,
    rendererBody: rendererBody ?? null,
    files: [
      {
        path: scaffold.descriptorPath,
        action: descriptorExists ? "conflict" : "create",
      },
      {
        path: scaffold.rendererPath,
        action: rendererExists ? "conflict" : "create",
      },
      {
        path: MANIFEST_PATH,
        action: manifestConflict ? "conflict" : "update",
      },
      ...synced.files.map((path): SlicePersistencePreviewFile => ({
        path,
        action: "update",
      })),
      ...cleanup.files.map((path): SlicePersistencePreviewFile => ({
        path,
        action: "update",
      })),
    ],
    conflicts,
    unrenderedFields,
    canonicalized: [...(canonical?.changes ?? [])],
  }
}

export async function persistSliceSpec(
  spec: SliceSpec,
  rootOrOptions:
    | string
    | {
        rendererBody?: string
        root?: string
        afterStage?: (stage: SlicePersistenceStage) => void | Promise<void>
      } = {}
): Promise<PersistedSlice> {
  const options =
    typeof rootOrOptions === "string" ? { root: rootOrOptions } : rootOrOptions
  const root = options.root ?? projectRoot()
  assertNewSlicePolicy(spec)
  assertSliceSpecHasValidDefaults(spec)
  assertSliceSpecPreview(spec)
  // Canonicalize BEFORE the safety assert and the gate: a bracket value with an
  // exact standard-utility equivalent is a legal intent in an illegal dialect,
  // and rejecting it would discard an otherwise-good generation over spelling.
  const canonical =
    options.rendererBody === undefined
      ? undefined
      : canonicalizeRendererBody(options.rendererBody, {
          spacingRemStep: await siteSpacingRemStep(root),
        })
  const rendererBody = canonical?.body
  if (rendererBody !== undefined) {
    assertRendererBodyIsSafe(rendererBody, spec, true)
  }
  const scaffold = scaffoldSlice(spec, {
    customRendererBody: rendererBody,
  })
  assertGeneratedFieldCoverage(spec, scaffold.rendererSource)
  const descriptorTarget = rootFile(root, scaffold.descriptorPath)
  const rendererTarget = rootFile(root, scaffold.rendererPath)

  if (await fileExists(descriptorTarget)) {
    throw new Error(`Descriptor already exists: ${scaffold.descriptorPath}`)
  }
  if (await fileExists(rendererTarget)) {
    throw new Error(`Renderer already exists: ${scaffold.rendererPath}`)
  }

  const entries = await readManifest(root)
  if (entries.some((entry) => entry.type === spec.type)) {
    throw new Error(`Slice "${spec.type}" is already registered.`)
  }
  const next = [
    ...entries,
    specToManifestEntry(spec, await authoredSliceOrigin(root)),
  ]

  const rollbackPaths = sliceCreationPersistencePaths(spec)

  return withFileRollback(root, rollbackPaths, async () => {
    await writeNewSource(
      root,
      scaffold.descriptorPath,
      scaffold.descriptorSource
    )
    await options.afterStage?.("descriptor")
    await writeNewSource(root, scaffold.rendererPath, scaffold.rendererSource)
    await options.afterStage?.("renderer")
    await writeManifest(root, next)
    await options.afterStage?.("manifest")
    const synced = await syncRegistration(manifestToRegistrations(next), {
      root,
      afterWrite: (file) =>
        options.afterStage?.(
          file === "sliceZone"
            ? "registration:slice-zone"
            : file === "sliceSim"
              ? "registration:slice-sim"
              : file === "tweakLocTypes"
                ? "registration:tweak-loc-types"
                : `registration:${file}`
        ),
    })
    const cleanup = await cleanupRetiredSliceReferences(root, {
      registeredTypes: new Set(next.map((entry) => entry.type)),
    })
    await options.afterStage?.("cleanup")
    const rendererSource = await readSource(root, scaffold.rendererPath)
    const unrenderedFields = unrenderedTopLevelFields(
      [...topLevelFields(spec).entries()].map(([name, scope]) => ({
        name,
        scope,
      })),
      rendererSource
    )

    return {
      type: spec.type,
      label: spec.label,
      files: [
        scaffold.descriptorPath,
        scaffold.rendererPath,
        MANIFEST_PATH,
        ...synced.files,
        ...cleanup.files,
      ],
      unrenderedFields,
      canonicalized: [...(canonical?.changes ?? [])],
    }
  })
}

export async function renameSliceMetadata(
  type: string,
  label: string,
  root = projectRoot()
): Promise<RenamedSlice> {
  const sliceType = validateSliceType(type)
  const nextLabel = validateSliceLabel(label)
  const entries = await readManifest(root)
  if (!entries.some((entry) => entry.type === sliceType)) {
    failSlice(`slice "${sliceType}" does not have registration metadata.`)
  }
  const next = entries.map((entry) =>
    entry.type === sliceType ? { ...entry, label: nextLabel } : entry
  )
  const manifestChanged = await writeManifest(root, next)
  const synced = await syncRegistration(manifestToRegistrations(next), {
    root,
    only: ["builder"],
  })
  const cleanup = await cleanupRetiredSliceReferences(root, {
    registeredTypes: new Set(next.map((entry) => entry.type)),
  })

  return {
    type: sliceType,
    label: nextLabel,
    files: [
      ...(manifestChanged ? [MANIFEST_PATH] : []),
      ...synced.files,
      ...cleanup.files,
    ],
  }
}

export async function updateSliceType(
  spec: SliceSpec,
  opts: { usageCount: number },
  root = projectRoot()
): Promise<UpdatedSlice> {
  const sliceType = validateSliceType(spec.type)
  assertSliceSpecHasValidDefaults(spec)
  assertSliceSpecPreview(spec)
  const scaffold = scaffoldSlice(spec)
  const descriptorPath = scaffold.descriptorPath
  const rendererPath = scaffold.rendererPath

  const entries = await readManifest(root)
  if (!entries.some((entry) => entry.type === sliceType)) {
    failSlice(`slice "${sliceType}" is not registered`)
  }
  if (!(await fileExists(rootFile(root, descriptorPath)))) {
    failSlice(`descriptor does not exist: ${descriptorPath}`)
  }

  const previousSpec = sliceTypeToSpec(sliceType as SliceType)
  assertSafeSliceUpdate(previousSpec, spec, opts.usageCount)

  // Only the descriptor (fields) and the slice's picker metadata can change on
  // an update; the slug — and therefore index.ts/slice-zone registration — is
  // fixed, so we regenerate builder.ts alone.
  // An update keeps the entry's installed selection and provenance. Re-deriving
  // it here would relabel a system slice as the owner's the first time it is
  // edited inside a starter.
  const next = entries.map((entry) =>
    entry.type === sliceType
      ? { ...entry, ...specToManifestEntry(spec, entry.origin) }
      : entry
  )
  await writeExistingSource(root, descriptorPath, scaffold.descriptorSource)
  const manifestChanged = await writeManifest(root, next)
  const synced = await syncRegistration(manifestToRegistrations(next), {
    root,
    only: ["builder"],
  })

  const rendererSource = await readSource(root, rendererPath)
  const topLevelAdded = addedTopLevelFields(previousSpec, spec)
  const unrenderedFields = unrenderedTopLevelFields(
    topLevelAdded,
    rendererSource
  )

  return {
    type: sliceType,
    label: spec.label,
    files: [
      descriptorPath,
      ...(manifestChanged ? [MANIFEST_PATH] : []),
      ...synced.files,
    ],
    unrenderedFields,
  }
}

export async function updateSliceRendererBody(
  type: string,
  rendererBody: string,
  root = projectRoot()
): Promise<UpdatedSliceRenderer> {
  const sliceType = validateSliceType(type)
  const canonical = canonicalizeRendererBody(rendererBody, {
    spacingRemStep: await siteSpacingRemStep(root),
  }).body

  const entries = await readManifest(root)
  if (!entries.some((entry) => entry.type === sliceType)) {
    failSlice(`slice "${sliceType}" is not registered`)
  }

  const spec = sliceTypeToSpec(sliceType as SliceType)
  assertRendererBodyIsSafe(canonical, spec)
  const scaffold = scaffoldSlice(spec, {
    customRendererBody: canonical,
  })
  const rendererPath = scaffold.rendererPath
  if (!(await fileExists(rootFile(root, rendererPath)))) {
    failSlice(`renderer does not exist: ${rendererPath}`)
  }

  await writeExistingSource(root, rendererPath, scaffold.rendererSource)

  return {
    type: sliceType,
    label: spec.label,
    files: [rendererPath],
  }
}

/**
 * Every root-relative path `deleteSliceType` may rewrite or delete, so a caller
 * can snapshot the full set before deleting and restore it atomically when the
 * post-delete gate fails (F-rollback). This is the single source of truth the
 * server action snapshots against - its old fixed 6-path set omitted the deleted
 * thumbnail/reference assets and the files `cleanupRetiredSliceReferences` edits,
 * so a gate-failed deletion could leave those deleted-and-unrestored.
 */
export function sliceDeletionSnapshotPaths(type: string): string[] {
  const camel = toCamel(type)
  return [
    MANIFEST_PATH,
    STARTER_SHIP_LIST_PATH,
    INDEX_PATH,
    "lib/slices/builder.ts",
    "components/slices/slice-zone-registry.tsx",
    "components/slices/slice-sim-registry.tsx",
    "components/slices/tweak-loc-modules.d.ts",
    `convex/lib/slices/${camel}.ts`,
    `components/slices/${type}.tsx`,
    ...thumbnailPaths(type),
    ...comparisonSnapshotPaths(type),
    ...sliceReferencePaths(type),
    ...SLICE_REFERENCE_CLEANUP_FILES,
  ]
}

/** The four catalog-thumbnail variants as repo-relative paths. Spelled by
 *  `thumbnails.ts` (the owner of the filename template) so a new slot is added
 *  in one place. */
function thumbnailPaths(type: string): string[] {
  return [
    thumbnailFilename(type),
    thumbnailFilename(type, "mobile"),
    thumbnailFilename(type, "desktop", "before"),
    thumbnailFilename(type, "mobile", "before"),
  ].map((filename) => `public/slice-sim/${filename}`)
}

function comparisonSnapshotPaths(type: string): string[] {
  return [
    comparisonSnapshotFilename(type),
    comparisonSnapshotFilename(type, "mobile"),
    comparisonSnapshotFilename(type, "desktop", "before"),
    comparisonSnapshotFilename(type, "mobile", "before"),
  ].map((filename) => `public/slice-sim/${filename}`)
}

export async function deleteSliceType(
  type: string,
  root = projectRoot()
): Promise<DeletedSlice> {
  const sliceType = validateSliceType(type)
  assertAuthoringPaths(
    root,
    sliceDeletionSnapshotPaths(sliceType).map((path) => rootFile(root, path))
  )
  const camel = toCamel(sliceType)
  const descriptorPath = `convex/lib/slices/${camel}.ts`
  const rendererPath = `components/slices/${sliceType}.tsx`

  const entries = await readManifest(root)
  const next = entries.filter((entry) => entry.type !== sliceType)

  // Independent local callers share the seed-free refusal. The action also
  // runs this before its final backend read; this last local read catches a
  // supported seed source introduced while that read was in flight.
  await assertSeedFreeRetirement(root)

  // Keep rollback-covered writes sequential: Promise.all rejects before other
  // writes necessarily settle, which could race the caller's file restore.
  await writeManifest(root, next)
  const shipList = await removeStarterShippedIfPresent(sliceType, root)
  const synced = await syncRegistration(manifestToRegistrations(next), { root })
  await removeSourceIfExists(root, descriptorPath)
  await removeSourceIfExists(root, rendererPath)

  // Remove the slice's on-disk artifacts too (F9) so a deleted slice leaves
  // nothing behind to resurrect: the four slice-sim thumbnail variants and the
  // design reference images. Root-relative (never cwd-based) so a delete run
  // against a test root can't touch the real repo's public assets.
  const assetPaths = [
    ...thumbnailPaths(sliceType),
    ...comparisonSnapshotPaths(sliceType),
    ...sliceReferencePaths(sliceType),
  ]
  // A failed removal must settle before the caller restores snapshots. An
  // earlier Promise.all rejection could leave a late unlink racing rollback.
  for (const assetPath of assetPaths) {
    await removeSourceIfExists(root, assetPath)
  }

  const cleanup = await cleanupRetiredSliceReferences(root, {
    registeredTypes: new Set(next.map((entry) => entry.type)),
  })

  return {
    type: sliceType,
    files: [
      descriptorPath,
      rendererPath,
      MANIFEST_PATH,
      ...(shipList?.changed ? [STARTER_SHIP_LIST_PATH] : []),
      ...assetPaths,
      ...synced.files,
      ...cleanup.files,
    ],
  }
}
