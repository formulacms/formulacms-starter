import { afterEach, describe, expect, test, vi } from "vitest"
import { ANTHROPIC_API_CATALOG } from "../capabilities/anthropic-api"
import { validateApiModelTuple } from "../task-profiles"
import { createAnthropicGenerationAdapter } from "./anthropic-api"

afterEach(() => vi.unstubAllGlobals())

// All product profiles, including structured-outline-meta, use this plain-text
// adapter request. Structured output is validated only after the response.
describe("Anthropic product requests through the installed SDK", () => {
  test.each([
    ["claude-sonnet-5-5", "high"],
    ["claude-opus-5-5", "medium"],
    ["claude-haiku-5-5", "medium"],
    ["claude-fable-5-1", "high"],
    ["claude-haiku-4-5-20251001", undefined],
  ] as const)("captures %s at its provider default effort", async (model, effort) => {
    const bodies: Record<string, unknown>[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages")
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({
        type: "message",
        id: "msg_capture",
        model,
        role: "assistant",
        content: [{ type: "text", text: "MODEL OUTPUT" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 4 },
      })
    })
    vi.stubGlobal("fetch", fetch)

    const tuple = validateApiModelTuple({
      mode: "catalog", provider: "anthropic", model,
      ...(effort ? { reasoning: { kind: "effort", effort } } : {}),
    })
    const result = await createAnthropicGenerationAdapter({ apiKey: "capture-test-key" }).generate({
      tuple,
      instructions: "Return a short answer.",
      input: { prompt: "PROMPT" },
      abortSignal: new AbortController().signal,
      maxRetries: 0,
      maxOutputTokens: 8192,
    })

    expect(result).toMatchObject({ text: "MODEL OUTPUT", actualModel: model, finishReason: "stop" })
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = bodies[0]!
    expect(body.model).toBe(model)
    if (effort) {
      expect(ANTHROPIC_API_CATALOG[model].reasoning).toMatchObject({ providerDefault: effort })
      expect(body).toHaveProperty("output_config.effort", effort)
    } else {
      expect(body).not.toHaveProperty("output_config")
      expect(body).not.toHaveProperty("reasoning.effort")
      expect(body).not.toHaveProperty("effort")
    }
    expect(body).not.toHaveProperty("tool_choice")
    expect(body).not.toHaveProperty("budget_tokens")
    expect(body).not.toHaveProperty("thinking.budget_tokens")
    expect(body).not.toHaveProperty("thinking.type", "disabled")
    for (const field of ["temperature", "top_p", "top_k", "response_format"]) {
      expect(body).not.toHaveProperty(field)
    }
    expect(body).not.toHaveProperty("output_config.format")
    expect(body).not.toHaveProperty("text.format")
  })
})
