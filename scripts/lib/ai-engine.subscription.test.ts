// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest"
import { createEngine, type GenerateRequest } from "./ai-engine"
const request: GenerateRequest = {
  instructions: "SYSTEM",
  prompt: "TEXT",
  images: [],
  profile: "vision-spec",
  phase: "block-spec",
}
const fakes = () => ({
  readCatalog: vi.fn(async () => {
    throw new Error("fake catalog read")
  }),
  runProcess: vi.fn(),
  stageRun: vi.fn(async () => {
    throw new Error("fake staging")
  }),
})
afterEach(() => vi.unstubAllEnvs())

describe("local tool engines run only in local development", () => {
  test.each(["claude", "codex"] as const)(
    "%s refuses in production before any process starts",
    async (id) => {
      vi.stubEnv("NODE_ENV", "production")
      const deps = fakes()
      const engine = createEngine(id, { claudeDeps: deps, codexDeps: deps })
      await expect(engine.generate(request)).rejects.toThrow(
        "only in local development"
      )
      expect(deps.readCatalog).not.toHaveBeenCalled()
      expect(deps.stageRun).not.toHaveBeenCalled()
      expect(deps.runProcess).not.toHaveBeenCalled()
    }
  )

  test("claude passes the guard in development", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const deps = fakes()
    await expect(
      createEngine("claude", { claudeDeps: deps }).generate(request)
    ).rejects.not.toThrow("only in local development")
    expect(deps.stageRun).toHaveBeenCalledOnce()
    expect(deps.runProcess).not.toHaveBeenCalled()
  })

  test("codex passes the guard in development", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const deps = fakes()
    await expect(
      createEngine("codex", { codexDeps: deps }).generate(request)
    ).rejects.not.toThrow("only in local development")
    expect(deps.readCatalog).toHaveBeenCalledOnce()
    expect(deps.runProcess).not.toHaveBeenCalled()
  })
})
