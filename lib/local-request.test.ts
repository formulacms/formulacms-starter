import { afterEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ headers: vi.fn() }))
vi.mock("next/headers", () => ({ headers: mocks.headers }))

import {
  isLocalToolRequest,
  isLoopbackAddress,
  isLoopbackRequest,
} from "./local-request"

const request = (values: Record<string, string>) => new Headers(values)

describe("isLoopbackAddress", () => {
  test.each([
    "localhost",
    "LOCALHOST:3000",
    "127.0.0.1",
    "127.0.0.1:3000",
    "127.255.10.2",
    "::1",
    "[::1]",
    "[::1]:3000",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "[::ffff:127.0.0.1]:3000",
    " 127.0.0.1 ",
  ])("%s is loopback", (value) => {
    expect(isLoopbackAddress(value)).toBe(true)
  })

  test.each([
    "",
    "192.168.1.20",
    "10.0.0.5:3000",
    "128.0.0.1",
    "::2",
    "[::2]:3000",
    "::ffff:192.168.1.20",
    "fe80::1%lo0",
    "localhost.",
    "app.localhost",
    "evil.example",
    "127.0.0.1.evil.example",
    "user@127.0.0.1",
    "127.0.0.1/admin",
    "[::1",
    "[::1]x",
    "127.0.0.1:port",
    "999.0.0.1",
    `127.0.0.1:${"1".repeat(1100)}`,
  ])("%s is not loopback", (value) => {
    expect(isLoopbackAddress(value)).toBe(false)
  })

  test("missing values are not loopback", () => {
    expect(isLoopbackAddress(null)).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})

describe("isLoopbackRequest", () => {
  test("accepts a browser on this computer", () => {
    expect(
      isLoopbackRequest(
        request({ "x-forwarded-for": "::1", host: "localhost:3000" })
      )
    ).toBe(true)
    expect(
      isLoopbackRequest(
        request({ "x-forwarded-for": "127.0.0.1", host: "127.0.0.1:3000" })
      )
    ).toBe(true)
  })

  test("refuses a spoofed host from a network socket address", () => {
    expect(
      isLoopbackRequest(
        request({ "x-forwarded-for": "192.168.1.20", host: "localhost:3000" })
      )
    ).toBe(false)
  })

  test("refuses a DNS-rebinding host from a loopback socket", () => {
    expect(
      isLoopbackRequest(
        request({ "x-forwarded-for": "127.0.0.1", host: "evil.example:3000" })
      )
    ).toBe(false)
  })

  test("refuses a proxy chain, even when every entry is loopback", () => {
    expect(
      isLoopbackRequest(
        request({ "x-forwarded-for": "127.0.0.1, ::1", host: "localhost" })
      )
    ).toBe(false)
  })

  test("fails closed when a header is missing", () => {
    expect(isLoopbackRequest(request({ host: "localhost:3000" }))).toBe(false)
    expect(isLoopbackRequest(request({ "x-forwarded-for": "::1" }))).toBe(false)
    expect(isLoopbackRequest(request({}))).toBe(false)
  })
})

describe("isLocalToolRequest", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  test("is true for a loopback request in development", async () => {
    mocks.headers.mockResolvedValue(
      request({ "x-forwarded-for": "::1", host: "localhost:3000" })
    )
    await expect(isLocalToolRequest()).resolves.toBe(true)
  })

  test("is false for a network request in development", async () => {
    mocks.headers.mockResolvedValue(
      request({ "x-forwarded-for": "192.168.1.20", host: "192.168.1.5:3000" })
    )
    await expect(isLocalToolRequest()).resolves.toBe(false)
  })

  test("is false in production without reading headers", async () => {
    vi.stubEnv("NODE_ENV", "production")
    await expect(isLocalToolRequest()).resolves.toBe(false)
    expect(mocks.headers).not.toHaveBeenCalled()
  })

  test("fails closed outside a request scope", async () => {
    mocks.headers.mockRejectedValue(new Error("outside a request scope"))
    await expect(isLocalToolRequest()).resolves.toBe(false)
  })
})
