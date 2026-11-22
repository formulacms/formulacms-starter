import { describe, expect, test } from "vitest"
import { resolveBlockCreatorSelection } from "./creator-selection"

const NO_KEYS = { anthropic: false, openrouter: false, openai: false }
const SAVED = {
  provider: "openai",
  model: "gpt-6.1-sol",
  reasoning: { kind: "effort", effort: "high" },
} as const

describe("resolveBlockCreatorSelection", () => {
  test("a saved tuple with its key runs that provider, model and effort", () => {
    expect(
      resolveBlockCreatorSelection(SAVED, { ...NO_KEYS, openai: true })
    ).toEqual({
      provider: "openai",
      model: "gpt-6.1-sol",
      effort: "high",
      keyPresent: true,
    })
  })

  test("a saved tuple without its key is kept and reported missing", () => {
    expect(
      resolveBlockCreatorSelection(SAVED, { ...NO_KEYS, anthropic: true })
    ).toEqual({
      provider: "openai",
      model: "gpt-6.1-sol",
      effort: "high",
      keyPresent: false,
    })
  })

  test("a saved model without effort control has no effort", () => {
    expect(
      resolveBlockCreatorSelection(
        { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        { ...NO_KEYS, anthropic: true }
      )
    ).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      keyPresent: true,
    })
  })

  test("nothing saved and one key: that provider, no model, no effort", () => {
    const selection = resolveBlockCreatorSelection(undefined, {
      ...NO_KEYS,
      openai: true,
    })
    expect(selection).toEqual({ provider: "openai", keyPresent: true })
    expect(selection).not.toHaveProperty("model")
    expect(selection).not.toHaveProperty("effort")
  })

  test("nothing saved and two keys: the connection order decides", () => {
    expect(
      resolveBlockCreatorSelection(undefined, {
        anthropic: false,
        openrouter: true,
        openai: true,
      })
    ).toEqual({ provider: "openrouter", keyPresent: true })
    expect(
      resolveBlockCreatorSelection(undefined, {
        anthropic: true,
        openrouter: true,
        openai: false,
      })
    ).toEqual({ provider: "anthropic", keyPresent: true })
  })

  test("no key at all: no provider", () => {
    expect(resolveBlockCreatorSelection(undefined, NO_KEYS)).toEqual({
      provider: null,
      keyPresent: false,
    })
  })
})
