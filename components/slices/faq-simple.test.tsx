import { render, screen } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"

// This suite is about which panel is open, not rich-text rendering.
vi.mock("./render-helpers", () => ({
  RichTextContent: () => null,
}))

import { FaqSimple } from "./faq-simple"
import type { FaqSimpleSlice } from "@/convex/lib/slices/faqSimple"
import type { SliceRenderContext } from "@/lib/slices/links"

const ctx = { locale: "en" } as SliceRenderContext

function prose(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  }
}

function sliceWith(questions: string[]): FaqSimpleSlice {
  return {
    id: "faq",
    type: "faq-simple",
    enabled: true,
    primary: { heading: "FAQ", eyebrow: "", body: prose("") },
    items: questions.map((question) => ({
      question,
      answer: prose(`Answer to ${question}`),
    })),
  } as unknown as FaqSimpleSlice
}

/** Which question's panel is currently expanded. */
function openQuestion(): string | undefined {
  return screen
    .getAllByRole("button")
    .find((trigger) => trigger.getAttribute("aria-expanded") === "true")
    ?.textContent?.trim()
}

describe("FaqSimple accordion identity", () => {
  test("opens the first item by default", () => {
    render(<FaqSimple slice={sliceWith(["A?", "B?", "C?"])} ctx={ctx} />)

    expect(openQuestion()).toBe("A?")
  })

  test("the open panel follows its item when the list is reordered", () => {
    // The regression this guards: open state used to be addressed by
    // `value={`item-${index}`}`, which pinned "which panel is open" to a
    // position. Reordering items in the editor therefore left the wrong
    // answer expanded. Keys are now derived from the question itself.
    const { rerender } = render(
      <FaqSimple slice={sliceWith(["A?", "B?", "C?"])} ctx={ctx} />
    )
    expect(openQuestion()).toBe("A?")

    // Editor drags "C?" to the top. "A?" must stay the open one.
    rerender(<FaqSimple slice={sliceWith(["C?", "A?", "B?"])} ctx={ctx} />)

    expect(openQuestion()).toBe("A?")
  })

  test("questions with identical text still render distinct panels", () => {
    render(<FaqSimple slice={sliceWith(["Same?", "Same?"])} ctx={ctx} />)

    // Duplicate keys would collapse these into one item.
    expect(screen.getAllByRole("button")).toHaveLength(2)
  })
})
