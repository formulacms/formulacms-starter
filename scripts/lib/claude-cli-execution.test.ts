// @vitest-environment node
import { describe, expect, test, vi } from "vitest"
import {
  executeClaudeCliGeneration,
  type RunClaudeCliProcess,
} from "./claude-cli-execution"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClaudeDiscoveryQuery } from "./claude-cli-discovery"
import {
  checkClaudeFablePlan,
  type CommandResult,
  type RunStatusCommand,
} from "./dev-ai-connections"
import { createLocalToolModelsLoader } from "./local-tool-models"
import { NativeLaunchBlockedError } from "./native-launch-guard"
import type { ClaudeOfferedModels } from "./subscription-cli-capabilities"
import { SubscriptionCliProcessError } from "./subscription-cli-process"

describe("executeClaudeCliGeneration", () => {
  test("rejects an effort above the ceiling before staging any customer inputs", async () => {
    const stageRun = vi.fn()

    await expect(
      executeClaudeCliGeneration(
        {
          systemPrompt: "PRIVATE SYSTEM PROMPT",
          prompt: "PRIVATE BUSINESS PROMPT",
          images: [{ path: "/private/design.png", mediaType: "image/png" }],
          profile: "vision-spec",
          phase: "block-spec",
          override: { model: "haiku", effort: "max" } as never,
        },
        { stageRun }
      )
    ).rejects.toMatchObject({ category: "UNSUPPORTED_CAPABILITY" })
    expect(stageRun).not.toHaveBeenCalled()
  })

  // Live-only models and the Fable rule (owner, 2026-11-15; ADR-0057). The
  // list Settings › AI last read decides membership only. Fable's plan is a
  // fresh check of the installed Claude Code in every Fable run, before
  // staging or the generation process; the cached plan has no say.
  const LISTED: ClaudeOfferedModels = {
    models: [
      { model: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh"] },
      { model: "claude-opus-4-8", efforts: ["low", "medium", "high", "xhigh"] },
      { model: "claude-fable-5-2", efforts: ["low", "medium", "high", "xhigh"] },
    ],
  }
  const request = (model: string, signal?: AbortSignal) => ({
    systemPrompt: "PRIVATE SYSTEM PROMPT",
    prompt: "PRIVATE BUSINESS PROMPT",
    images: [],
    profile: "grounded-help" as const,
    phase: "block-spec" as const,
    override: { model, effort: "high" as const },
    ...(signal ? { signal } : {}),
  })
  const stagedRun = () =>
    vi.fn(async () => ({
      cwd: "/tmp/formulacms-claude-fable-run",
      systemPromptFilename: "system-prompt.txt",
      imageFilenames: [],
      cleanupPaths: ["/tmp/formulacms-claude-fable-run"],
    }))
  const transcript = (model: string) =>
    [
      JSON.stringify({ type: "system", subtype: "init", model }),
      JSON.stringify({ type: "assistant", message: { model, content: [] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", usage: {} }),
    ].join("\n")
  const passed = () => vi.fn(async () => true)

  /** The real fresh check, with fakes only at its process seams: the status
   * command and the SDK's `query()`. */
  function freshCheck(options: {
    status?: Partial<CommandResult> & { json?: unknown }
    init?: () => Promise<{ models?: unknown; account?: unknown }>
    env?: Record<string, string>
  }) {
    const env = options.env ?? { PATH: "/usr/bin", HOME: "/home/owner" }
    const { json = { loggedIn: true, authMethod: "claude.ai" }, ...result } = options.status ?? {}
    const runCommand = vi.fn<RunStatusCommand>(async () => ({
      exitCode: 0,
      stdout: typeof json === "string" ? json : JSON.stringify(json),
      ...result,
    }))
    const close = vi.fn()
    let inputEnded = false
    const queryOptions: unknown[] = []
    const query = vi.fn((params: Parameters<ClaudeDiscoveryQuery>[0]) => {
      queryOptions.push(params.options)
      void (async () => {
        for await (const message of params.prompt) throw new Error(`sent ${String(message)}`)
        inputEnded = true
      })()
      return {
        initializationResult: options.init ?? (async () => ({ models: [], account: { subscriptionType: "Claude Ultra" } })),
        close,
      }
    })
    const checkFablePlan = vi.fn((r: { signal?: AbortSignal }) =>
      checkClaudeFablePlan({
        toolEnv: env,
        runCommand,
        query,
        executable: "/opt/claude/bin/claude",
        deadlineMs: 50,
        ...(r.signal ? { signal: r.signal } : {}),
      })
    )
    return { checkFablePlan, runCommand, query, close, queryOptions, env, inputEnded: () => inputEnded }
  }
  const plan = (subscriptionType: unknown) => async () => ({ models: [], account: { subscriptionType } })

  /** A list reader backed by real loaders sharing one mirror. */
  async function withMirror<T>(kind: "ultra" | "ultra-then-pro-unwritable" | "pro" | "unreadable", body: (readOffered: () => ClaudeOfferedModels) => Promise<T>) {
    const root = mkdtempSync(join(tmpdir(), "formulacms-claude-run-gate-"))
    const dir = join(root, ".formulacms", "local")
    const signIn = { status: "plan", loggedIn: true, authMethod: "claude.ai", envKey: false } as const
    const page = (subscriptionType: unknown) =>
      createLocalToolModelsLoader({
        readCodex: vi.fn(),
        readClaude: async () => ({ models: [{ value: "fable", resolvedModel: "claude-fable-5-2" }], subscriptionType }),
        root: () => root,
      })
    try {
      if (kind === "unreadable") mkdirSync(join(dir, "local-tool-models.json"), { recursive: true })
      else await page(kind === "pro" ? "Claude Pro" : "Claude Ultra").load({ claude: signIn })
      if (kind === "ultra-then-pro-unwritable") {
        // Round 2's P1: another loader sees a sign-in change and Pro, but
        // cannot write the mirror, which still says Ultra.
        chmodSync(dir, 0o500)
        await page("Claude Pro").load({ claude: { ...signIn, authMethod: "oauth_token" } })
        // The write really failed: the mirror still holds the Ultra plan.
        expect(JSON.parse(readFileSync(join(dir, "local-tool-models.json"), "utf8")).claudeAuth.plan.state).toBe("eligible")
      }
      const run = createLocalToolModelsLoader({ readCodex: vi.fn(), readClaude: vi.fn(), root: () => root })
      if (kind === "ultra" || kind === "ultra-then-pro-unwritable") {
        // The cached plan allows Fable in the menu of every loader.
        expect(run.peek().claude.models.find((m) => m.model === "claude-fable-5-2")?.unavailable).toBeUndefined()
      }
      return await body(() => run.peekClaude())
    } finally {
      if (existsSync(dir)) chmodSync(dir, 0o700)
      rmSync(root, { recursive: true, force: true })
    }
  }

  const FABLE = ["claude-fable-5-2", "fable"] as const

  // The class guard: the cache never authorizes spending.
  describe.each(["ultra", "ultra-then-pro-unwritable"] as const)("mirror %s", (kind) => {
    test.each(
      FABLE.flatMap((model) =>
        [
          ["Pro", { init: plan("Claude Pro") }],
          ["an unknown plan", { init: plan(null) }],
          ["a failed handshake", { init: async () => Promise.reject(new Error("handshake failed")) }],
          ["a timeout", { init: () => new Promise<never>(() => undefined) }],
          ["a failed status", { status: { exitCode: 1, json: "" } }],
        ].map(([label, options]) => [model, label, options] as const)
      )
    )("%s with a fresh check that returns %s is refused before staging or the process", async (model, _label, options) => {
      await withMirror(kind, async (readOffered) => {
        const check = freshCheck(options as Parameters<typeof freshCheck>[0])
        const stageRun = vi.fn()
        const runProcess = vi.fn()
        await expect(
          executeClaudeCliGeneration(request(model), { stageRun, runProcess, readOffered, checkFablePlan: check.checkFablePlan })
        ).rejects.toMatchObject({ category: "UNSUPPORTED_CAPABILITY" })
        expect(check.runCommand).toHaveBeenCalledTimes(1)
        expect(stageRun).not.toHaveBeenCalled()
        expect(runProcess).not.toHaveBeenCalled()
        if (check.query.mock.calls.length > 0) {
          expect(check.close).toHaveBeenCalledTimes(1)
          await vi.waitFor(() => expect(check.inputEnded()).toBe(true))
        }
      })
    })

    test.each(FABLE)("%s cancelled during the fresh check stops before staging, and the session closes", async (model) => {
      await withMirror(kind, async (readOffered) => {
        const controller = new AbortController()
        const check = freshCheck({
          init: () => {
            controller.abort()
            return new Promise<never>(() => undefined)
          },
        })
        const stageRun = vi.fn()
        const runProcess = vi.fn()
        await expect(
          executeClaudeCliGeneration(request(model, controller.signal), {
            stageRun,
            runProcess,
            readOffered,
            checkFablePlan: check.checkFablePlan,
          })
        ).rejects.toMatchObject({ category: "CANCELLED", attempts: 0 })
        expect(stageRun).not.toHaveBeenCalled()
        expect(runProcess).not.toHaveBeenCalled()
        expect(check.close).toHaveBeenCalledTimes(1)
        expect((check.queryOptions[0] as { abortController: AbortController }).abortController.signal.aborted).toBe(true)
        await vi.waitFor(() => expect(check.inputEnded()).toBe(true))
      })
    })
  })

  test.each(
    (["pro", "unreadable", "ultra-then-pro-unwritable"] as const).flatMap((kind) => FABLE.map((model) => [kind, model] as const))
  )("mirror %s, fresh check Ultra: %s runs (the run never reads the cached plan)", async (kind, model) => {
    await withMirror(kind, async (readOffered) => {
      const check = freshCheck({ init: plan("Claude Ultra") })
      const stageRun = stagedRun()
      const runProcess = vi.fn<RunClaudeCliProcess>(async () => ({ stdout: transcript("claude-fable-5-2") }))
      await expect(
        executeClaudeCliGeneration(request(model), { stageRun, runProcess, readOffered, checkFablePlan: check.checkFablePlan })
      ).resolves.toMatchObject({ selected: { model } })
      // One status and one handshake, in an empty directory, with the run's
      // executable and environment, and the run's setting sources (none).
      expect(check.runCommand).toHaveBeenCalledTimes(1)
      const [command, args, env, statusOptions] = check.runCommand.mock.calls[0]!
      expect([command, args, env]).toEqual(["/opt/claude/bin/claude", ["auth", "status"], check.env])
      expect(check.queryOptions).toEqual([
        expect.objectContaining({
          pathToClaudeCodeExecutable: "/opt/claude/bin/claude",
          env: check.env,
          cwd: statusOptions?.cwd,
          settingSources: [],
          settings: { disableAllHooks: true },
          tools: [],
          strictMcpConfig: true,
          persistSession: false,
        }),
      ])
      expect(existsSync(statusOptions!.cwd!)).toBe(false)
      // The same setting sources as the run's invocation: none.
      const runArgs = runProcess.mock.calls[0]![0].args
      expect(runArgs[runArgs.indexOf("--setting-sources") + 1]).toBe("")
      expect((check.queryOptions[0] as { settingSources: unknown }).settingSources).toEqual([])
      expect(check.close).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(check.inputEnded()).toBe(true))
      expect(stageRun.mock.invocationCallOrder[0]).toBeGreaterThan(check.close.mock.invocationCallOrder[0]!)
    })
  })

  const runFable = (model: string, check: ReturnType<typeof freshCheck>) => {
    const stageRun = stagedRun()
    const runProcess = vi.fn<RunClaudeCliProcess>(async () => ({ stdout: transcript("claude-fable-5-2") }))
    const result = executeClaudeCliGeneration(request(model), {
      stageRun,
      runProcess,
      readOffered: () => LISTED,
      checkFablePlan: check.checkFablePlan,
    })
    return { result, stageRun, runProcess }
  }

  // Every allow comes from the handshake (no settings file, like the run):
  // `claude auth status` loads settings files the run does not, so it can
  // only refuse (round 3), and a key in the run's environment may be cleared
  // by managed settings before the run sees it (round 4).
  type Account = { subscriptionType?: unknown; apiKeySource?: unknown; tokenSource?: unknown }
  const ACCOUNTS: readonly (readonly [string, Account, boolean])[] = [
    ["no key, Pro", { apiKeySource: "none", subscriptionType: "Claude Pro" }, false],
    ["nothing reported, Pro", { subscriptionType: "Claude Pro" }, false],
    ["no key, no plan", { apiKeySource: "none", tokenSource: "none", subscriptionType: null }, false],
    ["a stored Console key with Pro", { apiKeySource: "/login managed key", subscriptionType: "Claude Pro" }, false],
    ["a stored Console key, token none, Pro", { apiKeySource: "/login managed key", tokenSource: "none", subscriptionType: "Claude Pro" }, false],
    ["a stored Console key, no token source reported", { apiKeySource: "/login managed key" }, false],
    ["a stored Console key, token none, no plan", { apiKeySource: "/login managed key", tokenSource: "none" }, true],
    ["a stored Console key, token none, empty plan", { apiKeySource: "/login managed key", tokenSource: "none", subscriptionType: "" }, true],
    ["a stored Console key with Max", { apiKeySource: "/login managed key", subscriptionType: "Claude Max" }, true],
    ["ANTHROPIC_API_KEY with Pro", { apiKeySource: "ANTHROPIC_API_KEY", subscriptionType: "Claude Pro" }, true],
    ["apiKeyHelper with Pro", { apiKeySource: "apiKeyHelper", subscriptionType: "Claude Pro" }, true],
    ["the bearer token", { apiKeySource: "none", tokenSource: "ANTHROPIC_AUTH_TOKEN" }, true],
    ["a long-lived OAuth token, no plan", { apiKeySource: "none", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }, false],
    ["Ultra", { apiKeySource: "none", subscriptionType: "Claude Ultra" }, true],
    ["Max", { apiKeySource: "none", subscriptionType: "max" }, true],
    ["an unknown plan", { apiKeySource: "none", subscriptionType: "Claude Team" }, false],
  ]
  test.each(
    FABLE.flatMap((model) =>
      (["claude.ai", "api_key", "api_key_helper"] as const).flatMap((authMethod) =>
        ACCOUNTS.map(([label, account, allowed]) => [model, authMethod, label, account, allowed] as const)
      )
    )
  )("%s, status %s, handshake reports %s: runs %s", async (model, authMethod, _label, account, allowed) => {
    const check = freshCheck({
      status: { json: { loggedIn: true, authMethod } },
      init: async () => ({ models: [], account: { email: "owner@example.com", ...account } }),
    })
    const { result, stageRun, runProcess } = runFable(model, check)
    if (allowed) await expect(result).resolves.toMatchObject({ selected: { model } })
    else {
      await expect(result).rejects.toMatchObject({ category: "UNSUPPORTED_CAPABILITY" })
      expect(stageRun).not.toHaveBeenCalled()
      expect(runProcess).not.toHaveBeenCalled()
    }
    expect(check.query).toHaveBeenCalledTimes(1)
    expect((check.queryOptions[0] as { settingSources: unknown }).settingSources).toEqual([])
    expect(check.close).toHaveBeenCalledTimes(1)
  })

  // Round 4's P1: a key in the run's environment that managed settings clear.
  // The status still says API key; the handshake sees no key and Pro.
  test.each(
    FABLE.flatMap((model) =>
      (["api_key", "api_key_helper"] as const).flatMap((authMethod) =>
        (["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const).map((key) => [model, authMethod, key] as const)
      )
    )
  )("%s, status %s with %s in the run's environment, handshake no key and Pro: refused before staging", async (model, authMethod, key) => {
    const check = freshCheck({
      status: { json: { loggedIn: true, authMethod } },
      env: { PATH: "/usr/bin", [key]: "secret" },
      init: async () => ({ models: [], account: { apiKeySource: "none", subscriptionType: "Claude Pro" } }),
    })
    const { result, stageRun, runProcess } = runFable(model, check)
    await expect(result).rejects.toMatchObject({ category: "UNSUPPORTED_CAPABILITY" })
    expect(check.query).toHaveBeenCalledTimes(1)
    expect(stageRun).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  })

  test.each(FABLE)("%s with a key in the run's environment runs only when the handshake confirms it", async (model) => {
    const check = freshCheck({
      status: { json: { loggedIn: true, authMethod: "api_key" } },
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret" },
      init: async () => ({ models: [], account: { apiKeySource: "ANTHROPIC_API_KEY" } }),
    })
    await expect(runFable(model, check).result).resolves.toMatchObject({ selected: { model } })
    expect(check.query).toHaveBeenCalledTimes(1)
  })

  test.each([
    ["a key in the environment, but status reports a sign-in", { json: { loggedIn: true, authMethod: "claude.ai" } }, { ANTHROPIC_API_KEY: "sk-test" }],
    ["a cloud provider outranks the key status", { json: { loggedIn: true, authMethod: "api_key" } }, { CLAUDE_CODE_USE_BEDROCK: "1" }],
    ["a third-party provider", { json: { loggedIn: true, authMethod: "third_party" } }, {}],
    ["signed in, no method", { json: { loggedIn: true, authMethod: "none" } }, {}],
    ["an unknown method", { json: { loggedIn: true, authMethod: "something_new" } }, {}],
    ["signed out", { json: { loggedIn: false, authMethod: "api_key" } }, {}],
    ["unparsable output", { json: "Logged in as owner" }, {}],
    ["JSON that is not an object", { json: "null" }, {}],
    ["a status that timed out", { exitCode: null, timedOut: true, json: "" }, {}],
    ["no claude on the PATH", { exitCode: null, errorCode: "ENOENT", json: "" }, {}],
  ] as const)("%s: Fable is refused with no handshake, before staging", async (_label, status, env) => {
    for (const model of FABLE) {
      const check = freshCheck({ status: status as never, env: { PATH: "/usr/bin", ...env } })
      const stageRun = vi.fn()
      const runProcess = vi.fn()
      await expect(
        executeClaudeCliGeneration(request(model), { stageRun, runProcess, readOffered: () => LISTED, checkFablePlan: check.checkFablePlan })
      ).rejects.toMatchObject({ category: "UNSUPPORTED_CAPABILITY" })
      expect(check.query).not.toHaveBeenCalled()
      expect(stageRun).not.toHaveBeenCalled()
      expect(runProcess).not.toHaveBeenCalled()
    }
  })

  test("a model the list does not have, or an effort it does not accept, is refused before any check", async () => {
    for (const [model, effort] of [["claude-mythos-1", "high"], ["claude-fable-5-1", "high"], ["claude-fable-5-2", "max"]] as const) {
      const checkFablePlan = passed()
      const stageRun = vi.fn()
      // The fresh read fails: the cached list decides.
      const readOfferedFresh = vi.fn(async () => { throw new Error("no handshake") })
      const error = await executeClaudeCliGeneration(
        { ...request(model), override: { model, effort: effort as never } },
        { stageRun, readOffered: () => LISTED, readOfferedFresh, checkFablePlan }
      ).catch((value: unknown) => value)
      expect(error).toMatchObject({ category: "UNSUPPORTED_CAPABILITY" })
      expect(checkFablePlan).not.toHaveBeenCalled()
      expect(stageRun).not.toHaveBeenCalled()
    }
  })

  test("non-Fable runs: no plan check; only a model outside the committed ones is looked up in the cached list", async () => {
    const readOffered = vi.fn(() => LISTED)
    const readOfferedFresh = vi.fn()
    const checkFablePlan = passed()
    for (const model of ["claude-opus-5-5", "claude-opus-4-8", "opus"]) {
      const runProcess = vi.fn<RunClaudeCliProcess>(async () => ({ stdout: transcript(model === "opus" ? "claude-opus-5-5" : model) }))
      await executeClaudeCliGeneration(request(model), { stageRun: stagedRun(), runProcess, readOffered, readOfferedFresh, checkFablePlan })
    }
    expect(readOffered).toHaveBeenCalledTimes(1) // claude-opus-4-8 only
    expect(readOfferedFresh).not.toHaveBeenCalled() // both were in the cached list
    expect(checkFablePlan).not.toHaveBeenCalled()
  })

  // A stale cached list: the run reads the installed Claude Code's list once
  // more, for a model outside the committed ones only. Since 2026-11-17
  // (owner) no run is refused as "tool too old".
  describe("a model the cached list lacks", () => {
    const CACHED: ClaudeOfferedModels = {
      observed: true,
      models: [{ model: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh"] }],
    }
    const run = (
      model: string,
      fresh: () => Promise<ClaudeOfferedModels>,
      effort: "high" | "xhigh" = "high"
    ) => {
      const stageRun = stagedRun()
      const runProcess = vi.fn<RunClaudeCliProcess>(async () => ({ stdout: transcript(model) }))
      const readOffered = vi.fn(() => CACHED)
      const readOfferedFresh = vi.fn(fresh)
      const result = executeClaudeCliGeneration(
        { ...request(model), override: { model, effort } },
        { stageRun, runProcess, readOffered, readOfferedFresh, checkFablePlan: passed() }
      )
      return { result, stageRun, runProcess, readOffered, readOfferedFresh }
    }

    test("a committed model goes to the tool with no list read", async () => {
      const { result, runProcess, readOffered, readOfferedFresh } = run("claude-sonnet-5-5", async () => CACHED)
      await expect(result).resolves.toMatchObject({ selected: { model: "claude-sonnet-5-5" } })
      expect(runProcess).toHaveBeenCalledTimes(1)
      expect(readOffered).not.toHaveBeenCalled()
      expect(readOfferedFresh).not.toHaveBeenCalled()
    })

    test("a model outside the committed list that only the fresh list has runs on that list", async () => {
      const { result, readOfferedFresh } = run("claude-opus-4-9", async () => ({
        observed: true,
        models: [{ model: "claude-opus-4-9", efforts: ["high"] }],
      }))
      await expect(result).resolves.toMatchObject({ selected: { model: "claude-opus-4-9" } })
      expect(readOfferedFresh).toHaveBeenCalledTimes(1)
    })

    test.each([
      ["fell back to the committed list (not observed)", async (): Promise<ClaudeOfferedModels> => ({
        observed: false,
        models: [{ model: "claude-opus-4-9", efforts: ["high"] }],
      })],
      ["failed", async (): Promise<ClaudeOfferedModels> => {
        throw new Error("no handshake")
      }],
    ] as const)("a fresh read that %s is not used: the cached list refuses, before staging", async (_label, fresh) => {
      const { result, stageRun, runProcess } = run("claude-opus-4-9", fresh)
      await expect(result).rejects.toMatchObject({ category: "UNSUPPORTED_CAPABILITY" })
      expect(stageRun).not.toHaveBeenCalled()
      expect(runProcess).not.toHaveBeenCalled()
    })

    test("an effort the listed model does not accept is refused with the generic error", async () => {
      const { result, readOfferedFresh } = run("claude-opus-4-9", async () => ({
        observed: true,
        models: [{ model: "claude-opus-4-9", efforts: ["high"] }],
      }), "xhigh")
      await expect(result).rejects.toMatchObject({ category: "UNSUPPORTED_CAPABILITY" })
      expect(readOfferedFresh).toHaveBeenCalledTimes(1)
    })

    test("cancelled during the fresh read: cancelled", async () => {
      const controller = new AbortController()
      const stageRun = vi.fn()
      const error = await executeClaudeCliGeneration(request("claude-opus-4-9", controller.signal), {
        stageRun,
        readOffered: () => CACHED,
        readOfferedFresh: async () => {
          controller.abort()
          return CACHED
        },
      }).catch((value: unknown) => value)
      expect(error).toMatchObject({ category: "CANCELLED" })
      expect(stageRun).not.toHaveBeenCalled()
    })

    test("in a test run, the default fresh read refuses instead of starting Claude Code", async () => {
      const stageRun = vi.fn()
      await expect(
        executeClaudeCliGeneration(request("claude-opus-4-9"), { stageRun, readOffered: () => CACHED })
      ).rejects.toBeInstanceOf(NativeLaunchBlockedError)
      expect(stageRun).not.toHaveBeenCalled()
    })
  })

  test.each([
    ["claude-fable-5-2", "claude-fable-5-2"],
    ["claude-opus-4-8", "claude-opus-4-8"],
    ["fable", "claude-fable-5-2"],
  ])("runs %s when the list admits it, with no automatic model switch", async (model, initModel) => {
    const runProcess = vi.fn<RunClaudeCliProcess>(async () => ({ stdout: transcript(initModel) }))
    const result = await executeClaudeCliGeneration(request(model), {
      stageRun: stagedRun(),
      runProcess,
      readOffered: () => LISTED,
      checkFablePlan: passed(),
    })
    expect(result).toMatchObject({ selected: { model }, actual: { model: initModel } })
    const args = runProcess.mock.calls[0]![0].args
    expect(args).toEqual(expect.arrayContaining(["--model", model, "--settings", '{"switchModelsOnFlag":false}']))
    expect(args).not.toContain("--fallback-model")
  })

  test("a versioned run whose init names another model is invalid output", async () => {
    const error = await executeClaudeCliGeneration(request("claude-fable-5-2"), {
      stageRun: stagedRun(),
      runProcess: async () => ({ stdout: transcript("claude-fable-5-1") }),
      readOffered: () => LISTED,
      checkFablePlan: passed(),
    }).catch((value: unknown) => value)
    expect(error).toMatchObject({ category: "INVALID_OUTPUT" })
  })

  test("in a test run, the default list reader and the default Fable check refuse instead of reading or starting anything", async () => {
    const stageRun = vi.fn()
    await expect(executeClaudeCliGeneration(request("claude-fable-5-2"), { stageRun })).rejects.toThrow(
      /Inject readOffered/
    )
    for (const model of FABLE) {
      await expect(
        executeClaudeCliGeneration(request(model), { stageRun, readOffered: () => LISTED })
      ).rejects.toBeInstanceOf(NativeLaunchBlockedError)
    }
    // A check with one fake seam still refuses to reach the other default.
    const runCommand = vi.fn<RunStatusCommand>()
    await expect(checkClaudeFablePlan({ runCommand })).rejects.toBeInstanceOf(NativeLaunchBlockedError)
    await expect(checkClaudeFablePlan({ query: vi.fn() })).rejects.toBeInstanceOf(NativeLaunchBlockedError)
    expect(runCommand).not.toHaveBeenCalled()
    expect(stageRun).not.toHaveBeenCalled()
  })

  // A choice saved as an alias before 2026-11-15 is never rewritten and still runs.
  test("runs a supported Haiku override and proves its selected model family", async () => {
    const concreteModel = "claude-haiku-4-5-20251001"
    const stageRun = vi.fn(async () => ({
      cwd: "/tmp/formulacms-claude-haiku-run",
      systemPromptFilename: "system-prompt.txt",
      imageFilenames: [],
      cleanupPaths: ["/tmp/formulacms-claude-haiku-run"],
    }))
    const runProcess = vi.fn<RunClaudeCliProcess>(async () => ({
      stdout: [
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: concreteModel,
        }),
        JSON.stringify({
          type: "assistant",
          message: { model: concreteModel, content: [] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "COMPLETE HAIKU RESULT",
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      ].join("\n"),
    }))

    const result = await executeClaudeCliGeneration(
      {
        systemPrompt: "PRIVATE SYSTEM PROMPT",
        prompt: "PRIVATE BUSINESS PROMPT",
        images: [],
        profile: "vision-spec",
        phase: "block-spec",
        override: { model: "haiku", effort: "high" },
      },
      { stageRun, runProcess }
    )

    expect(result).toMatchObject({
      text: "COMPLETE HAIKU RESULT",
      selected: { model: "haiku", effort: "high" },
      actual: { model: concreteModel, effort: "high" },
    })
    expect(runProcess.mock.calls[0]?.[0].args).toEqual(
      expect.arrayContaining(["--model", "haiku", "--effort", "high"])
    )
  })

  test("normalizes staging failures as zero-attempt local process failures", async () => {
    const runProcess = vi.fn()
    const error = await executeClaudeCliGeneration(
      {
        systemPrompt: "PRIVATE SYSTEM PROMPT",
        prompt: "PRIVATE BUSINESS PROMPT",
        images: [
          { path: "/private/secret-design.png", mediaType: "image/png" },
        ],
        profile: "renderer-jsx",
        phase: "renderer-jsx",
      },
      {
        stageRun: async () => {
          throw new Error("failed at /private/secret-design.png")
        },
        runProcess,
      }
    ).catch((value: unknown) => value)

    expect(error).toMatchObject({
      category: "LOCAL_PROCESS_FAILED",
      attempts: 0,
      phase: "renderer-jsx",
      selected: {
        engine: "claude-cli",
        model: "claude-sonnet-5-5",
        effort: "high",
      },
    })
    expect(JSON.stringify(error)).not.toMatch(/secret-design|PRIVATE/u)
    expect(runProcess).not.toHaveBeenCalled()
  })

  test("runs vision authoring through staged inputs and returns transcript-proved identity", async () => {
    const stageRun = vi.fn(async () => ({
      cwd: "/tmp/formulacms-claude-run",
      systemPromptFilename: "system-prompt.txt",
      imageFilenames: ["snapshot.png"],
      cleanupPaths: ["/tmp/formulacms-claude-run"],
    }))
    // The default is a versioned id, proved by an exact init model.
    const concreteModel = "claude-sonnet-5-5"
    const runProcess = vi.fn<RunClaudeCliProcess>(async () => ({
      stdout: [
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: concreteModel,
        }),
        JSON.stringify({
          type: "assistant",
          message: { model: concreteModel, content: [] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "COMPLETE BLOCK SPEC",
          usage: { input_tokens: 13, output_tokens: 8 },
        }),
      ].join("\n"),
    }))

    const result = await executeClaudeCliGeneration(
      {
        systemPrompt: "PRIVATE SYSTEM PROMPT",
        prompt: "PRIVATE BUSINESS PROMPT",
        images: [{ path: "/private/design.png", mediaType: "image/png" }],
        profile: "vision-spec",
        phase: "block-spec",
        deadlineMs: 12_345,
      },
      { stageRun, runProcess }
    )

    expect(stageRun).toHaveBeenCalledWith({
      systemPrompt: "PRIVATE SYSTEM PROMPT",
      images: [{ path: "/private/design.png", mediaType: "image/png" }],
    })
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "claude",
        cwd: "/tmp/formulacms-claude-run",
        deadlineMs: 12_345,
        cleanupPaths: ["/tmp/formulacms-claude-run"],
        stdin:
          "First use your Read tool to read the design snapshot image at " +
          "./snapshot.png so you can see it.\n\nPRIVATE BUSINESS PROMPT",
      })
    )
    const processRequest = runProcess.mock.calls[0][0]
    expect(processRequest.args).toContain("--system-prompt-file")
    expect(processRequest.args).toContain("./system-prompt.txt")
    expect(processRequest.args).not.toContain("PRIVATE SYSTEM PROMPT")
    expect(processRequest.args).not.toContain("PRIVATE BUSINESS PROMPT")
    expect(result).toEqual({
      text: "COMPLETE BLOCK SPEC",
      output: "COMPLETE BLOCK SPEC",
      selected: {
        lane: "local-build",
        engine: "claude-cli",
        model: "claude-sonnet-5-5",
        effort: "high",
      },
      // The transcript proves the model; the effort stays configured evidence.
      identityEvidence: "transcript-observed",
      actual: {
        engine: "claude-cli",
        model: concreteModel,
        effort: "high",
        modelEvidence: "transcript",
        effortEvidence: "configured",
      },
      attempts: 1,
      usage: { inputTokens: 13, outputTokens: 8, totalTokens: 21 },
      finishReason: "stop",
    })
  })

  test("normalizes a Claude authentication failure without exposing diagnostics", async () => {
    const error = await executeClaudeCliGeneration(
      {
        systemPrompt: "PRIVATE SYSTEM PROMPT",
        prompt: "PRIVATE BUSINESS PROMPT",
        images: [],
        profile: "vision-spec",
        phase: "block-spec",
      },
      {
        stageRun: async () => ({
          cwd: "/tmp/private-run-path",
          systemPromptFilename: "system-prompt.txt",
          imageFilenames: [],
          cleanupPaths: ["/tmp/private-run-path"],
        }),
        runProcess: async () => {
          throw new SubscriptionCliProcessError(
            "auth-required",
            "token=secret session_id=private",
            1
          )
        },
      }
    ).catch((value: unknown) => value)

    expect(error).toMatchObject({
      category: "AUTH_REQUIRED",
      attempts: 1,
      phase: "block-spec",
      retryable: false,
      nextAction: "authenticate-provider",
    })
    expect(JSON.stringify(error)).not.toMatch(
      /secret|session_id|private-run-path/u
    )
  })

  test("normalizes an invalid Claude transcript without exposing partial output", async () => {
    const error = await executeClaudeCliGeneration(
      {
        systemPrompt: "SYSTEM",
        prompt: "PROMPT",
        images: [],
        profile: "renderer-jsx",
        phase: "renderer-jsx",
      },
      {
        stageRun: async () => ({
          cwd: "/tmp/run",
          systemPromptFilename: "system-prompt.txt",
          imageFilenames: [],
          cleanupPaths: ["/tmp/run"],
        }),
        runProcess: async () => ({ stdout: "partial customer output" }),
      }
    ).catch((value: unknown) => value)

    expect(error).toMatchObject({
      category: "INVALID_OUTPUT",
      attempts: 1,
      phase: "renderer-jsx",
      nextAction: "review-generated-output",
    })
    expect(JSON.stringify(error)).not.toContain("partial customer output")
  })
})
