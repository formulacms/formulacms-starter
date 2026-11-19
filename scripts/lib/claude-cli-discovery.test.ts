// @vitest-environment node
// The seam with the Agent SDK's `query()`: a fake stands in for the SDK, so
// no process starts. Guarded: the handshake never submits a prompt, and the
// session is closed on success, on a failure and at the deadline.
import { describe, expect, test, vi } from "vitest"
import {
  readClaudeCodeHandshake,
  type ClaudeDiscoveryQuery,
} from "./claude-cli-discovery"

type Params = Parameters<ClaudeDiscoveryQuery>[0]

function fakeQuery(initializationResult: () => Promise<{ models?: unknown; account?: unknown }>) {
  const submitted: unknown[] = []
  let inputEnded = false
  const close = vi.fn()
  const calls: Params[] = []
  const query = vi.fn((params: Params) => {
    calls.push(params)
    // Read the input as the SDK would, and record anything it yields.
    void (async () => {
      for await (const message of params.prompt) submitted.push(message)
      inputEnded = true
    })()
    return { initializationResult, close }
  })
  return { query, close, calls, submitted, inputEnded: () => inputEnded }
}

const ENV = { PATH: "/usr/bin", HOME: "/home/owner" }
const deps = (query: ClaudeDiscoveryQuery, deadlineMs?: number) => ({
  query,
  env: ENV,
  executable: "/opt/claude/bin/claude",
  ...(deadlineMs ? { deadlineMs } : {}),
})

describe("readClaudeCodeHandshake", () => {
  test("starts the run's claude with no settings, tools, MCP servers, hooks or saved session; returns only models, plan and credential source names", async () => {
    const models = [{ value: "opus", resolvedModel: "claude-opus-5-5" }]
    const fake = fakeQuery(async () => ({
      models,
      account: { email: "owner@example.com", organization: "Org", subscriptionType: "Claude Ultra", apiKeySource: "none", tokenSource: "none" },
    }))
    const result = await readClaudeCodeHandshake(deps(fake.query))
    expect(result).toEqual({ models, subscriptionType: "Claude Ultra", apiKeySource: "none", tokenSource: "none" })
    expect(JSON.stringify(result)).not.toMatch(/owner@example|Org/u)
    const { options } = fake.calls[0]!
    expect(options).toEqual({
      pathToClaudeCodeExecutable: "/opt/claude/bin/claude",
      env: ENV,
      settingSources: [],
      settings: { disableAllHooks: true },
      tools: [],
      strictMcpConfig: true,
      persistSession: false,
      abortController: expect.any(AbortController),
    })
    expect(options).not.toHaveProperty("allowedTools")
    expect(options).not.toHaveProperty("fallbackModel")
    expect(options).not.toHaveProperty("permissionMode")
    expect(fake.close).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(fake.inputEnded()).toBe(true))
    expect(fake.submitted).toEqual([])
  })

  test("closes the session when initialization fails", async () => {
    const fake = fakeQuery(async () => {
      throw new Error("handshake failed")
    })
    await expect(readClaudeCodeHandshake(deps(fake.query))).rejects.toThrow("handshake failed")
    expect(fake.close).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(fake.inputEnded()).toBe(true))
    expect(fake.submitted).toEqual([])
  })

  test("aborts and closes the session at the deadline", async () => {
    const fake = fakeQuery(() => new Promise(() => undefined))
    await expect(readClaudeCodeHandshake(deps(fake.query, 20))).rejects.toThrow(/did not answer in time/u)
    expect(fake.calls[0]!.options.abortController?.signal.aborted).toBe(true)
    expect(fake.close).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(fake.inputEnded()).toBe(true))
    expect(fake.submitted).toEqual([])
  })

  test("the caller's cancellation aborts and closes the session; an already cancelled check starts nothing", async () => {
    const controller = new AbortController()
    const fake = fakeQuery(() => {
      controller.abort()
      return new Promise(() => undefined)
    })
    await expect(readClaudeCodeHandshake({ ...deps(fake.query), signal: controller.signal })).rejects.toThrow(/cancelled/u)
    expect(fake.calls[0]!.options.abortController?.signal.aborted).toBe(true)
    expect(fake.close).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(fake.inputEnded()).toBe(true))
    const idle = fakeQuery(async () => ({}))
    await expect(readClaudeCodeHandshake({ ...deps(idle.query), signal: controller.signal })).rejects.toThrow(/cancelled/u)
    expect(idle.query).not.toHaveBeenCalled()
  })

  test("a given directory and setting sources are passed; by default no directory and no settings file", async () => {
    const fake = fakeQuery(async () => ({}))
    await readClaudeCodeHandshake({ ...deps(fake.query), cwd: "/tmp/check", settingSources: ["user"] })
    expect(fake.calls[0]!.options).toMatchObject({ cwd: "/tmp/check", settingSources: ["user"] })
    await readClaudeCodeHandshake(deps(fake.query))
    expect(fake.calls[1]!.options).not.toHaveProperty("cwd")
    expect(fake.calls[1]!.options.settingSources).toEqual([])
  })

  test("an account without a plan or a missing model list reads as unknown and empty", async () => {
    const fake = fakeQuery(async () => ({ account: null }))
    await expect(readClaudeCodeHandshake(deps(fake.query))).resolves.toEqual({ models: [], subscriptionType: undefined })
  })
})
