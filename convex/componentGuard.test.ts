// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

/**
 * ADR-0056 rule 7. Convex Auth 2.0.0 has no documented way to end another
 * user's sessions (or to set another user's password). We call the undocumented
 * component functions `auth.public.listSessions` and `auth.public.revokeSessions`,
 * only from `convex/lib/sessions.ts`. This guard fails when an upgrade renames
 * or reshapes them, or when any other non-test file names them.
 * (The third call, `authPassword.public._internal_dangerous_setPassword`, joins
 * the guard when the editor unit adds `lib/dangerousSetPassword.ts`.)
 */
const normalize = (text: string) => text.replace(/\s+/g, " ")
const pkg = join(process.cwd(), "node_modules/@convex-dev/auth")
const core = normalize(
  readFileSync(
    join(pkg, "dist/component/_generated/component.d.ts"),
    "utf8"
  )
)

const ALLOWED_FILES = ["convex/lib/sessions.ts"]

function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(directory)) {
    if (name === "_generated" || name === "node_modules") continue
    const path = join(directory, name)
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) found.push(path)
  }
  return found
}

describe("undocumented Convex Auth component calls (ADR-0056 rule 7)", () => {
  test("listSessions keeps its name and argument and result shape", () => {
    expect(core).toContain(
      'listSessions: FunctionReference<"query", "internal", { userId: string; }, Array<{ creationTime: number; lastRefreshedAt: number; sessionId: string; }>'
    )
  })

  test("revokeSessions keeps its name and argument and result shape", () => {
    expect(core).toContain(
      'revokeSessions: FunctionReference<"mutation", "internal", { sessionIds: Array<string>; }, Array<string>'
    )
  })

  test("only convex/lib/sessions.ts names them, and no file names the dangerous calls", () => {
    const root = process.cwd()
    const named = sourceFiles(join(root, "convex"))
      .filter((file) =>
        /listSessions|revokeSessions|_internal_dangerous/.test(
          readFileSync(file, "utf8")
        )
      )
      .map((file) => file.slice(root.length + 1))
      .sort()
    expect(named).toEqual(ALLOWED_FILES)
  })

  test("the guard notices a simulated upgrade that renames an argument", () => {
    const upgraded = core.replace("sessionIds: Array<string>;", "ids: Array<string>;")
    expect(upgraded).not.toContain(
      'revokeSessions: FunctionReference<"mutation", "internal", { sessionIds: Array<string>; }, Array<string>'
    )
  })
})
