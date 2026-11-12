import { describe, expect, test } from "vitest"
import {
  devServerArguments,
  resolveDevBundler,
  resolveDevServerOrigin,
} from "./dev-server-origin"

describe("development server origin", () => {
  test("uses the Better Auth origin as the fixed Next.js address", () => {
    expect(
      resolveDevServerOrigin({
        BETTER_AUTH_URL: "http://localhost:3001",
        NEXT_PUBLIC_SITE_URL: "http://localhost:3001",
      })
    ).toEqual({
      hostname: "localhost",
      origin: "http://localhost:3001",
      port: 3001,
    })
  })

  test("refuses an origin with a path that would break sign-in trust", () => {
    expect(() =>
      resolveDevServerOrigin({
        BETTER_AUTH_URL: "http://localhost:3000/admin",
      })
    ).toThrow(/must not include a path/)
  })

  test("refuses to run local development at a deployed origin", () => {
    expect(() =>
      resolveDevServerOrigin({
        BETTER_AUTH_URL: "https://cms.example.com",
      })
    ).toThrow(/must be a local HTTP origin/)
  })

  test("defaults to localhost 3000 when neither optional origin is set", () => {
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
