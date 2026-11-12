/// <reference types="vite/client" />

import { readdir, readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"

const RETIRED_ACCESS =
  /requirePermission|requireExactAdmin|resolveRoleAndPermissions|assertPagePermission|myPermissions/g

type InventoryClass =
  | "activeF03OwnerSeam"
  | "temporaryF03Shim"
  | "deferredR01Compatibility"
  | "deferredT01"
  | "deferredT02"
  | "deferredF04"
  | "deferredF05"
  | "activeF03Fixture"

/**
 * FR2e (D-7): rows for files the starter does not ship (the later Team
 * modules, the retired permission helpers, AI settings) live in the private
 * `f03verify.sourceInventory.ts`. Source merges them, so its inventory stays
 * exact; the starter copy is exact for what it ships.
 */
type SourceOnlyInventory = {
  legacyTokenFiles?: readonly string[]
  explicitNonTokenConsumers?: readonly string[]
  inventory?: Partial<Record<InventoryClass, readonly string[]>>
}
const SOURCE_ONLY: SourceOnlyInventory = (Object.values(
  import.meta.glob("./f03verify.sourceInventory.ts", { eager: true, import: "default" })
)[0] ?? {}) as SourceOnlyInventory

// This is the bounded F03 source claim. It covers active application/backend
// roots and the explicit owner-fixture helper; it is not a full-repository
// claim and does not scan archived, generated, or starter-overlay sources.
const LEGACY_TOKEN_FILES = [
  "convex/cms/aiSettings.ts",
  "convex/cms/media.ts",
  "convex/cms/pages.ts",
  "convex/cms/settings.ts",
  "convexTestWithExplicitAdmin.ts",
  ...(SOURCE_ONLY.legacyTokenFiles ?? []),
]

// F03 access consumers that remain relevant even after their old role-string
// token was removed, so the bounded scanner adds them explicitly.
const EXPLICIT_NON_TOKEN_CONSUMERS = [
  ...(SOURCE_ONLY.explicitNonTokenConsumers ?? []),
]

const SHIPPED_INVENTORY: Record<InventoryClass, readonly string[]> = {
  activeF03OwnerSeam: [],
  temporaryF03Shim: [
    "convex/cms/aiSettings.ts",
    "convex/cms/media.ts",
    "convex/cms/pages.ts",
    "convex/cms/settings.ts",
  ],
  deferredR01Compatibility: [],
  deferredT01: [],
  deferredT02: [],
  deferredF04: [],
  deferredF05: [],
  activeF03Fixture: ["convexTestWithExplicitAdmin.ts"],
}

const INVENTORY = Object.fromEntries(
  Object.entries(SHIPPED_INVENTORY).map(([key, files]) => [
    key,
    [...files, ...(SOURCE_ONLY.inventory?.[key as InventoryClass] ?? [])],
  ])
) as Record<InventoryClass, string[]>

// FR2e (D-7): the Search and Forms public boundaries are checked in their
// capability-owned suites.
const PUBLIC_BOUNDARIES = ["convex/cms/redirects.ts"]

async function sourceFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "_generated") continue
    const path = `${root}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path, `${prefix}${entry.name}/`)))
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.includes(".test.")
    ) {
      files.push(`${prefix}${entry.name}`)
    }
  }
  return files
}

describe("F03.verify access inventory", () => {
  test("accounts for every remaining legacy access token in the bounded source roots", async () => {
    const actual: string[] = []
    for (const root of ["convex", "app", "lib", "components"]) {
      for (const relativePath of await sourceFiles(root)) {
        const source = await readFile(`${root}/${relativePath}`, "utf8")
        if (source.match(RETIRED_ACCESS)) actual.push(`${root}/${relativePath}`)
      }
    }
    const fixtureSource = await readFile(
      "convexTestWithExplicitAdmin.ts",
      "utf8"
    )
    if (fixtureSource.match(RETIRED_ACCESS)) {
      actual.push("convexTestWithExplicitAdmin.ts")
    }

    expect(actual.sort()).toEqual([...LEGACY_TOKEN_FILES].sort())
    actual.push(...EXPLICIT_NON_TOKEN_CONSUMERS)
    const residual = new Set(actual)
    const classified = new Set(Object.values(INVENTORY).flat())
    expect([...residual].sort()).toEqual([...classified].sort())
    expect([...classified].sort()).toEqual([...residual].sort())
  })

  test("classifies the F03-relevant legacy consumers and their future owners", async () => {
    const classified = Object.values(INVENTORY).flat()
    expect(new Set(classified).size).toBe(classified.length)
    expect(classified).toContain("convexTestWithExplicitAdmin.ts")
    expect(classified).not.toContain(
      "scripts/starter/overlay/convex/edition/roles.ts"
    )

    const fixture = await readFile("convexTestWithExplicitAdmin.ts", "utf8")
    expect(fixture).toContain("seedCommunityOwner")
    expect(fixture).toContain("cmsOwner")
    expect(fixture).toMatch(/grants no[\s\S]*legacy/u)
  })

  test("keeps intentional public boundaries free of retired access tokens", async () => {
    for (const file of PUBLIC_BOUNDARIES) {
      expect(await readFile(file, "utf8")).not.toMatch(RETIRED_ACCESS)
    }
  })
})
