// DATA-LOSS-FIXES case 1, phase A: a late AI answer must not erase or revert a
// value the owner did not touch. These run through the real ContentTypeFieldsPanel
// with a stateful parent wired like page-editor.tsx (`onLocalizedChange` /
// `onSharedChange` receive the full bag and replace state with it).
import { useLayoutEffect, useState } from "react"
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import { group, list, text } from "@/convex/lib/blocks/primitives"
import type { DescriptorFieldMap } from "@/convex/lib/contentTypes"
import type { AdminContentType } from "@/lib/admin/content-types"
import type { FieldGenerate } from "./fields/field-editor"
import { ContentTypeFieldsPanel } from "./content-type-fields-panel"
import { toast } from "sonner"

const FIELD_CHANGED = "This field changed, so the AI answer was not applied."

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

function lateGenerate() {
  const answer = deferred<string>()
  const generate: FieldGenerate = {
    run: vi.fn(() => answer.promise),
    runRefine: vi.fn(() => answer.promise),
    runBlock: vi.fn(),
  }
  return { generate, answer }
}

type Bags = {
  shared: Record<string, unknown>
  localized: Record<string, unknown>
}

/** The page editor's wiring: the setter receives the full bag (no merge). */
function Host({
  fields,
  initial,
  generate,
  seenRef,
}: {
  fields: { sharedFields: DescriptorFieldMap; localizedFields: DescriptorFieldMap }
  initial: Bags
  generate: FieldGenerate
  seenRef: { current: Bags }
}) {
  const [shared, setShared] = useState(initial.shared)
  const [localized, setLocalized] = useState(initial.localized)
  useLayoutEffect(() => {
    seenRef.current = { shared, localized }
  })
  return (
    <ContentTypeFieldsPanel
      contentType={testimonial}
      sharedValues={shared}
      localizedValues={localized}
      onSharedChange={setShared}
      onLocalizedChange={setLocalized}
      currentLocale="en"
      generate={generate}
      descriptorOverride={fields}
    />
  )
}

function mount(
  fields: { sharedFields: DescriptorFieldMap; localizedFields: DescriptorFieldMap },
  initial: Bags
) {
  const late = lateGenerate()
  const seenRef = { current: initial }
  render(
    <Host fields={fields} initial={initial} generate={late.generate} seenRef={seenRef} />
  )
  return { ...late, seenRef }
}

async function clickWriteAndWait(button: HTMLElement, generate: FieldGenerate) {
  await act(async () => {
    fireEvent.click(button)
  })
  await waitFor(() => expect(generate.run).toHaveBeenCalledTimes(1))
}

function fieldGroup(label: string) {
  return screen.getByRole("group", { name: label })
}

beforeEach(() => {
  mocks.confirm.mockReset().mockResolvedValue(true)
  mocks.prompt.mockReset().mockResolvedValue("a short brief")
})
afterEach(() => vi.clearAllMocks())

describe("late AI answer, page-level localized fields (test 1)", () => {
  it("keeps a sibling typed during the request and writes the answer to its own field", async () => {
    const { generate, answer, seenRef } = mount(
      {
        sharedFields: {},
        localizedFields: { alpha: text(), beta: text() },
      },
      { shared: {}, localized: { alpha: "", beta: "" } }
    )
    await clickWriteAndWait(
      within(fieldGroup("Alpha")).getByRole("button", { name: "Write" }),
      generate
    )
    fireEvent.change(screen.getByRole("textbox", { name: "Beta" }), {
      target: { value: "typed by the owner" },
    })
    expect(seenRef.current.localized.beta).toBe("typed by the owner")
    await act(async () => answer.resolve("AI answer"))
    expect(seenRef.current.localized.alpha).toBe("AI answer")
    // Correct behavior: the late answer must not revert Beta.
    expect(seenRef.current.localized.beta).toBe("typed by the owner")
    expect(screen.getByRole("textbox", { name: "Beta" })).toHaveValue("typed by the owner")
  })
})

describe("late AI answer, shared chip toolbar (test 1, chip path)", () => {
  it("keeps a sibling chip typed during the request", async () => {
    const { generate, answer, seenRef } = mount(
      {
        sharedFields: { alpha: text(), beta: text() },
        localizedFields: {},
      },
      { shared: { alpha: "", beta: "" }, localized: {} }
    )
    // Chips have no role=group; the chip's input carries aria-label.
    const alphaChip = screen.getByLabelText("Alpha").parentElement!
    await clickWriteAndWait(
      within(alphaChip).getByRole("button", { name: "Write" }),
      generate
    )
    fireEvent.change(screen.getByLabelText("Beta"), {
      target: { value: "typed by the owner" },
    })
    await act(async () => answer.resolve("AI answer"))
    expect(seenRef.current.shared.alpha).toBe("AI answer")
    expect(seenRef.current.shared.beta).toBe("typed by the owner")
  })
})

describe("late AI answer, page-level list (test 2)", () => {
  const fields = {
    sharedFields: {},
    localizedFields: { highlights: list(group({ label: text() })) },
  }
  const initial = (): Bags => ({
    shared: {},
    localized: {
      highlights: [
        { itemId: "i0", label: "first" },
        { itemId: "i1", label: "second" },
      ],
    },
  })
  function itemWriteButton(index: number) {
    // Each list row holds one group "Label"; pick the nth row's Write.
    const groups = screen.getAllByRole("group", { name: "Label" })
    return within(groups[index]).getByRole("button", { name: "Write" })
  }
  function highlights(seenRef: { current: Bags }) {
    return seenRef.current.localized.highlights as Array<Record<string, unknown>>
  }

  it("removing a different item during the request does not bring it back", async () => {
    const { generate, answer, seenRef } = mount(fields, initial())
    await clickWriteAndWait(itemWriteButton(0), generate)
    fireEvent.click(screen.getByTitle("Remove highlights 2"))
    expect(highlights(seenRef)).toEqual([{ itemId: "i0", label: "first" }])
    await act(async () => answer.resolve("AI answer"))
    expect(highlights(seenRef)).toEqual([{ itemId: "i0", label: "AI answer" }])
  })

  it("removing the target item during the request writes nowhere and restores nothing", async () => {
    const { generate, answer, seenRef } = mount(fields, initial())
    await clickWriteAndWait(itemWriteButton(0), generate)
    fireEvent.click(screen.getByTitle("Remove highlights 1"))
    expect(highlights(seenRef)).toEqual([{ itemId: "i1", label: "second" }])
    await act(async () => answer.resolve("AI answer"))
    expect(highlights(seenRef)).toEqual([{ itemId: "i1", label: "second" }])
  })

  it("reordering during the request keeps the new order and lands on the same item", async () => {
    const { generate, answer, seenRef } = mount(fields, initial())
    await clickWriteAndWait(itemWriteButton(0), generate)
    const rows = document.querySelectorAll<HTMLElement>("[draggable='true']")
    fireEvent.dragStart(rows[0])
    fireEvent.dragEnter(rows[1])
    fireEvent.drop(rows[1])
    expect(highlights(seenRef).map((item) => item.itemId)).toEqual(["i1", "i0"])
    await act(async () => answer.resolve("AI answer"))
    expect(highlights(seenRef)).toEqual([
      { itemId: "i1", label: "second" },
      { itemId: "i0", label: "AI answer" },
    ])
  })

  it("editing a sibling item during the request keeps that edit", async () => {
    const { generate, answer, seenRef } = mount(fields, initial())
    await clickWriteAndWait(itemWriteButton(0), generate)
    const labels = screen.getAllByRole("textbox", { name: "Label" })
    fireEvent.change(labels[1], { target: { value: "second, edited" } })
    await act(async () => answer.resolve("AI answer"))
    expect(highlights(seenRef)).toEqual([
      { itemId: "i0", label: "AI answer" },
      { itemId: "i1", label: "second, edited" },
    ])
  })
})

// Phase B: a language switch while a field answer is in flight. The host keeps
// only the active language's bag in state, like the page editor.
function LocaleHost({
  generate,
  french,
  seenRef,
}: {
  generate: FieldGenerate
  french: Record<string, unknown>
  seenRef: { current: { locale: string; localized: Record<string, unknown> } }
}) {
  const [locale, setLocale] = useState<"en" | "fr">("en")
  const [localized, setLocalized] = useState<Record<string, unknown>>({
    alpha: "",
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
          setLocalized(french)
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
          localizedFields: { alpha: text(), beta: text() },
        }}
      />
    </>
  )
}

describe("late AI answer, language switch (phase B)", () => {
  it.each([
    ["French values differ", { alpha: "Alpha FR", beta: "Bêta FR" }],
    ["French values equal English (both empty)", { alpha: "", beta: "" }],
  ])("an English answer does not land in French (%s)", async (_name, french) => {
    const { generate, answer } = lateGenerate()
    const seenRef = {
      current: { locale: "en", localized: {} as Record<string, unknown> },
    }
    render(<LocaleHost generate={generate} french={french} seenRef={seenRef} />)
    await clickWriteAndWait(
      within(fieldGroup("Alpha")).getByRole("button", { name: "Write" }),
      generate
    )
    fireEvent.click(screen.getByRole("button", { name: "Switch to French" }))
    expect(seenRef.current.locale).toBe("fr")
    await act(async () => answer.resolve("English AI answer"))
    expect(seenRef.current.localized).toEqual(french)
  })
})

describe("late AI answer, guards (phase B)", () => {
  it("drops the answer with a toast when the owner edited the same field", async () => {
    const { generate, answer, seenRef } = mount(
      { sharedFields: {}, localizedFields: { alpha: text(), beta: text() } },
      { shared: {}, localized: { alpha: "", beta: "" } }
    )
    await clickWriteAndWait(
      within(fieldGroup("Alpha")).getByRole("button", { name: "Write" }),
      generate
    )
    fireEvent.change(screen.getByRole("textbox", { name: "Alpha" }), {
      target: { value: "typed by the owner" },
    })
    await act(async () => answer.resolve("AI answer"))
    expect(seenRef.current.localized.alpha).toBe("typed by the owner")
    expect(toast.error).toHaveBeenCalledWith(FIELD_CHANGED)
  })

  it("applies the answer with no toast when nothing else changed", async () => {
    const { generate, answer, seenRef } = mount(
      { sharedFields: {}, localizedFields: { alpha: text(), beta: text() } },
      { shared: {}, localized: { alpha: "", beta: "" } }
    )
    await clickWriteAndWait(
      within(fieldGroup("Alpha")).getByRole("button", { name: "Write" }),
      generate
    )
    await act(async () => answer.resolve("AI answer"))
    expect(seenRef.current.localized).toEqual({ alpha: "AI answer", beta: "" })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("a language switch drops the answer with the toast", async () => {
    const { generate, answer } = lateGenerate()
    const seenRef = {
      current: { locale: "en", localized: {} as Record<string, unknown> },
    }
    render(
      <LocaleHost
        generate={generate}
        french={{ alpha: "", beta: "" }}
        seenRef={seenRef}
      />
    )
    await clickWriteAndWait(
      within(fieldGroup("Alpha")).getByRole("button", { name: "Write" }),
      generate
    )
    fireEvent.click(screen.getByRole("button", { name: "Switch to French" }))
    await act(async () => answer.resolve("English AI answer"))
    expect(toast.error).toHaveBeenCalledWith(FIELD_CHANGED)
  })

  it("removing the target item drops the answer with the toast", async () => {
    const { generate, answer, seenRef } = mount(
      {
        sharedFields: {},
        localizedFields: { highlights: list(group({ label: text() })) },
      },
      {
        shared: {},
        localized: {
          highlights: [
            { itemId: "i0", label: "first" },
            { itemId: "i1", label: "second" },
          ],
        },
      }
    )
    const rows = screen.getAllByRole("group", { name: "Label" })
    await clickWriteAndWait(
      within(rows[0]).getByRole("button", { name: "Write" }),
      generate
    )
    fireEvent.click(screen.getByTitle("Remove highlights 1"))
    await act(async () => answer.resolve("AI answer"))
    expect(seenRef.current.localized.highlights).toEqual([
      { itemId: "i1", label: "second" },
    ])
    expect(toast.error).toHaveBeenCalledWith(FIELD_CHANGED)
  })

  it.each([
    [
      "group items with equal values",
      list(group({ label: text() })),
      [
        { itemId: "i0", label: "same" },
        { itemId: "i1", label: "same" },
      ],
      [
        { itemId: "i1", label: "same" },
        { itemId: "i0", label: "AI answer" },
      ],
    ],
    [
      "plain text items with equal values",
      list(text()),
      ["same", "same"],
      ["same", "AI answer"],
    ],
  ])(
    "reorder with %s: the answer lands on the clicked item",
    async (_name, def, items, expected) => {
      const { generate, answer, seenRef } = mount(
        { sharedFields: {}, localizedFields: { highlights: def } },
        { shared: {}, localized: { highlights: items } }
      )
      const writes = screen.getAllByRole("button", { name: "Write" })
      expect(writes).toHaveLength(2)
      await clickWriteAndWait(writes[0], generate)
      const rows = document.querySelectorAll<HTMLElement>("[draggable='true']")
      fireEvent.dragStart(rows[0])
      fireEvent.dragEnter(rows[1])
      fireEvent.drop(rows[1])
      await act(async () => answer.resolve("AI answer"))
      // The second item (originally at index 1) was not written; the clicked
      // item moved to index 1 and carries the answer.
      expect(seenRef.current.localized.highlights).toEqual(expected)
      expect(toast.error).not.toHaveBeenCalled()
    }
  )
})
