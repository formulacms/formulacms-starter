import { describe, expect, test } from "vitest"
import { claudeModelName, localToolModelName } from "./local-model-names"

describe("local-tool model names", () => {
  test("a versioned Claude id reads as its family and version; a date is dropped", () => {
    expect(claudeModelName("claude-opus-5-5")).toBe("Opus 5.5")
    expect(claudeModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5")
    expect(localToolModelName("claude", "claude-opus-5-5")).toBe("Opus 5.5")
    expect(localToolModelName("claude", "claude-haiku-4-5-20251001")).toBe("Haiku 4.5")
  })

  test("a Claude alias has no readable name", () => {
    expect(claudeModelName("opus")).toBe("opus")
    expect(localToolModelName("claude", "opus")).toBeUndefined()
  })

  test("a known Codex id has its menu name; an unknown one has none", () => {
    expect(localToolModelName("codex", "gpt-6.1-sol")).toBe("GPT-6.1 Sol")
    expect(localToolModelName("codex", "gpt-5.6-luna")).toBeUndefined()
  })
})
