import { describe, expect, test, vi } from "vitest"

import { convexRunArgs, main, parseRecoverOptions } from "./owner-recover"

const LINK = {
  url: "http://localhost:3000/recover?token=abc",
  expiresAt: "2026-11-14T01:15:00.000Z",
}

describe("pnpm owner:recover", () => {
  test("runs the recovery function on the app's own deployment and prints only the link and expiry", async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify(LINK, null, 2),
      stderr: "",
    }))
    const lines = await main([], runner)
    expect(runner).toHaveBeenCalledWith(["run", "cms/recovery:createRecoveryLink", "{}"])
    expect(lines).toEqual([
      "Owner recovery link (works once):",
      LINK.url,
      `It expires at ${LINK.expiresAt}.`,
    ])
  })

  test("passes the target and the base URL through", () => {
    expect(convexRunArgs(parseRecoverOptions(["--prod", "--base-url", "https://example.com/admin"]))).toEqual([
      "run",
      "cms/recovery:createRecoveryLink",
      '{"baseUrl":"https://example.com"}',
      "--prod",
    ])
    expect(convexRunArgs(parseRecoverOptions(["--deployment", "happy-animal-123"]))).toEqual([
      "run",
      "cms/recovery:createRecoveryLink",
      "{}",
      "--deployment",
      "happy-animal-123",
    ])
  })

  test.each([
    [["--prod", "--deployment", "x"], /either --prod or --deployment/],
    [["--base-url", "example.com"], /full address/],
    [["--base-url", "ftp://example.com"], /http:\/\/ or https:\/\//],
    [["--deployment"], /needs a value/],
    [["--email", "a@b.c"], /Unknown option/],
  ])("refuses %j", (args, message) => {
    expect(() => parseRecoverOptions(args)).toThrow(message)
  })

  test("a site with no saved address gets a plain instruction", async () => {
    const runner = async () => ({
      code: 1,
      stdout: "",
      stderr: "Uncaught ConvexError: RECOVERY_BASE_URL_MISSING",
    })
    await expect(main([], runner)).rejects.toThrow(/--base-url/)
  })

  test("any other failure shows the CLI's last lines, never a link", async () => {
    const runner = async () => ({ code: 1, stdout: "", stderr: "✖ No CONVEX_DEPLOYMENT set\n" })
    await expect(main([], runner)).rejects.toThrow("✖ No CONVEX_DEPLOYMENT set")
    await expect(main([], async () => ({ code: 0, stdout: "null", stderr: "" }))).rejects.toThrow(
      /did not return a recovery link/
    )
  })

  test("help runs nothing", async () => {
    const runner = vi.fn()
    expect((await main(["--help"], runner))[0]).toMatch(/one-time link/)
    expect(runner).not.toHaveBeenCalled()
  })
})
