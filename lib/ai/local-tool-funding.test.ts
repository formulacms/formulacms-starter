// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  fundingForAuditEngine,
  localToolFunding,
  resetLocalToolFundingCache,
} from "./local-tool-funding"

const TOOL_ENV = { PATH: "/usr/bin" }

function inspectReturning(...statuses: unknown[]) {
  const inspect = vi.fn()
  for (const status of statuses) inspect.mockResolvedValueOnce(status)
  return inspect
}

describe("localToolFunding", () => {
  beforeEach(() => resetLocalToolFundingCache())

  test.each([
    [{ state: "authenticated", method: "plan" }, "plan"],
    [{ state: "authenticated", method: "api-key" }, "api-key"],
    [{ state: "authenticated", method: "unknown" }, "unknown"],
    [{ state: "not-configured", issue: "signed-out" }, "unknown"],
    [{ state: "unreachable", issue: "timeout" }, "unknown"],
  ])("reports %j as %s", async (status, expected) => {
    const inspect = inspectReturning(status)
    await expect(
      localToolFunding("claude", {
        toolEnv: TOOL_ENV,
        inspect: inspect as never,
      })
    ).resolves.toBe(expected)
    expect(inspect).toHaveBeenCalledWith("claude", { toolEnv: TOOL_ENV })
  })

  test("reports unknown, and does not throw, when the status check fails", async () => {
    const inspect = vi.fn().mockRejectedValue(new Error("vendor said: secret"))
    await expect(
      localToolFunding("codex", {
        toolEnv: TOOL_ENV,
        inspect: inspect as never,
      })
    ).resolves.toBe("unknown")
  })

  test("caches each tool for 60 seconds, then asks again", async () => {
    let clock = 1_000
    const inspect = inspectReturning(
      { state: "authenticated", method: "plan" },
      { state: "authenticated", method: "api-key" },
      { state: "authenticated", method: "api-key" }
    )
    const options = {
      toolEnv: TOOL_ENV,
      inspect: inspect as never,
      now: () => clock,
    }

    await expect(localToolFunding("claude", options)).resolves.toBe("plan")
    clock += 59_999
    await expect(localToolFunding("claude", options)).resolves.toBe("plan")
    expect(inspect).toHaveBeenCalledTimes(1)

    // The other tool has its own entry.
    await expect(localToolFunding("codex", options)).resolves.toBe("api-key")
    expect(inspect).toHaveBeenCalledTimes(2)

    clock += 2
    await expect(localToolFunding("claude", options)).resolves.toBe("api-key")
    expect(inspect).toHaveBeenCalledTimes(3)
  })

  test("shares one lookup between parallel audit rows", async () => {
    const inspect = inspectReturning({ state: "authenticated", method: "plan" })
    const options = { toolEnv: TOOL_ENV, inspect: inspect as never }
    const rows = await Promise.all([
      localToolFunding("claude", options),
      localToolFunding("claude", options),
      localToolFunding("claude", options),
    ])
    expect(rows).toEqual(["plan", "plan", "plan"])
    expect(inspect).toHaveBeenCalledTimes(1)
  })
})

describe("fundingForAuditEngine", () => {
  test("gives no funding to an API engine and never starts a status check", async () => {
    for (const engine of ["openrouter-api", "anthropic-api", "openai-api"]) {
      await expect(fundingForAuditEngine(engine)).resolves.toBeUndefined()
    }
  })
})
