import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import {
  EmailAdapterError,
  type EmailAdapter,
  type EmailMessage,
} from "@opencoredev/email-sdk"
import { memoryAdapter } from "@opencoredev/email-sdk/testing"
import { describe, expect, test, vi } from "vitest"
import { dispatchPreparedEmail } from "./delivery.node"
import type { EmailProviderRegistry } from "./providerRegistry.node"
import {
  FormulaCmsClassifiedAdapterError,
  type EmailProviderAdapter,
} from "./successor"

const prepared = {
  providerId: "memory-e04",
  configuration: {},
  sender: { address: "sender@example.test", name: "FormulaCMS" },
  message: {
    to: "recipient@example.test",
    subject: "E04 delivery",
    text: "private-message-sentinel",
  },
  idempotencyKey: "contact:event-e04",
} as const

function adaptSdkAdapter(
  adapter: EmailAdapter,
  contexts: Array<{ attempt: number; idempotencyKey?: string }>
): EmailProviderAdapter {
  return {
    id: adapter.name,
    idempotency: adapter.capabilities.idempotency,
    async send(message, context) {
      contexts.push(context)
      const result = await adapter.send(message as EmailMessage, {
        adapter: adapter.name,
        operation: "send",
        attempt: context.attempt,
        idempotencyKey: context.idempotencyKey,
      })
      return { providerMessageId: result.id }
    },
  }
}

function registryFor(
  providerId: string,
  adapter: EmailProviderAdapter,
  readiness: "ready" | "needs_setup" = "ready"
): EmailProviderRegistry<string> {
  return {
    metadata: [],
    has(value): value is string {
      return value === providerId
    },
    readiness: () => readiness,
    createAdapter(value) {
      if (value !== providerId) throw new Error("unexpected provider")
      return adapter
    },
  }
}

describe("E04 FormulaCMS delivery executor", () => {
  test("uses the SDK memory adapter once with the stable event key", async () => {
    const contexts: Array<{ attempt: number; idempotencyKey?: string }> = []
    const memory = memoryAdapter("memory-e04")
    const registry = registryFor(
      "memory-e04",
      adaptSdkAdapter(memory, contexts)
    )

    await expect(
      dispatchPreparedEmail(prepared, { environment: {}, registry })
    ).resolves.toEqual({
      state: "provider_accepted",
      providerId: "memory-e04",
    })
    expect(memory.raw?.sent).toHaveLength(1)
    expect(memory.raw?.sent[0]?.message).toMatchObject({
      from: { email: "sender@example.test", name: "FormulaCMS" },
      to: { email: "recipient@example.test" },
      subject: "E04 delivery",
      text: "private-message-sentinel",
    })
    expect(contexts).toEqual([
      { attempt: 1, idempotencyKey: "contact:event-e04" },
    ])
  })

  test("fails closed before adapter construction when setup is missing", async () => {
    const createAdapter = vi.fn(() => ({
      id: "memory-e04",
      idempotency: "none" as const,
      send: vi.fn(),
    }))
    const registry: EmailProviderRegistry<string> = {
      metadata: [],
      has: (value): value is string => value === "memory-e04",
      readiness: () => "needs_setup",
      createAdapter,
    }

    await expect(
      dispatchPreparedEmail(prepared, { environment: {}, registry })
    ).resolves.toEqual({
      state: "failed",
      providerId: "memory-e04",
      reason: "needs_setup",
    })
    expect(createAdapter).not.toHaveBeenCalled()
  })

  test("offers only proven-not-sent provider failures to Action Retrier", async () => {
    const adapter: EmailProviderAdapter = {
      id: "memory-e04",
      idempotency: "none",
      async send() {
        throw new EmailAdapterError("sensitive-provider-error", {
          adapter: "memory-e04",
          retryable: true,
          delivery: "not_sent",
        })
      },
    }

    await expect(
      dispatchPreparedEmail(prepared, {
        environment: {},
        registry: registryFor("memory-e04", adapter),
      })
    ).resolves.toEqual({
      state: "retryable_failure",
      providerId: "memory-e04",
      reason: "provider_rejected",
    })
  })

  test("passes the bounded category through retryable and terminal failures", async () => {
    const classified = (retryable: boolean): EmailProviderAdapter => ({
      id: "memory-e04",
      idempotency: "none",
      async send() {
        throw new FormulaCmsClassifiedAdapterError({
          adapter: "memory-e04",
          delivery: "not_sent",
          retryable,
          category: retryable ? "could_not_connect" : "sender_refused",
        })
      },
    })

    await expect(
      dispatchPreparedEmail(prepared, {
        environment: {},
        registry: registryFor("memory-e04", classified(true)),
      })
    ).resolves.toEqual({
      state: "retryable_failure",
      providerId: "memory-e04",
      reason: "provider_rejected",
      category: "could_not_connect",
    })
    await expect(
      dispatchPreparedEmail(prepared, {
        environment: {},
        registry: registryFor("memory-e04", classified(false)),
      })
    ).resolves.toEqual({
      state: "failed",
      providerId: "memory-e04",
      reason: "provider_rejected",
      category: "sender_refused",
    })
  })

  test("keeps unknown delivery terminal and strips the raw error", async () => {
    const adapter: EmailProviderAdapter = {
      id: "memory-e04",
      idempotency: "none",
      async send() {
        throw new EmailAdapterError("sensitive-unknown-error", {
          adapter: "memory-e04",
          retryable: true,
          delivery: "unknown",
        })
      },
    }

    const result = await dispatchPreparedEmail(prepared, {
      environment: {},
      registry: registryFor("memory-e04", adapter),
    })
    expect(result).toEqual({
      state: "unknown",
      providerId: "memory-e04",
      reason: "delivery_unknown",
    })
    expect(JSON.stringify(result)).not.toContain("sensitive-unknown-error")
  })

  test("keeps consumers outside SDK, provider, and direct retrier imports", async () => {
    // FR2e (D-7): the Forms consumer is checked in
    // formSubmissions.boundaries.test.ts, which ships only with that module.
    // ADR-0056: sign-in sends no email, so `auth.ts` has no email consumer.

    const queueSource = await readFile(
      fileURLToPath(new URL("../../email.ts", import.meta.url)),
      "utf8"
    )
    const actionSource = await readFile(
      fileURLToPath(new URL("../../emailNode.ts", import.meta.url)),
      "utf8"
    )
    expect(queueSource).toMatch(
      /internal\.emailNode\.sendEmail,\s*\{ eventId \}/
    )
    expect(queueSource).not.toMatch(/console\.(?:log|warn|error)/)
    expect(actionSource).not.toMatch(/console\.(?:log|warn|error)/)
    expect(actionSource).not.toContain("sensitive-provider-error")
  })
})
