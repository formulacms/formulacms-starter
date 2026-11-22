import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { BlockSimDevPage } from "./dev-page"

vi.mock("./block-target-layer", () => ({ BlockTargetLayer: () => null }))
vi.mock("./sim-size-reporter", () => ({ SimSizeReporter: () => null }))
vi.mock("./block-workbench-panel", () => ({ BlockWorkbenchPanel: () => null }))

describe("RF3 simulator outline consumer", () => {
  it.each(["thumb", "1"])(
    "owns one document h1 around its section zone in %s mode", blockProfile(["hero-with-image"]),
    async (bare) => {
      const element = await BlockSimDevPage({
        params: Promise.resolve({ type: "hero-with-image" }),
        searchParams: Promise.resolve({ bare }),
      })
      const container = document.createElement("div")
      container.innerHTML = renderToStaticMarkup(element)
      expect(container.querySelectorAll("h1")).toHaveLength(1)
      expect(container.querySelector("h1")?.className).toBe("sr-only")
      expect(container.querySelectorAll("h2")).toHaveLength(1)
    }
  )
  for (const profileRow of ["hero-agency", "rich-text-body"]) {
    it.each([profileRow])("keeps one h1 when showing %s as page opening", blockProfile([profileRow]),
      async (type) => {
        const element = await BlockSimDevPage({
          params: Promise.resolve({ type }),
          searchParams: Promise.resolve({ bare: "1", opening: "1" }),
        })
        const container = document.createElement("div")
        container.innerHTML = renderToStaticMarkup(element)
        expect(container.querySelectorAll("h1")).toHaveLength(1)
        expect(container.querySelector("h1")?.classList.contains("sr-only")).toBe(
          type !== "hero-agency"
        )
      }
    )
  }
})
