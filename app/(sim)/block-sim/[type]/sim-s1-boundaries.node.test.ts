// @vitest-environment node
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

test("simulator editing and persistence paths cannot import token editing or write globals.css", () => {
  const paths = [
    "app/(sim)/block-sim/[type]/visual-tweak-store.tsx",
    "app/(sim)/block-sim/[type]/visual-tweak-reducer.ts",
    "app/(sim)/block-sim/[type]/spacing-batch.ts",
    "app/(sim)/block-sim/[type]/read-renderer-source.ts",
    "app/(sim)/block-sim/[type]/actions.ts",
    "lib/blocks/visual-tweak/class-operations.ts",
    "lib/blocks/visual-tweak/class-operation-files.ts",
    "lib/blocks/visual-tweak/write.ts",
    "lib/blocks/authoring/renderer-service.ts",
  ]
  for (const path of paths) {
    const source = readFileSync(path, "utf8")
    expect(source, path).not.toMatch(
      /(?:from\s*|import\s*\()["'][^"']*design-system\/edit/
    )
    expect(source, path).not.toMatch(
      /(?:writeFile(?:Sync)?|appendFile(?:Sync)?)\s*\([^)]*globals\.css/s
    )
  }
})
