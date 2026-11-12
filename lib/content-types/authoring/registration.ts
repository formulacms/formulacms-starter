import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ContentTypeManifestEntry } from "./manifest"

export const CONTENT_TYPE_MANIFEST_PATH =
  "convex/lib/contentTypes/content-types.manifest.json"

type RegistrationFile =
  | "index"
  | "pageTypes"
  | "schema"
  | "inputShapes"
  | "selection"
  | "renderers"

const FILE_PATHS: Record<RegistrationFile, string> = {
  index: "convex/lib/contentTypes/index.ts",
  pageTypes: "convex/lib/pages/types.ts",
  schema: "convex/schema.ts",
  inputShapes: "convex/lib/contentTypes/inputShapes.ts",
  selection: "convex/lib/contentTypes/starterSelection.ts",
  renderers: "components/content-types/index.ts",
}

const ALL_FILES = Object.keys(FILE_PATHS) as RegistrationFile[]

function objectKey(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
    ? value
    : JSON.stringify(value)
}

function literalUnion(types: string[]): string {
  return types.map((type) => JSON.stringify(type)).join(" | ")
}

function validatorArms(entries: ContentTypeManifestEntry[]): string {
  return entries
    .map((entry) => `  v.literal(${JSON.stringify(entry.type)})`)
    .join(",\n")
}

export function renderContentTypeIndexRegions(
  entries: ContentTypeManifestEntry[]
) {
  const imports = entries
    .map(
      (entry) =>
        `import { ${entry.exportName} } from "./${entry.module}"`
    )
    .join("\n")
  const definitions = [
    "export const contentTypeDefs = {",
    ...entries.map(
      (entry) =>
        `  ${objectKey(entry.type)}: ${entry.exportName},`
    ),
    "} as const satisfies Record<string, ContentTypeDescriptor>",
  ].join("\n")
  const validator = [
    "export const contentTypeValidator = v.union(",
    validatorArms(entries),
    ")",
  ].join("\n")
  const union = literalUnion(entries.map((entry) => entry.type))
  const guard = [
    `type _RegisteredContentType = ${union}`,
    "type _RegistryMatchesValidator = keyof typeof contentTypeDefs extends",
    "  _RegisteredContentType",
    "  ? _RegisteredContentType extends keyof typeof contentTypeDefs",
    "    ? true",
    "    : never",
    "  : never",
    "const _registryValidatorGuard: _RegistryMatchesValidator = true",
    "void _registryValidatorGuard",
  ].join("\n")
  return { imports, definitions, validator, guard }
}

export function renderPageTypeRegions(
  entries: ContentTypeManifestEntry[]
) {
  const values = entries
    .map((entry) => `  ${JSON.stringify(entry.type)},`)
    .join("\n")
  return {
    pageTypes: `export const PAGE_TYPES = [\n${values}\n] as const`,
    validator: [
      "export const pageTypeValidator = v.union(",
      validatorArms(entries),
      ")",
    ].join("\n"),
  }
}

function localizedValidator(
  entry: ContentTypeManifestEntry
): string {
  return entry.sliceBody
    ? `armLocalizedContentValidator(${entry.exportName})`
    : `armLocalizedContentValidatorNoSlices(${entry.exportName})`
}

function armName(entry: ContentTypeManifestEntry): string {
  return `${entry.module}ArmFields`
}

function stagingArmName(entry: ContentTypeManifestEntry): string {
  return `${entry.module}StagingArmFields`
}

function renderLiveArm(entry: ContentTypeManifestEntry): string {
  return [
    `export const ${armName(entry)} = {`,
    "  ...systemPageFields,",
    `  ...${entry.exportName}.sharedValidator.fields,`,
    `  pageType: v.literal(${JSON.stringify(entry.type)}),`,
    "  content: v.optional(",
    `    v.record(v.string(), ${localizedValidator(entry)})`,
    "  ),",
    "} as const",
  ].join("\n")
}

function renderStagingArm(entry: ContentTypeManifestEntry): string {
  return [
    `export const ${stagingArmName(entry)} = {`,
    "  ...stagingBookkeepingFields,",
    "  ...stagingSystemFields,",
    `  ...optionalizeSharedFieldsForStaging(${entry.exportName}.sharedValidator.fields),`,
    `  pageType: v.literal(${JSON.stringify(entry.type)}),`,
    "  content: v.optional(",
    `    v.record(v.string(), ${localizedValidator(entry)})`,
    "  ),",
    "} as const",
  ].join("\n")
}

function renderSimpleUnion(
  name: string,
  entries: ContentTypeManifestEntry[],
  arm: (entry: ContentTypeManifestEntry) => string
): string {
  return [
    `export const ${name} = v.union(`,
    entries.map((entry) => `  v.object(${arm(entry)})`).join(",\n"),
    ")",
  ].join("\n")
}

function renderDocumentUnion(
  name: string,
  table: "pages" | "pageStaging",
  entries: ContentTypeManifestEntry[],
  arm: (entry: ContentTypeManifestEntry) => string
): string {
  return [
    `export const ${name} = v.union(`,
    entries
      .map(
        (entry) =>
          [
            "  v.object({",
            `    _id: v.id(${JSON.stringify(table)}),`,
            "    _creationTime: v.number(),",
            `    ...${arm(entry)},`,
            "  })",
          ].join("\n")
      )
      .join(",\n"),
    ")",
  ].join("\n")
}

export function renderSchemaRegions(
  entries: ContentTypeManifestEntry[]
) {
  return {
    imports: entries
      .map(
        (entry) =>
          `import { ${entry.exportName} } from "./lib/contentTypes/${entry.module}"`
      )
      .join("\n"),
    liveArms: entries.map(renderLiveArm).join("\n\n"),
    pagesTableValidator: renderSimpleUnion(
      "pagesTableValidator",
      entries,
      armName
    ),
    stagingArms: entries.map(renderStagingArm).join("\n\n"),
    pageStagingTableValidator: renderSimpleUnion(
      "pageStagingTableValidator",
      entries,
      stagingArmName
    ),
    pageStagingDocValidator: renderDocumentUnion(
      "pageStagingDocValidator",
      "pageStaging",
      entries,
      stagingArmName
    ),
    pageDocValidator: renderDocumentUnion(
      "pageDocValidator",
      "pages",
      entries,
      armName
    ),
    pageWithStagedOverlayValidator: [
      "export const pageWithStagedOverlayValidator = v.union(",
      entries
        .map(
          (entry) =>
            [
              "  v.object({",
              '    _id: v.id("pages"),',
              "    _creationTime: v.number(),",
              `    ...${armName(entry)},`,
              "    ...stagedOverlayExtras,",
              "  })",
            ].join("\n")
        )
        .join(",\n"),
      ")",
    ].join("\n"),
  }
}

function draftInputName(entry: ContentTypeManifestEntry): string {
  return `${entry.module}DraftInput`
}

function renderDraftInput(entry: ContentTypeManifestEntry): string {
  return [
    `const ${draftInputName(entry)} = v.object({`,
    `  pageType: v.literal(${JSON.stringify(entry.type)}),`,
    `  localized: ${entry.exportName}.localizedValidator,`,
    ...(entry.sliceBody ? ["  slices: v.array(sliceValidator),"] : []),
    "})",
  ].join("\n")
}

export function renderInputShapeRegions(
  entries: ContentTypeManifestEntry[]
) {
  const union = literalUnion(entries.map((entry) => entry.type))
  return {
    imports: entries
      .map(
        (entry) =>
          `import { ${entry.exportName} } from "./${entry.module}"`
      )
      .join("\n"),
    arms: entries.map(renderDraftInput).join("\n\n"),
    validator: [
      "export const contentDraftInputValidator = v.union(",
      entries
        .map((entry) => `  ${draftInputName(entry)}`)
        .join(",\n"),
      ")",
    ].join("\n"),
    guard: [
      `type _EnumeratedDraftArms = ${union}`,
      "",
      "type _DraftArmsMatchRegistry = _EnumeratedDraftArms extends ContentType",
      "  ? ContentType extends _EnumeratedDraftArms",
      "    ? true",
      "    : never",
      "  : never",
      "",
      "const _draftArmsGuard: _DraftArmsMatchRegistry = true",
      "void _draftArmsGuard",
    ].join("\n"),
  }
}

export function renderSelectionRegion(
  entries: ContentTypeManifestEntry[]
): string {
  const values = entries
    .filter((entry) => entry.selected)
    .map((entry) => `  ${JSON.stringify(entry.type)},`)
    .join("\n")
  return `export const STARTER_CONTENT_TYPES = [\n${values}\n] as const`
}

function rendererDetails(entry: ContentTypeManifestEntry): {
  kind: "sliceBody" | "pureForm"
  module: string
  component: string
} | null {
  if (!entry.selected || entry.renderer === "none") return null
  if (entry.renderer === "default-slice-body") {
    return {
      kind: "sliceBody",
      module: "@/components/slices/_shared/default-slice-body",
      component: "DefaultSliceBodyRenderer",
    }
  }
  if (!entry.rendererModule || !entry.rendererExport) {
    throw new Error(
      `Content type "${entry.type}" needs rendererModule and rendererExport.`
    )
  }
  return {
    kind:
      entry.renderer === "custom-pure-form"
        ? "pureForm"
        : "sliceBody",
    module: entry.rendererModule,
    component: entry.rendererExport,
  }
}

export function renderRendererRegions(
  entries: ContentTypeManifestEntry[]
) {
  const details = entries.flatMap((entry) => {
    const renderer = rendererDetails(entry)
    return renderer ? [{ entry, renderer }] : []
  })
  const imports = [
    ...new Map(
      details.map(({ renderer }) => [
        `${renderer.module}:${renderer.component}`,
        `import { ${renderer.component} } from ${JSON.stringify(
          renderer.module
        )}`,
      ])
    ).values(),
  ].join("\n")
  const registry = [
    "const contentTypeRenderers: Partial<",
    "  Record<ContentType, ContentTypeRenderer>",
    "> = {",
    ...details.map(
      ({ entry, renderer }) =>
        `  ${objectKey(entry.type)}: { kind: ${JSON.stringify(
          renderer.kind
        )}, Component: ${renderer.component} },`
    ),
    "}",
  ].join("\n")
  return { imports, registry }
}

const REGION_RENDERERS: Record<
  RegistrationFile,
  Array<
    [
      string,
      (entries: ContentTypeManifestEntry[]) => string,
    ]
  >
> = {
  index: [
    [
      "content-type-imports",
      (entries) => renderContentTypeIndexRegions(entries).imports,
    ],
    [
      "content-type-definitions",
      (entries) => renderContentTypeIndexRegions(entries).definitions,
    ],
    [
      "content-type-validator",
      (entries) => renderContentTypeIndexRegions(entries).validator,
    ],
    [
      "content-type-guard",
      (entries) => renderContentTypeIndexRegions(entries).guard,
    ],
  ],
  pageTypes: [
    [
      "page-types",
      (entries) => renderPageTypeRegions(entries).pageTypes,
    ],
    [
      "page-type-validator",
      (entries) => renderPageTypeRegions(entries).validator,
    ],
  ],
  schema: [
    [
      "schema-content-type-imports",
      (entries) => renderSchemaRegions(entries).imports,
    ],
    [
      "schema-live-arms",
      (entries) => renderSchemaRegions(entries).liveArms,
    ],
    [
      "schema-pages-table-validator",
      (entries) => renderSchemaRegions(entries).pagesTableValidator,
    ],
    [
      "schema-staging-arms",
      (entries) => renderSchemaRegions(entries).stagingArms,
    ],
    [
      "schema-page-staging-table-validator",
      (entries) =>
        renderSchemaRegions(entries).pageStagingTableValidator,
    ],
    [
      "schema-page-staging-doc-validator",
      (entries) =>
        renderSchemaRegions(entries).pageStagingDocValidator,
    ],
    [
      "schema-page-doc-validator",
      (entries) => renderSchemaRegions(entries).pageDocValidator,
    ],
    [
      "schema-page-with-staged-overlay-validator",
      (entries) =>
        renderSchemaRegions(entries).pageWithStagedOverlayValidator,
    ],
  ],
  inputShapes: [
    [
      "content-draft-imports",
      (entries) => renderInputShapeRegions(entries).imports,
    ],
    [
      "content-draft-arms",
      (entries) => renderInputShapeRegions(entries).arms,
    ],
    [
      "content-draft-validator",
      (entries) => renderInputShapeRegions(entries).validator,
    ],
    [
      "content-draft-guard",
      (entries) => renderInputShapeRegions(entries).guard,
    ],
  ],
  selection: [
    ["content-type-selection", renderSelectionRegion],
  ],
  renderers: [
    [
      "content-type-renderer-imports",
      (entries) => renderRendererRegions(entries).imports,
    ],
    [
      "content-type-renderers",
      (entries) => renderRendererRegions(entries).registry,
    ],
  ],
}

function replaceRegion(
  source: string,
  name: string,
  body: string
): string {
  const start = `// @content-type-codegen:${name}:start`
  const end = `// @content-type-codegen:${name}:end`
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end)
  if (
    startIndex === -1 ||
    endIndex === -1 ||
    endIndex < startIndex
  ) {
    throw new Error(`Missing @content-type-codegen region "${name}".`)
  }
  const before = source.slice(0, startIndex + start.length)
  const after = source.slice(endIndex)
  return `${before}\n${body}\n${after}`
}

export function renderContentTypeRegistrationFile(
  file: RegistrationFile,
  source: string,
  entries: ContentTypeManifestEntry[]
): string {
  let next = source
  for (const [name, render] of REGION_RENDERERS[file]) {
    next = replaceRegion(next, name, render(entries))
  }
  return next
}

function isManifestEntry(
  value: unknown
): value is ContentTypeManifestEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.type === "string" &&
    typeof entry.module === "string" &&
    typeof entry.exportName === "string" &&
    typeof entry.labels === "object" &&
    typeof entry.selected === "boolean" &&
    typeof entry.sliceBody === "boolean" &&
    (entry.pathPrefix === undefined ||
      typeof entry.pathPrefix === "string") &&
    (entry.renderer === "default-slice-body" ||
      entry.renderer === "custom-slice-body" ||
      entry.renderer === "custom-pure-form" ||
      entry.renderer === "none") &&
    Array.isArray(entry.sharedFieldKeys) &&
    Array.isArray(entry.localizedFieldKeys)
  )
}

export async function readContentTypeManifest(
  root = process.cwd()
): Promise<ContentTypeManifestEntry[]> {
  const source = await readFile(
    join(root, CONTENT_TYPE_MANIFEST_PATH),
    "utf8"
  )
  const value: unknown = JSON.parse(source)
  if (!Array.isArray(value) || !value.every(isManifestEntry)) {
    throw new Error(
      `${CONTENT_TYPE_MANIFEST_PATH} is not a valid content-type manifest.`
    )
  }
  return value
}

export function serializeContentTypeManifest(
  entries: ContentTypeManifestEntry[]
): string {
  return `${JSON.stringify(entries, null, 2)}\n`
}

export async function planContentTypeRegistration(
  entries: ContentTypeManifestEntry[],
  root = process.cwd()
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = []
  for (const file of ALL_FILES) {
    const path = FILE_PATHS[file]
    const source = await readFile(join(root, path), "utf8")
    files.push({
      path,
      content: renderContentTypeRegistrationFile(
        file,
        source,
        entries
      ),
    })
  }
  return files
}

export async function syncContentTypeRegistration(
  entries: ContentTypeManifestEntry[],
  options: { root?: string; dryRun?: boolean } = {}
): Promise<{ files: string[] }> {
  const root = options.root ?? process.cwd()
  const planned = await planContentTypeRegistration(entries, root)
  const changed: string[] = []
  for (const file of planned) {
    const current = await readFile(join(root, file.path), "utf8")
    if (current === file.content) continue
    changed.push(file.path)
    if (!options.dryRun) {
      await writeFile(join(root, file.path), file.content)
    }
  }
  return { files: changed }
}
