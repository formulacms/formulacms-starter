// DATA-LOSS-FIXES case 1, phase A: the rich-text editor's own slash AI command
// ("Ask AI to write...") with the real TipTap editor, inside the real
// ContentTypeFieldsPanel and a stateful parent wired like page-editor.tsx.
// The answer arrives after the owner typed in a sibling field.
import { useLayoutEffect, useState } from "react"
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import { group, list, richText, text } from "@/convex/lib/blocks/primitives"
import type { AdminContentType } from "@/lib/admin/content-types"
import type { FieldGenerate } from "./fields/field-editor"
import { ContentTypeFieldsPanel } from "./content-type-fields-panel"
import { toast } from "sonner"

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  prompt: vi.fn(async () => "a short brief" as string | null),
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
  usePrompt: () => mocks.prompt,
}))
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), message: vi.fn(), success: vi.fn() },
}))

// jsdom has no layout; ProseMirror needs a rect to place the slash menu.
const rect = { top: 0, bottom: 10, left: 0, right: 10, width: 10, height: 10, x: 0, y: 0 }
const rects = () => Object.assign([rect], { item: () => rect })
Range.prototype.getClientRects = rects as never
Range.prototype.getBoundingClientRect = (() => rect) as never
Element.prototype.getClientRects = rects as never

const slashDoc = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "/" }] }],
})
const answerDoc = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "AI paragraph" }] },
  ],
})

const testimonial: AdminContentType = {
  type: "testimonial",
  singular: "Testimonial",
  plural: "Testimonials",
  routable: false,
  dictionaryKey: "testimonial",
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function Host({
  generate,
  seenRef,
}: {
  generate: FieldGenerate
  seenRef: { current: Record<string, unknown> }
}) {
  const [localized, setLocalized] = useState<Record<string, unknown>>({
    story: slashDoc,
    beta: "",
  })
  useLayoutEffect(() => {
    seenRef.current = localized
  })
  return (
    <ContentTypeFieldsPanel
      contentType={testimonial}
      sharedValues={{}}
      localizedValues={localized}
      onSharedChange={() => {}}
      onLocalizedChange={setLocalized}
      currentLocale="en"
      generate={generate}
      descriptorOverride={{
        sharedFields: {},
        localizedFields: {
          story: richText({ profile: "basic" }),
          beta: text(),
        },
      }}
    />
  )
}

beforeEach(() => {
  mocks.confirm.mockReset().mockResolvedValue(true)
  mocks.prompt.mockReset().mockResolvedValue("a short brief")
})
afterEach(() => vi.clearAllMocks())

test("slash 'Ask AI to write' keeps a sibling typed during the request (test 6)", async () => {
  const answer = deferred<string>()
  const generate: FieldGenerate = {
    run: vi.fn(() => answer.promise),
    runRefine: vi.fn(() => answer.promise),
    runBlock: vi.fn(),
  }
  const seenRef = { current: {} as Record<string, unknown> }
  render(<Host generate={generate} seenRef={seenRef} />)
  const surface = await screen.findByRole("textbox", { name: "Story" })
  await act(async () => {
    surface.focus()
    const range = document.createRange()
    range.selectNodeContents(surface.querySelector("p")!)
    range.collapse(false)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event("selectionchange"))
  })
  const item = await screen.findByRole("menuitem", { name: /Ask AI to write/ })
  await act(async () => {
    fireEvent.click(item)
  })
  await waitFor(() => expect(generate.run).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByRole("textbox", { name: "Beta" }), {
    target: { value: "typed by the owner" },
  })
  expect(seenRef.current.beta).toBe("typed by the owner")
  await act(async () => answer.resolve(answerDoc))
  expect(String(seenRef.current.story)).toContain("AI paragraph")
  // Correct behavior: the late answer must not revert Beta.
  expect(seenRef.current.beta).toBe("typed by the owner")
})

// Phase B: a language switch while the slash answer is in flight. The host
// keeps only the active language's bag in state, like the page editor.
const frenchDoc = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Texte FR" }] }],
})

function LocaleHost({
  generate,
  french,
  seenRef,
}: {
  generate: FieldGenerate
  french: string
  seenRef: { current: { locale: string; localized: Record<string, unknown> } }
}) {
  const [locale, setLocale] = useState<"en" | "fr">("en")
  const [localized, setLocalized] = useState<Record<string, unknown>>({
    story: slashDoc,
    beta: "",
  })
  useLayoutEffect(() => {
    seenRef.current = { locale, localized }
  })
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setLocale("fr")
          setLocalized({ story: french, beta: "" })
        }}
      >
        Switch to French
      </button>
      <ContentTypeFieldsPanel
        contentType={testimonial}
        sharedValues={{}}
        localizedValues={localized}
        onSharedChange={() => {}}
        onLocalizedChange={setLocalized}
        currentLocale={locale}
        generate={generate}
        descriptorOverride={{
          sharedFields: {},
          localizedFields: {
            story: richText({ profile: "basic" }),
            beta: text(),
          },
        }}
      />
    </>
  )
}

test.each([
  ["French text differs", frenchDoc],
  ["French text equals English", slashDoc],
])(
  "slash 'Ask AI to write': an English answer does not land in French (%s)",
  async (_name, french) => {
    const answer = deferred<string>()
    const generate: FieldGenerate = {
      run: vi.fn(() => answer.promise),
      runRefine: vi.fn(() => answer.promise),
      runBlock: vi.fn(),
    }
    const seenRef = {
      current: { locale: "en", localized: {} as Record<string, unknown> },
    }
    render(<LocaleHost generate={generate} french={french} seenRef={seenRef} />)
    const surface = await screen.findByRole("textbox", { name: "Story" })
    await act(async () => {
      surface.focus()
      const range = document.createRange()
      range.selectNodeContents(surface.querySelector("p")!)
      range.collapse(false)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      fireEvent(document, new Event("selectionchange"))
    })
    const item = await screen.findByRole("menuitem", { name: /Ask AI to write/ })
    await act(async () => {
      fireEvent.click(item)
    })
    await waitFor(() => expect(generate.run).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "Switch to French" }))
    expect(seenRef.current.locale).toBe("fr")
    const frenchBefore = seenRef.current.localized.story
    await act(async () => answer.resolve(answerDoc))
    expect(String(seenRef.current.localized.story)).not.toContain("AI paragraph")
    expect(seenRef.current.localized.story).toBe(frenchBefore)
    expect(toast.error).toHaveBeenCalledWith(
      "This field changed, so the AI answer was not applied."
    )
  }
)

// Phase B TipTap check: mounting the real editor must not make an untouched
// rich-text field look changed, or every late answer would be refused.
function StoryHost({
  story,
  generate,
  seenRef,
}: {
  story: string
  generate: FieldGenerate
  seenRef: { current: Record<string, unknown> }
}) {
  const [localized, setLocalized] = useState<Record<string, unknown>>({
    story,
  })
  useLayoutEffect(() => {
    seenRef.current = localized
  })
  return (
    <ContentTypeFieldsPanel
      contentType={testimonial}
      sharedValues={{}}
      localizedValues={localized}
      onSharedChange={() => {}}
      onLocalizedChange={setLocalized}
      currentLocale="en"
      generate={generate}
      descriptorOverride={{
        sharedFields: {},
        localizedFields: { story: richText({ profile: "basic" }) },
      }}
    />
  )
}

const unnormalized = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
})

test.each([
  ["empty value", ""],
  ["stored doc that TipTap would normalize", unnormalized],
])(
  "an untouched rich-text field is not seen as changed (%s)",
  async (_name, story) => {
    const answer = deferred<string>()
    const generate: FieldGenerate = {
      run: vi.fn(() => answer.promise),
      runRefine: vi.fn(() => answer.promise),
      runBlock: vi.fn(),
    }
    const seenRef = { current: {} as Record<string, unknown> }
    render(<StoryHost story={story} generate={generate} seenRef={seenRef} />)
    await screen.findByRole("textbox", { name: "Story" })
    // Mounting the real editor did not re-emit a normalized value.
    await act(async () => {})
    expect(seenRef.current.story).toBe(story)
    const group = screen.getByRole("group", { name: "Story" })
    await act(async () => {
      fireEvent.click(within(group).getByRole("button", { name: "Write" }))
    })
    await waitFor(() => expect(generate.run).toHaveBeenCalledTimes(1))
    await act(async () => {})
    await act(async () => answer.resolve(answerDoc))
    expect(toast.error).not.toHaveBeenCalled()
    expect(String(seenRef.current.story)).toContain("AI paragraph")
  }
)

// Fix r1: TipTap destroys an unmounted editor in setTimeout(…, 1), so
// `isDestroyed` stays false for one tick. An answer arriving in that window
// must still be dropped, or it writes through the removed row's onChange.
function NotesHost({
  generate,
  seenRef,
  writesRef,
}: {
  generate: FieldGenerate
  seenRef: { current: Record<string, unknown> }
  writesRef: { current: unknown[] }
}) {
  const [localized, setLocalized] = useState<Record<string, unknown>>({
    notes: [
      { itemId: "i0", body: slashDoc },
      { itemId: "i1", body: frenchDoc },
    ],
  })
  useLayoutEffect(() => {
    seenRef.current = localized
  })
  return (
    <ContentTypeFieldsPanel
      contentType={testimonial}
      sharedValues={{}}
      localizedValues={localized}
      onSharedChange={() => {}}
      onLocalizedChange={(next) => {
        writesRef.current = [...writesRef.current, next]
        setLocalized(next)
      }}
      currentLocale="en"
      generate={generate}
      descriptorOverride={{
        sharedFields: {},
        localizedFields: {
          notes: list(group({ body: richText({ profile: "basic" }) })),
        },
      }}
    />
  )
}

test("slash AI answer after target-row unmount, before destruction timer", async () => {
  const answer = deferred<string>()
  const generate: FieldGenerate = {
    run: vi.fn(() => answer.promise),
    runRefine: vi.fn(() => answer.promise),
    runBlock: vi.fn(),
  }
  const seenRef = { current: {} as Record<string, unknown> }
  const writesRef = { current: [] as unknown[] }
  render(
    <NotesHost generate={generate} seenRef={seenRef} writesRef={writesRef} />
  )
  await waitFor(() =>
    expect(screen.getAllByRole("textbox", { name: "Body" })).toHaveLength(2)
  )
  const surface = screen.getAllByRole("textbox", { name: "Body" })[0]
  await act(async () => {
    surface.focus()
    const range = document.createRange()
    range.selectNodeContents(surface.querySelector("p")!)
    range.collapse(false)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event("selectionchange"))
  })
  const item = await screen.findByRole("menuitem", { name: /Ask AI to write/ })
  await act(async () => {
    fireEvent.click(item)
  })
  await waitFor(() => expect(generate.run).toHaveBeenCalledTimes(1))
  // Remove the target row and resolve in the same tick: the answer's
  // continuation runs as a microtask, before TipTap's destroy timer.
  act(() => {
    fireEvent.click(screen.getByTitle("Remove notes 1"))
    answer.resolve(answerDoc)
  })
  const afterRemoval = [{ itemId: "i1", body: frenchDoc }]
  const writesAfterRemoval = writesRef.current.length
  await act(async () => {})
  expect(seenRef.current.notes).toEqual(afterRemoval)
  expect(writesRef.current.length).toBe(writesAfterRemoval)
  expect(toast.error).toHaveBeenCalledWith(
    "This field changed, so the AI answer was not applied."
  )
})
