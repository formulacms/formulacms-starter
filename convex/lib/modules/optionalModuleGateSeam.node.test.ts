import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, test } from "vitest"

// `createOptionalModuleGate` is the injection seam for the optional-module
// gate (catalog and readiness providers). Production code must only get the
// installed instance exported by `convex/lib/modules/state.ts`; a caller that
// builds its own gate could weaken the check. So the factory may be called
// only there and in tests.
const root = process.cwd()
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".handoffs",
  ".reference",
  ".kilo",
  "_generated",
  // Harness worktrees and archived copies hold second copies of state.ts.
  ".claude",
  "archive",
])
const ALLOWED_PRODUCTION_CALLER = "convex/lib/modules/state.ts"
// Any mention, not only a direct call: an aliased import or a stored
// reference would otherwise slip past (`import { createOptionalModuleGate as b }`).
const CALL = /\bcreateOptionalModuleGate\b/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), out)
    } else if (/\.(?:ts|tsx|mts)$/.test(entry.name)) {
      out.push(relative(root, join(dir, entry.name)).replaceAll("\\", "/"))
    }
  }
  return out
}

/** Non-test files that mention the factory. */
export function productionCallers(
  files: Iterable<[path: string, text: string]>
): string[] {
  const callers: string[] = []
  for (const [path, text] of files) {
    if (/\.test\.tsx?$/.test(path)) continue
    if (CALL.test(text)) callers.push(path)
  }
  return callers
}

describe("optional-module gate factory call sites", () => {
  test("only convex/lib/modules/state.ts calls it outside tests", () => {
    const files = sourceFiles(root).map(
      (path) =>
        [path, readFileSync(join(root, path), "utf8")] as [string, string]
    )
    expect(files.length).toBeGreaterThan(500)
    // The scan is real: the one allowed caller is found.
    expect(productionCallers(files)).toEqual([ALLOWED_PRODUCTION_CALLER])
  })

  test("the scan reports a non-test caller (injected in memory)", () => {
    expect(
      productionCallers([
        [ALLOWED_PRODUCTION_CALLER, "createOptionalModuleGate({})"],
        ["convex/cms/ai.ts", "const g = createOptionalModuleGate ({})"],
        [
          "convex/agents/localizer.ts",
          'import { createOptionalModuleGate as buildGate } from "../lib/modules/state"',
        ],
        ["convex/optionalModuleGate.test.ts", "createOptionalModuleGate({})"],
      ])
    ).toEqual([
      ALLOWED_PRODUCTION_CALLER,
      "convex/cms/ai.ts",
      "convex/agents/localizer.ts",
    ])
  })
})
