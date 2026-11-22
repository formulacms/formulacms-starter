// @vitest-environment node
import { describe, expect, test, vi } from "vitest"
import {
  resolveEngineId,
  isEngineId,
  createEngine,
  type GenerateRequest,
} from "./ai-engine"

const baseReq: GenerateRequest = {
  instructions: "SYS PROMPT",
  prompt: "BASE PROMPT",
  images: [{ path: "/tmp/a.png", mediaType: "image/png" }],
  profile: "vision-spec",
  phase: "block-spec",
}

describe("resolveEngineId", () => {
  test("flag beats env beats default", () => {
    expect(resolveEngineId("claude", "openrouter")).toBe("claude")
    expect(resolveEngineId(undefined, "claude")).toBe("claude")
    expect(resolveEngineId(undefined, undefined)).toBe("openrouter")
  })

  test("trims and validates", () => {
    expect(resolveEngineId("  codex  ")).toBe("codex")
    expect(() => resolveEngineId("gpt5")).toThrow(/Unknown AI engine/)
    expect(() => resolveEngineId(undefined, "bogus")).toThrow(
      /Unknown AI engine/
    )
  })

  test("reads the formulacms process environment before the legacy name", () => {
    const current = process.env.FORMULACMS_DEV_AI_ENGINE
    const legacy = process.env.NEXTCMS_DEV_AI_ENGINE
    try {
      process.env.FORMULACMS_DEV_AI_ENGINE = "codex"
      process.env.NEXTCMS_DEV_AI_ENGINE = "claude"
      expect(resolveEngineId(undefined)).toBe("codex")

      process.env.FORMULACMS_DEV_AI_ENGINE = ""
      expect(resolveEngineId(undefined)).toBe("claude")

      delete process.env.FORMULACMS_DEV_AI_ENGINE
      expect(resolveEngineId(undefined)).toBe("claude")
    } finally {
      if (current === undefined) delete process.env.FORMULACMS_DEV_AI_ENGINE
      else process.env.FORMULACMS_DEV_AI_ENGINE = current
      if (legacy === undefined) delete process.env.NEXTCMS_DEV_AI_ENGINE
      else process.env.NEXTCMS_DEV_AI_ENGINE = legacy
    }
  })

  test("isEngineId guards the union", () => {
    expect(isEngineId("claude")).toBe(true)
    expect(isEngineId("openrouter")).toBe(true)
    expect(isEngineId("anthropic")).toBe(true)
    expect(isEngineId("openai")).toBe(true)
    expect(isEngineId("codex")).toBe(true)
    expect(isEngineId("bedrock")).toBe(false)
  })
})

describe("engine boundary", () => {
  test.each(["claude", "codex"] as const)(
    "%s execution is refused in production",
    async (id) => {
      vi.stubEnv("NODE_ENV", "production")
      try {
        await expect(createEngine(id).generate(baseReq)).rejects.toThrow(
          "only in local development"
        )
      } finally {
        vi.unstubAllEnvs()
      }
    }
  )
  test("retains validation of partial subscription overrides", () => {
    expect(() => createEngine("claude", { engineEffort: "high" })).toThrow(
      "both"
    )
    expect(() => createEngine("claude", { engineModel: "sonnet" })).toThrow(
      "both"
    )
  })
  test("session-less API engine refuses before provider IO", async () => {
    await expect(createEngine("openai").generate(baseReq)).rejects.toThrow(
      "owner-session accounting"
    )
  })
})
