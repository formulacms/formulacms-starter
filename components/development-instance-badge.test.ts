import type { ReactElement } from "react"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  DevelopmentInstanceBadge,
  describeDevelopmentInstance,
} from "./development-instance-badge"

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) =>
    ({
      caption: "Local development",
      unidentified: "Convex not identified",
      label: "Development instance",
    })[key],
}))

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("development instance badge", () => {
  test("identifies the frontend and Convex deployment", () => {
    expect(
      describeDevelopmentInstance({
        NODE_ENV: "development",
        NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
        CONVEX_DEPLOYMENT: "dev:watchful-opossum-441",
      })
    ).toBe("Local development · localhost:3000 · watchful-opossum-441")
  })

  test("stays out of production", () => {
    expect(
      describeDevelopmentInstance({
        NODE_ENV: "production",
        NEXT_PUBLIC_SITE_URL: "https://cms.example.com",
        CONVEX_DEPLOYMENT: "prod:example",
      })
    ).toBeNull()
  })

  test("phones show the caption alone; the full text stays for screen readers and from md up", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000")
    vi.stubEnv("CONVEX_DEPLOYMENT", "dev:watchful-opossum-441")
    const badge = (await DevelopmentInstanceBadge()) as ReactElement<{
      "aria-label": string
      children: ReactElement<{
        "aria-hidden"?: string
        className: string
        children: string
      }>[]
    }>
    expect(badge.props["aria-label"]).toBe("Development instance")
    const [caption, full] = badge.props.children
    expect(caption?.props).toMatchObject({
      "aria-hidden": true,
      className: "md:hidden",
      children: "Local development",
    })
    expect(full?.props).toMatchObject({
      className: "sr-only md:not-sr-only",
      children: "Local development · localhost:3000 · watchful-opossum-441",
    })
  })
})
