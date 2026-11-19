import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  localProviderKeyPresenceNow,
  readLocalApiKeys,
} from "./local-api-keys-file"

// Fake keys only; each test uses its own temporary project root.
const ANTHROPIC = "sk-ant-test-0000"
const OPENAI = "sk-proj-test-0000"
const OPENROUTER = "sk-or-test-0000"
const NONE = { anthropic: undefined, openai: undefined, openrouter: undefined }

let root: string
const writeEnvLocal = (text: string) =>
  writeFileSync(join(root, ".env.local"), text)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "formulacms-local-keys-"))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe("readLocalApiKeys with .env.local", () => {
  test("the last line for a name wins", () => {
    writeEnvLocal(
      `FORMULACMS_DEV_ANTHROPIC_API_KEY=sk-ant-test-old\nFORMULACMS_DEV_ANTHROPIC_API_KEY=${ANTHROPIC}\n`
    )
    expect(readLocalApiKeys({ root }).anthropic).toBe(ANTHROPIC)
  })

  test("the current name beats the legacy one, and a legacy name alone counts", () => {
    writeEnvLocal(
      [
        "NEXTCMS_DEV_OPENROUTER_API_KEY=sk-or-test-legacy",
        `FORMULACMS_DEV_OPENROUTER_API_KEY=${OPENROUTER}`,
        `NEXTCMS_DEV_OPENAI_API_KEY='${OPENAI}'`,
      ].join("\n")
    )
    expect(readLocalApiKeys({ root })).toEqual({
      anthropic: undefined,
      openai: OPENAI,
      openrouter: OPENROUTER,
    })
  })

  test("a blank NAME= is no key", () => {
    writeEnvLocal(
      "FORMULACMS_DEV_ANTHROPIC_API_KEY=\nFORMULACMS_DEV_OPENAI_API_KEY=   \n"
    )
    expect(readLocalApiKeys({ root })).toEqual(NONE)
  })

  test("the file is the only source: a name missing there is no key, whatever process.env holds", () => {
    vi.stubEnv("FORMULACMS_DEV_ANTHROPIC_API_KEY", ANTHROPIC)
    vi.stubEnv("NEXTCMS_DEV_OPENAI_API_KEY", OPENAI)
    writeEnvLocal("# keys removed\nOTHER_VALUE=1\n")
    expect(readLocalApiKeys({ root })).toEqual(NONE)
    expect(
      readLocalApiKeys({
        root,
        env: { FORMULACMS_DEV_OPENROUTER_API_KEY: OPENROUTER },
      })
    ).toEqual(NONE)
  })

  test("a change between two calls is seen on the second call", () => {
    writeEnvLocal("FORMULACMS_DEV_OPENAI_API_KEY=sk-proj-test-first\n")
    expect(readLocalApiKeys({ root }).openai).toBe("sk-proj-test-first")
    writeEnvLocal(`FORMULACMS_DEV_OPENAI_API_KEY=${OPENAI}\n`)
    expect(readLocalApiKeys({ root }).openai).toBe(OPENAI)
    writeEnvLocal("")
    expect(readLocalApiKeys({ root }).openai).toBeUndefined()
  })
})

describe("readLocalApiKeys without .env.local", () => {
  test("falls back to the given environment", () => {
    expect(
      readLocalApiKeys({
        root,
        env: {
          FORMULACMS_DEV_ANTHROPIC_API_KEY: ANTHROPIC,
          NEXTCMS_DEV_OPENROUTER_API_KEY: OPENROUTER,
        },
      })
    ).toEqual({ anthropic: ANTHROPIC, openai: undefined, openrouter: OPENROUTER })
  })

  test("defaults to process.env", () => {
    vi.stubEnv("FORMULACMS_DEV_OPENAI_API_KEY", OPENAI)
    expect(readLocalApiKeys({ root }).openai).toBe(OPENAI)
  })
})

describe("an unreadable .env.local", () => {
  test("means no key, without throwing or logging", () => {
    // A folder named .env.local cannot be read as a file (EISDIR).
    mkdirSync(join(root, ".env.local"))
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {})
    )
    expect(
      readLocalApiKeys({ root, env: { FORMULACMS_DEV_ANTHROPIC_API_KEY: ANTHROPIC } })
    ).toEqual(NONE)
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
})

describe("localProviderKeyPresenceNow", () => {
  test("returns booleans only, never a value, and logs nothing", () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {})
    )
    writeEnvLocal(
      `FORMULACMS_DEV_ANTHROPIC_API_KEY=${ANTHROPIC}\nNEXTCMS_DEV_OPENROUTER_API_KEY=${OPENROUTER}\n`
    )
    const presence = localProviderKeyPresenceNow({ root })
    expect(presence).toEqual({ anthropic: true, openai: false, openrouter: true })
    const output = JSON.stringify(presence)
    for (const key of [ANTHROPIC, OPENROUTER]) expect(output).not.toContain(key)
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
})
