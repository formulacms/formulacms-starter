import { isValidElement, type ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/fonts", () => ({ fontClassName: "font-test" }))

import LiveFrameLayout from "./layout"

describe("private live-frame viewport scroll behavior", () => {
  it("sets motion-safe smooth scrolling on the independent document root", async () => {
    const layout = await LiveFrameLayout({
      children: <main>Preview</main>,
      params: Promise.resolve({ locale: "fr" }),
    })
    expect(isValidElement(layout)).toBe(true)
    const root = layout as ReactElement<{
      className: string
      lang: string
      dir: string
    }>
    expect(root.type).toBe("html")
    expect(root.props.lang).toBe("fr")
    expect(root.props.className.split(/\s+/)).toContain("font-test")
    expect(root.props.className.split(/\s+/)).toContain(
      "motion-safe:scroll-smooth"
    )
  })
})
