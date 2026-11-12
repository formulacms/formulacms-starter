import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, test, vi } from "vitest"
import { createFormulaCmsEmailService } from "./successor"
import {
  EMAIL_PROVIDER_REGISTRY,
  createEmailProviderRegistry,
  defineRegisteredEmailProvider,
  type EmailProviderFactoryContext,
  type EmailProviderRegistry,
} from "./providerRegistry.node"
import { REGISTERED_EMAIL_PROVIDER_METADATA } from "./providerMetadata"
import type {
  FormulaCmsEmailMessage,
  FormulaCmsProviderContext,
} from "./successor"

const message: FormulaCmsEmailMessage = {
  from: { email: "sender@example.test", name: "FormulaCMS" },
  to: { email: "owner@example.test" },
  subject: "E02 provider contract",
  text: "Registry contract proof",
}

async function exerciseRegisteredProvider(
  registry: EmailProviderRegistry<string>,
  providerId: string,
  context: EmailProviderFactoryContext,
  configuration: unknown
) {
  const service = createFormulaCmsEmailService(
    registry.createAdapter(providerId, context, configuration)
  )
  return await service.dispatch({
    message,
    idempotencyKey: `event:${providerId}:1`,
  })
}

describe("FormulaCMS email provider registry", () => {
  test("registers exactly the bundled Resend provider with server-only readiness", () => {
    expect(EMAIL_PROVIDER_REGISTRY.metadata).toEqual(
      REGISTERED_EMAIL_PROVIDER_METADATA
    )
    expect(EMAIL_PROVIDER_REGISTRY.metadata.map(({ id }) => id)).toEqual([
      "resend",
    ])
    expect(
      EMAIL_PROVIDER_REGISTRY.readiness("resend", { environment: {} })
    ).toBe("needs_setup")
    expect(
      EMAIL_PROVIDER_REGISTRY.readiness("resend", {
        environment: { RESEND_API_KEY: "server-secret" },
      })
    ).toBe("ready")
  })

  test("rejects unknown and internal SDK providers and refuses a factory that needs setup", () => {
    expect(() =>
      EMAIL_PROVIDER_REGISTRY.createAdapter("unknown", { environment: {} }, {})
    ).toThrow("CMS_EMAIL_PROVIDER_UNREGISTERED")
    expect(() =>
      EMAIL_PROVIDER_REGISTRY.createAdapter("smtp", { environment: {} }, {})
    ).toThrow("CMS_EMAIL_PROVIDER_UNREGISTERED")
    expect(() =>
      EMAIL_PROVIDER_REGISTRY.createAdapter("resend", { environment: {} }, {})
    ).toThrow("CMS_EMAIL_PROVIDER_NEEDS_SETUP")
    expect(() =>
      EMAIL_PROVIDER_REGISTRY.createAdapter(
        "resend",
        { environment: { RESEND_API_KEY: "server-secret" } },
        { apiKey: "must-not-be-state" }
      )
    ).toThrow("CMS_EMAIL_PROVIDER_CONFIGURATION_INVALID")
  })

  test("runs Resend and a synthetic private provider through the same FormulaCMS contract", async () => {
    const resendFetch = vi.fn(async (_input: string | URL | Request, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer resend-secret-sentinel"
      )
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
        "event:resend:1"
      )
      return new Response(JSON.stringify({ id: "resend_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })

    const privateSend = vi.fn<
      (
        message: FormulaCmsEmailMessage,
        context: FormulaCmsProviderContext
      ) => Promise<{ providerMessageId: string }>
    >(async () => ({ providerMessageId: "private_1" }))
    const privateRegistry = createEmailProviderRegistry([
      defineRegisteredEmailProvider({
        metadata: {
          id: "owner-private",
          label: "Owner private provider",
          description: "Synthetic private provider for the E02 contract.",
          registered: true,
          bundled: false,
          documentationUrl:
            "https://example.test/docs/owner-private-email-provider",
        },
        readiness: () => "ready",
        parseConfiguration(value): Readonly<{ route: "primary" }> {
          if (
            typeof value !== "object" ||
            value === null ||
            !("route" in value) ||
            value.route !== "primary" ||
            Object.keys(value).length !== 1
          ) {
            throw new Error("CMS_EMAIL_PROVIDER_CONFIGURATION_INVALID")
          }
          return { route: "primary" }
        },
        createAdapter: (_context, configuration) => ({
          id: "owner-private",
          idempotency: "none",
          send(message, context) {
            expect(configuration).toEqual({ route: "primary" })
            return privateSend(message, context)
          },
        }),
      }),
    ] as const)

    await expect(
      exerciseRegisteredProvider(
        EMAIL_PROVIDER_REGISTRY,
        "resend",
        {
          environment: { RESEND_API_KEY: "resend-secret-sentinel" },
          fetch: resendFetch,
        },
        {}
      )
    ).resolves.toEqual({
      state: "provider_accepted",
      providerId: "resend",
      providerMessageId: "resend_1",
      retry: "never",
    })

    await expect(
      exerciseRegisteredProvider(
        privateRegistry,
        "owner-private",
        {
          environment: { OWNER_PRIVATE_KEY: "private-secret-sentinel" },
        },
        { route: "primary" }
      )
    ).resolves.toEqual({
      state: "provider_accepted",
      providerId: "owner-private",
      providerMessageId: "private_1",
      retry: "never",
    })

    expect(resendFetch).toHaveBeenCalledTimes(1)
    expect(privateSend).toHaveBeenCalledTimes(1)
    expect(privateSend).toHaveBeenCalledWith(message, {
      attempt: 1,
      idempotencyKey: "event:owner-private:1",
    })
  })

  test("keeps browser metadata free of server factories and secret material", async () => {
    const serialized = JSON.stringify(REGISTERED_EMAIL_PROVIDER_METADATA)
    expect(serialized).not.toContain("secret")
    expect(serialized).not.toContain("API_KEY")

    const metadataSource = await readFile(
      fileURLToPath(new URL("./providerMetadata.ts", import.meta.url)),
      "utf8"
    )
    expect(metadataSource).not.toContain("@opencoredev/email-sdk")
    expect(metadataSource).not.toContain("providerRegistry.node")
    expect(metadataSource).not.toContain("process.env")

    const serverSource = await readFile(
      fileURLToPath(new URL("./providerRegistry.node.ts", import.meta.url)),
      "utf8"
    )
    expect(serverSource.startsWith('"use node"')).toBe(true)
  })
})
