import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import {
  EmailAdapterError,
  type EmailAdapter,
  type EmailMessage,
} from "@opencoredev/email-sdk"
import { memoryAdapter } from "@opencoredev/email-sdk/testing"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  createFormulaCmsEmailService,
  type EmailProviderAdapter,
  type FormulaCmsEmailMessage,
} from "./successor"

const message: FormulaCmsEmailMessage = {
  from: { email: "sender@example.test", name: "FormulaCMS" },
  to: { email: "owner@example.test" },
  subject: "E01 proof",
  text: "Deterministic delivery proof",
}

function adaptSdkAdapter(adapter: EmailAdapter): EmailProviderAdapter {
  return {
    id: adapter.name,
    idempotency: adapter.capabilities.idempotency,
    async send(value, context) {
      const result = await adapter.send(value as EmailMessage, {
        adapter: adapter.name,
        operation: "send",
        attempt: context.attempt,
        idempotencyKey: context.idempotencyKey,
      })
      return { providerMessageId: result.id }
    },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("FormulaCMS direct Email SDK boundary", () => {
  test("sends through the SDK memory adapter via the FormulaCMS wrapper", async () => {
    const memory = memoryAdapter("memory-e01")
    const service = createFormulaCmsEmailService(adaptSdkAdapter(memory))

    await expect(
      service.dispatch({ message, idempotencyKey: "event:memory:1" })
    ).resolves.toEqual({
      state: "provider_accepted",
      providerId: "memory-e01",
      providerMessageId: "mem_1",
      retry: "never",
    })
    expect(memory.raw?.sent).toHaveLength(1)
    expect(memory.raw?.sent[0]?.message).toMatchObject({
      subject: "E01 proof",
      to: { email: "owner@example.test" },
    })
  })

  test("sends through a synthetic private adapter via the same wrapper", async () => {
    const calls: Array<{
      message: FormulaCmsEmailMessage
      attempt: number
      idempotencyKey: string
    }> = []
    const privateAdapter: EmailProviderAdapter = {
      id: "owner-private",
      idempotency: "none",
      async send(value, context) {
        calls.push({
          message: value,
          attempt: context.attempt,
          idempotencyKey: context.idempotencyKey,
        })
        return { providerMessageId: "private_1" }
      },
    }

    const service = createFormulaCmsEmailService(privateAdapter)
    await expect(
      service.dispatch({ message, idempotencyKey: "event:private:1" })
    ).resolves.toEqual({
      state: "provider_accepted",
      providerId: "owner-private",
      providerMessageId: "private_1",
      retry: "never",
    })
    expect(calls).toEqual([
      {
        message,
        attempt: 1,
        idempotencyKey: "event:private:1",
      },
    ])
  })

  test("emits no production-mode telemetry network request", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const fetchSpy = vi.fn(async () => {
      throw new Error("unexpected network request")
    })
    vi.stubGlobal("fetch", fetchSpy)
    const service = createFormulaCmsEmailService(
      adaptSdkAdapter(memoryAdapter("memory-network-proof"))
    )

    await expect(
      service.dispatch({ message, idempotencyKey: "event:network:1" })
    ).resolves.toMatchObject({ state: "provider_accepted" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("does not let callers select an adapter, fallback, or retry policy", async () => {
    const selected = vi.fn(async () => ({ providerMessageId: "selected_1" }))
    const service = createFormulaCmsEmailService({
      id: "selected-by-formulacms",
      idempotency: "none",
      send: selected,
    })

    expect(Object.keys(service).sort()).toEqual(["dispatch", "providerId"])
    await expect(
      service.dispatch({
        message,
        idempotencyKey: "event:authority:1",
        adapter: "caller-choice",
        fallback: { adapters: ["caller-fallback"] },
        retry: { maxAttempts: 99 },
      } as Parameters<typeof service.dispatch>[0])
    ).resolves.toMatchObject({
      state: "provider_accepted",
      providerId: "selected-by-formulacms",
    })
    expect(selected).toHaveBeenCalledTimes(1)
  })

  test("uses one SDK attempt and offers only proven-not-sent failures to Action Retrier", async () => {
    const notSent = vi.fn(async () => {
      throw new EmailAdapterError("provider unavailable", {
        adapter: "safe-retry",
        retryable: true,
        delivery: "not_sent",
      })
    })
    const service = createFormulaCmsEmailService({
      id: "safe-retry",
      idempotency: "none",
      send: notSent,
    })

    await expect(
      service.dispatch({ message, idempotencyKey: "event:not-sent:1" })
    ).resolves.toEqual({
      state: "failed",
      providerId: "safe-retry",
      reason: "provider_rejected",
      retry: "action_retrier",
    })
    expect(notSent).toHaveBeenCalledTimes(1)
  })

  test("keeps unknown delivery terminal even when the provider marks it retryable", async () => {
    const unknown = vi.fn(async () => {
      throw new EmailAdapterError("response lost", {
        adapter: "unknown-delivery",
        retryable: true,
        delivery: "unknown",
      })
    })
    const service = createFormulaCmsEmailService({
      id: "unknown-delivery",
      idempotency: "none",
      send: unknown,
    })

    await expect(
      service.dispatch({ message, idempotencyKey: "event:unknown:1" })
    ).resolves.toEqual({
      state: "unknown",
      providerId: "unknown-delivery",
      reason: "delivery_unknown",
      retry: "never",
    })
    expect(unknown).toHaveBeenCalledTimes(1)
  })

  test("exports no raw SDK client and registers no client-reachable Convex function", async () => {
    const runtimeExports = await import("./successor")
    expect(Object.keys(runtimeExports)).toEqual([
      "createFormulaCmsEmailService",
    ])

    const source = await readFile(
      fileURLToPath(new URL("./successor.ts", import.meta.url)),
      "utf8"
    )
    expect(source).not.toMatch(
      /\b(?:query|mutation|action|internalQuery|internalMutation|internalAction|httpAction)\s*\(/
    )
    expect(source).not.toContain("exposeApi")
    expect(source).not.toContain("@opencoredev/convex-email")
    expect(source).toContain("idempotency: provider.idempotency")
    expect(source).not.toContain('      idempotency: "native",')
  })
})
