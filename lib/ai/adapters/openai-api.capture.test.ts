import { afterEach, describe, expect, test, vi } from "vitest"
import { OPENAI_API_CATALOG } from "../capabilities/openai-api"
import { validateApiModelTuple } from "../task-profiles"
import { createOpenAIGenerationAdapter } from "./openai-api"

afterEach(() => vi.unstubAllGlobals())

// The adapter has no native format/schema channel, even for
// structured-outline-meta. Capture the product path, without SDK module mocks.
describe("OpenAI product requests through the installed SDK", () => {
  test.each([
    ["gpt-6.1-sol", "medium"],
    ["gpt-6.1-terra", "medium"],
    ["gpt-6-luna", "medium"],
  ] as const)("captures %s at its provider default effort", async (model, effort) => {
    const bodies: Record<string, unknown>[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses")
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({
        id: "resp_capture",
        model,
        created_at: 0,
        status: "completed",
        output: [{
          type: "message", role: "assistant", id: "msg_capture", status: "completed",
          content: [{ type: "output_text", text: "MODEL OUTPUT", annotations: [] }],
        }],
        usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
      })
    })
    vi.stubGlobal("fetch", fetch)

    const result = await createOpenAIGenerationAdapter({ apiKey: "capture-test-key" }).generate({
      tuple: validateApiModelTuple({
        mode: "catalog", provider: "openai", model,
        reasoning: { kind: "effort", effort },
      }),
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
    expect(OPENAI_API_CATALOG[model].reasoning.providerDefault).toBe(effort)
    expect(body).toHaveProperty("reasoning.effort", effort)
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
