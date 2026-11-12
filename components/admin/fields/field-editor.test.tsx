import { useState } from "react"
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, it, vi } from "vitest"
import { screen, fireEvent, act, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import type { Primitive } from "@/convex/lib/slices"
import {
  group,
  boolean as booleanField,
  date,
  datetime,
  number,
  select,
  link,
  list,
  relation,
  text,
  richText,
} from "@/convex/lib/slices/primitives"
import { validateStrict } from "@/convex/lib/richtext/strict"
import { readFieldText } from "@/convex/lib/richtext/transitions"
import { isStructuralListOperation } from "@/lib/editor-structure"
import { ConfirmProvider } from "@/components/providers/confirm-provider"
import { PageSaveRefusedError } from "@/components/admin/page-editor/lib/page-save-refused-error"
import { toast } from "sonner"
import { FieldsEditor } from "./field-editor"

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  reorder: null as ((from: number, to: number) => void) | null,
}))

vi.mock("convex/react", () => ({ useQuery: mocks.useQuery }))
vi.mock("@/lib/use-drag-reorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/use-drag-reorder")>()),
  useDragReorder: (reorder: (from: number, to: number) => void) => {
    mocks.reorder = reorder
    return { dragHandlers: () => ({}) }
  },
}))

// FieldsEditor is the descriptor-generic seam plan 029 C8 exposes: the same
// primitive walker that renders a slice's `primary` group now renders a
// content-type descriptor's shared/localized bags. These tests pin the
// interface guarantees the ContentTypeFieldsPanel and future non-slice
// descriptors (C10 testimonial / faq-item) rely on.

// A synthetic descriptor field map — deliberately mixed leaf + nested group
// + list so the tests exercise recursion at depth without dragging a whole
// descriptor into scope.
function makeMockFields(): Record<string, Primitive> {
  return {
    headline: text({ placeholder: "Headline" }),
    subtitle: text({ placeholder: "Subtitle" }).optional(),
    author: group({
      name: text({ placeholder: "Name" }),
      handle: text({ placeholder: "Handle" }).optional(),
    }),
    quotes: list(
      group({
        quote: text({ placeholder: "Quote text" }),
      })
    ).optional(),
  }
}

function faqTitleWithBreak(first: string, second: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 3 },
        content: [
          { type: "text", text: first },
          { type: "hardBreak" },
          { type: "text", text: second },
        ],
      },
    ],
  })
}

describe("FieldsEditor", () => {
  it("renders link primitives with the shared localized page picker", () => {
    const page = {
      _id: "page_services",
      slug: "services",
      localizedSlugs: { fr: "services-fr" },
      localizedTitles: { en: "Services", fr: "Services français" },
      status: "published",
      pageType: "page",
    }
    mocks.useQuery.mockImplementation((reference) => {
      const name = getFunctionName(reference)
      if (name === "cms/pages:listLinkablePages") return [page]
      if (name === "cms/pages:getLinkablePageSelection") {
        return { status: "available", page }
      }
      return undefined
    })

    render(
      <FieldsEditor
        fields={{ destination: link() }}
        value={{ destination: { type: "internal", pageId: "page_services" } }}
        onChange={() => {}}
        basePath="test"
        locale="fr"
      />
    )

    expect(
      screen.getByRole("button", { name: /services français/i })
    ).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "/services" })).toBeNull()
  })

  it("shows relation candidates with their resolved title, address and state, and searches by title", () => {
    const candidates = [
      {
        _id: "page_guide",
        slug: "guide",
        localizedSlugs: { fr: "guide-fr" },
        localizedTitles: { fr: "Le guide complet" },
        localePublicationStates: { fr: "draft" },
        status: "draft",
        pageType: "landing-page",
      },
      {
        _id: "page_cible",
        slug: "cible",
        localizedTitles: { fr: "Cible publiée" },
        localePublicationStates: { fr: "published" },
        status: "published",
        pageType: "landing-page",
      },
    ]
    mocks.useQuery.mockImplementation((reference) =>
      getFunctionName(reference) === "cms/pages:listRelationCandidates"
        ? candidates
        : undefined
    )

    render(
      <FieldsEditor
        fields={{ target: relation({ pageTypes: ["landing-page"] }) }}
        value={{}}
        onChange={() => {}}
        basePath="test"
        locale="fr"
      />
    )

    const guide = screen.getByRole("button", { name: /Le guide complet/ })
    expect(guide).toHaveTextContent("/guide-fr")
    expect(guide).toHaveTextContent("draft")
    expect(screen.getByRole("button", { name: /Cible publiée/ })).toHaveTextContent(
      "published"
    )

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "complet" },
    })
    expect(screen.getByRole("button", { name: /Le guide complet/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Cible publiée/ })).toBeNull()
  })

  it("renders one input per declared leaf field", () => {
    render(
      <FieldsEditor
        fields={{ headline: text(), subtitle: text().optional() }}
        value={{ headline: "hello", subtitle: "world" }}
        onChange={() => {}}
        basePath="test"
        locale="en"
      />
    )
    expect(screen.getByDisplayValue("hello")).toBeInTheDocument()
    expect(screen.getByDisplayValue("world")).toBeInTheDocument()
  })

  it("propagates edits through onChange with the full bag", () => {
    const onChange = vi.fn<(value: Record<string, unknown>) => void>()
    render(
      <FieldsEditor
        fields={{ headline: text(), subtitle: text().optional() }}
        value={{ headline: "before", subtitle: "kept" }}
        onChange={onChange}
        basePath="test"
        locale="en"
      />
    )
    fireEvent.change(screen.getByDisplayValue("before"), {
      target: { value: "after" },
    })
    expect(onChange).toHaveBeenCalledWith({
      headline: "after",
      subtitle: "kept",
    })
  })

  it("emits undefined for an optional field cleared to empty (clearing works)", () => {
    const onChange = vi.fn<(value: Record<string, unknown>) => void>()
    render(
      <FieldsEditor
        fields={{
          headline: text(),
          subtitle: text().optional(),
        }}
        value={{ headline: "kept", subtitle: "wipe me" }}
        onChange={onChange}
        basePath="test"
        locale="en"
      />
    )
    fireEvent.change(screen.getByDisplayValue("wipe me"), {
      target: { value: "" },
    })
    expect(onChange).toHaveBeenCalledWith({
      headline: "kept",
      subtitle: undefined,
    })
  })

  it("recurses into nested group / list primitives", () => {
    render(
      <FieldsEditor
        fields={makeMockFields()}
        value={{
          headline: "H",
          author: { name: "Ada", handle: "@ada" },
          quotes: [{ quote: "Q1" }, { quote: "Q2" }],
        }}
        onChange={() => {}}
        basePath="test"
        locale="en"
      />
    )
    // Leaf at root.
    expect(screen.getByDisplayValue("H")).toBeInTheDocument()
    // Leaves nested inside a group.
    expect(screen.getByDisplayValue("Ada")).toBeInTheDocument()
    expect(screen.getByDisplayValue("@ada")).toBeInTheDocument()
    // Leaves nested inside a list of groups.
    expect(screen.getByDisplayValue("Q1")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Q2")).toBeInTheDocument()
  })

  it("threads dir prop onto the wrapper (idiomatic HTML — inputs inherit direction)", () => {
    const { container } = render(
      <FieldsEditor
        fields={{ headline: text() }}
        value={{ headline: "بحث" }}
        onChange={() => {}}
        basePath="test"
        locale="ar"
        dir="rtl"
      />
    )
    const wrapper = container.firstElementChild
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveAttribute("dir", "rtl")
  })

  it("defaults dir to ltr when unspecified", () => {
    const { container } = render(
      <FieldsEditor
        fields={{ headline: text() }}
        value={{ headline: "hi" }}
        onChange={() => {}}
        basePath="test"
        locale="en"
      />
    )
    expect(container.firstElementChild).toHaveAttribute("dir", "ltr")
  })

  it("reads a registered FAQ title's stored break as a space in a single-line control", sliceProfile([]), () => {
    const onChange = vi.fn<(value: Record<string, unknown>) => void>()
    render(
      <ConfirmProvider>
        <FieldsEditor
          fields={{ question: text() }}
          value={{ question: faqTitleWithBreak("First", "Second") }}
          onChange={onChange}
          basePath="items.0"
          locale="en"
          sliceType="faq-simple"
        />
      </ConfirmProvider>
    )

    const question = screen.getByRole("textbox", { name: "Question" })
    expect(question.tagName).toBe("INPUT")
    expect(question).toHaveValue("First Second")
    fireEvent.change(question, { target: { value: "First edit Second" } })
    expect(onChange).toHaveBeenCalledWith({
      question: "First edit Second",
    })
  })

  it("keeps the adopted FAQ control unchanged and emits canonical literal questions", sliceProfile([]), () => {
    const onChange = vi.fn<(value: Record<string, unknown>) => void>()
    render(
      <ConfirmProvider>
        <FieldsEditor
          fields={{
            question: richText({
              contract: "title",
              heading: { role: "itemTitle", parent: "primary.heading" },
            }),
          }}
          value={{ question: faqTitleWithBreak("First", "Second") }}
          onChange={onChange}
          basePath="items.0"
          locale="fr"
          sliceType="faq-simple"
        />
      </ConfirmProvider>
    )
    const question = screen.getByRole("textbox", { name: "Question" })
    expect(question.tagName).toBe("INPUT")
    expect(question).toHaveValue("First Second")
    const literal = '{"type":"doc","content":[]} <b>Question?</b>'
    fireEvent.change(question, { target: { value: literal } })
    const value = onChange.mock.calls[0][0].question as string
    expect(validateStrict("title", value)).toEqual({ ok: true })
    expect(
      readFieldText(
        { sliceType: "faq-simple", fieldPath: "items[0].question" },
        value
      )
    ).toBe(literal)
  })

  it("keeps every typed space when a FAQ question is typed one key at a time", sliceProfile([]), () => {
    // Review P1 (2026-11-04): the controlled input gets the stored value back on
    // every key; a trimmed title turned "What is" into "Whatis".
    const fields = {
      question: richText({
        contract: "title",
        heading: { role: "itemTitle", parent: "primary.heading" },
      }),
    }
    function Controlled() {
      const [value, setValue] = useState<Record<string, unknown>>({ question: "" })
      return (
        <FieldsEditor
          fields={fields}
          value={value}
          onChange={setValue}
          basePath="items.0"
          locale="fr"
          sliceType="faq-simple"
        />
      )
    }
    render(
      <ConfirmProvider>
        <Controlled />
      </ConfirmProvider>
    )
    const typed = "What is it?"
    for (let at = 1; at <= typed.length; at += 1) {
      const question = screen.getByRole("textbox", { name: "Question" })
      fireEvent.change(question, {
        target: { value: (question as HTMLInputElement).value + typed[at - 1] },
      })
    }
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue(typed)
  })

  it("uses a single-line control when only the registered FAQ source has a hard break", sliceProfile([]), async () => {
    const onChange = vi.fn<(value: Record<string, unknown>) => void>()
    const run = vi.fn(async (value: string) => value)
    render(
      <ConfirmProvider>
        <FieldsEditor
          fields={{ question: text() }}
          value={{ question: "" }}
          sourceValues={{ question: faqTitleWithBreak("Source", "question") }}
          onChange={onChange}
          basePath="items.0"
          locale="fr"
          sliceType="faq-simple"
          translate={{
            sourceLocale: "en",
            supportsPlainText: true,
            supportsRichText: false,
            run,
          }}
        />
      </ConfirmProvider>
    )

    const question = screen.getByRole("textbox", { name: "Question" })
    expect(question.tagName).toBe("INPUT")
    fireEvent.click(screen.getByRole("button", { name: /translate/i }))
    await waitFor(() => {
      expect(run).toHaveBeenCalledWith("Source question", "text", {
        sliceType: "faq-simple",
        fieldPath: "items.0.question",
      })
      expect(onChange).toHaveBeenCalledWith({ question: "Source question" })
    })
  })

  it.each([
    ["a refused Save stays quiet", new PageSaveRefusedError(), 0],
    ["another failure still reports", new Error("route down"), 1],
  ])("translate: %s", sliceProfile([]), async (_name, failure, toasts) => {
    const toastError = vi.spyOn(toast, "error").mockReturnValue("")
    toastError.mockClear()
    const run = vi.fn(async () => {
      throw failure
    })
    render(
      <ConfirmProvider>
        <FieldsEditor
          fields={{ question: text() }}
          value={{ question: "" }}
          sourceValues={{ question: "Source" }}
          onChange={vi.fn()}
          basePath="items.0"
          locale="fr"
          sliceType="faq-simple"
          translate={{
            sourceLocale: "en",
            supportsPlainText: true,
            supportsRichText: false,
            run,
          }}
        />
      </ConfirmProvider>
    )
    vi.spyOn(console, "error").mockImplementation(() => {})
    fireEvent.click(screen.getByRole("button", { name: /translate/i }))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    await act(async () => {})
    expect(toastError).toHaveBeenCalledTimes(toasts)
    toastError.mockRestore()
  })

  it("tolerates an undefined value bag by treating it as empty (no throw)", () => {
    expect(() =>
      render(
        <FieldsEditor
          fields={{ headline: text().optional() }}
          value={undefined}
          onChange={() => {}}
          basePath="test"
          locale="en"
        />
      )
    ).not.toThrow()
  })
})

it("NEW carries an explicit structural signal through the real nested widget for identical primitive reorder", () => {
  const onChange = vi.fn()
  const original = { quotes: ["equal", "equal"] }
  render(
    <FieldsEditor
      fields={{ quotes: list(text()) }}
      value={original}
      onChange={onChange}
      basePath="primary"
      locale="en"
    />
  )
  act(() => mocks.reorder!(0, 1))
  const next = onChange.mock.calls[0][0]
  expect(JSON.stringify(next)).toBe(JSON.stringify(original))
  expect(isStructuralListOperation(next.quotes)).toBe(true)
  expect(next.quotes).not.toBe(original.quotes)
})

// Owner 2026-11-03/04: a title field is edited with the title contract. The
// field editor hands that contract to the rich-text editor, so Enter, paste and
// the toolbar follow it, while description fields keep today's behaviour.
describe("title and description rich-text fields", () => {
  const titleField = richText({ contract: "title", heading: { role: "sliceTitle" } })
  const basicField = richText({ contract: "basic" })

  it("a title field's toolbar has no Link button and Enter inserts nothing", async () => {
    const onChange = vi.fn<(value: Record<string, unknown>) => void>()
    render(
      <ConfirmProvider>
        <FieldsEditor
          fields={{ title: titleField }}
          value={{ title: "" }}
          onChange={onChange}
          basePath="primary"
          locale="en"
        />
      </ConfirmProvider>
    )
    const surface = await screen.findByRole("textbox")
    expect(screen.queryByTitle("Link")).toBeNull()
    expect(screen.getByTitle(/bold/i)).toBeInTheDocument()
    const editor = (surface as HTMLElement & { editor: import("@tiptap/core").Editor }).editor
    act(() => {
      editor.commands.insertContent("ab")
      editor.commands.setTextSelection(2)
    })
    fireEvent.keyDown(surface, { key: "Enter" })
    fireEvent.keyDown(surface, { key: "Enter", shiftKey: true })
    const json = JSON.stringify(editor.getJSON())
    expect(json.split('"hardBreak"').length - 1).toBe(0)
    expect(json.split('"type":"paragraph"').length - 1).toBe(1)
    expect(editor.state.doc.textContent).toBe("ab")
  })

  it("a description field keeps the Link button and paragraph Enter", async () => {
    render(
      <ConfirmProvider>
        <FieldsEditor
          fields={{ description: basicField }}
          value={{ description: "" }}
          onChange={vi.fn()}
          basePath="primary"
          locale="en"
        />
      </ConfirmProvider>
    )
    const surface = await screen.findByRole("textbox")
    expect(screen.getByTitle("Link")).toBeInTheDocument()
    const editor = (surface as HTMLElement & { editor: import("@tiptap/core").Editor }).editor
    act(() => {
      editor.commands.insertContent("ab")
      editor.commands.setTextSelection(2)
    })
    fireEvent.keyDown(surface, { key: "Enter" })
    expect(JSON.stringify(editor.getJSON()).split('"type":"paragraph"').length - 1).toBe(2)
  })
})


describe("ED3 editable draft identity and numbers", () => {
  it("R2 keeps missing and duplicate row DOM identity through first edit and reorder", () => {
    const original = [{ name: "Missing" }, { itemId: "dup", name: "First" }, { itemId: "dup", name: "Second" }]
    let saved: Record<string, unknown> = {}
    function Harness() {
      const [value, setValue] = useState({ rows: original })
      return <FieldsEditor fields={{ rows: list(group({ name: text({ placeholder: "Row name" }) })) }} value={value} onChange={(next) => { saved = next; setValue(next as typeof value) }} basePath="primary" locale="en" />
    }
    render(<Harness />)
    const rows = screen.getAllByPlaceholderText("Row name")
    rows[0].focus()
    fireEvent.change(rows[0], { target: { value: "Edited" } })
    expect(screen.getByDisplayValue("Edited")).toBe(rows[0])
    expect(document.activeElement).toBe(rows[0])
    expect((saved.rows as Array<{ itemId: string }>)[0].itemId).toBeTruthy()
    act(() => mocks.reorder!(1, 2))
    expect(screen.getByDisplayValue("First")).toBe(rows[1])
    expect(screen.getByDisplayValue("Second")).toBe(rows[2])
    fireEvent.change(rows[2], { target: { value: "Second edited" } })
    expect(screen.getByDisplayValue("Second edited")).toBe(rows[2])
    expect(original).toEqual([{ name: "Missing" }, { itemId: "dup", name: "First" }, { itemId: "dup", name: "Second" }])
  })

  it.each([false, true])("number buffers empty input until blur (optional=%s) and never emits NaN", (optional) => {
    const writes: unknown[] = []
    function Harness() {
      const [value, setValue] = useState<Record<string, unknown>>({ amount: 12 })
      const def = number({ default: 7, step: 0.1 })
      return <FieldsEditor fields={{ amount: optional ? def.optional() : def }} value={value} onChange={(next) => { writes.push(next.amount); setValue(next) }} basePath="primary" locale="en" />
    }
    render(<Harness />)
    const input = screen.getByRole("spinbutton")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "" } })
    expect(input).toHaveValue(null)
    expect(writes).toEqual([])
    fireEvent.change(input, { target: { value: "-1.5" } })
    expect(writes).toEqual([-1.5])
    fireEvent.change(input, { target: { value: "" } })
    expect(writes).toEqual([-1.5])
    fireEvent.blur(input)
    expect(writes).toEqual([-1.5, optional ? undefined : 7])
    expect(writes.some((value) => typeof value === "number" && Number.isNaN(value))).toBe(false)
  })
})


it("R2 accepts absent optional lists and re-renders without a repair loop", () => {
  const fields = { rows: list(group({ name: text() })).optional() }
  expect(() => {
    const view = render(<FieldsEditor fields={fields} value={undefined} onChange={() => {}} basePath="primary" locale="en" />)
    view.rerender(<FieldsEditor fields={fields} value={{}} onChange={() => {}} basePath="primary" locale="en" />)
  }).not.toThrow()
})


it.each(["-", "1.", "NaN", "Infinity"])("number treats native-sanitized incomplete %s as local input until blur", (raw) => {
  const writes = vi.fn()
  render(<FieldsEditor fields={{ amount: number({ default: 7 }) }} value={{ amount: 12 }} onChange={writes} basePath="primary" locale="en" />)
  const input = screen.getByRole("spinbutton")
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: raw } })
  expect(writes).not.toHaveBeenCalled()
  expect(input).toHaveValue(null)
  fireEvent.blur(input)
  expect(writes).toHaveBeenCalledWith({ amount: 7 })
})


it("R6/R7 fields link stable native labels, selects and the rich-text editable name", async () => {
  const fields = { headline: text(), summary: text({ multiline: true }), amount: number({ default: 0 }), date: date(), timestamp: datetime(), choice: select({ options: ["one", "two"], default: "one" }), destination: link(), body: richText({ profile: "basic" }) }
  const value = { headline: "Text", summary: "Summary", amount: 1, date: "2026-11-08", timestamp: "2026-11-08T12:00:00Z", choice: "one", destination: { type: "none" }, body: "" }
  const view = render(<ConfirmProvider><FieldsEditor fields={fields} value={value} onChange={() => {}} basePath="primary" locale="en" /></ConfirmProvider>)
  const input = view.getByRole("textbox", { name: "Headline" })
  const label = Array.from(view.container.querySelectorAll("label")).find((node) => node.textContent === "Headline")!
  expect(label.htmlFor).toBeTruthy()
  expect(label.htmlFor).toBe(input.id)
  expect(view.getByRole("combobox", { name: "Choice" })).toBeInTheDocument()
  expect(view.getByRole("combobox", { name: "Destination" })).toBeInTheDocument()
  const rich = await view.findByRole("textbox", { name: "Body" })
  expect(rich).toHaveAttribute("aria-multiline", "true")
  expect(rich).toHaveAccessibleName("Body")
  const nativeControls = view.container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")
  expect(nativeControls).toHaveLength(7)
  for (const control of nativeControls) {
    expect(control.labels).toHaveLength(1)
    expect(control.closest("label")).toBeNull()
  }
  const id = input.id
  view.rerender(<ConfirmProvider><FieldsEditor fields={fields} value={value} onChange={() => {}} basePath="primary" locale="en" /></ConfirmProvider>)
  expect(view.getByRole("textbox", { name: "Headline" }).id).toBe(id)
})


it("R7 both native select surfaces reuse their visible field names", () => {
  const view = render(<FieldsEditor fields={{ choice: select({ options: ["one", "two"], default: "one" }), destination: link() }} value={{ choice: "one", destination: { type: "none" } }} onChange={() => {}} basePath="primary" locale="en" />)
  expect(view.getByRole("combobox", { name: "Choice" })).toBeInTheDocument()
  expect(view.getByRole("combobox", { name: "Destination" })).toBeInTheDocument()
})


it.each([
  ["default", {}],
  ["custom with description", { label: "Promote to front", description: "Shown first" }],
])("R6 boolean %s label names its checkbox exactly once", (_case, config) => {
  const fields = { featured: booleanField({ default: false, ...config }) }
  const view = render(<FieldsEditor fields={fields} value={{ featured: false }} onChange={() => {}} basePath="primary" locale="en" />)
  const checkbox = view.getByRole("checkbox") as HTMLInputElement
  if (_case === "default") {
    expect(checkbox).toHaveAccessibleName("Featured")
  } else {
    // dom-accessibility-api 0.6.3 accessible-name-and-description.js:258–261: the separator depends on computed display; jsdom has no Tailwind CSS.
    expect(checkbox).toHaveAccessibleName(/^Promote to front\s?Shown first$/)
  }
  expect(checkbox.labels).toHaveLength(1)
  expect(view.getByRole("group", { name: "Featured" })).toContainElement(checkbox)
})
