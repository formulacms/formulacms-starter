/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")

describe("E02 persisted email provider state shape", () => {
  test("stores fallback or the registered Resend state without secrets", async () => {
    const t = convexTest(schema, modules)

    const id = await t.run(async (ctx) => {
      return await ctx.db.insert("emailProviderState", {
        key: "owner",
        provider: {
          kind: "active",
          providerId: "resend",
          configuration: {},
        },
        sender: { address: "sender@example.test", name: "FormulaCMS" },
        configurationVersion: 1,
        updatedAt: 100,
      })
    })

    const stored = await t.run(async (ctx) => await ctx.db.get(id))
    expect(stored).toMatchObject({
      key: "owner",
      provider: { kind: "active", providerId: "resend", configuration: {} },
      configurationVersion: 1,
    })
    expect(JSON.stringify(stored)).not.toContain("secret")
    expect(JSON.stringify(stored)).not.toContain("API_KEY")
  })

  test("schema refuses unknown providers and untyped secret fields", async () => {
    const t = convexTest(schema, modules)

    await expect(
      t.run(async (ctx) => {
        await ctx.db.insert("emailProviderState", {
          key: "owner",
          provider: {
            kind: "active",
            providerId: "unknown",
            configuration: {},
          },
          sender: { address: "sender@example.test" },
          configurationVersion: 1,
          updatedAt: 100,
        } as never)
      })
    ).rejects.toThrow()

    await expect(
      t.run(async (ctx) => {
        await ctx.db.insert("emailProviderState", {
          key: "owner",
          provider: {
            kind: "active",
            providerId: "resend",
            configuration: { apiKey: "secret-sentinel" },
          },
          sender: { address: "sender@example.test" },
          configurationVersion: 1,
          updatedAt: 100,
        } as never)
      })
    ).rejects.toThrow()
  })
})
