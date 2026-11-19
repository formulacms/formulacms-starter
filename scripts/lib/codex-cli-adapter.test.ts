// @vitest-environment node
import { describe, expect, test } from "vitest"
import {
  buildCodexCliInvocation,
  classifyCodexCliFailure,
  parseCodexCliOutput,
  resolveCodexCliTuple,
  summarizeCodexTranscriptShape,
} from "./codex-cli-adapter"

describe("Codex CLI tuple resolution", () => {
  test("resolves the approved vision tuple from merged observed catalog data", () => {
    expect(
      resolveCodexCliTuple({
        profile: "vision-spec",
        imageCount: 1,
        observedCatalog: {
          data: [
            {
              model: "older-model",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              inputModalities: ["text"],
            },
            {
              model: "gpt-6.1-sol",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              inputModalities: ["text", "image"],
            },
          ],
        },
      })
    ).toEqual({ engine: "codex-cli", model: "gpt-6.1-sol", effort: "high" })
  })

  test("fails before execution when the exact effort or supplied-image capability is absent", () => {
    const request = {
      profile: "renderer-jsx" as const,
      imageCount: 1,
      observedCatalog: {
        data: [
          {
            model: "gpt-6.1-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" as const }],
            inputModalities: ["text" as const],
          },
        ],
      },
    }

    expect(() => resolveCodexCliTuple(request)).toThrow(
      /UNSUPPORTED_CAPABILITY.*high/
    )

    expect(() =>
      resolveCodexCliTuple({
        ...request,
        observedCatalog: {
          data: [
            {
              model: "gpt-6.1-sol",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              inputModalities: ["text"],
            },
          ],
        },
      })
    ).toThrow(/UNSUPPORTED_CAPABILITY.*image/)
  })

  // A catalog that only offers efforts above the owner's xhigh ceiling has no
  // selectable tuple. That fails closed — it never silently drops to a lower
  // effort, and never reaches for `max`/`ultra`.
  test("fails closed when the catalog offers no effort at or below the ceiling", () => {
    expect(() =>
      resolveCodexCliTuple({
        profile: "vision-spec",
        imageCount: 1,
        observedCatalog: {
          data: [
            {
              model: "gpt-6.1-sol",
              supportedReasoningEfforts: [],
              inputModalities: ["text", "image"],
            },
          ],
        },
      })
    ).toThrow(/UNSUPPORTED_CAPABILITY.*high/)
  })
})

describe("Codex CLI JSONL output", () => {
  test("classifies only trusted diagnostics and ignores customer-facing artifact text", () => {
    expect(
      classifyCodexCliFailure({ stderr: "401 unauthorized; token=secret" })
    ).toBe("auth-required")
    expect(
      classifyCodexCliFailure({
        stdout: JSON.stringify({
          type: "turn.failed",
          error: { message: "usage quota exhausted; account=private" },
        }),
      })
    ).toBe("quota-exhausted")
    expect(
      classifyCodexCliFailure({
        stdout: JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "Customer copy mentions 401 unauthorized",
          },
        }),
      })
    ).toBe("local-process-failed")
  })

  test("extracts one complete artifact and usage while keeping effective identity unproved", () => {
    const stdout = [
      { type: "thread.started", thread_id: "private-thread-id" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "message-1", type: "agent_message", text: "ARTIFACT" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 12,
          cached_input_tokens: 2,
          output_tokens: 7,
          reasoning_output_tokens: 3,
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")

    const parsed = parseCodexCliOutput(stdout)
    expect(parsed).toEqual({
      status: "unproved-effective-identity",
      text: "ARTIFACT",
      usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    })
    expect(JSON.stringify(parsed)).not.toContain("private-thread-id")
    expect(parsed).not.toHaveProperty("actualModel")
    expect(parsed).not.toHaveProperty("actualEffort")
  })

  // Regression: shape taken from a REAL `codex exec --json` transcript
  // (codex-cli 0.144.0-alpha.4, exit code 0). Codex emits local advisory notices
  // as `error`-typed ITEMS — here, "Skill descriptions were shortened to fit the
  // 2% skills context budget". The notice says nothing about the generation, and
  // a complete artifact followed it, but the parser's item allow-list rejected
  // the entire run as INVALID_OUTPUT. Whether the notice fires depends on the
  // machine's installed skills, which is why it looked like vendor flakiness.
  test("ignores a non-capability advisory item and still returns the artifact", () => {
    const stdout = [
      { type: "thread.started", thread_id: "private-thread-id" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "advisory notice" },
      },
      {
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "ARTIFACT" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 12541,
          cached_input_tokens: 0,
          output_tokens: 2404,
          reasoning_output_tokens: 1552,
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")

    expect(parseCodexCliOutput(stdout)).toEqual({
      status: "unproved-effective-identity",
      text: "ARTIFACT",
      usage: { inputTokens: 12541, outputTokens: 2404, totalTokens: 14945 },
    })
  })

  test("fails closed on malformed, partial, failed, rerouted, tool, or multiple-artifact streams", () => {
    const started = [
      { type: "thread.started", thread_id: "private-thread-id" },
      { type: "turn.started" },
    ]
    const artifact = {
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: "ARTIFACT" },
    }
    const completed = {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    }
    const jsonl = (...events: unknown[]) =>
      events.map((event) => JSON.stringify(event)).join("\n")
    const invalidStreams = [
      "not-json",
      jsonl(...started, artifact),
      jsonl(started[0], artifact, started[1], completed),
      jsonl(
        ...started,
        { type: "error", message: "secret-provider-body" },
        artifact,
        completed
      ),
      jsonl(
        ...started,
        { type: "turn.failed", error: { message: "secret-provider-body" } },
        artifact,
        completed
      ),
      jsonl(...started, { type: "model.rerouted", model: "other" }, artifact, completed),
      ...[
        "command_execution",
        "file_change",
        "mcp_tool_call",
        "collab_tool_call",
        "web_search",
      ].map((type) =>
        jsonl(
          ...started,
          { type: "item.completed", item: { id: "tool-1", type } },
          artifact,
          completed
        )
      ),
      jsonl(
        ...started,
        artifact,
        {
          type: "item.completed",
          item: { id: "message-2", type: "agent_message", text: "SECOND" },
        },
        completed
      ),
    ]

    for (const stdout of invalidStreams) {
      const error = (() => {
        try {
          parseCodexCliOutput(stdout)
        } catch (value) {
          return value
        }
      })()
      expect(error).toMatchObject({ category: "INVALID_OUTPUT" })
      expect(JSON.stringify(error)).not.toContain("secret-provider-body")
    }
  })
})

describe("Codex transcript shape summary", () => {
  test("describes event shape for the developer without leaking any content", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "SECRET-THREAD" }),
      "Update available! Run codex upgrade.",
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "i0", type: "error", message: "SECRET-NOTICE" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "SECRET-ARTIFACT" },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
    ].join("\n")

    const summary = summarizeCodexTranscriptShape(stdout)

    // Structure is the diagnostic: which events, which item kinds, in order.
    expect(summary).toContain("thread.started")
    expect(summary).toContain("item.completed(error)")
    expect(summary).toContain("item.completed(agent_message)")
    expect(summary).toContain("non-JSON line")

    // Content is never the diagnostic.
    expect(summary).not.toContain("SECRET-THREAD")
    expect(summary).not.toContain("SECRET-NOTICE")
    expect(summary).not.toContain("SECRET-ARTIFACT")
    expect(summary).not.toContain("Update available")
  })

  test("bounds a long stream and a long type so nothing unbounded reaches stderr", () => {
    const flood = Array.from({ length: 200 }, () =>
      JSON.stringify({
        type: "item.updated",
        item: { type: "reasoning" },
      })
    )
    const summary = summarizeCodexTranscriptShape(flood.join("\n"))
    expect(summary).toContain("+160 more event(s)")
    expect(summary.length).toBeLessThan(2000)

    const longType = "x".repeat(5000)
    const oneEvent = summarizeCodexTranscriptShape(
      JSON.stringify({ type: longType })
    )
    expect(oneEvent).not.toContain(longType)
    expect(oneEvent.length).toBeLessThan(200)
  })
})

describe("Codex CLI invocation", () => {
  test("rejects instruction and image paths that escape the staged run directory", () => {
    const base = {
      profile: "vision-spec" as const,
      prompt: "PROMPT",
      instructionsFilename: "system-instructions.md",
      imageFilenames: [] as string[],
      observedCatalog: {
        data: [
          {
            model: "gpt-6.1-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "high" as const }],
            inputModalities: ["text" as const, "image" as const],
          },
        ],
      },
    }

    expect(() =>
      buildCodexCliInvocation({
        ...base,
        instructionsFilename: "/tmp/private/system-instructions.md",
      })
    ).toThrow(/UNSUPPORTED_CAPABILITY.*safe relative basename/)
    expect(() =>
      buildCodexCliInvocation({
        ...base,
        imageFilenames: ["../private/snapshot.png"],
      })
    ).toThrow(/UNSUPPORTED_CAPABILITY.*safe relative basename/)
  })

  test("uses native images and a prompt stdin sentinel under the minimum documented policy", () => {
    const invocation = buildCodexCliInvocation({
      profile: "vision-spec",
      prompt: "PRIVATE ARTIFACT PROMPT",
      instructionsFilename: "system-instructions.md",
      imageFilenames: ["snapshot.png"],
      observedCatalog: {
        data: [
          {
            model: "gpt-6.1-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            inputModalities: ["text", "image"],
          },
        ],
      },
    })

    expect(invocation).toEqual({
      command: "codex",
      args: [
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--config",
        'approval_policy="never"',
        "--config",
        'web_search="disabled"',
        "--config",
        "features.shell_tool=false",
        "--config",
        "features.multi_agent=false",
        "--config",
        "features.apps=false",
        "--config",
        'model_instructions_file="./system-instructions.md"',
        "--model",
        "gpt-6.1-sol",
        "--config",
        'model_reasoning_effort="high"',
        "--image",
        "./snapshot.png",
        "-",
      ],
      stdin: "PRIVATE ARTIFACT PROMPT",
      selected: {
        engine: "codex-cli",
        model: "gpt-6.1-sol",
        effort: "high",
      },
    })
    expect(invocation.args).not.toContain("PRIVATE ARTIFACT PROMPT")
    expect(invocation.args).not.toContain("--output-schema")
    expect(invocation.args).not.toContain("tools.view_image=false")
  })
})
