import { render } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, expect, test, vi } from "vitest"
import { HydrationExtensionAttributeCleanup } from "./hydration-extension-attribute-cleanup"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test("emits executable cleanup JavaScript in server HTML", () => {
  vi.stubGlobal("window", undefined)

  const html = renderToStaticMarkup(<HydrationExtensionAttributeCleanup />)

  expect(html).toContain('id="hydration-extension-attribute-cleanup"')
  expect(html).toContain('type="text/javascript"')
  expect(html).toContain("MutationObserver")
})

test("renders an inert data block without React's client script warning", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

  const { container } = render(<HydrationExtensionAttributeCleanup />)

  expect(container.querySelector("script")).toHaveAttribute(
    "type",
    "text/plain"
  )
  expect(consoleError).not.toHaveBeenCalledWith(
    expect.stringContaining("Encountered a script tag")
  )
})
