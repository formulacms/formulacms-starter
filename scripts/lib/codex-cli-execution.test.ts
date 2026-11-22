// @vitest-environment node
import { describe, expect, test, vi } from "vitest"
import { executeCodexCliGeneration } from "./codex-cli-execution"
import { SubscriptionCliProcessError } from "./subscription-cli-process"
import type { SubscriptionCliProcessRequest } from "./subscription-cli-process"
import type { ObservedCodexCatalog } from "./subscription-cli-capabilities"

const CATALOG: ObservedCodexCatalog = {
  data: [
    {
      model: "gpt-6.1-sol",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      inputModalities: ["text", "image"],
    },
  ],
}

const TRANSCRIPT = [
  JSON.stringify({ type: "thread.started", thread_id: "thr_private" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "COMPLETE BLOCK SPEC" },
  }),
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 13, output_tokens: 8 },
  }),
].join("\n")

const staged = {
  cwd: "/tmp/formulacms-codex-staged",
  instructionsFilename: "model-instructions.txt",
  imageFilenames: ["snapshot.jpg"],
  cleanupPaths: ["/tmp/formulacms-codex-staged"],
}

const baseRequest = {
  systemPrompt: "PRIVATE SYSTEM PROMPT",
  prompt: "PRIVATE BUSINESS PROMPT",
  images: [{ path: "/repo/snapshot.jpg", mediaType: "image/jpeg" as const }],
  profile: "vision-spec" as const,
  phase: "block-spec" as const,
}

describe("executeCodexCliGeneration", () => {
  test("returns a selected-only success with no fabricated actual identity", async () => {
    let processRequest: SubscriptionCliProcessRequest | undefined

    const result = await executeCodexCliGeneration(baseRequest, {
      readCatalog: async () => CATALOG,
      stageRun: async () => staged,
      runProcess: async (request) => {
        processRequest = request
        return { stdout: TRANSCRIPT }
      },
    })

    expect(result).toEqual({
      text: "COMPLETE BLOCK SPEC",
      output: "COMPLETE BLOCK SPEC",
      selected: {
        lane: "local-build",
        engine: "codex-cli",
        model: "gpt-6.1-sol",
        effort: "high",
      },
      identityEvidence: "selected-only",
      attempts: 1,
      usage: { inputTokens: 13, outputTokens: 8, totalTokens: 21 },
      finishReason: "stop",
    })
    expect(result).not.toHaveProperty("actual")

    // Prompt and system text travel by stdin, never argv.
    expect(processRequest?.stdin).toBe("PRIVATE BUSINESS PROMPT")
    expect(processRequest?.args).not.toContain("PRIVATE BUSINESS PROMPT")
    expect(processRequest?.args).not.toContain("PRIVATE SYSTEM PROMPT")
    expect(processRequest?.args).toContain("--image")
    expect(processRequest?.args).toContain("read-only")
    expect(processRequest?.cleanupPaths).toEqual([staged.cwd])
    // The thread id in the transcript must not survive into the result.
    expect(JSON.stringify(result)).not.toContain("thr_private")
  })

  test("fails the capability gate before any customer input is staged", async () => {
    const stageRun = vi.fn()
    const runProcess = vi.fn()

    const error = await executeCodexCliGeneration(baseRequest, {
      readCatalog: async () => ({
        data: [
          {
            model: "gpt-6.1-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            inputModalities: ["text"],
          },
        ],
      }),
      stageRun,
      runProcess,
    }).catch((value: unknown) => value)

    expect(error).toMatchObject({
      category: "UNSUPPORTED_CAPABILITY",
      attempts: 0,
    })
    expect(stageRun).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  })

  // Owner 2026-11-15 ("romove mode sol-6"): a saved gpt-6-sol never starts
  // a process, not even the catalog read.
  test("refuses a never-offered model before the catalog read", async () => {
    const readCatalog = vi.fn(async () => CATALOG)
    const stageRun = vi.fn()
    const runProcess = vi.fn()
    const error = await executeCodexCliGeneration(
      { ...baseRequest, override: { model: "gpt-6-sol", effort: "high" } },
      { readCatalog, stageRun, runProcess }
    ).catch((value: unknown) => value)
    expect(error).toMatchObject({ category: "UNSUPPORTED_CAPABILITY", attempts: 0 })
    expect(readCatalog).not.toHaveBeenCalled()
    expect(stageRun).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  })

  test("refuses a hidden model after the catalog read, before codex exec", async () => {
    const readCatalog = vi.fn(async () => ({
      data: [{ ...CATALOG.data[0], model: "gpt-hidden", hidden: true }],
    }))
    const stageRun = vi.fn()
    const runProcess = vi.fn()
    const error = await executeCodexCliGeneration(
      { ...baseRequest, override: { model: "gpt-hidden", effort: "high" } },
      { readCatalog, stageRun, runProcess }
    ).catch((value: unknown) => value)
    expect(error).toMatchObject({ category: "UNSUPPORTED_CAPABILITY", attempts: 0 })
    expect(readCatalog).toHaveBeenCalledOnce()
    expect(stageRun).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  })

  test("admits a model only the installed catalog lists", async () => {
    const runProcess = vi.fn(async () => ({ stdout: TRANSCRIPT }))
    const result = await executeCodexCliGeneration(
      { ...baseRequest, override: { model: "gpt-6.2-nova", effort: "high" } },
      {
        readCatalog: async () => ({ data: [{ ...CATALOG.data[0], model: "gpt-6.2-nova" }] }),
        stageRun: async () => staged,
        runProcess,
      }
    )
    expect(result.selected).toMatchObject({ model: "gpt-6.2-nova", effort: "high" })
    expect(runProcess).toHaveBeenCalledOnce()
  })

  // Since 2026-11-17 (owner) no run is refused as "tool too old": a committed
  // model the installed catalog does not list gets the generic refusal.
  test("a committed model the catalog does not list: the generic refusal, before staging", async () => {
    const stageRun = vi.fn()
    const runProcess = vi.fn()
    const error = await executeCodexCliGeneration(
      { ...baseRequest, images: [], profile: "editorial-copy", override: { model: "gpt-6-astra", effort: "high" } },
      { readCatalog: async () => CATALOG, stageRun, runProcess }
    ).catch((value: unknown) => value)
    expect(error).toMatchObject({
      category: "UNSUPPORTED_CAPABILITY",
      message: "The selected local AI CLI does not support the requested capability.",
      attempts: 0,
      selected: { engine: "codex-cli", model: "gpt-6-astra", effort: "high" },
    })
    expect(stageRun).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  })

  test("maps a missing CLI at catalog preflight to CONFIG_MISSING with zero attempts", async () => {
    const error = await executeCodexCliGeneration(baseRequest, {
      readCatalog: async () => {
        throw new SubscriptionCliProcessError(
          "missing-cli",
          "The selected local AI CLI is not available.",
          undefined,
          0
        )
      },
    }).catch((value: unknown) => value)

    expect(error).toMatchObject({ category: "CONFIG_MISSING", attempts: 0 })
  })

  test("maps an auth failure to AUTH_REQUIRED without leaking diagnostics", async () => {
    const error = await executeCodexCliGeneration(baseRequest, {
      readCatalog: async () => CATALOG,
      stageRun: async () => staged,
      runProcess: async () => {
        throw new SubscriptionCliProcessError(
          "auth-required",
          "The selected local AI CLI requires authentication.",
          1
        )
      },
    }).catch((value: unknown) => value)

    expect(error).toMatchObject({
      category: "AUTH_REQUIRED",
      nextAction: "authenticate-provider",
      retryable: false,
    })
    expect(JSON.stringify(error)).not.toContain("PRIVATE")
  })

  test("rejects an incomplete transcript as INVALID_OUTPUT rather than partial success", async () => {
    const error = await executeCodexCliGeneration(baseRequest, {
      readCatalog: async () => CATALOG,
      stageRun: async () => staged,
      runProcess: async () => ({
        stdout: [
          JSON.stringify({ type: "thread.started" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "half a spec" },
          }),
        ].join("\n"),
      }),
    }).catch((value: unknown) => value)

    expect(error).toMatchObject({ category: "INVALID_OUTPUT", attempts: 1 })
  })

  // The transcript dies with the process, so a rejection that explains nothing
  // can only be diagnosed by re-running against the live CLI — which is what the
  // last INVALID_OUTPUT cost. The diagnostic is the whole defence against that.
  test("reports the rejected transcript's redacted shape without leaking content", async () => {
    const shapes: string[] = []

    const error = await executeCodexCliGeneration(baseRequest, {
      readCatalog: async () => CATALOG,
      stageRun: async () => staged,
      onInvalidOutput: (shape) => shapes.push(shape),
      runProcess: async () => ({
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "SECRET-ID" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "command_execution", command: "SECRET-COMMAND" },
          }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "SECRET-ARTIFACT" },
          }),
        ].join("\n"),
      }),
    }).catch((value: unknown) => value)

    expect(error).toMatchObject({ category: "INVALID_OUTPUT" })
    expect(shapes).toHaveLength(1)
    // It names the offending item kind — the thing that took a live run to learn.
    expect(shapes[0]).toContain("item.completed(command_execution)")
    expect(shapes[0]).not.toContain("SECRET-ID")
    expect(shapes[0]).not.toContain("SECRET-COMMAND")
    expect(shapes[0]).not.toContain("SECRET-ARTIFACT")
    // And the diagnostic never reaches the returned error, which is a value.
    expect(JSON.stringify(error)).not.toContain("command_execution")
  })
})
