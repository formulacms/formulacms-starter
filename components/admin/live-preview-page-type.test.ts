import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  CONTENT_TYPES,
  REGISTERED_CONTENT_TYPES,
  isActiveContentType,
  type ContentType,
} from "@/convex/lib/contentTypes"
import { supportsLivePreviewFrame } from "./live-preview-page-type"

/**
 * Owner rule, 2026-11-20: every content type has a live preview. The only
 * registered types the frame may refuse are listed here, each because no
 * public renderer ships for it. Neither is in the starter selection. Giving
 * one a renderer and selecting it must remove it from this list. That every
 * previewed type has a block-body renderer is checked in
 * `live-preview-frame-runtime.test.tsx` (renderers need a DOM test runner).
 */
const NO_RENDERER_YET: Partial<Record<ContentType, string>> = {
  testimonial: "form-only type without a block body or public renderer",
  job: "block-body type without a public renderer",
}

describe("live preview gate covers the content-type registry", () => {
  it("ships no starter type that has no renderer", () => {
    const selectionPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../starter.selection.json"
    )
    const { contentTypes } = JSON.parse(readFileSync(selectionPath, "utf8"))
    expect(Array.isArray(contentTypes)).toBe(true)
    for (const type of contentTypes as string[])
      expect(
        type in NO_RENDERER_YET,
        `${type} is in starter.selection.json but has no renderer, so it has no live preview. It needs a renderer before it ships.`
      ).toBe(false)
  })

  it.each(CONTENT_TYPES)("previews the selected type %s", (type) => {
    expect(supportsLivePreviewFrame(type)).toBe(true)
  })

  it.each(REGISTERED_CONTENT_TYPES)(
    "matches selection and renderer availability for registered type %s",
    (type) => {
      expect(supportsLivePreviewFrame(type)).toBe(
        isActiveContentType(type) && !(type in NO_RENDERER_YET)
      )
    }
  )
  it.each(
    REGISTERED_CONTENT_TYPES.filter((type) => !isActiveContentType(type))
  )("refuses the inactive registered type %s", (type) =>
    expect(supportsLivePreviewFrame(type)).toBe(false)
  )
})

it.each(["", "unknown", "toString", undefined, null, 3])(
  "refuses %j",
  (type) => {
    expect(supportsLivePreviewFrame(type)).toBe(false)
  }
)
