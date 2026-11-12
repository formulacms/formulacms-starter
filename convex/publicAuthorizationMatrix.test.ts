/// <reference types="vite/client" />
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import { coreRows } from "../test-utils/authorization-matrix/core"
import { coreLanguageRows } from "../test-utils/authorization-matrix/core_language"
import { coreMultilingualRows } from "../test-utils/authorization-matrix/core_multilingual"
import { contentRows } from "../test-utils/authorization-matrix/content"
import { integrationsRows } from "../test-utils/authorization-matrix/integrations"
import type {
  AuthorizationRow,
  FunctionKind,
} from "../test-utils/authorization-matrix/harness"

/**
 * Vite resolves the actual modules in this checkout, including non-ignored
 * untracked source modules. In a generated app it resolves that app's own
 * present modules. The API proxy and generated declarations are not an
 * inventory; exported registrations in loaded function modules are.
 */
const functionModules = import.meta.glob([
  "./**/*.ts",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
  "!./_generated/**",
  "!./**/convex.config.ts",
  "!./auth.config.ts",
  "!./schema.ts",
])
const testModules = import.meta.glob("./**/*.ts")

type Registration = ((...args: never[]) => unknown) & {
  isPublic?: boolean
  isQuery?: boolean
  isMutation?: boolean
  isAction?: boolean
}
type PublicFunction = { name: string; kind: FunctionKind }

async function discoverPublicFunctions(): Promise<PublicFunction[]> {
  const discovered: PublicFunction[] = []
  for (const [modulePath, load] of Object.entries(functionModules)) {
    const exports = (await load()) as Record<string, unknown>
    for (const [exportName, value] of Object.entries(exports)) {
      const registration = value as Registration | null
      if (typeof registration !== "function" || registration.isPublic !== true) {
        continue
      }
      const kind = registration.isQuery
        ? "query"
        : registration.isMutation
          ? "mutation"
          : registration.isAction
            ? "action"
            : null
      if (!kind) throw new Error(`Unclassified public function: ${modulePath}:${exportName}`)
      discovered.push({ name: `${modulePath.slice(2, -3)}:${exportName}`, kind })
    }
  }
  return discovered.sort((left, right) => left.name.localeCompare(right.name))
}

function assertOneExecutableRowPerPublicFunction(
  discovered: readonly PublicFunction[],
  rows: readonly Pick<AuthorizationRow, "name" | "kind">[],
): void {
  const actual = new Map(discovered.map((entry) => [entry.name, entry.kind]))
  // A generated app can omit an entire source-only module. Retain rows for
  // modules present in this checkout, so an export removed from a present
  // function module remains a stale-row failure.
  const presentModules = new Set(Object.keys(functionModules).map((path) => path.slice(2, -3)))
  const covered = new Map(rows.filter(({ name }) =>
    presentModules.has(name.slice(0, name.lastIndexOf(":")))
  ).map((entry) => [entry.name, entry.kind]))
  const missing = discovered.filter(({ name }) => !covered.has(name)).map(({ name }) => name)
  const stale = rows.filter(({ name }) =>
    presentModules.has(name.slice(0, name.lastIndexOf(":"))) && !actual.has(name)
  ).map(({ name }) => name)
  const wrongKind = rows.filter(({ name, kind }) => actual.has(name) && actual.get(name) !== kind)
    .map(({ name, kind }) => `${name}:${kind} expected ${actual.get(name)}`)
  const duplicate = rows.filter(({ name }, index) => rows.findIndex((row) => row.name === name) !== index)
    .map(({ name }) => name)
  if (missing.length || stale.length || wrongKind.length || duplicate.length) {
    throw new Error(
      `Public authorization matrix mismatch: discovered=${discovered.length}, covered=${covered.size}, ` +
      `missing=${missing.length} [${missing.join(", ")}]; stale=[${stale.join(", ")}]; ` +
      `wrongKind=[${wrongKind.join(", ")}]; duplicate=[${duplicate.join(", ")}]`,
    )
  }
}

const rows: AuthorizationRow[] = [
  ...coreRows, ...coreLanguageRows, ...coreMultilingualRows,
  ...contentRows, ...integrationsRows,
]
const presentModules = new Set(Object.keys(functionModules).map((path) => path.slice(2, -3)))
const executableRows = rows.filter(({ name }) =>
  presentModules.has(name.slice(0, name.lastIndexOf(":")))
)

describe("public Convex authorization matrix", () => {
  test("every discovered public query, mutation, and action has one executable row", async () => {
    const discovered = await discoverPublicFunctions()
    expect(discovered.length).toBeGreaterThan(0)
    assertOneExecutableRowPerPublicFunction(discovered, rows)
  })

  test("a discovered public function without a row fails closed", async () => {
    const discovered = await discoverPublicFunctions()
    const allRows = discovered.map(({ name, kind }) => ({ name, kind }))
    const omitted = allRows[0]!
    expect(() => assertOneExecutableRowPerPublicFunction(discovered, allRows.slice(1)))
      .toThrow(`missing=1 [${omitted.name}]`)
  })

  for (const row of executableRows) {
    // These rows assert the owned Hero presentation/installed authoring contract.
    const needsHero = [
      "cms/slices:getPresentationCatalog",
      "cms/slices:setPresentationArchived",
      "cms/slices:getSliceAuthoringState",
    ].includes(row.name)
    test(row.name, sliceProfile(needsHero ? ["hero-with-image"] : []), async () => {
      await row.run(testModules)
    })
  }
})
