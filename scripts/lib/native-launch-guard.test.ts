// @vitest-environment node
// Guard for the defect class "a test reaches a real vendor tool" (2026-11-15:
// a test started the real `codex app-server`). Every native launch default
// refuses in a test run, before `node:child_process` is called. Hermetic twice
// over: `node:child_process` is mocked here, and every command is a path that
// does not exist, so a broken guard fails instead of starting a tool.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { readClaudeCodeHandshake } from "./claude-cli-discovery"
import { withCodexModelListTransport } from "./codex-app-server"
import { inspectDevAiConnection } from "./dev-ai-connections"
import {
  assertNativeLaunchAllowed,
  isTestRun,
  NativeLaunchBlockedError,
} from "./native-launch-guard"
import { runSubscriptionCliProcess } from "./subscription-cli-process"

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  ...childProcess,
}))
// The Agent SDK starts `claude` itself: a broken guard would reach this fake.
const agentSdk = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock("@anthropic-ai/claude-agent-sdk", () => agentSdk)

const MISSING_CODEX = "/nonexistent/formulacms-guard/codex"
const MISSING_CLAUDE = "/nonexistent/formulacms-guard/claude"

const blocked = (command: string) =>
  expect.objectContaining({
    name: "NativeLaunchBlockedError",
    command,
    message: expect.stringContaining(`"${command}"`),
  })

beforeEach(() => {
  childProcess.spawn.mockReset()
  childProcess.execFile.mockReset()
  // A broken guard would reach these: they fail as "not installed".
  childProcess.spawn.mockImplementation(() => {
    throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })
  })
  childProcess.execFile.mockImplementation((...args: unknown[]) => {
    const done = args.at(-1) as (error: Error, stdout: string, stderr: string) => void
    done(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "", "")
  })
  vi.stubEnv("FORMULACMS_CODEX_BIN", MISSING_CODEX)
})

afterEach(() => {
  expect(agentSdk.query).not.toHaveBeenCalled()
  expect(childProcess.spawn).not.toHaveBeenCalled()
  expect(childProcess.execFile).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
})

describe("native launch guard", () => {
  test("a Vitest run is a test run, and the check names the command", () => {
    expect(isTestRun()).toBe(true)
    expect(() => assertNativeLaunchAllowed("codex")).toThrow(NativeLaunchBlockedError)
    expect(() => assertNativeLaunchAllowed("codex")).toThrow('"codex"')
  })

  test("the Codex model list (codex app-server) refuses, with the configured or a given command", async () => {
    for (const command of [undefined, MISSING_CODEX]) {
      const withPage = vi.fn(async () => null)
      await expect(
        withCodexModelListTransport(withPage, { command, env: {}, deadlineMs: 1_000 })
      ).rejects.toEqual(blocked(MISSING_CODEX))
      expect(withPage).not.toHaveBeenCalled()
    }
  })

  test("a Claude Code or Codex run refuses before any process starts", async () => {
    for (const command of [MISSING_CLAUDE, MISSING_CODEX]) {
      const removePath = vi.fn(async () => undefined)
      await expect(
        runSubscriptionCliProcess(
          { command, args: ["-p"], stdin: "prompt", cwd: "/nonexistent", deadlineMs: 1_000, cleanupPaths: ["/nonexistent/run"] },
          { env: {}, killTree: vi.fn(), removePath }
        )
      ).rejects.toEqual(blocked(command))
      // The run's own cleanup still happens.
      expect(removePath).toHaveBeenCalledWith("/nonexistent/run")
    }
  })

  test("the Claude Code model list (Agent SDK handshake) refuses before the SDK starts claude", async () => {
    await expect(
      readClaudeCodeHandshake({ env: { PATH: "/nonexistent/formulacms-guard" }, executable: MISSING_CLAUDE, deadlineMs: 1_000 })
    ).rejects.toEqual(blocked("claude"))
  })

  test("the sign-in status commands refuse (claude auth status, codex login status)", async () => {
    await expect(inspectDevAiConnection("claude", { env: {}, toolEnv: {} })).rejects.toEqual(blocked("claude"))
    await expect(
      inspectDevAiConnection("codex", { env: { FORMULACMS_CODEX_BIN: MISSING_CODEX }, toolEnv: {} })
    ).rejects.toEqual(blocked(MISSING_CODEX))
  })
})
