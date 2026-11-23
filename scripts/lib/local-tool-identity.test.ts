// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { localToolIdentity } from "./local-tool-identity"
import { localToolEnvironment } from "./subscription-cli-process"
import { claudeOnPath } from "./claude-cli-discovery"

// Fake executables in a temp directory; nothing is started (only file
// metadata is read). Each env is explicit: no real PATH or FORMULACMS_CODEX_BIN.
describe("localToolIdentity", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "formulacms-tool-identity-"))
    roots.push(root)
    const bin = join(root, "bin")
    const versions = join(root, "versions")
    mkdirSync(bin)
    mkdirSync(versions)
    const install = (name: string, body: string) => {
      const path = join(versions, name)
      writeFileSync(path, body, "utf8")
      chmodSync(path, 0o755)
      return path
    }
    return { root, bin, install, env: { PATH: bin } }
  }

  test.skipIf(process.platform === "win32")("native Claude discovery and cache identity agree when the starting shell omits its install directory", () => {
    const { root, bin, install, env } = setup()
    const one = install("native", "#!/bin/sh\n")
    const nativeBin = join(root, ".local", "bin")
    mkdirSync(nativeBin, { recursive: true })
    const nativeClaude = join(nativeBin, "claude")
    symlinkSync(one, nativeClaude)
    const startingEnv = { ...env, HOME: root }
    const toolEnv = localToolEnvironment({ env: startingEnv, root, readFile: () => null })
    expect(claudeOnPath(toolEnv)).toBe(nativeClaude)
    expect(localToolIdentity("claude", startingEnv)).toBeDefined()
    // A different installation already on PATH continues to take precedence.
    const earlier = join(bin, "claude")
    symlinkSync(one, earlier)
    expect(claudeOnPath(localToolEnvironment({ env: startingEnv, root, readFile: () => null }))).toBe(earlier)
  })

  test("Claude Code through a symlink on PATH: defined; changes with size, time or a new target", () => {
    const { bin, install, env } = setup()
    const v1 = install("1.0.0", "#!/bin/sh\n")
    const link = join(bin, "claude")
    symlinkSync(v1, link)
    const first = localToolIdentity("claude", env)
    expect(first).toBeDefined()
    expect(first).toContain(v1.split("/").pop())
    expect(localToolIdentity("claude", env)).toBe(first)

    writeFileSync(v1, "#!/bin/sh\necho upgraded\n", "utf8")
    const resized = localToolIdentity("claude", env)
    expect(resized).not.toBe(first)

    utimesSync(v1, new Date(2_000_000_000_000), new Date(2_000_000_000_000))
    const touched = localToolIdentity("claude", env)
    expect(touched).not.toBe(resized)

    unlinkSync(link)
    symlinkSync(install("2.0.0", "#!/bin/sh\necho upgraded\n"), link)
    expect(localToolIdentity("claude", env)).not.toBe(touched)
  })

  test("Codex: a bare name on PATH, or the path FORMULACMS_CODEX_BIN names", () => {
    const { bin, install, env } = setup()
    symlinkSync(install("codex-a", "a"), join(bin, "codex"))
    const onPath = localToolIdentity("codex", env)
    expect(onPath).toBeDefined()
    const configured = install("codex-b", "bb")
    const fromEnv = localToolIdentity("codex", { ...env, FORMULACMS_CODEX_BIN: configured })
    expect(fromEnv).toBeDefined()
    expect(fromEnv).not.toBe(onPath)
    expect(fromEnv).toContain("codex-b")
  })

  test("a tool that is missing, not executable or named wrongly: undefined, never a throw", () => {
    const { bin, install, env } = setup()
    expect(localToolIdentity("claude", env)).toBeUndefined()
    expect(localToolIdentity("codex", env)).toBeUndefined()
    expect(localToolIdentity("claude", {})).toBeUndefined()
    expect(localToolIdentity("codex", { ...env, FORMULACMS_CODEX_BIN: join(bin, "nowhere") })).toBeUndefined()
    const plain = install("claude", "not executable")
    chmodSync(plain, 0o644)
    symlinkSync(plain, join(bin, "claude"))
    expect(localToolIdentity("claude", env)).toBeUndefined()
  })
})
