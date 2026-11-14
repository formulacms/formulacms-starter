import { describe, expect, test } from "vitest"
import {
  devServerArguments,
  resolveDevBundler,
  resolveDevServerOrigin,
} from "./dev-server-origin"

describe("development server origin", () => {
  test("a local NEXT_PUBLIC_SITE_URL is the fixed Next.js address", () => {
    expect(
      resolveDevServerOrigin({ NEXT_PUBLIC_SITE_URL: "http://localhost:3001" })
    ).toEqual({
      hostname: "localhost",
      origin: "http://localhost:3001",
      port: 3001,
    })
  })

  test("refuses a local origin with a path", () => {
    expect(() =>
      resolveDevServerOrigin({
        NEXT_PUBLIC_SITE_URL: "http://localhost:3000/admin",
      })
    ).toThrow(/must not include a path/)
  })

  test("a deployed or schemeless site address leaves the default", () => {
    for (const value of ["https://cms.example.com", "example.com"]) {
      expect(resolveDevServerOrigin({ NEXT_PUBLIC_SITE_URL: value }).origin).toBe(
        "http://localhost:3000"
      )
    }
  })

  test("defaults to localhost 3000 when the site address is not set", () => {
    expect(resolveDevServerOrigin({})).toEqual({
      hostname: "localhost",
      origin: "http://localhost:3000",
      port: 3000,
    })
  })
})

describe("development bundler selection", () => {
  const origin = {
    hostname: "localhost",
    origin: "http://localhost:3001",
    port: 3001,
  }

  test("defaults to Turbopack and passes the flag explicitly", () => {
    expect(resolveDevBundler({})).toBe("turbopack")
    expect(resolveDevBundler({ FORMULACMS_DEV_BUNDLER: "  " })).toBe(
      "turbopack"
    )
    expect(devServerArguments(origin, "turbopack")).toEqual([
      "dev",
      "--turbopack",
      "--hostname",
      "localhost",
      "--port",
      "3001",
    ])
  })

  test("keeps webpack available through the environment variable", () => {
    const bundler = resolveDevBundler({ FORMULACMS_DEV_BUNDLER: "webpack" })
    expect(bundler).toBe("webpack")
    expect(devServerArguments(origin, bundler)).toEqual([
      "dev",
      "--webpack",
      "--hostname",
      "localhost",
      "--port",
      "3001",
    ])
  })

  test("rejects an unknown bundler instead of guessing", () => {
    expect(() =>
      resolveDevBundler({ FORMULACMS_DEV_BUNDLER: "rspack" })
    ).toThrow(/must be "turbopack" or "webpack"; received "rspack"/)
    expect(() =>
      resolveDevBundler({ FORMULACMS_DEV_BUNDLER: "Webpack" })
    ).toThrow(/must be/)
  })
})
