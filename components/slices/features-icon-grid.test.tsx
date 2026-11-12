import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile } from "@/test-utils/slice-profile"
import { cloneElement, isValidElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { SliceRenderContext } from "@/lib/slices/links"
import { FeaturesIconGrid } from "./features-icon-grid"

const ctx: SliceRenderContext = {
  locale: "en",
  defaultLocale: "en",
  pagePaths: {},
}

function markup(count: number, preview: boolean) {
  const slice = createSampleSlice("features-icon-grid")
  slice.items = Array.from({ length: count }, (_, index) => ({
    ...slice.items[index % slice.items.length],
    icon: index % 2 ? undefined : "Zap",
    title:
      index % 3 === 0
        ? ""
        : index % 3 === 1
          ? "A realistic feature title with enough detail to wrap across several lines"
          : "Short title",
  }))
  const context: SliceRenderContext = preview
    ? {
        ...ctx,
        previewRichText: ({ rendered, fieldPath }) =>
          isValidElement<Record<string, unknown>>(rendered)
            ? cloneElement(rendered, { "data-sim-field": fieldPath })
            : rendered,
      }
    : ctx
  const container = document.createElement("div")
  container.innerHTML = renderToStaticMarkup(
    <FeaturesIconGrid slice={slice} ctx={context} />
  )
  return container
}

describe("Features icon-grid shared card tracks", () => {
  it.each([1, 5, 12])(
    "keeps %i cards in two direct tracks with natural mobile blocks", sliceProfile([]),
    (count) => {
      for (const preview of [false, true]) {
        const container = markup(count, preview)
        const grid = container.querySelector("section .grid")!
        expect(grid).toHaveClass(
          "grid-cols-1",
          "sm:grid-cols-2",
          "lg:grid-cols-3",
          "gap-gutter"
        )
        expect(grid.children).toHaveLength(count)
        if (count > 1)
          expect(grid.querySelectorAll(".text-lead").length).toBeGreaterThan(0)
        for (const card of grid.children) {
          expect(card).toHaveClass(
            "block",
            "sm:grid",
            "sm:grid-rows-subgrid",
            "sm:row-span-2",
            "sm:gap-y-0"
          )
          for (const utility of [
            "grid",
            "row-span-2",
            "grid-rows-subgrid",
            "gap-y-0",
          ])
            expect(card).not.toHaveClass(utility)
          expect(card.children).toHaveLength(2)
          const [header, body] = card.children
          expect(header).toHaveClass("flex", "items-start", "min-w-0")
          expect(body).toHaveClass("min-w-0", "mt-stack", "text-body")
          const title = header.querySelector(".text-lead")
          if (title)
            expect(title).toHaveClass(
              "min-w-0",
              "self-stretch",
              "wrap-break-word"
            )
          if (preview)
            expect(body.querySelector("[data-sim-field]")).not.toBeNull()
        }
      }
    }
  )
})
