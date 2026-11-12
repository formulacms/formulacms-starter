import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const root = process.cwd()

function readLayout(path: string): string {
  return readFileSync(join(root, path), "utf8")
}

describe("root layout provider boundaries", () => {
  test("keeps the dev-only slice simulator outside the Convex auth provider", () => {
    const source = readLayout("app/(sim)/layout.tsx")

    expect(source).not.toContain("@/components/providers")
    expect(source).not.toContain("<Providers")
  })

  test.each(["app/(core)/layout.tsx", "app/(public)/[locale]/layout.tsx"])(
    "keeps production auth wired in %s",
    (path) => {
      const source = readLayout(path)

      expect(source).toContain("@/components/providers")
      expect(source).toContain("<Providers")
    }
  )
})
