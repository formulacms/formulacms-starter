import type { GenericValidator } from "convex/values"
import type { ContentTypeDescriptor, DescriptorField } from "../contentTypes/types"
import {
  LIVE_ROW_FIELD_NAMES,
  LOCALIZED_CONTENT_FIELD_NAMES,
  STAGING_ROW_FIELD_NAMES,
} from "../pages/storageFields"
import {
  describe,
  repeated,
  type DefinitionProblem,
  type DefinitionRule,
} from "./common"

/**
 * One pass over the complete set of content-type definitions (the block check
 * lives in `blocks.ts`).
 *
 * Pure: no `node:` imports, no file system, no backend. It imports types and
 * the storage-field leaf only, so the registries can call it while they load
 * without an import cycle. It returns every problem instead of stopping at the
 * first, so an owner or a coding agent fixes the whole set in one edit.
 *
 * Prior art: Payload validates its whole config once at start
 * (`sanitizeConfig`), and Sanity lists every schema problem with its type and
 * field before the studio starts.
 */

/** A manifest row, as the build gate reads it from the manifest file. */
export type ContentTypeManifestEntry = {
  type: string
  module?: string
  exportName?: string
  pathPrefix?: string
}

function isOptionalValidator(validator: GenericValidator | undefined): boolean {
  return validator?.isOptional === "optional"
}

type RelationUse = { path: string; pageTypes: readonly string[] }

/** Every relation primitive, including those nested in groups and lists. */
function collectRelations(
  field: DescriptorField,
  path: string,
  out: RelationUse[]
): void {
  const config = field.config as Record<string, unknown>
  if (field.kind === "relation") {
    const pageTypes = config.pageTypes
    out.push({
      path,
      pageTypes: Array.isArray(pageTypes) ? (pageTypes as string[]) : [],
    })
  } else if (field.kind === "group") {
    const fields = config.fields as Record<string, DescriptorField> | undefined
    for (const [name, child] of Object.entries(fields ?? {})) {
      collectRelations(child, `${path}.${name}`, out)
    }
  } else if (field.kind === "list") {
    const item = config.item as DescriptorField | undefined
    if (item) collectRelations(item, `${path}[]`, out)
  }
}

/**
 * Shared fields a type still stores but no longer declares. The stored shape
 * keeps them readable while old rows migrate (widen, migrate, narrow), so the
 * parity rule skips them. Add a row here only for a migration in flight, and
 * remove it when the stored shape narrows.
 */
const STORED_ONLY_SHARED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // ADR-0037 amendment (2026-11-17): the post category moved to each language;
  // the old shared `category` stays readable until the narrowing unit.
  post: ["category"],
}

/**
 * Shared fields that the admin editor handles for the `post` type only.
 * The other types hide them (`components/admin/content-type-fields-panel.tsx`)
 * and only post edits and saves them (`components/admin/page-editor/components/
 * settings-panel.tsx`, with state in `components/admin/page-editor.tsx`), so a
 * different type that declares one would show a field that is never saved.
 * Remove a name here when the editor supports it for every type.
 */
export const POST_ONLY_SHARED_FIELDS = ["tags", "authorIds"] as const

export function contentTypeDefinitionProblems(input: {
  definitions: Readonly<Record<string, ContentTypeDescriptor>>
  activeTypes?: readonly string[]
  entries?: readonly ContentTypeManifestEntry[]
}): DefinitionProblem[] {
  const problems: DefinitionProblem[] = []
  const add = (
    type: string,
    field: string | undefined,
    rule: DefinitionRule,
    detail: string
  ) => problems.push(describe("content type", type, field, rule, detail))

  const registered = new Set(Object.keys(input.definitions))

  // Registry keys and duplicate descriptor types.
  const types: string[] = []
  for (const [key, descriptor] of Object.entries(input.definitions)) {
    types.push(descriptor.type)
    if (descriptor.type !== key) {
      add(
        key,
        undefined,
        "key-mismatch",
        `the registry key is "${key}" but the descriptor type is "${descriptor.type}"; make them the same word.`
      )
    }
  }
  for (const type of repeated(types)) {
    add(
      type,
      undefined,
      "duplicate-type",
      `two descriptors use the type "${type}"; give each content type its own type.`
    )
  }

  // Manifest rows: a duplicate object-literal key has already collapsed by
  // load time, so only the manifest array can show these.
  if (input.entries) {
    const pairs: Array<[keyof ContentTypeManifestEntry, string]> = [
      ["type", "type"],
      ["module", "module"],
      ["exportName", "export name"],
    ]
    for (const [property, label] of pairs) {
      const values = input.entries
        .map((entry) => entry[property])
        .filter((value): value is string => typeof value === "string")
      for (const value of repeated(values)) {
        const owner =
          input.entries.find((entry) => entry[property] === value)?.type ?? value
        add(
          owner,
          undefined,
          "duplicate-type",
          `the manifest lists the ${label} "${value}" more than once; remove the extra row.`
        )
      }
    }
    const prefixes = input.entries
      .map((entry) => entry.pathPrefix)
      .filter((value): value is string => typeof value === "string" && value !== "")
    for (const prefix of repeated(prefixes)) {
      const owner =
        input.entries.find((entry) => entry.pathPrefix === prefix)?.type ?? prefix
      add(
        owner,
        undefined,
        "duplicate-path-prefix",
        `the manifest gives the URL prefix "${prefix}" to more than one type; use a different prefix.`
      )
    }
  }

  const seenPrefixes = new Map<string, string>()
  for (const [key, descriptor] of Object.entries(input.definitions)) {
    // Reserved names: the arm builders spread the descriptor's fields after
    // (shared) or before (localized) the storage fields and would silently
    // replace a field of the same name.
    for (const name of Object.keys(descriptor.sharedValidator.fields)) {
      const places: string[] = []
      if (LIVE_ROW_FIELD_NAMES.has(name)) places.push("the live page row")
      if (STAGING_ROW_FIELD_NAMES.has(name)) places.push("the staging row")
      if (places.length > 0) {
        add(
          key,
          name,
          "reserved-field",
          `${places.join(" and ")} already stores "${name}"; rename the field.`
        )
      }
    }
    for (const name of Object.keys(descriptor.localizedValidator.fields)) {
      if (LOCALIZED_CONTENT_FIELD_NAMES.has(name)) {
        add(
          key,
          name,
          "reserved-field",
          `the localized content of every type already stores "${name}"; rename the field.`
        )
      }
    }

    // Parity: the stored shared validator and the declared shared fields are
    // two lists of one thing. The pages arms, the draft tables and the public
    // page all read one of them, so a key in only one list is silently
    // stored without being declared, or declared without being stored.
    const declared = new Set(Object.keys(descriptor.sharedFields))
    const stored = new Set(Object.keys(descriptor.sharedValidator.fields))
    for (const name of declared) {
      if (!stored.has(name)) {
        add(
          key,
          name,
          "validator-parity",
          `the shared field "${name}" is declared but the shared validator does not store it; add "${name}" to the sharedValidator.`
        )
      }
    }
    for (const name of stored) {
      if (declared.has(name)) continue
      if (STORED_ONLY_SHARED_FIELDS[key]?.includes(name)) continue
      add(
        key,
        name,
        "validator-parity",
        `the shared validator stores "${name}" but no shared field declares it; declare the field or remove it from the sharedValidator.`
      )
    }

    // Fields the admin editor supports for post only.
    if (key !== "post") {
      for (const name of POST_ONLY_SHARED_FIELDS) {
        if (name in descriptor.sharedFields) {
          add(
            key,
            name,
            "post-only-field",
            `the admin editor supports this field only on "post"; rename the field.`
          )
        }
      }
    }

    // Title: the admin list, the reference card and search all read it.
    const title = descriptor.localizedFields.title as DescriptorField | undefined
    if (!title) {
      add(
        key,
        "title",
        "missing-title",
        'the localized fields have no "title"; add a required text field named "title".'
      )
    } else if (title.kind !== "text") {
      add(
        key,
        "title",
        "missing-title",
        `the localized "title" is a ${title.kind} field; make it a text field.`
      )
    } else if (
      isOptionalValidator(title.validator) ||
      isOptionalValidator(descriptor.localizedValidator.fields.title)
    ) {
      add(
        key,
        "title",
        "missing-title",
        'the localized "title" is optional; remove .optional() so every row has a title.'
      )
    } else {
      const stored = descriptor.localizedValidator.fields.title as
        | GenericValidator
        | undefined
      if (!stored) {
        add(
          key,
          "title",
          "missing-title",
          'the stored localized content has no "title"; add a required string "title" to the localized validator.'
        )
      } else if (stored.kind !== "string") {
        add(
          key,
          "title",
          "missing-title",
          `the stored localized "title" is a ${stored.kind} validator; make it a required string.`
        )
      }
    }

    // Relation targets must be registered types.
    const relations: RelationUse[] = []
    for (const [name, field] of Object.entries(descriptor.sharedFields)) {
      collectRelations(field, name, relations)
    }
    for (const [name, field] of Object.entries(descriptor.localizedFields)) {
      collectRelations(field, name, relations)
    }
    for (const relation of relations) {
      for (const target of relation.pageTypes) {
        if (!registered.has(target)) {
          add(
            key,
            relation.path,
            "relation-target",
            `the relation points to "${target}", which is not a registered content type; use a registered type or register "${target}".`
          )
        }
      }
    }

    // Non-empty URL prefixes must be unique; the wildcard router dispatches
    // by prefix. Several types may share the empty prefix.
    const prefix = descriptor.routing?.pathPrefix
    if (prefix) {
      const first = seenPrefixes.get(prefix)
      if (first !== undefined) {
        add(
          key,
          undefined,
          "duplicate-path-prefix",
          `the URL prefix "${prefix}" is already used by "${first}"; use a different prefix.`
        )
      } else {
        seenPrefixes.set(prefix, key)
      }
    }
  }

  if (input.activeTypes) {
    const seen = new Set<string>()
    for (const type of input.activeTypes) {
      if (!registered.has(type)) {
        add(
          type,
          undefined,
          "active-type",
          `the starter selection lists "${type}", which is not registered; remove it or register the type.`
        )
      } else if (seen.has(type)) {
        add(
          type,
          undefined,
          "active-type",
          `the starter selection lists "${type}" twice; list it once.`
        )
      }
      seen.add(type)
    }
  }

  return problems
}
