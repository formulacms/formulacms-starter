/// <reference types="vite/client" />

import { createTestAccounting } from "@/lib/ai/accounting.testFixtures"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "../_generated/api"
import { validateStrict } from "../lib/richtext/strict"
import {
  makeSite,
  OWNER,
  seedReplacedOwner,
} from "../../test-utils/authorization-matrix/harness"

const mocks = vi.hoisted(() => ({
  enforceAiRateLimit: vi.fn(async () => undefined),
  generateRuntimeText: vi.fn(),
}))

vi.mock("../lib/ai", async (original) => ({
  ...(await original<typeof import("../lib/ai")>()),
  generateRuntimeText: mocks.generateRuntimeText,
  createRuntimeAccounting: () => createTestAccounting(),
}))
vi.mock("../lib/aiRateLimit", () => ({
  enforceAiRateLimit: mocks.enforceAiRateLimit,
}))

afterEach(() => vi.unstubAllEnvs())

const modules = import.meta.glob("../**/*.ts", { base: "../" })

function generation(text: string) {
  return {
    text,
    output: text,
    selected: {
      lane: "local-build" as const,
      provider: "openai" as const,
      engine: "openai-api" as const,
      model: "test-model",
      effort: "medium" as const,
    },
    actual: {
      provider: "openai" as const,
      engine: "openai-api" as const,
      model: "test-model",
      effort: "medium" as const,
    },
    attempts: 1 as const,
    usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
    finishReason: "stop",
  }
}

async function site() {
  const t = makeSite(modules)
  await seedReplacedOwner(t)
  await t.run((ctx) =>
    ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: 1,
      enabledModules: [{ moduleId: "ai", configVersion: 1 }],
    })
  )
  return t.withIdentity(OWNER)
}

describe("runtime field-generation contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("OPENAI_API_KEY", "fake-field-key")
  })

  test.each([
    ["sliceTitle", 2],
    ["itemTitle", 3],
  ] as const)(
    "accepts canonical %s output at heading level %i",
    async (headingRole, level) => {
      mocks.generateRuntimeText.mockResolvedValueOnce(
        generation("A concise title")
      )
      const actor = await site()
      const result = await actor.action(
        api.agents.contentWriter.generateRichText,
        {
          brief: "Write a title",
          locale: "English",
          fieldLabel: "question",
          profile: "basic",
          contract: "title",
          headingRole,
        }
      )

      expect(validateStrict("title", result)).toEqual({ ok: true })
      expect(JSON.parse(result).content[0].attrs.level).toBe(level)
    }
  )

  test.each(["inline", "basic", "full"] as const)(
    "keeps the legacy %s profile call canonical",
    async (profile) => {
      mocks.generateRuntimeText.mockResolvedValueOnce(generation("Legacy copy"))
      const actor = await site()
      const result = await actor.action(
        api.agents.contentWriter.generateRichText,
        {
          brief: "Write field copy",
          locale: "English",
          fieldLabel: "body",
          profile,
        }
      )
      expect(validateStrict(profile, result)).toEqual({ ok: true })
    }
  )

  test("refuses invalid contracts and heading roles before generation", async () => {
    const actor = await site()
    await expect(
      actor.action(api.agents.contentWriter.generateRichText, {
        brief: "Write a title",
        locale: "English",
        fieldLabel: "question",
        profile: "basic",
        contract: "invalid" as never,
      })
    ).rejects.toThrow()

    await expect(
      actor.action(api.agents.contentWriter.generateRichText, {
        brief: "Write a title",
        locale: "English",
        fieldLabel: "question",
        profile: "basic",
        headingRole: "itemTitle",
      })
    ).rejects.toThrow(/only valid for title/i)

    expect(mocks.generateRuntimeText).not.toHaveBeenCalled()
    expect(mocks.enforceAiRateLimit).not.toHaveBeenCalled()
  })
})
