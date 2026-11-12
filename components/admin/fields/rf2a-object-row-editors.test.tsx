import { useState } from "react"
import { act, fireEvent, screen } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import { group, image, link, list, relation, text, type Primitive } from "@/convex/lib/slices/primitives"
import { FieldsEditor } from "./field-editor"

vi.mock("./relation-picker", () => ({
  RelationPicker: ({ onChange }: { onChange: (value: unknown) => void }) => (
    <div>
      <button
        type="button"
        onClick={() => onChange({ pageId: "new-author", itemId: "incoming" })}
      >
        Replace relation
      </button>
      <button type="button" onClick={() => onChange(undefined)}>
        Clear relation
      </button>
    </div>
  ),
}))

vi.mock("./image-field-editor", () => ({
  ImageFieldEditor: ({
    onChange,
    value,
  }: {
    onChange: (value: unknown) => void
    value: { url?: string } | undefined
  }) => (
    <div data-testid="mock-image" data-url={value?.url}>
      <button
        type="button"
        onClick={() => onChange({ url: "/new.png", alt: "New image" })}
      >
        Replace image
      </button>
      <button type="button" onClick={() => onChange(undefined)}>
        Clear image
      </button>
    </div>
  ),
}))

describe("RF2a object-row editor identity", () => {
  test("relation replacement retains the row itemId", () => {
    const onChange = vi.fn()
    const original = { authorIds: [{ itemId: "relation-row", pageId: "old" }] }
    render(
      <FieldsEditor
        fields={{ authorIds: list(relation({ pageTypes: ["author"] })) }}
        value={original}
        onChange={onChange}
        basePath="shared"
        locale="en"
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Replace relation" }))
    expect(onChange).toHaveBeenCalledWith({
      authorIds: [{ pageId: "new-author", itemId: "relation-row" }],
    })
    expect(original.authorIds[0]).toEqual({
      itemId: "relation-row",
      pageId: "old",
    })
  })

  test("clearing a relation retains an otherwise-empty identified row", () => {
    const onChange = vi.fn()
    render(
      <FieldsEditor
        fields={{ authorIds: list(relation({ pageTypes: ["author"] })) }}
        value={{ authorIds: [{ itemId: "relation-row", pageId: "old" }] }}
        onChange={onChange}
        basePath="shared"
        locale="en"
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Clear relation" }))
    expect(onChange).toHaveBeenCalledWith({
      authorIds: [{ itemId: "relation-row" }],
    })
  })

  test("image replacement retains row identity without retaining old image data", () => {
    const onChange = vi.fn()
    const original = {
      images: [{ itemId: "image-row", url: "/old.png", alt: "Old image" }],
    }
    render(
      <FieldsEditor
        fields={{ images: list(image()) }}
        value={original}
        onChange={onChange}
        basePath="shared"
        locale="en"
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Replace image" }))
    expect(onChange).toHaveBeenCalledWith({
      images: [{ itemId: "image-row", url: "/new.png", alt: "New image" }],
    })
    expect(original.images[0]?.url).toBe("/old.png")
  })

  test("clearing an image keeps only the existing row identity", () => {
    const onChange = vi.fn()
    render(
      <FieldsEditor
        fields={{ images: list(image()) }}
        value={{ images: [{ itemId: "image-row", url: "/old.png" }] }}
        onChange={onChange}
        basePath="shared"
        locale="en"
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Clear image" }))
    expect(onChange).toHaveBeenCalledWith({ images: [{ itemId: "image-row" }] })
  })

  test("clearing an ID-less image row keeps later image rows mounted", () => {
    const onChange = vi.fn()
    const fields = { images: list(image()) }
    const original = {
      images: [
        { url: "/old.png" },
        { url: "/remaining.png" },
        { itemId: "identified-image", url: "/identified.png" },
      ],
    }
    const editor = render(
      <FieldsEditor
        fields={fields}
        value={original}
        onChange={onChange}
        basePath="shared"
        locale="en"
      />
    )

    const before = screen.getAllByTestId("mock-image")
    const remainingNodes = before.slice(1)
    fireEvent.click(screen.getAllByRole("button", { name: "Clear image" })[0]!)

    expect(onChange).toHaveBeenLastCalledWith({
      images: [
        { itemId: expect.any(String) },
        { url: "/remaining.png" },
        { itemId: "identified-image", url: "/identified.png" },
      ],
    })
    const emitted = onChange.mock.lastCall?.[0]
    expect(emitted).toEqual({
      images: [
        { itemId: expect.any(String) },
        { url: "/remaining.png" },
        { itemId: "identified-image", url: "/identified.png" },
      ],
    })

    editor.rerender(
      <FieldsEditor
        fields={fields}
        value={emitted}
        onChange={onChange}
        basePath="shared"
        locale="en"
      />
    )

    const after = screen.getAllByTestId("mock-image")
    expect(after).toHaveLength(3)
    expect(after.map((node) => node.getAttribute("data-url"))).toEqual([
      null,
      "/remaining.png",
      "/identified.png",
    ])
    expect(after[1]).toBe(remainingNodes[0])
    expect(after[2]).toBe(remainingNodes[1])
    expect(original.images).toEqual([
      { url: "/old.png" },
      { url: "/remaining.png" },
      { itemId: "identified-image", url: "/identified.png" },
    ])
  })
})


const controls = vi.hoisted(() => ({ reorder: null as ((from: number, to: number) => void) | null }))
vi.mock("convex/react", () => ({ useQuery: () => undefined }))
vi.mock("@/lib/use-drag-reorder", async (original) => ({
  ...(await original<typeof import("@/lib/use-drag-reorder")>()),
  useDragReorder: (reorder: typeof controls.reorder) => { controls.reorder = reorder; return { dragHandlers: () => ({}) } },
}))

const rowCases: Array<{ name: string; def: Primitive; row: Record<string, unknown> }> = [
  { name: "group", def: group({ name: text() }), row: { name: "old" } },
  { name: "image", def: image().optional(), row: { url: "old", alt: "kept" } },
  { name: "link", def: link(), row: { type: "external", url: "old" } },
  { name: "relation", def: relation({ pageTypes: ["page"] }).optional(), row: { pageId: "old" } },
]

test.each(rowCases)("R2 $name: first edit/clear keeps focus, identity, reorder and JSON round trip", ({ def, row, name }) => {
  let saved: Record<string, unknown> = {}
  function Harness() {
    const [value, setValue] = useState<Record<string, unknown>>({ rows: [row, { ...row, itemId: "same" }, { ...row, itemId: "same" }] })
    return <FieldsEditor fields={{ rows: list(def) }} value={value} onChange={(v) => { saved = v; setValue(v) }} basePath="primary" locale="en" />
  }
  const view = render(<Harness />)
  const pickControls = () => name === "image" || name === "relation"
    ? screen.getAllByRole("button", { name: `Clear ${name}` })
    : Array.from(view.container.querySelectorAll<HTMLInputElement>("input"))
  const before = pickControls()
  before[0].focus()
  if (name === "image" || name === "relation") fireEvent.click(before[0])
  else fireEvent.change(before[0], { target: { value: "new" } })
  const edited = saved.rows as Array<Record<string, unknown>>
  expect(edited[0].itemId).toBeTruthy()
  expect(document.activeElement).toBe(before[0])
  expect(pickControls()[0]).toBe(before[0])
  if (name === "image" || name === "relation") expect(Object.keys(edited[0])).toEqual(["itemId"])
  const serialized = JSON.stringify(saved)
  expect(JSON.parse(serialized)).toEqual(saved)
  act(() => controls.reorder!(1, 2))
  expect(pickControls()).toEqual([before[0], before[2], before[1]])
  const id = (saved.rows as Array<Record<string, unknown>>)[0].itemId
  view.unmount()
  const restored = JSON.parse(serialized)
  const reloaded = render(<FieldsEditor fields={{ rows: list(def) }} value={restored} onChange={(v) => { saved = v }} basePath="primary" locale="en" />)
  if (name === "group" || name === "link") expect(reloaded.container.querySelector("input")).toHaveValue("new")
  if (name === "image") expect(screen.getAllByTestId("mock-image")[0]).not.toHaveAttribute("data-url")
  expect((restored.rows as Array<Record<string, unknown>>)[0].itemId).toBe(id)
  expect(row).not.toHaveProperty("itemId")
})
