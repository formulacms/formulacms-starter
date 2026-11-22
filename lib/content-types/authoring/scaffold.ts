import type { ContentTypeManifestEntry } from "./manifest"
import type { ContentFieldSpec, ContentTypeSpec } from "./spec"

export type ContentTypeScaffold = {
  descriptorPath: string
  descriptorSource: string
  /** Emitted only when the spec asks for a custom renderer. */
  rendererPath?: string
  rendererSource?: string
  manifestEntry: ContentTypeManifestEntry
}

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
] as const

function toCamel(type: string): string {
  return type.replace(/-([a-z0-9])/g, (_, character: string) =>
    character.toUpperCase()
  )
}

const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function emitKey(key: string): string {
  return VALID_IDENTIFIER.test(key) ? key : JSON.stringify(key)
}

function emitValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => emitValue(item)).join(", ")}]`
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => `${emitKey(key)}: ${emitValue(child)}`)
    return `{ ${entries.join(", ")} }`
  }
  return "undefined"
}

function emitConfig(config: Record<string, unknown> | undefined): string {
  if (!config) return ""
  const kept = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined)
  )
  return Object.keys(kept).length === 0 ? "" : emitValue(kept)
}

function emitModifiers(field: ContentFieldSpec): string {
  return `${field.optional ? ".optional()" : ""}${
    field.public ? ".public()" : ""
  }`
}

function emitField(field: ContentFieldSpec, indent = 0): string {
  const modifiers = emitModifiers(field)
  switch (field.kind) {
    case "text":
      return `text(${emitConfig(field.config)})${modifiers}`
    case "richText":
      return `richText(${emitConfig(field.config)})${modifiers}`
    case "image":
      return `image()${modifiers}`
    case "link":
      return `link()${modifiers}`
    case "geopoint":
      return `geopoint()${modifiers}`
    case "boolean":
      return `boolean(${emitConfig(field.config)})${modifiers}`
    case "select":
      return `select(${emitConfig(field.config)})${modifiers}`
    case "number":
      return `number(${emitConfig(field.config)})${modifiers}`
    case "date":
      return `date(${emitConfig(field.config)})${modifiers}`
    case "datetime":
      return `datetime(${emitConfig(field.config)})${modifiers}`
    case "embed":
      return `embed(${emitConfig(field.config)})${modifiers}`
    case "table":
      return `table(${emitConfig(field.config)})${modifiers}`
    case "relation":
      return `relation(${emitConfig(field.config)})${modifiers}`
    case "group": {
      const padding = " ".repeat(indent)
      const fields = Object.entries(field.fields)
        .map(
          ([name, child]) =>
            `${" ".repeat(indent + 2)}${name}: ${emitField(child, indent + 2)},`
        )
        .join("\n")
      return `group({\n${fields}\n${padding}})${modifiers}`
    }
    case "list": {
      const config = emitConfig(field.config)
      return `list(${emitField(field.item, indent)}${
        config ? `, ${config}` : ""
      })${modifiers}`
    }
  }
}

function collectFactories(
  field: ContentFieldSpec,
  factories: Set<string>
): void {
  factories.add(field.kind)
  if (field.kind === "group") {
    for (const child of Object.values(field.fields)) {
      collectFactories(child, factories)
    }
  }
  if (field.kind === "list") collectFactories(field.item, factories)
}

function emitFieldMap(fields: Record<string, ContentFieldSpec>): string {
  const body = Object.entries(fields)
    .map(([name, field]) => `  ${name}: ${emitField(field, 2)},`)
    .join("\n")
  return `{\n${body}\n}`
}

function emitValidatorMap(
  fields: Record<string, ContentFieldSpec>,
  variable: "sharedFields" | "localizedFields"
): string {
  const body = Object.keys(fields)
    .map((name) => `    ${name}: ${variable}.${name}.validator,`)
    .join("\n")
  return `v.object({\n${body}\n  })`
}

function fieldExpression(pointer: {
  scope: "shared" | "localized"
  field: string
}): string {
  return pointer.scope === "shared"
    ? `(doc as Record<string, unknown>)[${JSON.stringify(pointer.field)}]`
    : `localized?.[${JSON.stringify(pointer.field)}]`
}

function buildDescriptor(spec: ContentTypeSpec): string {
  const camel = toCamel(spec.type)
  const exportName = `${camel}ContentType`
  const factories = new Set<string>()
  for (const field of Object.values(spec.sharedFields)) {
    collectFactories(field, factories)
  }
  for (const field of Object.values(spec.localizedFields)) {
    collectFactories(field, factories)
  }
  const primitiveImports = FACTORY_ORDER.filter((factory) =>
    factories.has(factory)
  ).join(", ")
  const english = spec.labels.en
  const titleExpression = fieldExpression(spec.referenceCard.title)
  const subtitleExpression = spec.referenceCard.subtitle
    ? fieldExpression(spec.referenceCard.subtitle)
    : undefined
  const href = spec.routing
    ? `status === "published" && slug\n        ? \`/\${locale}/${spec.routing.pathPrefix}/\${slug}\`\n        : undefined`
    : "undefined"

  return [
    `import { v } from "convex/values"`,
    `import { ${primitiveImports} } from "../blocks/primitives"`,
    `import type { ContentTypeDescriptor } from "./types"`,
    ``,
    `const sharedFields = ${emitFieldMap(spec.sharedFields)} as const`,
    ``,
    `const localizedFields = ${emitFieldMap(spec.localizedFields)} as const`,
    ``,
    `export const ${exportName}: ContentTypeDescriptor<`,
    `  typeof sharedFields,`,
    `  typeof localizedFields`,
    `> = {`,
    `  type: ${JSON.stringify(spec.type)},`,
    `  label: ${emitValue(english)},`,
    `  sharedFields,`,
    `  localizedFields,`,
    `  sharedValidator: ${emitValidatorMap(
      spec.sharedFields,
      "sharedFields"
    )},`,
    `  localizedValidator: ${emitValidatorMap(
      spec.localizedFields,
      "localizedFields"
    )},`,
    ...(spec.routing
      ? [
          `  routing: { pathPrefix: ${JSON.stringify(
            spec.routing.pathPrefix
          )} },`,
        ]
      : []),
    ...(spec.seo ? [`  seo: ${emitValue(spec.seo)},`] : []),
    `  capabilities: ${emitValue(spec.capabilities)},`,
    `  referenceCard: (doc, locale) => {`,
    `    const content = (doc as {`,
    `      content?: Record<string, Record<string, unknown>>`,
    `    }).content`,
    `    const localized = content?.[locale]`,
    `    const titleValue = ${titleExpression}`,
    `    const title =`,
    `      typeof titleValue === "string" && titleValue.trim().length > 0`,
    `        ? titleValue`,
    `        : ${JSON.stringify(`Untitled ${english.singular.toLowerCase()}`)}`,
    ...(subtitleExpression
      ? [
          `    const subtitleValue = ${subtitleExpression}`,
          `    const subtitle =`,
          `      typeof subtitleValue === "string" && subtitleValue.trim().length > 0`,
          `        ? subtitleValue`,
          `        : undefined`,
        ]
      : []),
    `    const slug = (doc as { slug?: string }).slug ?? ""`,
    `    const status = (doc as { status?: string }).status`,
    `    return {`,
    `      id: doc._id,`,
    `      type: ${JSON.stringify(spec.type)},`,
    `      title,`,
    ...(subtitleExpression ? [`      subtitle,`] : []),
    `      href: ${href},`,
    `    }`,
    `  },`,
    ...(spec.aiHint ? [`  aiHint: ${emitValue(spec.aiHint)},`] : []),
    `}`,
    ``,
  ].join("\n")
}

/** `job` → `Job`, `landing-page` → `LandingPage`. */
function toPascal(type: string): string {
  const camel = toCamel(type)
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

/** `salaryMin` → `Salary min`. A starting label the author will rewrite. */
function humanizeFieldKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Field kinds the stub can render without inventing copy or layout.
 *
 * Booleans are deliberately absent: rendering one requires deciding what
 * true and false *say* ("Yes"/"No", "Remote"/"On-site"), which is an editorial
 * choice the generator has no basis for. Media, links, relations, and the
 * container kinds need a layout decision for the same reason. Both groups are
 * named in the stub's TODO instead of being guessed at.
 */
const STUB_RENDERABLE_KINDS = new Set([
  "text",
  "select",
  "number",
  "date",
  "datetime",
])

/** The universal metadata every type carries; not type-specific surface. */
const UNIVERSAL_LOCALIZED_FIELDS = new Set([
  "title",
  "metaTitle",
  "metaDescription",
])

type StubField = {
  key: string
  kind: ContentFieldSpec["kind"]
  scope: "shared" | "localized"
  accessor: string
}

function stubFields(
  fields: Record<string, ContentFieldSpec>,
  scope: "shared" | "localized"
): StubField[] {
  return Object.entries(fields).flatMap(([key, field]) => {
    if (scope === "localized" && UNIVERSAL_LOCALIZED_FIELDS.has(key)) return []
    if (!field.public) return []
    return [
      {
        key,
        kind: field.kind,
        scope,
        accessor: scope === "shared" ? `page.${key}` : `localized.${key}`,
      },
    ]
  })
}

function stubRow(field: StubField, exportName: string): string[] {
  // A `select` is a union of its options and a `number` is a number, so
  // comparing either to "" is a type error, not a defensive check. Only the
  // string-backed kinds can arrive empty.
  const guard =
    field.kind === "number" || field.kind === "select"
      ? `${field.key} !== undefined`
      : `${field.key} !== undefined && ${field.key} !== ""`
  const value =
    field.kind === "select"
      ? `selectLabel(${exportName}.${field.scope}Fields.${field.key}, ${field.key})`
      : field.key
  return [
    `        {${guard} && (`,
    `          <div>`,
    `            <dt className="text-muted-foreground">${humanizeFieldKey(
      field.key
    )}</dt>`,
    `            <dd>{${value}}</dd>`,
    `          </div>`,
    `        )}`,
  ]
}

/**
 * A custom renderer that is compliant on arrival.
 *
 * The 2026-08-06 product audit found every one of its renderer findings on the
 * hand-written half of this pipeline, because that half had a generator for
 * the descriptor and nothing for the renderer. This emits the shape the
 * renderer-contract check in `verify.ts` enforces — the exposure gate, option
 * labels read off the descriptor, one stable native root — so the starting
 * point cannot be the thing the check rejects.
 *
 * What it deliberately does not do is guess at design. The body is the type's
 * own public fields in a flat list plus the block canvas; anything needing an
 * editorial or layout decision is left as a named TODO rather than invented
 * here and then inherited by every type that follows.
 */
function buildRenderer(spec: ContentTypeSpec): string {
  const moduleName = toCamel(spec.type)
  const exportName = `${moduleName}ContentType`
  const component = `${toPascal(spec.type)}Renderer`
  const blockBody = spec.capabilities.blockBody

  const shared = stubFields(spec.sharedFields, "shared")
  const localized = stubFields(spec.localizedFields, "localized")
  const renderable = [...shared, ...localized].filter((field) =>
    STUB_RENDERABLE_KINDS.has(field.kind)
  )
  const deferred = [...shared, ...localized].filter(
    (field) => !STUB_RENDERABLE_KINDS.has(field.kind)
  )
  const hasSelect = renderable.some((field) => field.kind === "select")
  const usesLocalized = renderable.some((field) => field.scope === "localized")
  const contentType = `${toPascal(spec.type)}Content`

  // A pure-form renderer reads `page.content?.[locale]` off an already
  // narrowed `page`, so it needs no content alias. Only the block-body arm
  // does, where `content` arrives as its own union-typed prop.
  const needsContentAlias = blockBody && usesLocalized

  const imports = [
    ...(blockBody
      ? [
          `import { BlockList } from "@/components/blocks/block-list"`,
          `import { resolvePageOutline } from "@/lib/blocks/page-outline"`,
        ]
      : []),
    ...(needsContentAlias
      ? [`import type { Doc } from "@/convex/_generated/dataModel"`]
      : []),
    ...(shared.length > 0 || localized.length > 0
      ? [
          `import { ${exportName} } from "@/convex/lib/contentTypes/${moduleName}"`,
          `import { publicFieldsOf } from "@/convex/lib/contentTypes/exposure"`,
        ]
      : []),
    `import type { ${
      blockBody ? "BlockBodyRendererProps" : "PureFormRendererProps"
    } } from "./types"`,
  ]

  const localizedTypes = needsContentAlias
    ? [
        ``,
        `type ${toPascal(spec.type)}Arm = Doc<"pages"> & { pageType: ${JSON.stringify(
          spec.type
        )} }`,
        `type ${contentType} = NonNullable<${toPascal(
          spec.type
        )}Arm["content"]>[string]`,
      ]
    : []

  const selectHelper = hasSelect
    ? [
        ``,
        `/**`,
        ` * Option labels come off the descriptor's \`select()\` config — the same`,
        ` * source the admin editor reads. Restating them here would let a new option`,
        ` * render as a blank on the public page while looking correct in the admin.`,
        ` */`,
        `function selectLabel(`,
        `  field: { config: Record<string, unknown> },`,
        `  value: string`,
        `): string {`,
        `  const labels = field.config.labels`,
        `  if (labels && typeof labels === "object") {`,
        `    const label = (labels as Record<string, unknown>)[value]`,
        `    if (typeof label === "string") return label`,
        `  }`,
        `  return value`,
        `}`,
      ]
    : []

  const docblock = [
    ``,
    `/**`,
    ` * Public renderer for \`${spec.type}\`.`,
    ` *`,
    ` * TODO — say in one sentence what this type is for editorially, and record`,
    ` * the ADR-0039 justification it was created under: its own URL, propagating`,
    ` * reuse, set semantics, or an independent lifecycle.`,
    ...(shared.length > 0 || localized.length > 0
      ? [
          ` *`,
          ` * ADR-0038: every descriptor field is read through \`publicFieldsOf\`, so`,
          ` * removing \`.public()\` from a field drops it from the page instead of`,
          ` * continuing to render it. Keep new fields on that path.`,
        ]
      : []),
    ...(deferred.length > 0
      ? [
          ` *`,
          ` * TODO — the scaffold left these fields unrendered because each needs a`,
          ` * layout or copy decision it has no basis to make: ${deferred
            .map((field) => `${field.key} (${field.kind})`)
            .join(", ")}.`,
        ]
      : []),
    ` */`,
  ]

  const props = blockBody
    ? `{ page, content, blocks, ctx }: BlockBodyRendererProps`
    : `{ page, renderLocale, defaultLocale }: PureFormRendererProps`

  // Both arms narrow: `page` arrives as the whole `Doc<"pages">` union on the
  // pure-form side too, and the type-specific fields are unreadable until it
  // is narrowed.
  const body: string[] = [
    `  if (page.pageType !== ${JSON.stringify(spec.type)}) return null`,
  ]
  if (usesLocalized) {
    if (blockBody) {
      body.push(
        ``,
        `  // \`page\` narrows on the guard above. \`content\` cannot — it arrives as`,
        `  // its own prop, typed as the union across every block-body arm, so the`,
        `  // type-specific fields need this cast to be readable.`,
        `  const localized = content as ${contentType}`
      )
    } else {
      body.push(
        ``,
        `  const localized =`,
        `    page.content?.[renderLocale] ?? page.content?.[defaultLocale]`,
        `  if (!localized) return null`
      )
    }
  }
  if (shared.length > 0) {
    body.push(
      ``,
      `  const publicShared = publicFieldsOf(${exportName}.sharedFields)`
    )
  }
  if (localized.length > 0) {
    body.push(
      `  const publicLocalized = publicFieldsOf(${exportName}.localizedFields)`
    )
  }
  if (renderable.length > 0) body.push(``)
  for (const field of renderable) {
    const map = field.scope === "shared" ? "publicShared" : "publicLocalized"
    body.push(
      `  const ${field.key} =`,
      `    ${JSON.stringify(field.key)} in ${map} ? ${field.accessor} : undefined`
    )
  }

  const heading = [
    `      <header className="mx-auto max-w-content px-gutter pt-gutter">`,
    `        <h1 className="text-3xl font-semibold">{${
      blockBody ? "content.title" : "localized.title"
    }}</h1>`,
    `      </header>`,
  ]
  const list =
    renderable.length > 0
      ? [
          `      {/* TODO — lay these out for the design. The scaffold lists every`,
          `          public field so none of them is invisible on day one. */}`,
          `      <dl className="mx-auto max-w-content px-gutter pt-gutter">`,
          ...renderable.flatMap((field) => stubRow(field, exportName)),
          `      </dl>`,
        ]
      : []

  return [
    ...imports,
    ...localizedTypes,
    ...selectHelper,
    ...docblock,
    `export function ${component}(${props}) {`,
    ...body,
    ``,
    `  return (`,
    `    <div>`,
    ...(blockBody || usesLocalized ? heading : []),
    ...list,
    ...(blockBody
      ? [
          `      <BlockList blocks={blocks} ctx={ctx} outline={resolvePageOutline({ blocks, locale: ctx.locale, mode: "owned" })} />`,
        ]
      : []),
    `    </div>`,
    `  )`,
    `}`,
    ``,
  ].join("\n")
}

/**
 * Which renderer a spec gets.
 *
 * `default` is only meaningful for a block-body type — that is the one arm
 * with a shared fallback (`components/blocks/_shared/default-block-body.tsx`).
 * A pure-form type has no fallback to fall back to, so a routable one without
 * a custom renderer would generate a tree that immediately fails its own
 * verifier (`rendererRegistrationErrors`). Rather than emit that and let the
 * author discover it, a routable pure-form type defaults to a custom renderer.
 */
export function resolveRendererChoice(
  spec: ContentTypeSpec
): "default" | "custom" | "none" {
  if (spec.renderer === "custom") return "custom"
  if (spec.capabilities.blockBody) return "default"
  if (spec.routing) {
    if (spec.renderer === "default") {
      throw new Error(
        `Content type "${spec.type}" is routable and has no block body, so it cannot use the shared renderer — there is no pure-form fallback. Set "renderer": "custom".`
      )
    }
    return "custom"
  }
  return "none"
}

export function scaffoldContentType(
  spec: ContentTypeSpec
): ContentTypeScaffold {
  const moduleName = toCamel(spec.type)
  const choice = resolveRendererChoice(spec)
  const custom = choice === "custom"
  return {
    descriptorPath: `convex/lib/contentTypes/${moduleName}.ts`,
    descriptorSource: buildDescriptor(spec),
    ...(custom
      ? {
          rendererPath: `components/content-types/${spec.type}.tsx`,
          rendererSource: buildRenderer(spec),
        }
      : {}),
    manifestEntry: {
      type: spec.type,
      module: moduleName,
      exportName: `${moduleName}ContentType`,
      labels: spec.labels,
      selected: true,
      blockBody: spec.capabilities.blockBody,
      ...(spec.routing ? { pathPrefix: spec.routing.pathPrefix } : {}),
      renderer: custom
        ? spec.capabilities.blockBody
          ? "custom-block-body"
          : "custom-pure-form"
        : choice === "default"
          ? "default-block-body"
          : "none",
      ...(custom
        ? {
            rendererModule: `./${spec.type}`,
            rendererExport: `${toPascal(spec.type)}Renderer`,
          }
        : {}),
      sharedFieldKeys: Object.keys(spec.sharedFields),
      localizedFieldKeys: Object.keys(spec.localizedFields),
    },
  }
}
