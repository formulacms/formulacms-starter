import {
  boolean,
  date,
  datetime,
  embed,
  geopoint,
  group,
  image,
  link,
  list,
  number,
  relation,
  richText,
  select,
  table,
  text,
  type Primitive,
} from "@/convex/lib/slices/primitives"
import { button } from "@/convex/lib/slices/fields"
import type { PageType } from "@/convex/lib/pages/types"
import type { RichTextContractConfig } from "@/convex/lib/richtext/contracts"
import { buildFieldDoc } from "@/convex/lib/richtext/build"
import {
  DEFAULT_ACTION_LIST_PATH,
  primaryFieldProtocol,
  primaryListTagExample,
  primaryListInstructions,
  primaryScalarTagExample,
} from "@/convex/lib/slices/repeating"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { SLICE_ICON_NAMES } from "@/lib/slices/icon-names"
import { toCamel, toPascal } from "./naming"

/**
 * Deterministic slice scaffolder (ADR-0016, Phase 2 M2).
 *
 * The slice-authoring agent's output splits in two: an AI-judgment part (which
 * design properties become fields, the renderer JSX) and a mechanical part (the
 * validator, registration, picker metadata). This file owns the mechanical part.
 *
 * Given a {@link SliceSpec} — the field-set decision the M3 agent produces — it
 * emits idiomatic source for the descriptor (`convex/lib/slices/<type>.ts`), a
 * renderer stub (`components/slices/<type>.tsx`), and the anchored insertion
 * snippets for the three registration files. No AI, fully deterministic, so its
 * output is snapshot- and round-trip-testable.
 *
 * {@link specToPrimitive} is the runtime twin of the codegen: it builds the real
 * {@link Primitive} tree from the same spec, so a spec can be validated (and
 * compared to a shipped descriptor) before any source is emitted.
 */

// ── spec ──────────────────────────────────────────────────────────────────────

export type FieldSpec =
  | {
      kind: "text"
      optional?: boolean
      config?: {
        multiline?: boolean
        maxLength?: number
        placeholder?: string
        /** Only `false` is written: an identifier never sent for translation. */
        translatable?: false
      }
    }
  | {
      kind: "richText"
      optional?: boolean
      config: RichTextContractConfig & { placeholder?: string }
    }
  | { kind: "image"; optional?: boolean }
  | { kind: "link"; optional?: boolean }
  | {
      kind: "boolean"
      optional?: boolean
      config: { label?: string; description?: string; default: boolean }
    }
  | {
      kind: "select"
      optional?: boolean
      config: {
        options: string[]
        default: string
        labels?: Record<string, string>
      }
    }
  | {
      kind: "number"
      optional?: boolean
      config: { min?: number; max?: number; step?: number; default: number }
    }
  | { kind: "date"; optional?: boolean; config?: { placeholder?: string } }
  | { kind: "datetime"; optional?: boolean; config?: { placeholder?: string } }
  | { kind: "geopoint"; optional?: boolean }
  | { kind: "embed"; optional?: boolean; config?: { placeholder?: string } }
  | {
      kind: "table"
      optional?: boolean
      config?: { minColumns?: number; maxColumns?: number }
    }
  | {
      kind: "relation"
      optional?: boolean
      config: {
        pageTypes: [PageType, ...PageType[]]
        tag?: string
      }
    }
  | { kind: "group"; optional?: boolean; fields: Record<string, FieldSpec> }
  | {
      kind: "list"
      optional?: boolean
      item: FieldSpec
      config?: { min?: number; max?: number }
    }
  /** Reference to a shared, named field descriptor exported from `./fields`.
   *  Distinct from the stored `relation` primitive, which points at pages. */
  | { kind: "ref"; ref: "button"; optional?: boolean }

export type GroupSpec = Extract<FieldSpec, { kind: "group" }>

/** Optional, complete stored values used by the slice simulator. Missing
 * values are synthesized from the spec's primitive semantics. */
export interface SliceSpecPreview {
  primary?: unknown
  items?: unknown
}

export interface SliceSpec {
  /** kebab-case slug, e.g. "pricing". */
  type: string
  /** Picker label, e.g. "Pricing". */
  label: string
  /** Picker one-liner. */
  description: string
  /** lucide-react icon name, e.g. "DollarSign". */
  icon: string
  /** Picker section: one of the closed `SliceGroup` union values. Required —
   *  add a governed taxonomy value instead of overloading `misc`. */
  group: string
  primary: GroupSpec
  items?: { item: FieldSpec; min?: number; max?: number }
  preview?: SliceSpecPreview
  aiHint?: { purpose?: string; fields?: string[] }
}

export interface SettledSliceSpecPreview {
  primary: unknown
  items?: unknown
}

// ── runtime build (spec → Primitive) ───────────────────────────────────────────

/** Build the real {@link Primitive} tree from a spec, via the actual factories.
 *  The runtime counterpart to the codegen — used to validate/compare a spec. */
export function specToPrimitive(spec: FieldSpec): Primitive {
  let p: Primitive
  switch (spec.kind) {
    case "text":
      p = text(spec.config ?? {})
      break
    case "richText":
      p = richText(spec.config)
      break
    case "image":
      p = image()
      break
    case "link":
      p = link()
      break
    case "boolean":
      p = boolean(spec.config)
      break
    case "select":
      p = select({
        options: spec.config.options as unknown as readonly [
          string,
          string,
          ...string[],
        ],
        default: spec.config.default,
        labels: spec.config.labels,
      })
      break
    case "number":
      p = number(spec.config)
      break
    case "date":
      p = date(spec.config ?? {})
      break
    case "datetime":
      p = datetime(spec.config ?? {})
      break
    case "geopoint":
      p = geopoint()
      break
    case "embed":
      p = embed(spec.config ?? {})
      break
    case "table":
      p = table(spec.config ?? {})
      break
    case "relation":
      p = relation(spec.config)
      break
    case "group": {
      const fields: Record<string, Primitive> = {}
      for (const [key, child] of Object.entries(spec.fields)) {
        fields[key] = specToPrimitive(child)
      }
      p = group(fields)
      break
    }
    case "list":
      p = list(specToPrimitive(spec.item) as never, spec.config ?? {})
      break
    case "ref":
      p = button
      break
  }
  return spec.optional ? p.optional() : p
}

function validatorJson(p: Primitive): string {
  return JSON.stringify((p.validator as unknown as { json: unknown }).json)
}

const buttonValidatorJson = validatorJson(button)
const optionalButtonValidatorJson = validatorJson(button.optional())

function optionalSpec(p: Primitive): { optional?: true } {
  return p.validator.isOptional === "optional" ? { optional: true } : {}
}

function compactConfig<T extends Record<string, unknown>>(
  config: T
): T | undefined {
  const kept = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined)
  ) as T
  return Object.keys(kept).length === 0 ? undefined : kept
}

export function isButtonPrimitive(p: Primitive): boolean {
  if (p === button) return true
  if (p.kind !== "group") return false
  const currentValidatorJson = validatorJson(p)
  return (
    currentValidatorJson === buttonValidatorJson ||
    currentValidatorJson === optionalButtonValidatorJson
  )
}

export function primitiveToSpec(p: Primitive): FieldSpec {
  const optional = optionalSpec(p)
  if (isButtonPrimitive(p)) return { kind: "ref", ref: "button", ...optional }

  switch (p.kind) {
    case "text": {
      const config = compactConfig({
        multiline:
          typeof p.config.multiline === "boolean"
            ? p.config.multiline
            : undefined,
        maxLength:
          typeof p.config.maxLength === "number"
            ? p.config.maxLength
            : undefined,
        placeholder:
          typeof p.config.placeholder === "string"
            ? p.config.placeholder
            : undefined,
        // The default (translatable) is omitted.
        translatable:
          p.config.translatable === false ? (false as const) : undefined,
      })
      return config
        ? { kind: "text", ...optional, config }
        : { kind: "text", ...optional }
    }
    case "richText":
      return {
        kind: "richText",
        ...optional,
        config: {
          ...(p.config.profile
            ? { profile: p.config.profile }
            : { contract: p.config.contract }),
          ...(p.config.heading ? { heading: p.config.heading } : {}),
          ...(p.config.headingFloor
            ? { headingFloor: p.config.headingFloor }
            : {}),
          ...(typeof p.config.placeholder === "string"
            ? { placeholder: p.config.placeholder }
            : {}),
        } as RichTextContractConfig & { placeholder?: string },
      }
    case "image":
    case "link":
    case "geopoint":
      return { kind: p.kind, ...optional } as FieldSpec
    case "boolean":
      return {
        kind: "boolean",
        ...optional,
        config: compactConfig({
          label:
            typeof p.config.label === "string" ? p.config.label : undefined,
          description:
            typeof p.config.description === "string"
              ? p.config.description
              : undefined,
          default: p.config.default as boolean,
        }) as { label?: string; description?: string; default: boolean },
      }
    case "select":
      return {
        kind: "select",
        ...optional,
        config: compactConfig({
          options: p.config.options as string[],
          default: p.config.default as string,
          labels: p.config.labels as Record<string, string> | undefined,
        }) as {
          options: string[]
          default: string
          labels?: Record<string, string>
        },
      }
    case "number":
      return {
        kind: "number",
        ...optional,
        config: compactConfig({
          min: p.config.min as number | undefined,
          max: p.config.max as number | undefined,
          step: p.config.step as number | undefined,
          default: p.config.default as number,
        }) as { min?: number; max?: number; step?: number; default: number },
      }
    case "date":
    case "datetime":
    case "embed": {
      const config = compactConfig({
        placeholder: p.config.placeholder,
      })
      return config
        ? ({ kind: p.kind, ...optional, config } as FieldSpec)
        : ({ kind: p.kind, ...optional } as FieldSpec)
    }
    case "table": {
      const config = compactConfig({
        minColumns:
          typeof p.config.minColumns === "number"
            ? p.config.minColumns
            : undefined,
        maxColumns:
          typeof p.config.maxColumns === "number"
            ? p.config.maxColumns
            : undefined,
      })
      return config
        ? { kind: "table", ...optional, config }
        : { kind: "table", ...optional }
    }
    case "relation":
      return {
        kind: "relation",
        ...optional,
        config: compactConfig({
          pageTypes: p.config.pageTypes as [PageType, ...PageType[]],
          tag: p.config.tag as string | undefined,
        }) as { pageTypes: [PageType, ...PageType[]]; tag?: string },
      }
    case "group": {
      const fields = p.config.fields as Record<string, Primitive>
      return {
        kind: "group",
        ...optional,
        fields: Object.fromEntries(
          Object.entries(fields).map(([key, child]) => [
            key,
            primitiveToSpec(child),
          ])
        ),
      }
    }
    case "list": {
      const config = compactConfig({
        min: typeof p.config.min === "number" ? p.config.min : undefined,
        max: typeof p.config.max === "number" ? p.config.max : undefined,
      }) as { min?: number; max?: number } | undefined
      return {
        kind: "list",
        ...optional,
        item: primitiveToSpec(p.config.item as Primitive),
        ...(config ? { config } : {}),
      }
    }
    default:
      throw new Error(`Unsupported primitive kind: ${p.kind}`)
  }
}

// ── deterministic simulator preview ──────────────────────────────────────────

function humanizePreviewKey(key: string, seed: number): string {
  const label = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim()
  return seed === 0 ? label : `${label} ${seed + 1}`
}

function boundedPreviewText(value: string, maxLength?: number): string {
  return maxLength === undefined ? value : value.slice(0, maxLength)
}

function previewNumber(field: Extract<FieldSpec, { kind: "number" }>): number {
  const min = field.config.min
  const max = field.config.max
  let value = field.config.default
  if (min !== undefined) value = Math.max(min, value)
  if (max !== undefined) value = Math.min(max, value)
  return value
}

function previewTable(field: Extract<FieldSpec, { kind: "table" }>): unknown {
  const min = field.config?.minColumns ?? 1
  const max = field.config?.maxColumns ?? Math.max(min, 2)
  const columns = Math.max(min, Math.min(max, 2))
  if (columns === 0) return { rows: [] }
  return {
    headerRow: Array.from({ length: columns }, (_, index) =>
      index === 0 ? "Label" : `Detail ${index}`
    ),
    rows: [
      Array.from({ length: columns }, (_, index) =>
        index === 0 ? "Preview" : `Value ${index}`
      ),
    ],
  }
}

/**
 * Synthesize a stable, schema-valid preview value for one field. This is a
 * provisional fixture: it makes a new type renderable in the simulator, but it
 * does not imply that the fixture matches an accepted screenshot.
 */
function synthesizedPreviewValue(
  field: FieldSpec,
  key: string,
  seed: number
): unknown {
  switch (field.kind) {
    case "text":
      return boundedPreviewText(
        field.config?.placeholder ?? humanizePreviewKey(key, seed),
        field.config?.maxLength
      )
    case "richText":
      return JSON.stringify(
        buildFieldDoc(
          field.config.placeholder ?? humanizePreviewKey(key, seed),
          field.config,
          field.config.heading?.role,
          { emphasis: true }
        )
      )
    case "image":
      return structuredClone(specToPrimitive(field).default)
    case "link":
      return { type: "external", url: "https://example.com" }
    case "boolean":
      return field.config.default
    case "select":
      return field.config.default
    case "number":
      return previewNumber(field)
    case "date":
      return "2026-01-15"
    case "datetime":
      return "2026-01-15T14:30:00.000Z"
    case "geopoint":
      return structuredClone(specToPrimitive(field).default)
    case "embed":
      return {
        url: "https://example.com/embed",
        title: humanizePreviewKey(key, seed),
      }
    case "table":
      return previewTable(field)
    case "relation":
      // Relations are intentionally empty until an editor chooses a real page;
      // a preview must never invent a content/storage ID.
      return structuredClone(specToPrimitive(field).default)
    case "group":
      return Object.fromEntries(
        Object.entries(field.fields).map(([childKey, child]) => [
          childKey,
          synthesizedPreviewValue(child, childKey, seed),
        ])
      )
    case "list": {
      const min = field.config?.min ?? 0
      const max = field.config?.max ?? 3
      const count = Math.max(min, Math.min(max, 3))
      return Array.from({ length: count }, (_, index) =>
        synthesizedPreviewValue(field.item, key, seed + index + 1)
      )
    }
    case "ref":
      return {
        label: seed === 0 ? "Learn more" : `Learn more ${seed + 1}`,
        link: { type: "external", url: "https://example.com" },
        variant: seed === 0 ? "primary" : "secondary",
        withIcon: false,
        enabled: true,
      }
  }
}

function hasPreviewValue(
  preview: SliceSpecPreview | undefined,
  key: "primary" | "items"
): boolean {
  return Boolean(preview && Object.prototype.hasOwnProperty.call(preview, key))
}

/** Resolve supplied preview values over deterministic provisional defaults. */
export function resolveSliceSpecPreview(
  spec: SliceSpec
): SettledSliceSpecPreview {
  const primary = synthesizedPreviewValue(spec.primary, "primary", 0)
  const items = spec.items
    ? synthesizedPreviewValue(
        {
          kind: "list",
          item: spec.items.item,
          config: { min: spec.items.min, max: spec.items.max },
        },
        "items",
        0
      )
    : undefined

  return {
    primary: hasPreviewValue(spec.preview, "primary")
      ? structuredClone(spec.preview!.primary)
      : primary,
    ...(spec.items
      ? {
          items: hasPreviewValue(spec.preview, "items")
            ? structuredClone(spec.preview!.items)
            : items,
        }
      : {}),
  }
}

// ── source emitters ────────────────────────────────────────────────────────────

const FACTORY_KINDS = new Set([
  "text",
  "richText",
  "image",
  "link",
  "relation",
  "boolean",
  "select",
  "number",
  "date",
  "datetime",
  "geopoint",
  "embed",
  "table",
  "group",
  "list",
])

const pad = (n: number) => " ".repeat(n)
const isIdent = (k: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)

/** Emit a TS literal for a config value (string / number / boolean / array / object). */
function emitValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  if (Array.isArray(value)) return `[${value.map(emitValue).join(", ")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${isIdent(k) ? k : JSON.stringify(k)}: ${emitValue(v)}`)
    return `{ ${entries.join(", ")} }`
  }
  return "undefined"
}

/** Emit a factory config object, or "" when there's nothing to pass. */
function emitConfig(config: Record<string, unknown> | undefined): string {
  if (!config) return ""
  const kept = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined)
  )
  return Object.keys(kept).length === 0 ? "" : emitValue(kept)
}

/** Emit the factory-call source for one field spec at the given indent. */
function emitPrimitive(spec: FieldSpec, indent: number): string {
  const opt = spec.optional ? ".optional()" : ""
  switch (spec.kind) {
    case "text":
      return `text(${emitConfig(spec.config)})${opt}`
    case "richText":
      return `richText(${emitConfig(spec.config)})${opt}`
    case "image":
      return `image()${opt}`
    case "link":
      return `link()${opt}`
    case "relation":
      return `relation(${emitConfig(spec.config)})${opt}`
    case "boolean":
      return `boolean(${emitConfig(spec.config)})${opt}`
    case "select":
      return `select(${emitConfig(spec.config)})${opt}`
    case "number":
      return `number(${emitConfig(spec.config)})${opt}`
    case "date":
      return `date(${emitConfig(spec.config)})${opt}`
    case "datetime":
      return `datetime(${emitConfig(spec.config)})${opt}`
    case "geopoint":
      return `geopoint()${opt}`
    case "embed":
      return `embed(${emitConfig(spec.config)})${opt}`
    case "table":
      return `table(${emitConfig(spec.config)})${opt}`
    case "ref":
      return `${spec.ref}${opt}`
    case "group": {
      const fields = Object.entries(spec.fields)
        .map(
          ([key, child]) =>
            `${pad(indent + 2)}${key}: ${emitPrimitive(child, indent + 2)},`
        )
        .join("\n")
      return `group({\n${fields}\n${pad(indent)}})${opt}`
    }
    case "list": {
      const cfg = emitConfig(spec.config)
      const tail = cfg ? `, ${cfg}` : ""
      return `list(${emitPrimitive(spec.item, indent)}${tail})${opt}`
    }
  }
}

/** Collect the `./primitives` factory names and whether `button` (`./fields`) is used. */
function collectImports(
  spec: FieldSpec,
  factories: Set<string>,
  refs: Set<string>
): void {
  if (FACTORY_KINDS.has(spec.kind)) factories.add(spec.kind)
  if (spec.kind === "ref") refs.add(spec.ref)
  if (spec.kind === "group")
    for (const c of Object.values(spec.fields))
      collectImports(c, factories, refs)
  if (spec.kind === "list") collectImports(spec.item, factories, refs)
}

// ── public output ──────────────────────────────────────────────────────────────

export interface ScaffoldOutput {
  descriptorPath: string
  descriptorSource: string
  rendererPath: string
  rendererSource: string
}

function buildDescriptor(spec: SliceSpec): string {
  const camel = toCamel(spec.type)
  const pascal = toPascal(spec.type)
  const factories = new Set<string>()
  const refs = new Set<string>()
  collectImports(spec.primary, factories, refs)
  const itemsSpec: FieldSpec | undefined = spec.items
    ? {
        kind: "list",
        item: spec.items.item,
        config: { min: spec.items.min, max: spec.items.max },
      }
    : undefined
  if (itemsSpec) collectImports(itemsSpec, factories, refs)

  const FACTORY_ORDER = [
    "group",
    "text",
    "richText",
    "image",
    "link",
    "relation",
    "boolean",
    "select",
    "number",
    "date",
    "datetime",
    "geopoint",
    "embed",
    "table",
    "list",
  ]
  const factoryImport = FACTORY_ORDER.filter((f) => factories.has(f)).join(", ")

  const primarySrc = emitPrimitive(spec.primary, 0)
  const itemsSrc = itemsSpec ? emitPrimitive(itemsSpec, 0) : undefined
  const preview = resolveSliceSpecPreview(spec)
  const previewPrimarySrc = JSON.stringify(preview.primary, null, 2)
  const previewItemsSrc =
    preview.items === undefined
      ? undefined
      : JSON.stringify(preview.items, null, 2)

  const purpose = spec.aiHint?.purpose ?? `Content for ${spec.label}.`
  const generatedFieldInstructions = [
    "Return declared scalar editorial fields in matching fenced tags.",
    ...primaryFieldProtocol(specToPrimitive(spec.primary)).scalars.map(
      ({ path }) => primaryScalarTagExample(path)
    ),
  ]
  const authoredFields = spec.aiHint?.fields ?? generatedFieldInstructions
  const fieldsLines = appendPrimaryListGuidance(authoredFields, spec)

  const validatorLines = [
    "    id: v.string(),",
    `    type: v.literal("${spec.type}"),`,
    "    enabled: v.boolean(),",
    "    primary: primary.validator,",
    ...(itemsSrc ? ["    items: items.validator,"] : []),
  ].join("\n")

  return [
    `import { v, type Infer } from "convex/values"`,
    `import { ${factoryImport} } from "./primitives"`,
    ...(refs.has("button") ? [`import { button } from "./fields"`] : []),
    ``,
    `const primary = ${primarySrc}`,
    ...(itemsSrc ? [``, `const items = ${itemsSrc}`] : []),
    ``,
    `const previewPrimary: Infer<typeof primary.validator> = ${previewPrimarySrc}`,
    ...(itemsSrc && previewItemsSrc
      ? [
          ``,
          `const previewItems: Infer<typeof items.validator> = ${previewItemsSrc}`,
        ]
      : []),
    ``,
    `/** ${spec.label.replaceAll("*/", "* /").replace(/[\r\n\u2028\u2029]/g, " ")} slice descriptor — scaffolded (ADR-0016 M2). Tune the aiHint`,
    ` *  and replace the renderer stub with designed JSX before merging. */`,
    `export const ${camel}Def = {`,
    `  type: "${spec.type}" as const,`,
    `  primary,`,
    ...(itemsSrc ? [`  items,`] : []),
    `  validator: v.object({`,
    validatorLines,
    `  }),`,
    ...(itemsSrc && previewItemsSrc
      ? [`  preview: { primary: previewPrimary, items: previewItems },`]
      : [`  preview: { primary: previewPrimary },`]),
    `  aiHint: {`,
    `    purpose: ${JSON.stringify(purpose)},`,
    `    fields: [`,
    ...fieldsLines.map((l) => `      ${JSON.stringify(l)},`),
    `    ].join("\\n\\n"),`,
    `  },`,
    `}`,
    ``,
    `export const ${camel}Slice = ${camel}Def.validator`,
    `export type ${pascal}Slice = Infer<typeof ${camel}Slice>`,
    ``,
  ].join("\n")
}

/** JSX for one primary field in the renderer stub. Empty for fields the stub
 *  leaves to the human (selects/booleans/numbers/links — structural intent). */
type FieldJsxContext = {
  access: string
  fieldPath: string
  listDepth: number
  indent: number
}

function fieldPathAttribute(fieldPath: string): string {
  return fieldPath.includes("${")
    ? `fieldPath={\`${fieldPath}\`}`
    : `fieldPath=${JSON.stringify(fieldPath)}`
}

function appendPrimaryListGuidance(
  fields: string[],
  spec: SliceSpec
): string[] {
  const protocol = primaryFieldProtocol(specToPrimitive(spec.primary))
  const paths = protocol.lists
    .filter(({ path, definition }) => {
      if (path.includes("[]")) return false
      const item = definition.config.item as Primitive
      return isButtonPrimitive(item)
    })
    .map(({ path }) => path)
  const buttonGuidance = paths.map(
    (path) =>
      `${path}: provide a JSON array of shared button values in a full-path block ${primaryListTagExample(path)}.`
  )
  if (paths.includes(DEFAULT_ACTION_LIST_PATH)) {
    buttonGuidance.unshift(
      `${DEFAULT_ACTION_LIST_PATH} is the default named list for section actions.`
    )
  }
  const listInstructions = primaryListInstructions(specToPrimitive(spec.primary))
  const scalarGuidance = [
    "Return declared scalar editorial fields in matching fenced tags.",
    ...protocol.scalars.map(({ path }) => primaryScalarTagExample(path)),
  ]
  const guidance = [
    ...scalarGuidance,
    ...(listInstructions ? listInstructions.split("\n") : []),
    ...buttonGuidance,
  ]
  const output = [...fields]
  for (const entry of guidance) {
    if (!entry || output.join("\n").includes(entry)) continue
    output.push(entry)
  }
  return output
}

function emitFieldJsx(
  name: string,
  spec: FieldSpec,
  helpers: Set<string>,
  context: FieldJsxContext = {
    access: `primary.${name}`,
    fieldPath: `primary.${name}`,
    listDepth: 0,
    indent: 8,
  }
): string {
  const { access, fieldPath, listDepth, indent } = context
  const pad = " ".repeat(indent)
  const lower = name.toLowerCase()
  if (spec.kind === "group") {
    return Object.entries(spec.fields)
      .map(([childName, child]) =>
        emitFieldJsx(childName, child, helpers, {
          ...context,
          access: `${access}.${childName}`,
          fieldPath: `${fieldPath}.${childName}`,
        })
      )
      .filter(Boolean)
      .join("\n")
  }
  if (spec.kind === "list") {
    if (spec.item.kind === "ref" && spec.item.ref === "button") {
      helpers.add("Buttons")
      return `${pad}<Buttons fields={fields} ${fieldPathAttribute(fieldPath)} ctx={ctx} className="pt-3" />`
    }
    const itemName = `item${listDepth}`
    const indexName = `index${listDepth}`
    const rowPath = `${fieldPath}[\${${indexName}}]`
    const itemContent = emitFieldJsx(name, spec.item, helpers, {
      access: itemName,
      fieldPath: rowPath,
      listDepth: listDepth + 1,
      indent: indent + 4,
    })
    const contents = itemContent
    const key = `typeof ${itemName} === "object" && ${itemName} !== null && "itemId" in ${itemName} ? String((${itemName} as { itemId: string }).itemId) : ${indexName}`
    return `${pad}{Array.isArray(${access}) && ${access}.map((${itemName}, ${indexName}) => (\n${" ".repeat(indent + 2)}<div key={${key}} className="space-y-3">\n${contents}\n${" ".repeat(indent + 2)}</div>\n${pad}))}`
  }
  if (spec.kind === "text") {
    if (
      lower.includes("accent") ||
      lower.includes("emphasis") ||
      lower.includes("highlight")
    ) {
      helpers.add("Text")
      return `${pad}{${access} && <Text fields={fields} ${fieldPathAttribute(fieldPath)} as="p" className="text-display font-black text-brand" ctx={ctx} />}`
    }
    if (
      lower.includes("eyebrow") ||
      lower.includes("kicker") ||
      lower.includes("suptitle")
    ) {
      helpers.add("Text")
      return `${pad}<Text fields={fields} ${fieldPathAttribute(fieldPath)} as="p" className="text-caption font-medium uppercase tracking-widest text-brand" ctx={ctx} />`
    }
    if (
      lower.includes("description") ||
      lower.includes("subtitle") ||
      lower.includes("dek")
    ) {
      helpers.add("Text")
      return `${pad}<Text fields={fields} ${fieldPathAttribute(fieldPath)} as="p" className="max-w-prose-content text-lead text-on-surface-muted" ctx={ctx} />`
    }
    helpers.add("Text")
    const className = name === "title"
      ? "max-w-content text-display font-black text-on-surface"
      : "max-w-prose-content text-body text-on-surface-muted"
    return `${pad}<Text fields={fields} ${fieldPathAttribute(fieldPath)} as="p" className="${className}" ctx={ctx} />`
  }
  if (spec.kind === "richText") {
    helpers.add("RichText")
    const { contract } = resolveFieldContract(spec.config)
    if (contract === "title")
      return `${pad}<RichText fields={fields} ${fieldPathAttribute(fieldPath)} ctx={ctx} className="max-w-content text-display font-black text-on-surface" />`
    const className =
      lower.includes("description") ||
      lower.includes("subtitle") ||
      lower.includes("body")
        ? ` className="max-w-prose-content text-lead text-on-surface-muted"`
        : ""
    return `${pad}<RichText fields={fields} ${fieldPathAttribute(fieldPath)} as="${contract === "inline" ? "span" : "div"}" ctx={ctx}${className} />`
  }
  if (spec.kind === "image") {
    helpers.add("KitImage")
    return `${pad}<KitImage fields={fields} ${fieldPathAttribute(fieldPath)} className="max-w-full rounded-md object-cover" ctx={ctx} />`
  }
  if (spec.kind === "relation") {
    return `${pad}{${access}?.pageId && ctx.relationCards?.[${access}.pageId] && (\n${pad}  <article className="space-y-1 rounded-md border p-4">\n${pad}    <p className="text-xs font-medium uppercase text-muted-foreground">{ctx.relationCards[${access}.pageId]?.pageType}</p>\n${pad}    <p className="font-semibold">{ctx.relationCards[${access}.pageId]?.title}</p>\n${pad}    {ctx.relationCards[${access}.pageId]?.excerpt && (\n${pad}      <p className="text-sm text-muted-foreground">{ctx.relationCards[${access}.pageId]?.excerpt}</p>\n${pad}    )}\n${pad}  </article>\n${pad})}`
  }
  if (spec.kind === "date" || spec.kind === "datetime") {
    return `${pad}{${access} && <time className="text-sm text-muted-foreground" dateTime={${access}}>{new Intl.DateTimeFormat(ctx.locale).format(new Date(${access}))}</time>}`
  }
  if (spec.kind === "geopoint") {
    return `${pad}{${access} && <p className="text-sm text-muted-foreground">{${access}.lat}, {${access}.lng}</p>}`
  }
  if (spec.kind === "embed") {
    return `${pad}{${access}?.url && <a className="text-sm font-medium underline underline-offset-4" href={${access}.url}>{${access}.title ?? ${access}.url}</a>}`
  }
  if (spec.kind === "table") {
    return `${pad}{${access}?.rows?.length > 0 && (\n${pad}  <div className="overflow-x-auto">\n${pad}    <table className="min-w-full border-collapse text-sm">\n${pad}      {${access}.headerRow && (\n${pad}        <thead>\n${pad}          <tr>{${access}.headerRow.map((cell, index) => <th key={index} className="border px-3 py-2 text-left">{cell}</th>)}</tr>\n${pad}        </thead>\n${pad}      )}\n${pad}      <tbody>\n${pad}        {${access}.rows.map((row, rowIndex) => (\n${pad}          <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border px-3 py-2">{cell}</td>)}</tr>\n${pad}        ))}\n${pad}      </tbody>\n${pad}    </table>\n${pad}  </div>\n${pad})}`
  }
  return ""
}

/** Indent every line of `body` by `spaces` columns. The model may emit the JSX
 *  starting at column 0; the boilerplate wraps it at the function-body indent. */
function indentBody(body: string, spaces: number): string {
  const prefix = " ".repeat(spaces)
  return body
    .split("\n")
    .map((line) => (line.length === 0 ? line : prefix + line))
    .join("\n")
}

/** Detect which render-helpers the model-emitted body uses, so the wrapper
 *  emits the right import line. Cheap surface scan — the verify gate catches
 *  references that don't resolve. */
const HELPER_NAMES = [
  "RichText",
  "Text",
  "Buttons",
  "KitImage",
  "RichTextContent",
  "SliceImage",
  "SliceButtons",
  "SliceIcon",
] as const

const HELPER_REGEXPS = new Map(
  HELPER_NAMES.map((name) => [name, new RegExp(`<${name}\\b`)])
)

/** True when a select field's options are (a subset of) the curated icon set,
 *  i.e. the field should render through <SliceIcon> rather than as text. */
function isIconSelect(field: FieldSpec): boolean {
  return (
    field.kind === "select" &&
    field.config.options.length > 0 &&
    field.config.options.every((o) =>
      (SLICE_ICON_NAMES as readonly string[]).includes(o)
    )
  )
}
function helpersUsedIn(body: string): Set<string> {
  const used = new Set<string>()
  for (const helper of HELPER_NAMES) {
    if (HELPER_REGEXPS.get(helper)!.test(body)) used.add(helper)
  }
  return used
}

function buildRenderer(spec: SliceSpec, customBody?: string): string {
  const pascal = toPascal(spec.type)
  const camel = toCamel(spec.type)
  const helpers = new Set<string>()

  if (customBody) {
    for (const h of helpersUsedIn(customBody)) helpers.add(h)
    return [
      `import type { ${pascal}Slice } from "@/convex/lib/slices"`,
      `import type { SliceRenderContext } from "@/lib/slices/links"`,
      `import { ${camel}Def } from "@/convex/lib/slices"`,
      `import { bindSliceFields${
        [...helpers].some((name) =>
          ["RichText", "Text", "Buttons", "KitImage"].includes(name)
        )
          ? `, ${[...helpers]
              .filter((name) =>
                ["RichText", "Text", "Buttons", "KitImage"].includes(name)
              )
              .sort()
              .join(", ")}`
          : ""
      } } from "@/components/slice-kit"`,
      ...([...helpers].some((name) =>
        ["RichTextContent", "SliceImage", "SliceButtons", "SliceIcon"].includes(
          name
        )
      )
        ? [
            `import { ${[...helpers]
              .filter((name) =>
                [
                  "RichTextContent",
                  "SliceImage",
                  "SliceButtons",
                  "SliceIcon",
                ].includes(name)
              )
              .sort()
              .join(", ")} } from "./render-helpers"`,
          ]
        : []),
      ``,
      `// Renderer authored by the slice-renderer agent (ADR-0016, Phase 2).`,
      `export function ${pascal}({`,
      `  slice,`,
      `  ctx,`,
      `}: {`,
      `  slice: ${pascal}Slice`,
      `  ctx: SliceRenderContext`,
      `}) {`,
      `  const fields = bindSliceFields(${camel}Def, slice)`,
      `  const { primary } = slice`,
      `  const content = (`,
      indentBody(customBody.trim(), 4),
      `  )`,
      `  return ctx.previewKitSlice ? ctx.previewKitSlice(content) : content`,
      `}`,
      ``,
    ].join("\n")
  }

  const primaryJsx = Object.entries(spec.primary.fields)
    .flatMap(([name, field]) => {
      const jsx = emitFieldJsx(name, field, helpers)
      return jsx ? [jsx] : []
    })
    .join("\n")

  // items: a list of `button` ref renders via SliceButtons; any other list maps
  // its rows and renders each item's text/richText/image fields generically.
  let itemsJsx = ""
  if (spec.items) {
    if (spec.items.item.kind === "ref" && spec.items.item.ref === "button") {
      helpers.add("Buttons")
      itemsJsx = `        <Buttons fields={fields} fieldPath="items" ctx={ctx} className="pt-3" />`
    } else if (spec.items.item.kind === "group") {
      const itemFields = Object.entries(spec.items.item.fields)
        .flatMap(([name, field]): string[] => {
          const access = `item.${name}`
          if (isIconSelect(field)) {
            helpers.add("SliceIcon")
            return [
              `              <SliceIcon name={${access}} className="size-5 text-brand" />`,
            ]
          }
          if (field.kind === "text") {
            helpers.add("Text")
            return [
              `              <Text fields={fields} fieldPath={\`items[\${index}].${name}\`} as="p" className="font-medium" ctx={ctx} />`,
            ]
          }
          if (field.kind === "richText") {
            helpers.add("RichText")
            return [
              `              <RichText fields={fields} fieldPath={\`items[\${index}].${name}\`} ctx={ctx} />`,
            ]
          }
          if (field.kind === "image") {
            helpers.add("KitImage")
            return [
              `              <KitImage fields={fields} fieldPath={\`items[\${index}].${name}\`} ctx={ctx} />`,
            ]
          }
          if (field.kind === "relation") {
            return [
              `              {${access}?.pageId && ctx.relationCards?.[${access}.pageId] && (\n                <div className="space-y-1">\n                  <p className="text-xs font-medium uppercase text-muted-foreground">{ctx.relationCards[${access}.pageId]?.pageType}</p>\n                  <p className="font-medium">{ctx.relationCards[${access}.pageId]?.title}</p>\n                  {ctx.relationCards[${access}.pageId]?.excerpt && (\n                    <p className="text-sm text-muted-foreground">{ctx.relationCards[${access}.pageId]?.excerpt}</p>\n                  )}\n                </div>\n              )}`,
            ]
          }
          if (field.kind === "date" || field.kind === "datetime") {
            return [
              `              {${access} && <time className="text-sm text-muted-foreground" dateTime={${access}}>{new Intl.DateTimeFormat(ctx.locale).format(new Date(${access}))}</time>}`,
            ]
          }
          if (field.kind === "geopoint") {
            return [
              `              {${access} && <p className="text-sm text-muted-foreground">{${access}.lat}, {${access}.lng}</p>}`,
            ]
          }
          if (field.kind === "embed") {
            return [
              `              {${access}?.url && <a className="text-sm font-medium underline underline-offset-4" href={${access}.url}>{${access}.title ?? ${access}.url}</a>}`,
            ]
          }
          if (field.kind === "table") {
            return [
              `              {${access}?.rows?.length > 0 && <p className="text-sm text-muted-foreground">{${access}.rows.length} table rows</p>}`,
            ]
          }
          return []
        })
        .join("\n")
      itemsJsx = `        <div className="grid gap-stack sm:grid-cols-2 lg:grid-cols-3">\n          {slice.items.map((item, index) => (\n            <article key={index} className="space-y-2 rounded-md border bg-surface-2 p-4 text-on-surface">\n${itemFields}\n            </article>\n          ))}\n        </div>`
    }
  }

  const innerBody = [primaryJsx, itemsJsx].filter(Boolean).join("\n")
  const kitHelpers = [...helpers]
    .filter((name) =>
      ["RichText", "Text", "Buttons", "KitImage"].includes(name)
    )
    .sort()
  const legacyHelpers = [...helpers]
    .filter((name) =>
      ["RichTextContent", "SliceImage", "SliceButtons", "SliceIcon"].includes(
        name
      )
    )
    .sort()
  return [
    `import type { ${pascal}Slice } from "@/convex/lib/slices"`,
    `import type { SliceRenderContext } from "@/lib/slices/links"`,
    `import { ${camel}Def } from "@/convex/lib/slices"`,
    `import { bindSliceFields${kitHelpers.length ? `, ${kitHelpers.join(", ")}` : ""} } from "@/components/slice-kit"`,
    ...(legacyHelpers.length
      ? [`import { ${legacyHelpers.join(", ")} } from "./render-helpers"`]
      : []),
    ``,
    `// TODO(ADR-0016): scaffolded renderer; close-enough first pass from snapshot.`,
    `// Replace with the designed JSX/Tailwind after reviewing the generated model.`,
    `export function ${pascal}({`,
    `  slice,`,
    `  ctx,`,
    `}: {`,
    `  slice: ${pascal}Slice`,
    `  ctx: SliceRenderContext`,
    `}) {`,
    `  const fields = bindSliceFields(${camel}Def, slice)`,
    `  const { primary } = slice`,
    `  const content = (`,
    `    <section className="bg-surface px-gutter py-section">`,
    `      <div className="mx-auto flex max-w-content flex-col items-start gap-stack text-left">`,
    innerBody,
    `      </div>`,
    `    </section>`,
    `  )`,
    `  return ctx.previewKitSlice ? ctx.previewKitSlice(content) : content`,
    `}`,
    ``,
  ].join("\n")
}

/** Emit every mechanical artifact for a slice from its field-set spec.
 *  When `customRendererBody` is supplied, the renderer is wrapped around that
 *  model-authored JSX body (ADR-0016, Phase 2); otherwise the deterministic
 *  vertical scaffold is emitted. */
export function scaffoldSlice(
  spec: SliceSpec,
  options: { customRendererBody?: string } = {}
): ScaffoldOutput {
  const camel = toCamel(spec.type)
  return {
    descriptorPath: `convex/lib/slices/${camel}.ts`,
    descriptorSource: buildDescriptor(spec),
    rendererPath: `components/slices/${spec.type}.tsx`,
    rendererSource: buildRenderer(spec, options.customRendererBody),
  }
}
