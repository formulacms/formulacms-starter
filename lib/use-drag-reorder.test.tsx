import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { expect, test } from "vitest"
import { moveItem, useDragReorder } from "./use-drag-reorder"

function Harness() {
  const [items, setItems] = useState(["One", "Two", "Three"])
  const drag = useDragReorder(
    (from, to) => setItems(moveItem(items, from, to)),
    {
      count: items.length,
      announce: (action, from, to) => `${action}:${from}:${to}`,
    }
  )
  return (
    <>
      <p>{items.join(",")}</p>
      <div role="status">{drag.announcement}</div>
      {items.map((item, index) => (
        <button key={item} {...drag.keyboardHandlers(index)}>
          {item}
        </button>
      ))}
    </>
  )
}

test("keyboard move previews, drops once, and preserves focus on the moved handle", () => {
  render(<Harness />)
  const handle = screen.getByRole("button", { name: "One" })
  handle.focus()
  fireEvent.keyDown(handle, { key: " " })
  expect(handle).toHaveAttribute("aria-pressed", "true")
  fireEvent.keyDown(handle, { key: "ArrowDown" })
  expect(screen.getByRole("status")).toHaveTextContent("movePosition:0:1")
  expect(screen.getByText("One,Two,Three")).toBeTruthy()
  fireEvent.keyDown(handle, { key: " " })
  expect(screen.getByText("Two,One,Three")).toBeTruthy()
  expect(screen.getByRole("status")).toHaveTextContent("drop:0:1")
  expect(handle).toHaveFocus()
})

test("keyboard cancel and boundary moves leave the original list unchanged", () => {
  render(<Harness />)
  const handle = screen.getByRole("button", { name: "One" })
  fireEvent.keyDown(handle, { key: " " })
  fireEvent.keyDown(handle, { key: "ArrowUp" })
  expect(screen.getByRole("status")).toHaveTextContent("movePosition:0:0")
  fireEvent.keyDown(handle, { key: "ArrowDown" })
  fireEvent.keyDown(handle, { key: "Escape" })
  expect(screen.getByText("One,Two,Three")).toBeTruthy()
  expect(screen.getByRole("status")).toHaveTextContent("cancel:0:0")
})
