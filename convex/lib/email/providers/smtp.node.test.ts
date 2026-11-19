import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import { describe, expect, test, vi } from "vitest"
import { EmailAdapterError, EmailValidationError } from "@opencoredev/email-sdk"
import type { smtp } from "@opencoredev/email-sdk/smtp"
import { createFormulaCmsEmailService } from "../successor"
import type { FormulaCmsEmailMessage } from "../successor"
import { smtpDefinition } from "./smtp.node"

const message: FormulaCmsEmailMessage = {
  from: { email: "sender@example.test", name: "FormulaCMS" },
  to: { email: "owner@example.test" },
  subject: "SMTP provider proof",
  text: "Deterministic delivery proof",
}

const baseEnvironment = {
  EMAIL_SMTP_HOST: " mail.example.test ",
  EMAIL_SMTP_USER: " test-user ",
  EMAIL_SMTP_PASSWORD: " test-password ",
}

type SmtpOptions = Parameters<typeof smtp>[0]

function fakeSmtp(
  send: (...args: unknown[]) => Promise<unknown> = async () => ({
    adapter: "smtp",
    id: "queue-1",
  })
) {
  const sendSpy = vi.fn(send)
  const factory = vi.fn((options: SmtpOptions) => {
    void options
    return { name: "smtp", send: sendSpy }
  })
  return {
    sendSpy,
    factory,
    seam: factory as unknown as typeof smtp,
  }
}

function adapterFor(
  environment: Record<string, string | undefined>,
  seam: typeof smtp | undefined
) {
  return smtpDefinition.createAdapter({ environment, smtp: seam }, {})
}

describe("SMTP provider adapter", () => {
  test.each([
    ["no port", undefined, 465, true, false],
    ["port 587", "587", 587, false, true],
    ["port 2525", "2525", 2525, false, true],
  ] as const)(
    "passes exactly the allowed option keys for %s",
    async (_name, port, expectedPort, secure, requireTLS) => {
      const { factory, seam } = fakeSmtp()
      const adapter = adapterFor(
        { ...baseEnvironment, EMAIL_SMTP_PORT: port },
        seam
      )
      await adapter.send(message, { attempt: 1, idempotencyKey: "owner_test:abc" })

      expect(factory).toHaveBeenCalledTimes(1)
      expect(factory.mock.calls[0]![0]).toEqual({
        name: "smtp",
        host: "mail.example.test",
        port: expectedPort,
        secure,
        requireTLS,
        auth: { user: "test-user", pass: "test-password" },
        timeoutMs: 15_000,
        tls: { rejectUnauthorized: true },
      })
      expect(Object.keys(factory.mock.calls[0]![0]).sort()).toEqual([
        "auth",
        "host",
        "name",
        "port",
        "requireTLS",
        "secure",
        "timeoutMs",
        "tls",
      ])
    }
  )

  test("passes a 64-character hex digest, not the delivery key, to the SDK", async () => {
    const { sendSpy, seam } = fakeSmtp()
    const adapter = adapterFor(baseEnvironment, seam)
    await adapter.send(message, { attempt: 1, idempotencyKey: "owner_test:abc" })

    const context = sendSpy.mock.calls[0]![1] as { idempotencyKey: string }
    expect(context.idempotencyKey).toMatch(/^[0-9a-f]{64}$/)
    expect(context.idempotencyKey).not.toContain(":")
    expect(adapter.id).toBe("smtp")
    expect(adapter.idempotency).toBe("message_id")
  })

  test.each([
    ["a queue id with an address", "q17@mail.example.test"],
    ["a 64-character hex queue id", "ab".repeat(32)],
  ] as const)(
    "a success result poisoned with server text returns only the local digest: %s",
    async (_name, serverId) => {
      const deliveryKey = "owner_test:abc"
      const expectedDigest = createHash("sha256").update(deliveryKey).digest("hex")
      expect(serverId).not.toBe(expectedDigest)
      const { sendSpy, seam } = fakeSmtp(async () => ({
        adapter: "smtp",
        id: serverId,
        accepted: ["owner@mail.example.test"],
        rejected: ["other@mail.example.test"],
        raw: {
          response: "250 2.0.0 queued as q17@mail.example.test",
          envelope: { from: "sender@example.test", to: ["owner@example.test"] },
        },
      }))
      const spies = (["log", "warn", "error"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined)
      )
      try {
        const adapter = adapterFor(baseEnvironment, seam)
        const adapterResult = await adapter.send(message, {
          attempt: 1,
          idempotencyKey: deliveryKey,
        })
        expect(adapterResult).toEqual({ providerMessageId: expectedDigest })

        const serviceResult = await createFormulaCmsEmailService(adapter).dispatch({
          message,
          idempotencyKey: deliveryKey,
        })
        expect(serviceResult).toEqual({
          state: "provider_accepted",
          providerId: "smtp",
          providerMessageId: expectedDigest,
          retry: "never",
        })

        // The value is the digest the SDK adapter itself received as its key.
        expect(sendSpy).toHaveBeenCalledTimes(2)
        for (const call of sendSpy.mock.calls) {
          expect((call[1] as { idempotencyKey: string }).idempotencyKey).toBe(
            expectedDigest
          )
        }
        for (const spy of spies) expect(spy).not.toHaveBeenCalled()
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
    }
  )

  test("surrounding spaces and line breaks in a value are ignored", async () => {
    const { factory, seam } = fakeSmtp()
    const adapter = adapterFor(
      {
        EMAIL_SMTP_HOST: "\tmail.example.test\n",
        EMAIL_SMTP_USER: "  test-user  ",
        EMAIL_SMTP_PASSWORD: "  test-password\n",
      },
      seam
    )
    await adapter.send(message, { attempt: 1, idempotencyKey: "owner_test:abc" })
    expect(factory.mock.calls[0]![0]).toMatchObject({
      host: "mail.example.test",
      auth: { user: "test-user", pass: "test-password" },
    })
  })

  test("turns a 535 reply into a classified error without server text", async () => {
    const secretReply = "535 5.7.8 Username and Password not accepted for test-user"
    const { seam } = fakeSmtp(async () => {
      throw new EmailAdapterError(secretReply, {
        adapter: "smtp",
        delivery: "not_sent",
        retryable: false,
        cause: Object.assign(new Error(secretReply), {
          code: "EAUTH",
          responseCode: 535,
          command: "AUTH PLAIN",
          response: secretReply,
        }),
      })
    })
    const adapter = adapterFor(baseEnvironment, seam)

    const error = await adapter
      .send(message, { attempt: 1, idempotencyKey: "owner_test:abc" })
      .then(
        () => null,
        (caught: unknown) => caught
      )
    expect(error).toBeInstanceOf(EmailAdapterError)
    expect(error).toMatchObject({
      name: "FormulaCmsClassifiedAdapterError",
      delivery: "not_sent",
      retryable: false,
      category: "sign_in_refused",
    })
    const text = JSON.stringify(error) + String((error as Error).message)
    for (const leaked of [secretReply, "test-user", "test-password", "mail.example.test"]) {
      expect(text).not.toContain(leaked)
    }
    expect((error as Error).cause).toBeUndefined()

    // Through the service, the category reaches the failed result.
    const service = createFormulaCmsEmailService(adapter)
    await expect(
      service.dispatch({ message, idempotencyKey: "owner_test:abc" })
    ).resolves.toEqual({
      state: "failed",
      providerId: "smtp",
      reason: "provider_rejected",
      retry: "never",
      category: "sign_in_refused",
    })
  })

  test("a validation error before any connection keeps today's verdict: unknown", async () => {
    const { seam } = fakeSmtp(async () => {
      throw new EmailValidationError("bad envelope")
    })
    const service = createFormulaCmsEmailService(adapterFor(baseEnvironment, seam))
    await expect(
      service.dispatch({ message, idempotencyKey: "owner_test:abc" })
    ).resolves.toEqual({
      state: "unknown",
      providerId: "smtp",
      reason: "delivery_unknown",
      retry: "never",
    })
  })

  test("an invalid port makes no SDK call and is a not-sent could_not_connect", async () => {
    for (const port of ["0", "70000", "abc", "25.5"]) {
      const { factory, sendSpy, seam } = fakeSmtp()
      const service = createFormulaCmsEmailService(
        adapterFor({ ...baseEnvironment, EMAIL_SMTP_PORT: port }, seam)
      )
      await expect(
        service.dispatch({ message, idempotencyKey: "owner_test:abc" })
      ).resolves.toEqual({
        state: "failed",
        providerId: "smtp",
        reason: "provider_rejected",
        retry: "never",
        category: "could_not_connect",
      })
      expect(factory).not.toHaveBeenCalled()
      expect(sendSpy).not.toHaveBeenCalled()
    }
  })

  test("refuses to build without the required variables", () => {
    for (const missing of Object.keys(baseEnvironment)) {
      expect(() =>
        adapterFor({ ...baseEnvironment, [missing]: undefined }, undefined)
      ).toThrow("CMS_EMAIL_PROVIDER_NEEDS_SETUP")
    }
    expect(() => smtpDefinition.createAdapter({ environment: baseEnvironment }, { host: "x" })).toThrow(
      "CMS_EMAIL_PROVIDER_CONFIGURATION_INVALID"
    )
  })

  test("source files read only the EMAIL_SMTP_* names and never weaken TLS", async () => {
    const directory = fileURLToPath(new URL("./", import.meta.url))
    const names = (await readdir(directory)).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
    )
    expect(names).toEqual(
      expect.arrayContaining(["smtp.node.ts", "smtpFailure.node.ts"])
    )
    const legacyNames =
      /(?<![A-Z0-9_])SMTP_(?:HOST|PORT|SECURE|USER|PASSWORD|FROM_ADDRESS|FROM_NAME)\b/
    const forbidden = [
      "CMS_SECRET_KEY",
      "emailSettings",
      "siteSettings",
      "providerMigration",
      "allowInsecureAuth",
      "ignoreTLS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
    ]
    for (const name of names) {
      const source = await readFile(`${directory}${name}`, "utf8")
      expect(source, name).not.toMatch(legacyNames)
      expect(source, name).not.toMatch(/rejectUnauthorized\s*:\s*false/)
      // `tls` appears only as the one explicit, verifying option.
      const tlsKeys = source.match(/\btls\s*:/g) ?? []
      const verifying = source.match(/\btls\s*:\s*\{\s*rejectUnauthorized\s*:\s*true\s*\}/g) ?? []
      expect(verifying.length, name).toBe(tlsKeys.length)
      for (const word of forbidden) expect(source, name).not.toContain(word)
    }
    const smtpSource = await readFile(`${directory}smtp.node.ts`, "utf8")
    expect(smtpSource).toContain("EMAIL_SMTP_HOST")
    expect(smtpSource).toContain("EMAIL_SMTP_USER")
    expect(smtpSource).toContain("EMAIL_SMTP_PASSWORD")
    expect(smtpSource.match(/\btls\s*:/g)).toHaveLength(1)
  })

  test("the real SDK adapter against a closed loopback port fails as could_not_connect", async () => {
    // Find a port nothing listens on: bind, note the port, close.
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        const value = typeof address === "object" && address ? address.port : 0
        server.close(() => resolve(value))
      })
    })
    const service = createFormulaCmsEmailService(
      adapterFor(
        {
          ...baseEnvironment,
          EMAIL_SMTP_HOST: "127.0.0.1",
          EMAIL_SMTP_PORT: String(port),
        },
        undefined
      )
    )
    await expect(
      service.dispatch({ message, idempotencyKey: "owner_test:abc" })
    ).resolves.toEqual({
      state: "failed",
      providerId: "smtp",
      reason: "provider_rejected",
      retry: "action_retrier",
      category: "could_not_connect",
    })
  })
})
