// @vitest-environment node
import { EventEmitter } from "node:events"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { PassThrough } from "node:stream"
import { parse as parseDotenv } from "dotenv"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { withCodexModelListTransport } from "./codex-app-server"
import {
  inspectDevAiConnection,
  type RunStatusCommand,
} from "./dev-ai-connections"
import {
  localToolEnvironment,
  PROJECT_ENV_FILES,
  SubscriptionCliProcessError,
  runSubscriptionCliProcess,
  type SpawnSubscriptionCli,
} from "./subscription-cli-process"

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}))

vi.mock("node:child_process", () => childProcess)

class FakeChild extends EventEmitter {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
}

function fakeSpawn(
  settle: (child: FakeChild) => void
): { child: FakeChild; spawn: SpawnSubscriptionCli } {
  const child = new FakeChild()
  return {
    child,
    spawn: vi.fn(() => {
      queueMicrotask(() => settle(child))
      return child
    }),
  }
}

describe("runSubscriptionCliProcess", () => {
  test("passes argv without a shell, writes the prompt to stdin, and captures stdout", async () => {
    const { child, spawn } = fakeSpawn((current) => {
      current.stdout.end('{"type":"result"}\n')
      current.stderr.end()
      current.emit("close", 0, null)
    })
    let stdin = ""
    child.stdin.on("data", (chunk) => (stdin += chunk.toString()))
    const removePath = vi.fn(async () => {})

    await expect(
      runSubscriptionCliProcess(
        {
          command: "claude",
          args: ["-p", "--output-format", "json"],
          stdin: "PRIVATE PROMPT",
          cwd: "/tmp/isolated",
          deadlineMs: 1_000,
          cleanupPaths: ["/tmp/isolated"],
        },
        { spawn, killTree: vi.fn(), removePath }
      )
    ).resolves.toEqual({ stdout: '{"type":"result"}\n' })

    expect(spawn).toHaveBeenCalledWith(
      "claude",
      ["-p", "--output-format", "json"],
      expect.objectContaining({
        cwd: "/tmp/isolated",
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      })
    )
    expect(stdin).toBe("PRIVATE PROMPT")
    expect(removePath).toHaveBeenCalledWith("/tmp/isolated")
  })

  test("kills the process tree and cleans staged files when the deadline expires", async () => {
    vi.useFakeTimers()
    const { spawn } = fakeSpawn(() => {})
    const killTree = vi.fn(async () => {})
    const removePath = vi.fn(async () => {})

    const result = runSubscriptionCliProcess(
      {
        command: "claude",
        args: ["-p"],
        stdin: "prompt",
        cwd: "/tmp/staged",
        deadlineMs: 25,
        cleanupPaths: ["/tmp/staged"],
      },
      { spawn, killTree, removePath }
    )
    const rejected = expect(result).rejects.toMatchObject({ kind: "timeout" })
    await vi.advanceTimersByTimeAsync(25)

    await rejected
    expect(killTree).toHaveBeenCalledWith(4242, "SIGKILL")
    expect(removePath).toHaveBeenCalledWith("/tmp/staged")
    vi.useRealTimers()
  })

  test("kills the process tree and reports cancellation when the caller aborts", async () => {
    const { spawn } = fakeSpawn(() => {})
    const killTree = vi.fn(async () => {})
    const controller = new AbortController()
    const result = runSubscriptionCliProcess(
      {
        command: "codex",
        args: ["exec", "--json"],
        stdin: "prompt",
        cwd: "/tmp/run",
        deadlineMs: 1_000,
        signal: controller.signal,
      },
      { spawn, killTree, removePath: vi.fn() }
    )

    controller.abort()

    await expect(result).rejects.toMatchObject({ kind: "cancelled" })
    expect(killTree).toHaveBeenCalledWith(4242, "SIGKILL")
  })

  test("cleans staged files without spawning when already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn()
    const removePath = vi.fn(async () => {})

    const error = await runSubscriptionCliProcess(
        {
          command: "claude",
          args: ["-p"],
          stdin: "prompt",
          cwd: "/tmp/staged",
          deadlineMs: 1_000,
          signal: controller.signal,
          cleanupPaths: ["/tmp/staged"],
        },
        { spawn, killTree: vi.fn(), removePath }
      ).catch((value: unknown) => value)

    // The `.catch` hands back `unknown`; narrow before reaching for the
    // class's own `toJSON`. This is the same instance check the sibling test
    // at the bottom of this file asserts.
    if (!(error instanceof SubscriptionCliProcessError)) {
      throw new Error("expected a SubscriptionCliProcessError")
    }

    expect(error).toMatchObject({ kind: "cancelled", attempts: 0 })
    expect(error.toJSON()).not.toHaveProperty("attempts")
    expect(spawn).not.toHaveBeenCalled()
    expect(removePath).toHaveBeenCalledWith("/tmp/staged")
  })

  test("normalizes missing executables without exposing OS details", async () => {
    const { spawn } = fakeSpawn((current) => {
      current.emit("error", Object.assign(new Error("secret path"), { code: "ENOENT" }))
    })

    const result = runSubscriptionCliProcess(
      {
        command: "codex",
        args: ["exec"],
        stdin: "prompt",
        cwd: "/tmp/run",
        deadlineMs: 1_000,
      },
      { spawn, killTree: vi.fn(), removePath: vi.fn() }
    )

    await expect(result).rejects.toEqual(
      expect.objectContaining({
        kind: "missing-cli",
        message: "The selected local AI CLI is not available.",
      })
    )
  })

  test.each([
    ["Please login with token sk-ant-secret", "auth-required"],
    ["Your subscription quota is exhausted", "quota-exhausted"],
    ["rate limit reached", "rate-limited"],
    ["unsupported image input", "unsupported-capability"],
    ["request input is too large", "input-too-large"],
    ["session_id=private-value crashed", "local-process-failed"],
  ] as const)("lets each CLI classify its own non-zero exit safely: %s", async (stderr, kind) => {
    const { spawn } = fakeSpawn((current) => {
      current.stdout.end("partial output must not escape")
      current.stderr.end(stderr)
      current.emit("close", 1, null)
    })
    const classifyFailure = vi.fn(() => kind)

    const result = runSubscriptionCliProcess(
      {
        command: "claude",
        args: ["-p"],
        stdin: "prompt",
        cwd: "/tmp/run",
        deadlineMs: 1_000,
        classifyFailure,
      },
      { spawn, killTree: vi.fn(), removePath: vi.fn() }
    )

    const error = await result.catch((value: unknown) => value)
    expect(error).toBeInstanceOf(SubscriptionCliProcessError)
    expect(error).toMatchObject({ kind })
    expect(classifyFailure).toHaveBeenCalledWith({
      exitCode: 1,
      stdout: "partial output must not escape",
      stderr,
    })
    expect(JSON.stringify(error)).not.toContain("sk-ant-secret")
    expect(JSON.stringify(error)).not.toContain("private-value")
    expect(JSON.stringify(error)).not.toContain("partial output")
  })

  test("uses a generic process failure when an adapter supplies no classifier", async () => {
    const { spawn } = fakeSpawn((current) => {
      current.stderr.end("vendor-specific wording")
      current.emit("close", 2, null)
    })

    await expect(
      runSubscriptionCliProcess(
        {
          command: "future-cli",
          args: [],
          stdin: "prompt",
          cwd: "/tmp/run",
          deadlineMs: 1_000,
        },
        { spawn, killTree: vi.fn(), removePath: vi.fn() }
      )
    ).rejects.toMatchObject({ kind: "local-process-failed" })
  })
})

describe("localToolEnvironment", () => {
  const ROOT = "/project"
  function files(byName: Record<string, string>) {
    const readFile = vi.fn((path: string) => {
      const name = relative(ROOT, path)
      return name in byName ? byName[name]! : null
    })
    return readFile
  }

  test.skipIf(process.platform === "win32")("finds the native installer after the inherited PATH without changing its precedence", () => {
    const env = { HOME: "/home/owner", PATH: "/opt/custom/bin:/usr/bin" }
    const toolEnv = localToolEnvironment({ root: ROOT, readFile: files({}), env })
    expect(toolEnv.PATH).toBe("/opt/custom/bin:/usr/bin:/home/owner/.local/bin")
    expect(env.PATH).toBe("/opt/custom/bin:/usr/bin")
    expect(localToolEnvironment({ root: ROOT, readFile: files({}), env: toolEnv }).PATH).toBe(toolEnv.PATH)
  })

  test.each([
    { HOME: "/home/owner" },
    { HOME: "/home/owner", PATH: "" },
    { PATH: "/usr/bin" },
    { HOME: "relative/home", PATH: "/usr/bin" },
  ])("does not invent a home or search path: %j", (env) => {
    expect(localToolEnvironment({ root: ROOT, readFile: files({}), env }).PATH).toBe(env.PATH)
  })

  test.each(["HOME=/home/owner", "PATH=/usr/bin"])("does not restore a project-loaded path variable: %s", (text) => {
    const toolEnv = localToolEnvironment({ root: ROOT, readFile: files({ ".env.local": text }), env: { HOME: "/home/owner", PATH: "/usr/bin" } })
    expect(toolEnv.PATH).toBe(text.startsWith("PATH=") ? undefined : "/usr/bin")
  })

  test("keeps the terminal's variables and removes the values loaded from project .env files", () => {
    const readFile = files({
      ".env.local": "ANTHROPIC_API_KEY=from-file\nCONVEX_DEPLOYMENT=dev:one\n",
      ".env": "OPENAI_API_KEY=file-value\n",
      ".env.development": "EXPANDED=${HOME}/x\n",
    })
    const toolEnv = localToolEnvironment({
      root: ROOT,
      readFile,
      env: {
        PATH: "/usr/bin",
        HOME: "/home/owner",
        // Loaded from .env.local: same value as the file.
        ANTHROPIC_API_KEY: "from-file",
        CONVEX_DEPLOYMENT: "dev:one",
        // Exported in the terminal: dotenv never overrides it, so it differs.
        OPENAI_API_KEY: "terminal-value",
        // A file value with `$` may have been expanded: removed.
        EXPANDED: "/home/owner/x",
        // formulacms's own development keys never reach the tool.
        FORMULACMS_DEV_ANTHROPIC_API_KEY: "terminal-or-file",
        NEXTCMS_DEV_OPENAI_API_KEY: "terminal-or-file",
        UNSET: undefined,
      },
    })

    expect(Object.keys(toolEnv).sort()).toEqual([
      "HOME",
      "OPENAI_API_KEY",
      "PATH",
    ])
    expect(readFile.mock.calls.map(([path]) => relative(ROOT, path))).toEqual([
      ...PROJECT_ENV_FILES,
    ])
  })

  test("keeps a terminal key when no project file names it", () => {
    const toolEnv = localToolEnvironment({
      root: ROOT,
      readFile: files({}),
      env: { ANTHROPIC_API_KEY: "terminal", CODEX_API_KEY: "terminal" },
    })
    expect(Object.keys(toolEnv).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "CODEX_API_KEY",
    ])
  })

  // Guard: the names removed are the names the loaders (dotenv in Next.js and
  // the Convex CLI) read from the file. Expected sets are written out.
  test.each([
    ["a byte-order mark before the first name", "\uFEFFANTHROPIC_API_KEY=k\nB=2\n", ["ANTHROPIC_API_KEY", "B"]],
    ["the `KEY: value` form", "ANTHROPIC_API_KEY: k\n", ["ANTHROPIC_API_KEY"]],
    ["CRLF line ends", "A=1\r\nB=2\r\n", ["A", "B"]],
    ["`export` before a name", "export OPENAI_API_KEY=k\n", ["OPENAI_API_KEY"]],
    ["single, double and back quotes", "A='1'\nB=\"2\"\nC=`3`\n", ["A", "B", "C"]],
    ["comments, full-line and after a value", "# A=1\nB=2 # note\n", ["B"]],
    ["a multiline double-quoted value", 'A="line one\nline two"\nB=2\n', ["A", "B"]],
  ])("removes the names dotenv reads: %s", (_label, text, removed) => {
    const parsed = parseDotenv(text)
    expect(Object.keys(parsed).sort()).toEqual([...removed].sort())
    const toolEnv = localToolEnvironment({
      root: ROOT,
      readFile: files({ ".env.local": text }),
      env: { ...parsed, PATH: "/usr/bin" },
    })
    expect(Object.keys(toolEnv)).toEqual(["PATH"])
  })

  test("handles an environment of 500 variables", () => {
    const env = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`VAR_${index}`, `v${index}`])
    )
    const readFile = files({ ".env.local": "VAR_0=v0\nVAR_1=other\n" })
    const toolEnv = localToolEnvironment({ root: ROOT, readFile, env })
    expect(Object.keys(toolEnv)).toHaveLength(499)
    expect(toolEnv.VAR_0).toBeUndefined()
  })
})

// Guard for the defect class "a local tool run or status check that can bill
// a key the owner did not give to the tool": every spawn of a local tool
// passes an explicit environment. The process layer is an injected fake: the
// native defaults refuse to start a tool in a test (native-launch-guard.test.ts).
describe("local tool spawn sites", () => {
  const TOOL_ENV = { PATH: "/usr/bin", MARKER: "tool-env" }
  const toolSpawn = vi.fn<SpawnSubscriptionCli>()
  const runCommand = vi.fn<RunStatusCommand>()
  beforeEach(() => {
    toolSpawn.mockReset()
    runCommand.mockReset()
  })

  function closingChild(code: number): ReturnType<SpawnSubscriptionCli> {
    const child = new FakeChild()
    Object.defineProperty(child, "pid", { value: undefined })
    queueMicrotask(() => {
      child.stdout.end()
      child.stderr.end()
      child.emit("close", code, null)
    })
    return child as unknown as ReturnType<SpawnSubscriptionCli>
  }

  test("runSubscriptionCliProcess spawns with the tool environment", async () => {
    toolSpawn.mockImplementationOnce(() => closingChild(0))
    await runSubscriptionCliProcess(
      {
        command: "claude",
        args: ["-p"],
        stdin: "prompt",
        cwd: "/tmp/run",
        deadlineMs: 1_000,
      },
      { spawn: toolSpawn, env: TOOL_ENV, killTree: vi.fn(), removePath: vi.fn() }
    )
    expect(toolSpawn).toHaveBeenLastCalledWith(
      "claude",
      ["-p"],
      expect.objectContaining({ env: TOOL_ENV, shell: false })
    )
  })

  test("the Codex model-list preflight spawns with the tool environment", async () => {
    toolSpawn.mockImplementationOnce(() => closingChild(1))
    await withCodexModelListTransport(async () => null, {
      command: "codex",
      env: TOOL_ENV,
      deadlineMs: 1_000,
      spawn: toolSpawn,
    }).catch(() => undefined)
    expect(toolSpawn).toHaveBeenLastCalledWith(
      "codex",
      ["app-server", "--listen", "stdio://"],
      expect.objectContaining({ env: TOOL_ENV, shell: false })
    )
  })

  for (const [choice, command] of [
    ["claude", "claude"],
    ["codex", "codex"],
  ] as const) {
    test(`the ${choice} status command runs with the tool environment`, async () => {
      runCommand.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Logged in using ChatGPT",
        stderr: "",
      })
      await inspectDevAiConnection(choice, {
        env: {},
        toolEnv: TOOL_ENV,
        runCommand,
      })
      expect(runCommand).toHaveBeenLastCalledWith(
        command,
        expect.any(Array),
        TOOL_ENV
      )
    })
  }

  describe("by default (no injected environment)", () => {
    let project: string

    beforeEach(() => {
      // A scratch project whose .env.local holds a key formulacms loaded.
      project = mkdtempSync(join(tmpdir(), "formulacms-tool-env-"))
      writeFileSync(join(project, ".env.local"), "ANTHROPIC_API_KEY=from-file\n")
      vi.spyOn(process, "cwd").mockReturnValue(project)
      vi.stubEnv("ANTHROPIC_API_KEY", "from-file")
      vi.stubEnv("TERMINAL_ONLY", "kept")
      vi.stubEnv("HOME", "/home/owner")
      vi.stubEnv("PATH", "/usr/bin")
    })

    afterEach(() => {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
      rmSync(project, { recursive: true, force: true })
    })

    const spawnedEnv = () =>
      toolSpawn.mock.lastCall![2].env as Record<string, string>

    test("a tool run never receives the key loaded from .env.local", async () => {
      toolSpawn.mockImplementationOnce(() => closingChild(0))
      await runSubscriptionCliProcess(
        {
          command: "claude",
          args: ["-p"],
          stdin: "prompt",
          cwd: project,
          deadlineMs: 1_000,
        },
        { spawn: toolSpawn, killTree: vi.fn(), removePath: vi.fn() }
      )
      expect(spawnedEnv().ANTHROPIC_API_KEY).toBeUndefined()
      expect(spawnedEnv().TERMINAL_ONLY).toBe("kept")
      if (process.platform !== "win32") expect(spawnedEnv().PATH).toBe("/usr/bin:/home/owner/.local/bin")
    })

    test("a tool run never receives it when .env.local starts with a byte-order mark", async () => {
      writeFileSync(join(project, ".env.local"), "\uFEFFANTHROPIC_API_KEY=from-file\n")
      toolSpawn.mockImplementationOnce(() => closingChild(0))
      await runSubscriptionCliProcess(
        {
          command: "claude",
          args: ["-p"],
          stdin: "prompt",
          cwd: project,
          deadlineMs: 1_000,
        },
        { spawn: toolSpawn, killTree: vi.fn(), removePath: vi.fn() }
      )
      expect(spawnedEnv().ANTHROPIC_API_KEY).toBeUndefined()
      expect(spawnedEnv().TERMINAL_ONLY).toBe("kept")
    })

    test("the Codex model-list preflight never receives it", async () => {
      toolSpawn.mockImplementationOnce(() => closingChild(1))
      await withCodexModelListTransport(async () => null, {
        command: "codex",
        deadlineMs: 1_000,
        spawn: toolSpawn,
      }).catch(() => undefined)
      expect(spawnedEnv().ANTHROPIC_API_KEY).toBeUndefined()
      expect(spawnedEnv().TERMINAL_ONLY).toBe("kept")
    })

    test("the status check runs without it, so it reports the plan a run uses", async () => {
      const runCommand = vi.fn(async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      }))
      await expect(
        inspectDevAiConnection("claude", {
          env: { ANTHROPIC_API_KEY: "from-file", TERMINAL_ONLY: "kept" },
          runCommand,
        })
      ).resolves.toEqual({ state: "authenticated", method: "plan" })
      expect(runCommand).toHaveBeenCalledWith("claude", ["auth", "status"], {
        TERMINAL_ONLY: "kept",
      })
    })

    test.skipIf(process.platform === "win32")("the status check receives the same native PATH fallback as a real run", async () => {
      runCommand.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) })
      await expect(inspectDevAiConnection("claude", { runCommand })).resolves.toEqual({ state: "authenticated", method: "plan" })
      const call = runCommand.mock.lastCall!
      expect(call[0]).toBe("claude")
      expect(call[1]).toEqual(["auth", "status"])
      // Assert only these fields: a red guard must never print the inherited
      // environment (which may include terminal credentials).
      expect(call[2].PATH).toBe("/usr/bin:/home/owner/.local/bin")
      expect(call[2].HOME).toBe("/home/owner")
      expect(Boolean(call[2].ANTHROPIC_API_KEY)).toBe(false)
    })
  })

  test("every child_process importer is a covered tool site or a listed other site", () => {
    // Tool sites: covered by the tests above.
    const toolSites = [
      "scripts/lib/codex-app-server.ts",
      "scripts/lib/dev-ai-connections.ts",
      "scripts/lib/subscription-cli-process.ts",
    ]
    const root = process.cwd()
    // Not local tools: git, tar, pnpm, node and the Convex CLI. The starter
    // does not ship every one (scripts/lib/empirical-runner.ts stays in the
    // source), so the list keeps the sites this tree has. Every importer
    // found below must still be listed.
    const otherSites = [
      "lib/blocks/authoring/gate.ts",
      "scripts/lib/empirical-runner.ts",
      "scripts/lib/local-setup.ts",
      "scripts/lib/pre-rename-source.ts",
      "scripts/lib/stored-module-state.ts",
    ].filter((file) => existsSync(join(root, file)))
    const importers = ["app", "lib", "scripts/lib"].flatMap((dir) =>
      (readdirSync(join(root, dir), { recursive: true }) as string[])
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
        .map((file) => join(dir, file))
        .filter((file) =>
          /from "(node:)?child_process"/.test(
            readFileSync(join(root, file), "utf8")
          )
        )
    )
    expect(importers.sort()).toEqual([...toolSites, ...otherSites].sort())
  })
})
