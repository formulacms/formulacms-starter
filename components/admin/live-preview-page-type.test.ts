import { expect, it } from "vitest"
import { supportsLivePreviewFrame } from "./live-preview-page-type"

it.each(["page", "landing-page"])("gives %s a live preview frame", (type) => {
  expect(supportsLivePreviewFrame(type)).toBe(true)
})
it.each(["post", "author", "testimonial", "", undefined, null, 3])(
  "refuses %j",
  (type) => {
    expect(supportsLivePreviewFrame(type)).toBe(false)
  }
)
