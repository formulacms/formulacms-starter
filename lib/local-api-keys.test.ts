import { describe, expect, test } from "vitest"
import { localProviderKeyPresence } from "./local-api-keys"

const NONE = { anthropic: false, openai: false, openrouter: false }

describe("localProviderKeyPresence", () => {
  test("the current variable name counts as a key", () => {
    expect(
      localProviderKeyPresence({ FORMULACMS_DEV_ANTHROPIC_API_KEY: "sk-test" })
    ).toEqual({ ...NONE, anthropic: true })
  })

  test("the legacy variable name counts as a key", () => {
    expect(
      localProviderKeyPresence({ NEXTCMS_DEV_OPENROUTER_API_KEY: "sk-test" })
    ).toEqual({ ...NONE, openrouter: true })
  })

  test("a blank value is no key", () => {
    expect(
      localProviderKeyPresence({
        FORMULACMS_DEV_OPENAI_API_KEY: "   ",
        NEXTCMS_DEV_OPENAI_API_KEY: "",
      })
    ).toEqual(NONE)
  })

  test("no variable is no key", () => {
    expect(localProviderKeyPresence({})).toEqual(NONE)
  })

  test("the result holds booleans only, never a value", () => {
    const result = localProviderKeyPresence({
      FORMULACMS_DEV_ANTHROPIC_API_KEY: "sk-secret-a",
      NEXTCMS_DEV_OPENAI_API_KEY: "sk-secret-b",
      FORMULACMS_DEV_OPENROUTER_API_KEY: "sk-secret-c",
    })
    expect(Object.values(result).every((value) => value === true)).toBe(true)
    expect(JSON.stringify(result)).not.toContain("sk-secret")
  })
})
