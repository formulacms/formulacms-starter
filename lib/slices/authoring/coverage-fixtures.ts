import type { Primitive } from "@/convex/lib/slices/primitives"
import { isPrimitiveValueEmpty } from "@/convex/lib/slices/primitives"
import { buildFieldDoc } from "@/convex/lib/richtext/build"
import { walkValue } from "@/convex/lib/slices/walk"
import {
  coveragePattern,
  fieldCoverageInventory,
  isButtonDefinition,
  type CoverageDescriptor,
} from "./field-coverage"

export type CoverageSlice = {
  id: string
  type: string
  enabled: boolean
  primary: unknown
  items?: unknown
}
export type CoverageFixture = {
  id: string
  slice: CoverageSlice
  expectedPaths: string[]
}
const canonical = (path: string) => path.replace(/\[(\d+)\]/g, ".$1")
function put(
  value: unknown,
  path: string,
  replacement: unknown,
  omit = false
): void {
  const parts = canonical(path).split(".")
  let current = value as Record<string, unknown>
  for (const key of parts.slice(0, -1))
    current = current[key] as Record<string, unknown>
  if (omit) delete current[parts.at(-1)!]
  else current[parts.at(-1)!] = replacement
}
export function coverageValueAt(value: unknown, path: string): unknown {
  return canonical(path)
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value
    )
}
function filled(def: Primitive, path: string, depth = 0, row = 0): unknown {
  const token = `U3 ${path.replace(/[^a-zA-Z0-9]/g, " ")}`
  if (def.kind === "group")
    return Object.fromEntries(
      Object.entries(def.config.fields as Record<string, Primitive>).map(
        ([name, child]) => [name, filled(child, `${path}.${name}`, depth, row)]
      )
    )
  if (def.kind === "list") {
    const count = Math.max(
      Number(def.config.min ?? 0),
      Math.min(depth > 0 && row === 1 ? 3 : 2, Number(def.config.max ?? 3))
    )
    return Array.from({ length: count }, (_, index) =>
      filled(
        def.config.item as Primitive,
        `${path}[${index}]`,
        depth + 1,
        index
      )
    )
  }
  if (def.kind === "text")
    return token.slice(0, Number(def.config.maxLength ?? 100))
  if (def.kind === "richText")
    return JSON.stringify(buildFieldDoc(token, def.config))
  if (def.kind === "image")
    return {
      url: `/slice-placeholders/coverage-${path.replace(/[^a-zA-Z0-9]/g, "-")}.png`,
      alt: token,
      width: 800,
      height: 600,
    }
  if (def.kind === "link")
    return {
      type: "external",
      url: `https://example.com/${path.replace(/[^a-zA-Z0-9]/g, "-")}`,
    }
  if (def.kind === "boolean")
    return path.endsWith(".enabled") ? true : row % 2 === 0
  if (def.kind === "number") return row === 0 ? 0 : 7
  if (def.kind === "select")
    return (def.config.options as string[])[
      row % (def.config.options as string[]).length
    ]
  return structuredClone(def.default)
}

/** Declared finite branches: populated/empty optional values, each visible
 * field absent alone, linked/plain announcement/contact values, button icon
 * on/off and disabled/unresolved first button. No arbitrary-JS exhaustiveness. */
export function createCoverageFixtures(
  type: string,
  descriptor: CoverageDescriptor
): CoverageFixture[] {
  const inventory = fieldCoverageInventory(type, descriptor)
  if (inventory.every((entry) => entry.status === "legacy")) return []
  const base: CoverageSlice = {
    id: `coverage-${type}`,
    type,
    enabled: true,
    primary: filled(descriptor.primary, "primary"),
    ...(descriptor.items ? { items: filled(descriptor.items, "items") } : {}),
  }
  const leaves: { path: string; def: Primitive }[] = []
  walkValue(
    descriptor.primary,
    base.primary,
    ({ path, def }) => leaves.push({ path, def }),
    "primary"
  )
  if (descriptor.items)
    walkValue(
      descriptor.items,
      base.items,
      ({ path, def }) => leaves.push({ path, def }),
      "items"
    )
  const candidates = new Map<string, CoverageSlice>([["filled", base]])
  const optional = structuredClone(base)
  const lists: string[] = []
  const optionalProperties: string[] = []
  const collectContainers = (
    def: Primitive,
    value: unknown,
    path: string,
    objectProperty: boolean,
    aggregatePresent = true
  ) => {
    const omitProperty =
      objectProperty && def.validator.isOptional === "optional"
    if (omitProperty) {
      optionalProperties.push(path)
      if (aggregatePresent) put(optional, path, undefined, true)
    }
    const childrenPresent = aggregatePresent && !omitProperty
    if (def.kind === "group")
      for (const [name, child] of Object.entries(
        def.config.fields as Record<string, Primitive>
      ))
        collectContainers(
          child,
          (value as Record<string, unknown>)?.[name],
          `${path}.${name}`,
          true,
          childrenPresent
        )
    if (def.kind === "list" && Array.isArray(value)) {
      lists.push(path)
      value.forEach((row, index) =>
        collectContainers(
          def.config.item as Primitive,
          row,
          `${path}[${index}]`,
          false,
          childrenPresent
        )
      )
    }
  }
  collectContainers(descriptor.primary, base.primary, "primary", true)
  if (descriptor.items)
    collectContainers(descriptor.items, base.items, "items", true)
  candidates.set("optional-empty", optional)
  // Storage arrays admit [] even when min is positive authoring metadata.
  // Exercise every concrete nested list while retaining populated siblings.
  for (const path of lists) {
    const slice = structuredClone(base)
    put(slice, path, [])
    candidates.set(`empty:${path}`, slice)
  }
  for (const path of optionalProperties) {
    const slice = structuredClone(base)
    put(slice, path, undefined, true)
    candidates.set(`omitted:${path}`, slice)
  }
  for (const { path, def } of leaves) {
    const entry = inventory.find(
      (field) => field.path === coveragePattern(path)
    )
    if (entry?.status !== "bound" && def.kind !== "link") continue
    const slice = structuredClone(base)
    put(
      slice,
      path,
      def.kind === "image"
        ? { url: "", alt: "" }
        : def.kind === "link"
          ? { type: "none" }
          : def.kind === "richText"
            ? JSON.stringify(buildFieldDoc("", def.config))
            : ""
    )
    candidates.set(`empty:${path}`, slice)
  }
  const buttonLists: string[] = []
  const findButtons = (def: Primitive, value: unknown, path: string) => {
    if (isButtonDefinition(def)) {
      buttonLists.push(path)
      return
    }
    if (def.kind === "group")
      for (const [name, child] of Object.entries(
        def.config.fields as Record<string, Primitive>
      ))
        findButtons(
          child,
          (value as Record<string, unknown>)?.[name],
          `${path}.${name}`
        )
    if (def.kind === "list" && Array.isArray(value))
      value.forEach((item, index) =>
        findButtons(def.config.item as Primitive, item, `${path}[${index}]`)
      )
  }
  findButtons(descriptor.primary, base.primary, "primary")
  if (descriptor.items) findButtons(descriptor.items, base.items, "items")
  for (const path of buttonLists)
    for (const mode of [
      "disabled-first",
      "unresolved-first",
      "icons-off",
    ] as const) {
      const slice = structuredClone(base)
      const rows = coverageValueAt(slice, path) as Record<string, unknown>[]
      if (rows.length < 2 && mode !== "icons-off") continue
      if (mode === "disabled-first") rows[0].enabled = false
      if (mode === "unresolved-first") rows[0].link = { type: "none" }
      if (mode === "icons-off")
        rows.forEach((item) => {
          item.withIcon = false
        })
      candidates.set(`${mode}:${path}`, slice)
    }
  return [...candidates].map(([id, slice]) => {
    const expectedPaths: string[] = []
    const inspect = (def: Primitive, value: unknown, path: string) =>
      walkValue(
        def,
        value,
        ({ def: field, value: actual, path: at }) => {
          // Existing Buttons keeps its label span even when the required label is
          // empty. Verify that exact empty host/value while preserving link geometry.
          const buttonLabel = buttonLists.some(
            (list) => at.startsWith(`${list}[`) && at.endsWith(".label")
          )
          if (
            inventory.find((entry) => entry.path === coveragePattern(at))
              ?.status !== "bound" ||
            (!buttonLabel && isPrimitiveValueEmpty(field, actual))
          )
            return
          if (
            type === "hero-with-image" &&
            at === "primary.eyebrowLinkLabel" &&
            (!coverageValueAt(slice, "primary.eyebrow") ||
              (
                coverageValueAt(slice, "primary.eyebrowLink") as {
                  type?: string
                }
              )?.type === "none")
          )
            return
          for (const list of buttonLists)
            if (at.startsWith(`${list}[`)) {
              const row = coverageValueAt(
                slice,
                at.slice(0, at.lastIndexOf("."))
              ) as Record<string, unknown>
              if (
                row.enabled === false ||
                (row.link as { type?: string })?.type === "none"
              )
                return
            }
          expectedPaths.push(canonical(at))
        },
        path
      )
    inspect(descriptor.primary, slice.primary, "primary")
    if (descriptor.items) inspect(descriptor.items, slice.items, "items")
    return { id, slice, expectedPaths }
  })
}
