import {
  isEditorialTextPrimitive,
  type Primitive,
} from "./primitives"

export const PRIMARY_LIST_ROOT = "primary"
export const DEFAULT_ACTION_LIST_PATH = `${PRIMARY_LIST_ROOT}.ctas`

export const PRIMARY_LIST_AUTHORING_POLICY = [
  "New repeating content belongs in descriptively named lists inside primary, not in the legacy items field.",
  "Content is section-owned by default. Model independent relations only when content needs its own URL, propagating reuse, set semantics, or independent lifecycle.",
  "Supported limits: at most 4 named primary lists, 2 list levels, and 24 rows per list (or the descriptor's lower maximum).",
].join(" ")

export type PrimaryListField = { path: string; definition: Primitive }
export type PrimaryScalarField = {
  path: string
  definition: Primitive
  legacyAlias?: string
}
export type PrimaryFieldProtocol = {
  scalars: PrimaryScalarField[]
  lists: PrimaryListField[]
}

/** The shared descriptor walk for authored scalar and list block paths. */
export function primaryFieldProtocol(primary: Primitive): PrimaryFieldProtocol {
  const scalars: PrimaryScalarField[] = []
  const lists: PrimaryListField[] = []

  function visit(definition: Primitive, path: string, inList: boolean): void {
    if (definition.kind === "list") {
      lists.push({ path, definition })
      visit(definition.config.item as Primitive, `${path}[]`, true)
      return
    }
    if (definition.kind === "group") {
      const fields = definition.config.fields as Record<string, Primitive>
      for (const [key, child] of Object.entries(fields)) {
        visit(child, `${path}.${key}`, inList)
      }
      return
    }
    if (!inList && isEditorialTextPrimitive(definition)) {
      const rootKey = path.startsWith(`${PRIMARY_LIST_ROOT}.`)
        ? path.slice(PRIMARY_LIST_ROOT.length + 1)
        : undefined
      scalars.push({
        path,
        definition,
        ...(rootKey && !rootKey.includes(".") ? { legacyAlias: rootKey } : {}),
      })
    }
  }

  if (primary.kind === "group") {
    const fields = primary.config.fields as Record<string, Primitive>
    for (const [key, field] of Object.entries(fields)) {
      visit(field, `${PRIMARY_LIST_ROOT}.${key}`, false)
    }
  } else {
    visit(primary, PRIMARY_LIST_ROOT, false)
  }
  return { scalars, lists }
}

/** Discover list descriptors without depending on the runtime slice registry. */
export function primaryListFields(primary: Primitive): PrimaryListField[] {
  return primaryFieldProtocol(primary).lists
}

export function primaryScalarTagExample(
  path: string,
  value = "...editorial value..."
): string {
  return `[${path}]${value}[/${path}]`
}

export function primaryListTagExample(
  path: string,
  value = "...JSON rows..."
): string {
  return `[${path}]${value}[/${path}]`
}

/** Build JSON examples from declared editorial leaves only. */
export function primaryListInstructions(primary: Primitive): string {
  const blocks = primaryFieldProtocol(primary).lists
    .filter(({ path }) => !path.includes("[]"))
    .flatMap(({ path, definition }) => {
      if (!hasEditorialContent(definition)) return []
      const max = definition.config.max as number | undefined
      const min = definition.config.min as number | undefined
      const limit = max ?? 24
      const row = editorialExample(definition.config.item as Primitive)
      if (row === undefined) return []
      return [
        `${path}: provide a JSON array with ${min ?? 0}–${limit} rows (maximum ${limit}). Use only the declared editorial fields shown by this row shape:`,
        `[${JSON.stringify(row)}]`,
        `Use the full-path block ${primaryListTagExample(path, "...")}. Nested lists belong inside their parent JSON rows. Title fields are plain text values, not ProseMirror or HTML wrappers.`,
      ]
    })

  if (blocks.length === 0) return ""
  return [PRIMARY_LIST_AUTHORING_POLICY, ...blocks].join("\n")
}

function hasEditorialContent(definition: Primitive): boolean {
  if (definition.kind === "list")
    return hasEditorialContent(definition.config.item as Primitive)
  if (definition.kind === "group") {
    const fields = definition.config.fields as Record<string, Primitive>
    return Object.values(fields).some(hasEditorialContent)
  }
  return isEditorialTextPrimitive(definition)
}

function editorialExample(definition: Primitive): unknown | undefined {
  if (definition.kind === "list") {
    const child = editorialExample(definition.config.item as Primitive)
    return child === undefined ? undefined : [child]
  }
  if (definition.kind === "group") {
    const fields = definition.config.fields as Record<string, Primitive>
    const shape: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(fields)) {
      const example = editorialExample(child)
      if (example !== undefined) shape[key] = example
    }
    return Object.keys(shape).length > 0 ? shape : undefined
  }
  if (!isEditorialTextPrimitive(definition)) return undefined
  return "Editorial text"
}
