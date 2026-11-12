import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { checkTokenBoundary } from "./check-token-boundary"

test.each([
  ["public", ["components/public", "app/(public)"], "bg-sidebar"],
  ["admin", ["components/admin", "app/(core)"], "text-display"],
] as const)(
  "%s token checks ignore test assertions and still reject runtime violations",
  async (_surface, directories, token) => {
    const root = mkdtempSync(join(tmpdir(), "formulacms-token-boundary-"))
    for (const directory of directories) {
      mkdirSync(join(root, directory), { recursive: true })
      for (const name of ["view.test.tsx", "view.node.test.ts", "view.spec.tsx"]) {
        writeFileSync(
          join(root, directory, name),
          `expect(classes).toContain("${token}")`
        )
      }
    }
    expect(await checkTokenBoundary(root)).toBe(0)

    for (const directory of directories) {
      writeFileSync(
        join(root, directory, "view.tsx"),
        `<div className="${token}" />`
      )
    }
    expect(await checkTokenBoundary(root)).toBe(directories.length)
  }
)
