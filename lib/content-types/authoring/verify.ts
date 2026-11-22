import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { definitionProblemLines } from "../../factories/definitions"
import type { ContentTypeManifestEntry } from "./manifest"
import {
  ADMIN_DICTIONARY_LOCALES,
  adminMessagesPath,
  readAdminMessages,
} from "./admin-messages"
import {
  planContentTypeRegistration,
  readContentTypeManifest,
} from "./registration"

export type ContentTypeVerification = {
  verifiedTypes: string[]
  errors: string[]
  warnings: string[]
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>()
  const duplicate = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value)
    seen.add(value)
  }
  return [...duplicate]
}

export const UNIVERSAL_LOCALIZED_FIELDS = new Set([
  "title",
  "metaTitle",
  "metaDescription",
])

/**
 * Type pairs that are field-identical on purpose, and whose duplication is
 * already a recorded decision. The similarity warning is a prompt to reconsider
 * a *new* type; re-raising it against a locked decision on every run would
 * train readers to ignore the whole check.
 *
 * Keep this list short and cite the decision. A pair belongs here only when the
 * duplication has been argued and accepted somewhere durable — not merely
 * because it is inconvenient to see.
 */
const SANCTIONED_FIELD_TWINS: ReadonlyArray<{
  types: readonly [string, string]
  reason: string
}> = [
  {
    types: ["landing-page", "page"],
    reason:
      "ADR-0037: page and landing-page are deliberately discriminator-only siblings — same row shape, different editorial surface.",
  },
]

function isSanctionedTwin(left: string, right: string): boolean {
  return SANCTIONED_FIELD_TWINS.some(
    (pair) =>
      (pair.types[0] === left && pair.types[1] === right) ||
      (pair.types[0] === right && pair.types[1] === left)
  )
}

/**
 * Overlap between two types' *distinguishing* fields, in [0, 1].
 *
 * The universal localized metadata (title / metaTitle / metaDescription) is
 * excluded first, because every type has it and counting it would make any two
 * types look alike.
 *
 * That exclusion is why the empty cases need care. A type whose comparison set
 * is empty declares nothing beyond the universal metadata:
 *
 *   - Both sides empty → the two types are *identical* by everything this
 *     metric can see. Score 1. This is the case ADR-0039 most wants surfaced —
 *     a new type that earns its existence purely by having a different name —
 *     and scoring it 0 (as this function did before) made the guard blind to
 *     exactly the duplication it exists to catch.
 *   - Exactly one side empty → the other side has distinguishing fields, so
 *     they are not duplicates of each other. Score 0.
 */
export function contentTypeFieldSimilarity(
  left: ContentTypeManifestEntry,
  right: ContentTypeManifestEntry
): number {
  const leftFields = new Set([
    ...left.sharedFieldKeys.map((field) => `shared:${field}`),
    ...left.localizedFieldKeys
      .filter((field) => !UNIVERSAL_LOCALIZED_FIELDS.has(field))
      .map((field) => `localized:${field}`),
  ])
  const rightFields = new Set([
    ...right.sharedFieldKeys.map((field) => `shared:${field}`),
    ...right.localizedFieldKeys
      .filter((field) => !UNIVERSAL_LOCALIZED_FIELDS.has(field))
      .map((field) => `localized:${field}`),
  ])
  if (leftFields.size === 0 && rightFields.size === 0) return 1
  const denominator = Math.min(leftFields.size, rightFields.size)
  if (denominator === 0) return 0
  let shared = 0
  for (const field of leftFields) {
    if (rightFields.has(field)) shared += 1
  }
  return shared / denominator
}

export function rendererRegistrationErrors(
  entries: ContentTypeManifestEntry[]
): string[] {
  return entries.flatMap((entry) =>
    entry.selected &&
    entry.pathPrefix !== undefined &&
    entry.renderer === "none"
      ? [
          `${entry.type}: routable content type needs a registered public renderer. Add a custom renderer to the manifest, then run pnpm content-types:sync.`,
        ]
      : []
  )
}

async function starterSelectionErrors(
  root: string,
  entries: ContentTypeManifestEntry[]
): Promise<string[]> {
  const path = join(root, "convex/lib/contentTypes/starterSelection.ts")
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch {
    return ["convex/lib/contentTypes/starterSelection.ts is missing."]
  }
  const match = /STARTER_CONTENT_TYPES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(
    source
  )
  if (!match) {
    return [
      "convex/lib/contentTypes/starterSelection.ts has no STARTER_CONTENT_TYPES declaration.",
    ]
  }
  const selected = [...match[1]!.matchAll(/["']([^"']+)["']/g)].map(
    ([, type]) => type!
  )
  const errors: string[] = []
  for (const duplicate of duplicates(selected)) {
    errors.push(`Starter content-type selection contains a duplicate: ${duplicate}.`)
  }
  const expected = entries
    .filter((entry) => entry.selected)
    .map((entry) => entry.type)
    .sort()
  const actual = [...new Set(selected)].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(
      `Starter content-type selection and manifest disagree: selection has ${actual.join(", ") || "(none)"}; manifest selects ${expected.join(", ") || "(none)"}.`
    )
  }
  return errors
}

async function verifyMessages(
  root: string,
  entries: ContentTypeManifestEntry[],
  errors: string[]
): Promise<void> {
  for (const locale of ADMIN_DICTIONARY_LOCALES) {
    const file = adminMessagesPath(locale)
    let source: string
    try {
      source = await readAdminMessages(root, locale)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
      continue
    }
    const messages = JSON.parse(source) as {
      sidebar?: {
        contentType?: Record<string, { singular?: unknown; plural?: unknown }>
      }
    }
    for (const entry of entries.filter((candidate) => candidate.selected)) {
      const expected = entry.labels[locale]
      if (!expected) {
        errors.push(`${entry.type}: manifest is missing labels.${locale}.`)
        continue
      }
      const actual = messages.sidebar?.contentType?.[entry.type]
      if (
        actual?.singular !== expected.singular ||
        actual?.plural !== expected.plural
      ) {
        errors.push(`${entry.type}: ${file} is missing the manifest labels.`)
      }
    }
  }
}

type DescriptorModuleCache = Map<string, Record<string, unknown>>

/** Loads a descriptor module once per verification run. */
export type ImportDescriptor = (path: string) => Promise<Record<string, unknown>>

/** More rules over the same manifest and descriptor modules. */
export type ContentTypeVerifyCheck = (context: {
  root: string
  entries: ContentTypeManifestEntry[]
  importDescriptor: ImportDescriptor
}) => Promise<string[]>

/**
 * Import a descriptor once per verification run. Both the descriptor checks
 * and the renderer-contract collection need the live module; importing it
 * twice under two cache-busting URLs would double the cost and, worse, let the
 * two halves disagree about what the descriptor says.
 */
async function importDescriptor(
  path: string,
  cache: DescriptorModuleCache
): Promise<Record<string, unknown>> {
  const cached = cache.get(path)
  if (cached) return cached
  const url = `${pathToFileURL(path).href}?verify=${Date.now()}`
  const descriptorModule = (await import(url)) as Record<string, unknown>
  cache.set(path, descriptorModule)
  return descriptorModule
}

async function verifyDescriptor(
  root: string,
  entry: ContentTypeManifestEntry,
  cache: DescriptorModuleCache,
  errors: string[]
): Promise<void> {
  const path = join(root, "convex/lib/contentTypes", `${entry.module}.ts`)
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch {
    errors.push(`${entry.type}: descriptor file is missing.`)
    return
  }
  if (source.includes("v.any(")) {
    errors.push(`${entry.type}: descriptor contains forbidden v.any().`)
  }
  if (!source.includes("referenceCard:")) {
    errors.push(`${entry.type}: descriptor has no referenceCard resolver.`)
  }
  if (!source.includes("sharedValidator:")) {
    errors.push(`${entry.type}: descriptor has no sharedValidator.`)
  }
  if (!source.includes("localizedValidator:")) {
    errors.push(`${entry.type}: descriptor has no localizedValidator.`)
  }

  try {
    const descriptorModule = await importDescriptor(path, cache)
    const descriptor = descriptorModule[entry.exportName] as
      | {
          type?: unknown
          capabilities?: { blockBody?: unknown }
          routing?: { pathPrefix?: unknown }
          sharedValidator?: { fields?: Record<string, unknown> }
          localizedValidator?: { fields?: Record<string, unknown> }
          referenceCard?: unknown
        }
      | undefined
    if (!descriptor) {
      errors.push(
        `${entry.type}: descriptor does not export ${entry.exportName}.`
      )
      return
    }
    if (descriptor.type !== entry.type) {
      errors.push(`${entry.type}: descriptor type does not match manifest.`)
    }
    if (descriptor.capabilities?.blockBody !== entry.blockBody) {
      errors.push(
        `${entry.type}: descriptor blockBody capability does not match manifest.`
      )
    }
    if ((descriptor.routing?.pathPrefix ?? undefined) !== entry.pathPrefix) {
      errors.push(
        `${entry.type}: descriptor pathPrefix does not match manifest.`
      )
    }
    if (typeof descriptor.referenceCard !== "function") {
      errors.push(`${entry.type}: referenceCard is not callable.`)
    }
    const sharedKeys = Object.keys(descriptor.sharedValidator?.fields ?? {})
    const localizedKeys = Object.keys(
      descriptor.localizedValidator?.fields ?? {}
    )
    if (JSON.stringify(sharedKeys) !== JSON.stringify(entry.sharedFieldKeys)) {
      errors.push(
        `${entry.type}: shared validator fields do not match manifest.`
      )
    }
    if (
      JSON.stringify(localizedKeys) !== JSON.stringify(entry.localizedFieldKeys)
    ) {
      errors.push(
        `${entry.type}: localized validator fields do not match manifest.`
      )
    }
  } catch (error) {
    errors.push(
      `${entry.type}: descriptor could not be loaded: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

export async function verifyContentTypes(
  options: {
    root?: string
    type?: string | "all"
    /** The source repository adds the renderer-contract rules here. */
    extraChecks?: ContentTypeVerifyCheck
  } = {}
): Promise<ContentTypeVerification> {
  const root = options.root ?? process.cwd()
  const entries = await readContentTypeManifest(root)
  const errors: string[] = []
  const warnings: string[] = []

  for (const duplicate of duplicates(entries.map((entry) => entry.type))) {
    errors.push(`Duplicate content-type slug: ${duplicate}.`)
  }
  for (const duplicate of duplicates(entries.map((entry) => entry.module))) {
    errors.push(`Duplicate content-type module: ${duplicate}.`)
  }
  for (const duplicate of duplicates(
    entries.flatMap((entry) => (entry.pathPrefix ? [entry.pathPrefix] : []))
  )) {
    errors.push(`Duplicate non-empty content-type pathPrefix: ${duplicate}.`)
  }
  const descriptorCache: DescriptorModuleCache = new Map()
  errors.push(...rendererRegistrationErrors(entries))
  errors.push(...(await starterSelectionErrors(root, entries)))
  // Part of the build gate too: the load-time definition check, with the
  // manifest rows so a duplicate row is caught.
  errors.push(...(await definitionProblemLines(root)))
  if (options.extraChecks) {
    errors.push(
      ...(await options.extraChecks({
        root,
        entries,
        importDescriptor: (path) => importDescriptor(path, descriptorCache),
      }))
    )
  }

  const requested = options.type ?? "all"
  const selectedEntries =
    requested === "all"
      ? entries
      : entries.filter((entry) => entry.type === requested)
  if (selectedEntries.length === 0) {
    errors.push(`Unknown content type: ${requested}.`)
  }

  const planned = await planContentTypeRegistration(entries, root)
  for (const file of planned) {
    const current = await readFile(join(root, file.path), "utf8")
    if (current !== file.content) {
      errors.push(`${file.path} is stale; run pnpm content-types:sync.`)
    }
  }

  await verifyMessages(root, entries, errors)
  for (const entry of selectedEntries) {
    await verifyDescriptor(root, entry, descriptorCache, errors)
  }

  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (isSanctionedTwin(entries[left]!.type, entries[right]!.type)) continue
      const similarity = contentTypeFieldSimilarity(
        entries[left]!,
        entries[right]!
      )
      if (similarity >= 0.8) {
        warnings.push(
          `${entries[left]!.type} and ${entries[right]!.type} are ${Math.round(
            similarity * 100
          )}% similar by field identity; consider extending an existing type or using a distinguishing field.`
        )
      }
    }
  }
  if (entries.length > 12) {
    warnings.push(
      `${entries.length} content types are registered; review sidebar, permissions, and modeling complexity.`
    )
  }

  return {
    verifiedTypes: selectedEntries.map((entry) => entry.type),
    errors,
    warnings,
  }
}

/** `pnpm content-type:verify -- [type]`: prints the result; returns the exit code. */
export async function runContentTypeVerifyCli(
  args: readonly string[],
  verify: typeof verifyContentTypes = verifyContentTypes
): Promise<number> {
  const requested = args.filter((argument) => argument !== "--")[0] ?? "all"
  try {
    const result = await verify({ type: requested })
    for (const warning of result.warnings) console.warn(`warning: ${warning}`)
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(`error: ${error}`)
      return 1
    }
    console.log(`Verified content types: ${result.verifiedTypes.join(", ")}`)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
