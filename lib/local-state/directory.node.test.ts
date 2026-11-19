import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  isLocalStatePath,
  localStateDirectory,
  markLocalStateInUse,
  moveLegacyLocalState,
} from "./directory"

vi.mock("@/lib/env", () => ({ validateNextRuntimeEnv: vi.fn() }))

const roots: string[] = []
const LOCAL = join(".formulacms", "local")

function makeRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "formulacms-local-state-"))
  )
  roots.push(root)
  return root
}

function seedLegacy(root: string, ...relative: string[]): void {
  const legacy = join(root, ".nextcms")
  mkdirSync(join(legacy, "slice-references"), { recursive: true })
  writeFileSync(join(legacy, "dev-ai.json"), "{}\n")
  for (const path of relative)
    mkdirSync(join(legacy, path), { recursive: true })
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe("local state folder", () => {
  test("uses an old folder in place, then the new one; never touches disk", () => {
    const root = makeRoot()
    expect(localStateDirectory(root)).toBe(join(root, LOCAL))
    seedLegacy(root)
    // Creation records alone do not hide the old folder.
    mkdirSync(join(root, ".formulacms"))
    expect(localStateDirectory(root)).toBe(join(root, ".nextcms"))
    mkdirSync(join(root, LOCAL))
    expect(localStateDirectory(root)).toBe(join(root, LOCAL))
    expect(existsSync(join(root, ".nextcms", "dev-ai.json"))).toBe(true)
  })

  test.each([false, true])(
    "the move keeps the contents (creation records present: %s)",
    (records) => {
      const root = makeRoot()
      seedLegacy(root)
      if (records) {
        mkdirSync(join(root, ".formulacms"))
        writeFileSync(join(root, ".formulacms", "creation-receipt.json"), "r")
      }
      moveLegacyLocalState(root)
      expect(existsSync(join(root, ".nextcms"))).toBe(false)
      expect(readFileSync(join(root, LOCAL, "dev-ai.json"), "utf8")).toBe(
        "{}\n"
      )
      if (records)
        expect(
          readFileSync(
            join(root, ".formulacms", "creation-receipt.json"),
            "utf8"
          )
        ).toBe("r")
    }
  )

  test("the move does nothing when the new folder exists", () => {
    const root = makeRoot()
    seedLegacy(root)
    mkdirSync(join(root, LOCAL), { recursive: true })
    moveLegacyLocalState(root)
    expect(existsSync(join(root, ".nextcms", "dev-ai.json"))).toBe(true)
    expect(existsSync(join(root, LOCAL, "dev-ai.json"))).toBe(false)
  })

  test("the move does nothing when .formulacms is not a real folder", () => {
    const root = makeRoot()
    seedLegacy(root)
    mkdirSync(join(root, "elsewhere"))
    symlinkSync(join(root, "elsewhere"), join(root, ".formulacms"))
    moveLegacyLocalState(root)
    expect(existsSync(join(root, ".nextcms", "dev-ai.json"))).toBe(true)
    expect(readdirSync(join(root, "elsewhere"))).toEqual([])
  })

  test.each([
    "design-system-transactions/lock",
    "design-system-transactions/active/a",
    "design-system-transactions/preparing/a",
  ])("an open transaction (%s) keeps the old folder in place", (busy) => {
    const root = makeRoot()
    seedLegacy(root, busy)
    moveLegacyLocalState(root)
    expect(existsSync(join(root, ".nextcms", busy))).toBe(true)
    expect(existsSync(join(root, ".formulacms"))).toBe(false)
  })

  test("the move does nothing on a fresh checkout and never throws", () => {
    const root = makeRoot()
    moveLegacyLocalState(root)
    expect(existsSync(join(root, ".formulacms"))).toBe(false)
    seedLegacy(root)
    expect(() =>
      moveLegacyLocalState(root, () => {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" })
      })
    ).not.toThrow()
    expect(existsSync(join(root, ".nextcms", "dev-ai.json"))).toBe(true)
  })

  test("the in-use marker is written only in the old folder", () => {
    const root = makeRoot()
    markLocalStateInUse(root)()
    expect(existsSync(join(root, ".nextcms"))).toBe(false)
    expect(existsSync(join(root, ".formulacms"))).toBe(false)

    seedLegacy(root)
    const release = markLocalStateInUse(root)
    expect(readdirSync(join(root, ".nextcms", "in-use"))).toHaveLength(1)
    release()
    expect(readdirSync(join(root, ".nextcms", "in-use"))).toEqual([])

    mkdirSync(join(root, LOCAL), { recursive: true })
    markLocalStateInUse(root)
    expect(existsSync(join(root, LOCAL, "in-use"))).toBe(false)
  })

  test("a marker never re-creates an old folder that vanished", () => {
    const root = makeRoot()
    // Found by the lookup, gone by the mkdir (a dangling link stands in).
    symlinkSync(join(root, "moved-away"), join(root, ".nextcms"))
    expect(() => markLocalStateInUse(root)()).not.toThrow()
    expect(existsSync(join(root, "moved-away"))).toBe(false)
    expect(existsSync(join(root, ".formulacms"))).toBe(false)
  })

  test("a live marker holds the move; a dead one does not", () => {
    const root = makeRoot()
    seedLegacy(root, "in-use")
    writeFileSync(join(root, ".nextcms", "in-use", "999999-dead"), "")
    writeFileSync(join(root, ".nextcms", "in-use", "not-a-pid"), "")
    moveLegacyLocalState(root, undefined, () => true)
    expect(existsSync(join(root, ".nextcms"))).toBe(true)
    moveLegacyLocalState(root, undefined, () => false)
    expect(existsSync(join(root, ".nextcms"))).toBe(false)
    expect(readdirSync(join(root, LOCAL, "in-use")).sort()).toEqual([
      "999999-dead",
      "not-a-pid",
    ])
  })

  test("a CLI that started first keeps its old-folder paths until it ends", () => {
    const root = makeRoot()
    seedLegacy(root)
    const release = markLocalStateInUse(root)
    const original = join(
      localStateDirectory(root),
      "slice-references",
      "originals",
      "x.png"
    )
    moveLegacyLocalState(root) // the server starts while the CLI runs
    expect(original.startsWith(join(root, ".nextcms"))).toBe(true)
    expect(existsSync(join(root, ".nextcms"))).toBe(true)
    release()
    moveLegacyLocalState(root) // the next server start
    expect(existsSync(join(root, LOCAL))).toBe(true)
    expect(existsSync(join(root, ".nextcms"))).toBe(false)
  })

  test.each([
    ["nodejs", false],
    ["edge", true],
  ])("server start under %s: old folder kept is %s", async (runtime, kept) => {
    const root = makeRoot()
    seedLegacy(root)
    vi.stubEnv("NEXT_RUNTIME", runtime)
    const cwd = process.cwd()
    process.chdir(root)
    try {
      const { register } = await import("@/instrumentation")
      await register()
    } finally {
      process.chdir(cwd)
    }
    expect(existsSync(join(root, ".nextcms"))).toBe(kept)
  })

  test("recognizes both folder names, but not look-alike names", () => {
    for (const path of [
      ".formulacms",
      ".formulacms/x",
      ".formulacms/creation-receipt.json",
      ".formulacms/local/dev-ai.json",
      ".nextcms",
      ".nextcms/x",
    ]) {
      expect(isLocalStatePath(path)).toBe(true)
    }
    for (const path of [
      ".formulacms-design-system-transaction-1",
      ".nextcmsx/a",
      "app/globals.css",
    ]) {
      expect(isLocalStatePath(path)).toBe(false)
    }
  })
})
