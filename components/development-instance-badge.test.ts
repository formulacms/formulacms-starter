import { describe, expect, test } from "vitest"
import { describeDevelopmentInstance } from "./development-instance-badge"

describe("development instance badge", () => {
  test("identifies the frontend and Convex deployment", () => {
    expect(
      describeDevelopmentInstance({
        NODE_ENV: "development",
        BETTER_AUTH_URL: "http://localhost:3000",
        CONVEX_DEPLOYMENT: "dev:watchful-opossum-441",
      })
    ).toBe("Local development · localhost:3000 · watchful-opossum-441")
  })

  test("stays out of production", () => {
    expect(
      describeDevelopmentInstance({
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://cms.example.com",
        CONVEX_DEPLOYMENT: "prod:example",
      })
    ).toBeNull()
  })
})
