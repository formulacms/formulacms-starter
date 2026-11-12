import { createTestAccounting } from "@/lib/ai/accounting.testFixtures"
import { APICallError } from "ai"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  GENERATION_ERROR_CATEGORIES,
  GenerationError,
  type AdapterGenerationRequest,
  type AdapterGenerationResult,
  type ApiGenerationAdapter,
  type GenerationErrorCategory,
  type GenerationRequest,
} from "./execution-contract"
import {
  executeGeneration,
  LOCAL_GENERATION_CEILING_MS,
  makeGenerationError,
  normalizeGenerationError,
  RUNTIME_GENERATION_CEILING_MS,
  safeGenerationError,
  type ProviderAttemptSettlement,
} from "./execute-generation"
import { taskProfileTuple } from "./task-profiles"

function request(
  overrides: Partial<GenerationRequest<unknown>> = {}
): GenerationRequest<unknown> {
  return {
    target: { lane: "runtime", provider: "openrouter" },
    tuple: taskProfileTuple("openrouter", "editorial-copy"),
    profile: "editorial-copy",
    phase: "content-generation",
    input: { prompt: "CUSTOMER_PROMPT_SENTINEL" },
    requirements: { inputModalities: ["text"], structuredOutput: false },
    output: { kind: "text" },
    ...overrides,
  }
}

function result(
  overrides: Partial<AdapterGenerationResult> = {}
): AdapterGenerationResult {
  return {
    text: "MODEL OUTPUT",
    finishReason: "stop",
    actualModel: "google/gemini-3-flash-preview",
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    routedProvider: "google",
    ...overrides,
  }
}

function adapter(
  generate: ApiGenerationAdapter["generate"]
): ApiGenerationAdapter {
  return { provider: "openrouter", generate }
}

afterEach(() => {
  vi.useRealTimers()
})

test.each([
  [401, "AUTH_REQUIRED", "refused"],
  [403, "AUTH_REQUIRED", undefined],
  [402, "QUOTA_EXHAUSTED", undefined],
  [429, "RATE_LIMITED", undefined],
  [413, "INPUT_TOO_LARGE", undefined],
  [503, "PROVIDER_UNAVAILABLE", "unreachable"],
] as const)("runtime provider health is normalized before settlement: HTTP %s", async (statusCode, category, state) => {
  const accounting = createTestAccounting()
  await expect(executeGeneration(request(), adapter(async () => { throw { statusCode } }), accounting))
    .rejects.toMatchObject({ category })
  const settlements = accounting.settlements as ProviderAttemptSettlement[]
  expect(settlements.length).toBe(statusCode === 503 ? 2 : 1)
  for (const settlement of settlements) {
    if (state) expect(settlement.providerObservation).toEqual({ state, observedAt: expect.any(Number) })
    else expect(settlement).not.toHaveProperty("providerObservation")
  }
})

// Shaped like the AI SDK's APICallError: the provider's parsed error body is in
// `data`, as each installed provider's failed-response handler builds it.
function apiCallError(statusCode: number, data: unknown) {
  return new APICallError({
    message: "provider refused", url: "https://provider.test/v1", requestBodyValues: {},
    statusCode, responseBody: JSON.stringify(data), data,
  })
}

test.each([
  ["OpenAI 401 invalid_api_key", apiCallError(401, { error: { message: "Incorrect API key", type: "invalid_request_error", param: null, code: "invalid_api_key" } }), "refused"],
  ["OpenAI 403 invalid_api_key", apiCallError(403, { error: { message: "Invalid API key", type: null, param: null, code: "invalid_api_key" } }), "refused"],
  ["Anthropic 403 permission_error", apiCallError(403, { type: "error", error: { type: "permission_error", message: "Not allowed" } }), undefined],
  ["Anthropic 401 authentication_error", apiCallError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), "refused"],
  ["OpenRouter 403 moderation", apiCallError(403, { error: { code: 403, message: "Input flagged by moderation", type: null, param: null, metadata: { reasons: ["violence"] } } }), undefined],
  ["OpenRouter 401", apiCallError(401, { error: { code: 401, message: "User not found.", type: null, param: null } }), "refused"],
] as const)("only a rejected key marks the provider refused; a 403 still fails the call: %s", async (_name, thrown, state) => {
  const accounting = createTestAccounting()
  await expect(executeGeneration(request(), adapter(async () => { throw thrown }), accounting))
    .rejects.toMatchObject({ category: "AUTH_REQUIRED" })
  const [settlement] = accounting.settlements as ProviderAttemptSettlement[]
  if (state) expect(settlement?.providerObservation).toEqual({ state, observedAt: expect.any(Number) })
  else expect(settlement).not.toHaveProperty("providerObservation")
})

test("successful fake provider records ok; invalid output and local lane record no health", async () => {
  const accounting = createTestAccounting()
  await executeGeneration(request(), adapter(async () => result()), accounting)
  expect((accounting.settlements[0] as ProviderAttemptSettlement).providerObservation?.state).toBe("ok")
  const invalid = createTestAccounting()
  await expect(executeGeneration(request(), adapter(async () => result({ text: "" })), invalid)).rejects.toMatchObject({ category: "INVALID_OUTPUT" })
  expect(invalid.settlements[0]).not.toHaveProperty("providerObservation")
  const local = createTestAccounting()
  await executeGeneration(request({ target: { lane: "local-build", provider: "openrouter", engine: "openrouter-api" } }), adapter(async () => result()), local)
  expect(local.settlements[0]).not.toHaveProperty("providerObservation")
})

test.each([
  ["network", new TypeError("fake network failure"), "PROVIDER_UNAVAILABLE", "unreachable"],
  ["credits", Object.assign(new Error("credits exhausted"), { statusCode: 429 }), "QUOTA_EXHAUSTED", undefined],
  ["payload", { statusCode: 400 }, "UNSUPPORTED_CAPABILITY", undefined],
] as const)("runtime health observes only actionable provider outcomes: %s", async (_name, error, category, state) => {
  const accounting = createTestAccounting()
  await expect(executeGeneration(request(), adapter(async () => { throw error }), accounting))
    .rejects.toMatchObject({ category })
  for (const settlement of accounting.settlements as ProviderAttemptSettlement[]) {
    expect(settlement.providerObservation?.state).toBe(state)
  }
})

test.each([false, true])("deadline health distinguishes caller cancellation=%s", async (cancelled) => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const accounting = createTestAccounting()
  const pending = executeGeneration(request({ deadlineMs: 10, signal: controller.signal }), adapter(async (input) =>
    new Promise((_resolve, reject) => input.abortSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }))
  ), accounting)
  const assertion = expect(pending).rejects.toMatchObject({ category: cancelled ? "CANCELLED" : "TIMEOUT" })
  // Admission must finish so this proves an actually-called provider outcome.
  await vi.advanceTimersByTimeAsync(0)
  if (cancelled) controller.abort()
  else await vi.advanceTimersByTimeAsync(10)
  await assertion
  expect(accounting.settlements.length).toBeGreaterThan(0)
  for (const settlement of accounting.settlements as ProviderAttemptSettlement[]) {
    expect(settlement.providerObservation?.state).toBe(cancelled ? undefined : "unreachable")
  }
})

describe("normalized errors and redaction", () => {
  test("normalizes all 13 contract categories to the exact safe shape", () => {
    const req = request()
    for (const category of GENERATION_ERROR_CATEGORIES) {
      const source = makeGenerationError(category, {
        request: req,
        attempts: 1,
      })
      const normalized = normalizeGenerationError(source, {
        request: req,
        attempts: 2,
      })
      expect(normalized).toBeInstanceOf(GenerationError)
      expect(normalized).toMatchObject({
        category,
        attempts: 2,
        phase: "content-generation",
        retryable: false,
      })
      expect(safeGenerationError(normalized)).toEqual(normalized.toJSON())
    }
  })

  test.each<[string, unknown, GenerationErrorCategory, boolean]>([
    [
      "authentication",
      Object.assign(new Error("RAW_BODY"), { status: 401 }),
      "AUTH_REQUIRED",
      false,
    ],
    [
      "quota",
      Object.assign(new Error("billing quota RAW_BODY"), { status: 429 }),
      "QUOTA_EXHAUSTED",
      false,
    ],
    [
      "rate limit",
      { status: 429, headers: { "retry-after": "1" }, body: "RAW_BODY" },
      "RATE_LIMITED",
      true,
    ],
    [
      "input size",
      Object.assign(new Error("payload too large RAW_BODY"), { status: 413 }),
      "INPUT_TOO_LARGE",
      false,
    ],
    [
      "unsupported",
      Object.assign(new Error("RAW_BODY"), { status: 422 }),
      "UNSUPPORTED_CAPABILITY",
      false,
    ],
    [
      "server",
      Object.assign(new Error("RAW_BODY"), { status: 503 }),
      "PROVIDER_UNAVAILABLE",
      true,
    ],
    [
      "network",
      Object.assign(new Error("RAW_BODY"), { code: "ECONNRESET" }),
      "PROVIDER_UNAVAILABLE",
      true,
    ],
  ])(
    "maps %s without leaking provider material",
    (_label, source, category, retryable) => {
      const normalized = normalizeGenerationError(source, {
        request: request(),
        attempts: 1,
      })
      expect(normalized).toMatchObject({ category, retryable })
      const serialized = JSON.stringify(normalized)
      for (const forbidden of [
        "RAW_BODY",
        "CUSTOMER_PROMPT_SENTINEL",
        "sk-secret-key",
        "/Users/customer/.credentials/provider.json",
        "session-identifier-123",
      ]) {
        expect(serialized).not.toContain(forbidden)
      }
    }
  )
})

describe("frozen tuple, retry, and no fallback", () => {
  test("passes maxRetries zero and repeats the identical tuple at most once", async () => {
    const calls: AdapterGenerationRequest[] = []
    const generate = vi.fn(async (value: AdapterGenerationRequest) => {
      calls.push(value)
      if (calls.length === 1) {
        throw Object.assign(new Error("temporary"), { status: 503 })
      }
      return result()
    })
    const req = request()

    await expect(
      executeGeneration(req, adapter(generate), createTestAccounting())
    ).resolves.toMatchObject({
      attempts: 2,
      selected: {
        provider: "openrouter",
        model: "google/gemini-3-flash-preview",
        effort: "medium",
      },
      actual: {
        provider: "openrouter",
        model: "google/gemini-3-flash-preview",
        effort: "medium",
        routedProvider: "google",
      },
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(calls[0].maxRetries).toBe(0)
    expect(calls[1].maxRetries).toBe(0)
    expect(calls[0].tuple).toBe(req.tuple)
    expect(calls[1].tuple).toBe(req.tuple)
    expect(calls[1].tuple).toBe(calls[0].tuple)
  })

  test.each([
    ["authentication", Object.assign(new Error("no"), { status: 401 })],
    ["quota", Object.assign(new Error("quota"), { status: 429 })],
    ["invalid request", Object.assign(new Error("bad"), { status: 400 })],
    ["size", Object.assign(new Error("too large"), { status: 413 })],
  ])("does not retry %s", async (_label, failure) => {
    const generate = vi.fn(async () => {
      throw failure
    })
    await expect(
      executeGeneration(request(), adapter(generate), createTestAccounting())
    ).rejects.toBeInstanceOf(GenerationError)
    expect(generate).toHaveBeenCalledOnce()
  })

  test("rejects mutable, extraneous, partial, and mismatched tuples before a call", async () => {
    const generate = vi.fn(async () => result())
    const invalid = [
      {
        mode: "catalog",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-5",
        reasoning: { kind: "effort", effort: "medium" },
      },
      Object.freeze({
        mode: "catalog",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-5",
        reasoning: Object.freeze({ kind: "effort", effort: "medium" }),
        credential: "extraneous",
      }),
      Object.freeze({
        mode: "catalog",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-5",
      }),
    ]
    for (const tuple of invalid) {
      await expect(
        executeGeneration(
          request({ tuple: tuple as GenerationRequest<unknown>["tuple"] }),
          adapter(generate),
          createTestAccounting()
        )
      ).rejects.toMatchObject({
        category: "UNSUPPORTED_CAPABILITY",
        attempts: 0,
      })
    }
    expect(generate).not.toHaveBeenCalled()
  })

  test("returns validated output and maps validation failure without retry", async () => {
    const generate = vi.fn(async () => result({ text: '{"ok":true}' }))
    const validated = request({
      output: {
        kind: "validated",
        validate: (text) => JSON.parse(text) as { ok: boolean },
      },
    })
    await expect(
      executeGeneration(validated, adapter(generate), createTestAccounting())
    ).resolves.toMatchObject({
      text: '{"ok":true}',
      output: { ok: true },
      attempts: 1,
    })

    const invalid = request({
      output: {
        kind: "validated",
        validate: () => {
          throw new Error("customer output")
        },
      },
    })
    await expect(
      executeGeneration(invalid, adapter(generate), createTestAccounting())
    ).rejects.toMatchObject({
      category: "VALIDATION_FAILED",
      attempts: 1,
    })
    expect(generate).toHaveBeenCalledTimes(2)
  })

  test.each([
    ["empty", { text: "" }],
    ["whitespace", { text: "   \n" }],
    ["partial length", { finishReason: "length" }],
    ["missing actual model", { actualModel: " " }],
  ])("rejects %s output without retry", async (_label, overrides) => {
    const generate = vi.fn(async () => result(overrides))
    await expect(
      executeGeneration(request(), adapter(generate), createTestAccounting())
    ).rejects.toMatchObject({
      category: "INVALID_OUTPUT",
      attempts: 1,
    })
    expect(generate).toHaveBeenCalledOnce()
  })
})

describe("fake-clock deadlines and cancellation", () => {
  test("retries a short Retry-After inside one shared total deadline", async () => {
    vi.useFakeTimers()
    const generate = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, headers: { "retry-after": "1" } })
      .mockResolvedValueOnce(result())
    const pending = executeGeneration(
      request({ deadlineMs: 1_500 }),
      adapter(generate),
      createTestAccounting()
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toMatchObject({ attempts: 2 })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("does not retry a Retry-After that cannot fit the total deadline", async () => {
    vi.useFakeTimers()
    const generate = vi.fn(async () => {
      throw { status: 429, headers: { "retry-after": "2" } }
    })
    await expect(
      executeGeneration(
        request({ deadlineMs: 1_500 }),
        adapter(generate),
        createTestAccounting()
      )
    ).rejects.toMatchObject({ category: "RATE_LIMITED", attempts: 1 })
    expect(generate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each([
    ["runtime", RUNTIME_GENERATION_CEILING_MS],
    ["local-build", LOCAL_GENERATION_CEILING_MS],
  ] as const)(
    "enforces the %s ceiling against an adapter that ignores abort",
    async (lane, ceiling) => {
      vi.useFakeTimers()
      const generate = vi.fn<
        (value: AdapterGenerationRequest) => Promise<AdapterGenerationResult>
      >(() => new Promise<AdapterGenerationResult>(() => {}))
      const pending = executeGeneration(
        request({
          target:
            lane === "runtime"
              ? { lane, provider: "openrouter" }
              : { lane, provider: "openrouter", engine: "openrouter-api" },
          deadlineMs: ceiling + 60_000,
        }),
        adapter(generate),
        createTestAccounting()
      )
      const assertion = expect(pending).rejects.toMatchObject({
        category: "TIMEOUT",
        attempts: 1,
      })
      await vi.advanceTimersByTimeAsync(ceiling)
      await assertion
      expect(generate.mock.calls[0][0].abortSignal.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  test("honors a shorter deadline and does not call the adapter for zero budget", async () => {
    vi.useFakeTimers()
    const generate = vi.fn(() => new Promise<AdapterGenerationResult>(() => {}))
    const pending = executeGeneration(
      request({ deadlineMs: 25 }),
      adapter(generate),
      createTestAccounting()
    )
    const assertion = expect(pending).rejects.toMatchObject({
      category: "TIMEOUT",
    })
    await vi.advanceTimersByTimeAsync(25)
    await assertion

    const zeroGenerate = vi.fn(async () => result())
    await expect(
      executeGeneration(
        request({ deadlineMs: 0 }),
        adapter(zeroGenerate),
        createTestAccounting()
      )
    ).rejects.toMatchObject({ category: "TIMEOUT", attempts: 0 })
    expect(zeroGenerate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test("distinguishes caller cancellation and cleans retry timers/listeners", async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const remove = vi.spyOn(caller.signal, "removeEventListener")
    const generate = vi.fn(async () => {
      throw { status: 429, headers: { "retry-after": "10" } }
    })
    const pending = executeGeneration(
      request({ signal: caller.signal, deadlineMs: 20_000 }),
      adapter(generate),
      createTestAccounting()
    )
    const assertion = expect(pending).rejects.toMatchObject({
      category: "CANCELLED",
      attempts: 1,
    })
    await vi.advanceTimersByTimeAsync(1)
    caller.abort()
    await assertion
    expect(generate).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
