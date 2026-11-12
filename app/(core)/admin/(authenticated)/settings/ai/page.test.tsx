import { isValidElement } from "react"
import { afterEach, describe, expect, test, vi } from "vitest"

const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  })
)

vi.mock("next/navigation", () => ({ notFound }))

import AiSettingsPage from "./page"

describe("Settings AI route", () => {
  test("the direct Settings AI route renders the installed participant with a server-owned local flag", async () => {
    const element = await AiSettingsPage()
    expect(isValidElement(element)).toBe(true)
    if (!isValidElement<{ isLocal: boolean }>(element)) throw new Error("Expected settings participant")
    expect(element.props.isLocal).toBe(process.env.NODE_ENV !== "production")
    expect(notFound).not.toHaveBeenCalled()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test("locally the binding receives which Slice creator keys exist, as booleans only", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("FORMULACMS_DEV_ANTHROPIC_API_KEY", "secret-key-value")
    vi.stubEnv("FORMULACMS_DEV_OPENAI_API_KEY", "")
    vi.stubEnv("NEXTCMS_DEV_OPENAI_API_KEY", "")
    vi.stubEnv("FORMULACMS_DEV_OPENROUTER_API_KEY", "")
    vi.stubEnv("NEXTCMS_DEV_OPENROUTER_API_KEY", "")
    const element = await AiSettingsPage()
    if (!isValidElement<{ isLocal: boolean; localKeys?: Record<string, unknown> }>(element)) throw new Error("Expected settings participant")
    expect(element.props.isLocal).toBe(true)
    expect(element.props.localKeys).toEqual({ anthropic: true, openai: false, openrouter: false })
    expect(Object.values(element.props.localKeys!).every((value) => typeof value === "boolean")).toBe(true)
    expect(JSON.stringify(element.props)).not.toContain("secret-key-value")
  })

  test("in production the binding receives no local key prop", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("FORMULACMS_DEV_ANTHROPIC_API_KEY", "secret-key-value")
    const element = await AiSettingsPage()
    if (!isValidElement<{ isLocal: boolean; localKeys?: unknown }>(element)) throw new Error("Expected settings participant")
    expect(element.props).toEqual({ isLocal: false })
  })
})
