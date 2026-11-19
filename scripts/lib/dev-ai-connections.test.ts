import { describe, expect, test, vi } from "vitest"
import type { LocalApiKeys } from "@/lib/local-api-keys"

// Without an explicit env, the API keys come from .env.local at each call.
const readLocalApiKeys = vi.hoisted(() =>
  vi.fn(
    (): LocalApiKeys => ({ anthropic: undefined, openai: undefined, openrouter: undefined })
  )
)
vi.mock("@/lib/local-api-keys-file", () => ({ readLocalApiKeys }))
import {
  inspectDevAiConnection,
  inspectDevAiConnections,
  inspectLocalTools,
  validateDevAiConnection,
  type RunStatusCommand,
} from "./dev-ai-connections"

describe("Development AI connection inspection", () => {
  test("without an explicit env, reads the API keys from .env.local at each call", async () => {
    readLocalApiKeys.mockReturnValueOnce({
      anthropic: undefined,
      openai: undefined,
      openrouter: "sk-or-test-0000",
    })
    await expect(inspectDevAiConnection("openrouter")).resolves.toEqual({
      state: "configured",
      method: "api-key",
    })
    // The next call sees the key removed from the file.
    await expect(inspectDevAiConnection("openrouter")).resolves.toEqual({
      state: "not-configured",
      issue: "missing-key",
    })
  })

  test("distinguishes local key configuration from authenticated CLIs", async () => {
    const runCommand: RunStatusCommand = vi.fn(async (command) =>
      command === "claude"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
          }
        : { exitCode: 0, stdout: "Logged in using ChatGPT\n" }
    )

    const status = await inspectDevAiConnections({
      env: { NEXTCMS_DEV_OPENROUTER_API_KEY: "openrouter-key" },
      runCommand,
      toolEnv: {},
    })

    expect(status).toEqual({
      off: { state: "off" },
      openrouter: { state: "configured", method: "api-key" },
      anthropic: { state: "not-configured", issue: "missing-key" },
      openai: { state: "not-configured", issue: "missing-key" },
      claude: { state: "authenticated", method: "plan" },
      codex: { state: "authenticated", method: "plan" },
    })
  })

  test("reads formulacms API keys and retains legacy-only keys across providers", async () => {
    const runCommand: RunStatusCommand = vi.fn(async () => ({
      exitCode: 1,
      stdout: "not logged in",
    }))

    const current = await inspectDevAiConnections({
      env: {
        FORMULACMS_DEV_OPENROUTER_API_KEY: "current-openrouter-key",
        FORMULACMS_DEV_ANTHROPIC_API_KEY: "current-anthropic-key",
        FORMULACMS_DEV_OPENAI_API_KEY: "current-openai-key",
      },
      runCommand,
      toolEnv: {},
    })
    const legacy = await inspectDevAiConnections({
      env: {
        NEXTCMS_DEV_OPENROUTER_API_KEY: "legacy-openrouter-key",
        NEXTCMS_DEV_ANTHROPIC_API_KEY: "legacy-anthropic-key",
        NEXTCMS_DEV_OPENAI_API_KEY: "legacy-openai-key",
      },
      runCommand,
      toolEnv: {},
    })

    for (const provider of ["openrouter", "anthropic", "openai"] as const) {
      expect(current[provider]).toEqual({
        state: "configured",
        method: "api-key",
      })
      expect(legacy[provider]).toEqual({
        state: "configured",
        method: "api-key",
      })
    }
  })

  test("fails closed for missing and signed-out CLIs", async () => {
    const runCommand: RunStatusCommand = vi.fn(async (command) =>
      command === "claude"
        ? { exitCode: 1, stdout: JSON.stringify({ loggedIn: false }) }
        : { exitCode: null, stdout: "", errorCode: "ENOENT" }
    )

    const status = await inspectDevAiConnections({
      env: {},
      runCommand,
      toolEnv: {},
    })
    expect(status.claude).toEqual({
      state: "not-configured",
      issue: "signed-out",
    })
    expect(status.codex).toEqual({
      state: "not-configured",
      issue: "missing-cli",
    })
  })

  test("does not call API validation until explicitly requested", async () => {
    const fetch = vi.fn(async () => Response.json({ data: {} }))
    const runCommand: RunStatusCommand = vi.fn(async () => ({
      exitCode: 1,
      stdout: "not logged in",
    }))

    await inspectDevAiConnections({
      env: { NEXTCMS_DEV_OPENROUTER_API_KEY: "key" },
      runCommand,
      toolEnv: {},
    })
    expect(fetch).not.toHaveBeenCalled()

    await expect(
      validateDevAiConnection("openrouter", {
        env: { NEXTCMS_DEV_OPENROUTER_API_KEY: "key" },
        fetch,
      })
    ).resolves.toEqual({ state: "authenticated", method: "api-key" })
    expect(fetch).toHaveBeenCalledOnce()
  })

  test("keeps API-key sign-in and reports it as the method", async () => {
    const claudeApiKey: RunStatusCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key" }),
    }))
    await expect(
      validateDevAiConnection("claude", {
        runCommand: claudeApiKey,
        toolEnv: {},
      })
    ).resolves.toEqual({ state: "authenticated", method: "api-key" })

    const codexApiKey: RunStatusCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: "Logged in using an API key - sk-***\n",
    }))
    await expect(
      validateDevAiConnection("codex", { runCommand: codexApiKey, toolEnv: {} })
    ).resolves.toEqual({ state: "authenticated", method: "api-key" })
  })

  test("honors both Codex binary namespaces with formulacms first", async () => {
    const runCommand: RunStatusCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: "Logged in using ChatGPT\n",
    }))
    await validateDevAiConnection("codex", {
      env: { NEXTCMS_CODEX_BIN: "/Applications/Codex/codex" },
      runCommand,
      toolEnv: {},
    })
    expect(runCommand).toHaveBeenCalledWith(
      "/Applications/Codex/codex",
      ["login", "status"],
      {}
    )

    await validateDevAiConnection("codex", {
      env: {
        FORMULACMS_CODEX_BIN: "/Applications/Formula/Codex/codex",
        NEXTCMS_CODEX_BIN: "/Applications/Legacy/Codex/codex",
      },
      runCommand,
      toolEnv: {},
    })
    expect(runCommand).toHaveBeenLastCalledWith(
      "/Applications/Formula/Codex/codex",
      ["login", "status"],
      {}
    )
  })

  test("accepts Codex versions that report login status on stderr", async () => {
    const runCommand: RunStatusCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "Logged in using ChatGPT\n",
    }))
    await expect(
      validateDevAiConnection("codex", { runCommand, toolEnv: {} })
    ).resolves.toEqual({ state: "authenticated", method: "plan" })
  })
})

describe("local tool sign-in method", () => {
  const claudeStatus = (
    authMethod: string,
    loggedIn = true
  ): RunStatusCommand =>
    vi.fn(async () => ({
      exitCode: loggedIn ? 0 : 1,
      stdout: JSON.stringify({ loggedIn, authMethod }),
    }))
  const codexStatus = (line: string, exitCode = 0): RunStatusCommand =>
    vi.fn(async () => ({ exitCode, stdout: `${line}\n` }))

  for (const [authMethod, method] of [
    ["claude.ai", "plan"],
    ["oauth_token", "plan"],
    ["api_key", "api-key"],
    ["api_key_helper", "api-key"],
    ["third_party", "unknown"],
    ["something-new", "unknown"],
  ] as const) {
    test(`Claude Code authMethod ${authMethod} is ${method}`, async () => {
      await expect(
        inspectDevAiConnection("claude", {
          env: {},
          toolEnv: {},
          runCommand: claudeStatus(authMethod),
        })
      ).resolves.toEqual({ state: "authenticated", method })
    })
  }

  test("Claude Code signed out is not configured", async () => {
    await expect(
      inspectDevAiConnection("claude", {
        env: {},
        toolEnv: {},
        runCommand: claudeStatus("none", false),
      })
    ).resolves.toEqual({ state: "not-configured", issue: "signed-out" })
  })

  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    test(`Claude Code with ${name} in the tool environment is api-key, even signed in with the plan`, async () => {
      const runCommand = claudeStatus("claude.ai")
      await expect(
        inspectDevAiConnection("claude", {
          env: {},
          toolEnv: { [name]: "key" },
          runCommand,
        })
      ).resolves.toEqual({ state: "authenticated", method: "api-key" })
      expect(runCommand).toHaveBeenCalledWith("claude", ["auth", "status"], {
        [name]: "key",
      })
    })
  }

  test("a key only in formulacms's environment does not change the Claude Code method", async () => {
    await expect(
      inspectDevAiConnection("claude", {
        env: { ANTHROPIC_API_KEY: "from-env-file" },
        toolEnv: {},
        runCommand: claudeStatus("claude.ai"),
      })
    ).resolves.toEqual({ state: "authenticated", method: "plan" })
  })

  for (const [line, expected] of [
    ["Logged in using ChatGPT", { state: "authenticated", method: "plan" }],
    [
      "Logged in using an API key - sk-***",
      { state: "authenticated", method: "api-key" },
    ],
    [
      "Logged in using an access token",
      { state: "authenticated", method: "unknown" },
    ],
    ["Not logged in", { state: "not-configured", issue: "signed-out" }],
  ] as const) {
    test(`Codex "${line}" is reported without the vendor text`, async () => {
      const status = await inspectDevAiConnection("codex", {
        env: {},
        toolEnv: {},
        runCommand: codexStatus(
          line,
          expected.state === "authenticated" ? 0 : 1
        ),
      })
      expect(status).toEqual(expected)
      expect(JSON.stringify(status)).not.toContain("sk-")
    })
  }

  test("Codex with CODEX_API_KEY in the tool environment is api-key", async () => {
    await expect(
      inspectDevAiConnection("codex", {
        env: {},
        toolEnv: { CODEX_API_KEY: "key" },
        runCommand: codexStatus("Logged in using ChatGPT"),
      })
    ).resolves.toEqual({ state: "authenticated", method: "api-key" })
  })

  test("a missing tool stays missing even with a key in the tool environment", async () => {
    const missing: RunStatusCommand = vi.fn(async () => ({
      exitCode: null,
      stdout: "",
      errorCode: "ENOENT",
    }))
    await expect(
      inspectDevAiConnection("claude", {
        env: {},
        toolEnv: { ANTHROPIC_API_KEY: "key" },
        runCommand: missing,
      })
    ).resolves.toEqual({ state: "not-configured", issue: "missing-cli" })
  })
})

describe("local tools on Settings › AI", () => {
  const status = (claude: Awaited<ReturnType<RunStatusCommand>>, codex: Awaited<ReturnType<RunStatusCommand>>): RunStatusCommand =>
    vi.fn(async (command) => (command === "claude" ? claude : codex))

  test("reports the sign-in method of both tools, checked in parallel", async () => {
    const runCommand = status(
      { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) },
      { exitCode: 0, stdout: "Logged in using an API key\n" }
    )
    await expect(inspectLocalTools({ env: {}, toolEnv: {}, runCommand })).resolves.toEqual({ claude: "plan", codex: "api-key", claudeSignIn: { status: "plan", loggedIn: true, authMethod: "claude.ai", envKey: false } })
    expect(runCommand).toHaveBeenCalledTimes(2)
  })

  test("not installed, not signed in, and a failed check are told apart", async () => {
    const runCommand = status(
      { exitCode: null, stdout: "", errorCode: "ENOENT" },
      { exitCode: 1, stdout: "Not logged in\n" }
    )
    await expect(inspectLocalTools({ env: {}, toolEnv: {}, runCommand })).resolves.toEqual({ claude: "not-installed", codex: "signed-out", claudeSignIn: { status: "not-installed", loggedIn: null, authMethod: null, envKey: false } })
    const slow = status({ exitCode: null, stdout: "", timedOut: true }, { exitCode: 2, stdout: "" })
    await expect(inspectLocalTools({ env: {}, toolEnv: {}, runCommand: slow })).resolves.toEqual({ claude: "unknown", codex: "unknown", claudeSignIn: { status: "unknown", loggedIn: null, authMethod: null, envKey: false } })
  })

  test("Codex signed in with ChatGPT and OPENAI_API_KEY in the tool environment is not verified", async () => {
    const runCommand = status(
      { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) },
      { exitCode: 0, stdout: "Logged in using ChatGPT\n" }
    )
    await expect(inspectLocalTools({ env: {}, toolEnv: { OPENAI_API_KEY: "shell-key" }, runCommand })).resolves.toEqual({ claude: "plan", codex: "unknown", claudeSignIn: { status: "plan", loggedIn: true, authMethod: "claude.ai", envKey: false } })
    await expect(inspectLocalTools({ env: { OPENAI_API_KEY: "project-key" }, toolEnv: {}, runCommand })).resolves.toEqual({ claude: "plan", codex: "plan", claudeSignIn: { status: "plan", loggedIn: true, authMethod: "claude.ai", envKey: false } })
  })

  // The plan rule compares these raw values (review 1c3 round 1, P2): the
  // displayed status maps claude.ai and oauth_token both to "plan".
  test("Claude's raw sign-in keeps loggedIn and the exact authMethod, never identity", async () => {
    const claude = (body: object, toolEnv = {}) =>
      inspectLocalTools({ env: {}, toolEnv, runCommand: status({ exitCode: 0, stdout: JSON.stringify(body) }, { exitCode: 0, stdout: "Logged in using ChatGPT\n" }) })
    const identity = { email: "owner@example.com", orgName: "Org", configDirectory: "/Users/owner/.claude", subscriptionType: "max" }
    expect((await claude({ loggedIn: true, authMethod: "oauth_token", ...identity })).claudeSignIn).toEqual({ status: "plan", loggedIn: true, authMethod: "oauth_token", envKey: false })
    expect((await claude({ loggedIn: true, authMethod: "claude.ai" })).claudeSignIn).toEqual({ status: "plan", loggedIn: true, authMethod: "claude.ai", envKey: false })
    expect((await claude({ loggedIn: true, authMethod: "something-new" })).claudeSignIn).toEqual({ status: "unknown", loggedIn: true, authMethod: "other", envKey: false })
    expect((await claude({ loggedIn: false, authMethod: "none" })).claudeSignIn).toEqual({ status: "signed-out", loggedIn: false, authMethod: "none", envKey: false })
    // A key in the tool's environment wins before the JSON is read.
    expect((await claude({ loggedIn: true, authMethod: "claude.ai" }, { ANTHROPIC_API_KEY: "shell-key" })).claudeSignIn).toEqual({ status: "api-key", loggedIn: null, authMethod: null, envKey: true })
    expect(JSON.stringify(await claude({ loggedIn: true, authMethod: "oauth_token", ...identity }))).not.toMatch(/owner@example|Org|\/Users\/owner|max/u)
  })
})
