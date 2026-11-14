import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const root = process.cwd()

function readLayout(path: string): string {
  return readFileSync(join(root, path), "utf8")
}

const SERVER_AUTH_PROVIDER = "ConvexAuthNextjsServerProvider"

describe("root layout provider boundaries", () => {
  test("keeps the dev-only slice simulator outside every Convex provider", () => {
    const source = readLayout("app/(sim)/layout.tsx")

    expect(source).not.toContain("@/components/providers")
    expect(source).not.toContain("<Providers")
    expect(source).not.toContain(SERVER_AUTH_PROVIDER)
  })

  // The Convex Auth server provider reads cookies, so it may wrap only
  // request-time trees. The public site stays static/ISR (owner rule) and
  // gets the anonymous provider; its header asks /api/session-label instead.
  test.each([
    "app/(core)/layout.tsx",
    "app/(live-preview)/admin/pages/[id]/live-frame/[locale]/layout.tsx",
  ])("wires the signed-in Convex Auth provider in %s", (path) => {
    const source = readLayout(path)

    expect(source).toContain("@/lib/auth/convexAuth")
    expect(source).toContain(`<${SERVER_AUTH_PROVIDER}>`)
  })

  test("keeps the static public layout on the anonymous provider", () => {
    const source = readLayout("app/(public)/[locale]/layout.tsx")

    expect(source).toContain("@/components/providers")
    expect(source).toContain("<Providers")
    expect(source).not.toContain(SERVER_AUTH_PROVIDER)
    expect(source).not.toContain("@/lib/auth/")
  })
})
