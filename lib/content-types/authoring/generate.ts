import { access } from "node:fs/promises"
import { join } from "node:path"
import type { ContentFieldSpec, ContentTypeSpec } from "./spec"
import { scaffoldContentType } from "./scaffold"
import {
  CONTENT_TYPE_MANIFEST_PATH,
  planContentTypeRegistration,
  readContentTypeManifest,
  serializeContentTypeManifest,
} from "./registration"
import {
  ADMIN_DICTIONARY_LOCALES,
  adminMessagesPath,
  readAdminMessages,
} from "./admin-messages"
import {
  hasCreationRecord,
  pendingCreationMessage,
  readCreationRecord,
  writeFilesUnderCreationRecord,
  type CreationWriteOptions,
} from "./recovery"

export type PlannedContentTypeFile = {
  path: string
  content: string
}

export type ContentTypeGenerationPlan = {
  type: string
  files: PlannedContentTypeFile[]
}

function walkFields(
  fields: Record<string, ContentFieldSpec>,
  visit: (field: ContentFieldSpec) => void
): void {
  for (const field of Object.values(fields)) {
    visit(field)
    if (field.kind === "group") walkFields(field.fields, visit)
    if (field.kind === "list") walkFields({ item: field.item }, visit)
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function findMatchingBrace(source: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === "{") depth += 1
    if (character === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new Error("Could not find the end of a JSON object.")
}

function findObjectPropertyStart(
  source: string,
  objectStart: number,
  property: string
): number {
  const objectEnd = findMatchingBrace(source, objectStart)
  const needle = JSON.stringify(property)
  let cursor = objectStart + 1
  let depth = 1
  let inString = false
  let escaped = false
  while (cursor < objectEnd) {
    const character = source[cursor]
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      cursor += 1
      continue
    }
    if (character === '"') {
      if (
        depth === 1 &&
        source.slice(cursor, cursor + needle.length) === needle
      ) {
        let colon = cursor + needle.length
        while (/\s/.test(source[colon] ?? "")) colon += 1
        if (source[colon] === ":") {
          colon += 1
          while (/\s/.test(source[colon] ?? "")) colon += 1
          if (source[colon] === "{") return colon
        }
      }
      inString = true
    } else if (character === "{") {
      depth += 1
    } else if (character === "}") {
      depth -= 1
    }
    cursor += 1
  }
  throw new Error(`Could not find JSON object property "${property}".`)
}

function insertAdminLabel(
  source: string,
  type: string,
  label: { singular: string; plural: string }
): string {
  const parsed = JSON.parse(source) as {
    sidebar?: {
      contentType?: Record<string, { singular: string; plural: string }>
    }
  }
  const labels = parsed.sidebar?.contentType
  if (!labels) {
    throw new Error("Admin messages are missing sidebar.contentType.")
  }
  if (labels[type]) {
    throw new Error(`Admin messages already contain content type "${type}".`)
  }

  const rootStart = source.indexOf("{")
  const sidebarStart = findObjectPropertyStart(source, rootStart, "sidebar")
  const contentTypeStart = findObjectPropertyStart(
    source,
    sidebarStart,
    "contentType"
  )
  const contentTypeEnd = findMatchingBrace(source, contentTypeStart)
  let last = contentTypeEnd - 1
  while (/\s/.test(source[last] ?? "")) last -= 1
  const property =
    `${JSON.stringify(type)}: { "singular": ${JSON.stringify(
      label.singular
    )}, "plural": ${JSON.stringify(label.plural)} }`
  const next =
    source.slice(0, last + 1) +
    `,\n      ${property}` +
    source.slice(last + 1)
  JSON.parse(next)
  return next
}

export async function planContentTypeGeneration(
  spec: ContentTypeSpec,
  root = process.cwd()
): Promise<ContentTypeGenerationPlan> {
  const entries = await readContentTypeManifest(root)
  if (entries.some((entry) => entry.type === spec.type)) {
    throw new Error(
      `Content type "${spec.type}" is already registered; v1 creation is create-only.`
    )
  }
  if (
    spec.routing &&
    entries.some(
      (entry) =>
        entry.pathPrefix &&
        entry.pathPrefix === spec.routing?.pathPrefix
    )
  ) {
    throw new Error(
      `Content-type path prefix "${spec.routing.pathPrefix}" is already registered.`
    )
  }

  const registeredTypes = new Set(entries.map((entry) => entry.type))
  registeredTypes.add(spec.type)
  const validateRelation = (field: ContentFieldSpec): void => {
    if (field.kind !== "relation") return
    for (const target of field.config.pageTypes) {
      if (!registeredTypes.has(target)) {
        throw new Error(
          `Relation target "${target}" is not a registered content type.`
        )
      }
    }
  }
  walkFields(spec.sharedFields, validateRelation)
  walkFields(spec.localizedFields, validateRelation)

  const scaffold = scaffoldContentType(spec)
  for (const path of [scaffold.descriptorPath, scaffold.rendererPath]) {
    if (path && (await fileExists(join(root, path)))) {
      throw new Error(
        `${path} already exists; content-type creation never overwrites files.`
      )
    }
  }

  const nextEntries = [...entries, scaffold.manifestEntry]
  const registrationFiles = await planContentTypeRegistration(
    nextEntries,
    root
  )
  const files: PlannedContentTypeFile[] = [
    {
      path: scaffold.descriptorPath,
      content: scaffold.descriptorSource,
    },
    ...(scaffold.rendererPath && scaffold.rendererSource
      ? [
          {
            path: scaffold.rendererPath,
            content: scaffold.rendererSource,
          },
        ]
      : []),
    {
      path: CONTENT_TYPE_MANIFEST_PATH,
      content: serializeContentTypeManifest(nextEntries),
    },
    ...registrationFiles,
  ]

  // The admin languages are the declared list, not whatever files exist.
  for (const locale of ADMIN_DICTIONARY_LOCALES) {
    const label = spec.labels[locale]
    if (!label) {
      throw new Error(
        `Content-type spec must provide labels.${locale} for the shipped admin locale.`
      )
    }
    const path = adminMessagesPath(locale)
    files.push({
      path,
      content: insertAdminLabel(
        await readAdminMessages(root, locale),
        spec.type,
        label
      ),
    })
  }

  return { type: spec.type, files }
}

export async function generateContentType(
  spec: ContentTypeSpec,
  options: {
    root?: string
    dryRun?: boolean
  } & CreationWriteOptions = {}
): Promise<ContentTypeGenerationPlan & { interrupted?: boolean }> {
  const root = options.root ?? process.cwd()
  // A half-created type would make the new plan wrong; refuse even a dry run.
  if (hasCreationRecord(root)) {
    throw new Error(
      pendingCreationMessage((await readCreationRecord(root))?.type)
    )
  }
  const plan = await planContentTypeGeneration(spec, root)
  if (options.dryRun) return plan
  const { interrupted } = await writeFilesUnderCreationRecord(
    root,
    plan,
    options
  )
  return interrupted ? { ...plan, interrupted } : plan
}
