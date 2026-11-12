import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"
import { SimInspectorSection } from "./sim-inspector-section"

const key = "formulacms:simulator:inspector-sections:v1"

function Sections() {
  return (
    <>
      <SimInspectorSection
        name="character-style"
        label="Character style"
        headerExtras={<span>H3</span>}
      >
        <button>Strong</button>
      </SimInspectorSection>
      <SimInspectorSection name="paragraph-style" label="Paragraph style">
        <button>Paragraph</button>
      </SimInspectorSection>
    </>
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

test("sections start open without writing, persist independently and reload their choices", () => {
  const write = vi.spyOn(Storage.prototype, "setItem")
  const { unmount } = render(<Sections />)
  expect(write).not.toHaveBeenCalled()
  expect(
    screen.getByRole("button", { name: "Character style" })
  ).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByRole("button", { name: "Strong" })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Character style" }))
  expect(screen.queryByRole("button", { name: "Strong" })).toBeNull()
  expect(screen.getByRole("button", { name: "Paragraph" })).toBeVisible()
  expect(screen.getByText("H3")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Paragraph style" }))
  fireEvent.click(screen.getByRole("button", { name: "Character style" }))
  expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({
    "character-style": true,
    "paragraph-style": false,
  })
  unmount()
  write.mockClear()
  render(<Sections />)
  expect(write).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Strong" })).toBeVisible()
  expect(screen.queryByRole("button", { name: "Paragraph" })).toBeNull()
  expect(
    screen.getByRole("button", { name: "Paragraph style" })
  ).toHaveAttribute("aria-expanded", "false")
})

test("only boolean entries are restored and retained on the next intentional write", () => {
  window.localStorage.setItem(
    key,
    JSON.stringify({
      "character-style": false,
      "paragraph-style": "false",
      typography: true,
      pending: null,
    })
  )
  render(<Sections />)
  expect(screen.queryByRole("button", { name: "Strong" })).toBeNull()
  expect(screen.getByRole("button", { name: "Paragraph" })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Paragraph style" }))
  expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({
    "character-style": false,
    "paragraph-style": false,
    typography: true,
  })
})

test.each(["{", "[]", "null", "true"])(
  "invalid stored preferences %s fall back to open without writing",
  (stored) => {
    window.localStorage.setItem(key, stored)
    const write = vi.spyOn(Storage.prototype, "setItem")
    render(<Sections />)
    expect(screen.getByRole("button", { name: "Strong" })).toBeVisible()
    expect(write).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Character style" }))
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({
      "character-style": false,
    })
  }
)

test("a denied storage getter leaves disclosures usable", () => {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage")!
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("Storage denied")
    },
  })
  try {
    render(<Sections />)
    expect(screen.getByRole("button", { name: "Strong" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Character style" }))
    expect(screen.queryByRole("button", { name: "Strong" })).toBeNull()
  } finally {
    Object.defineProperty(window, "localStorage", original)
  }
})

test.each(["getItem", "setItem"] as const)(
  "a denied storage %s leaves disclosures usable",
  (method) => {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new Error("Storage denied")
    })
    render(<Sections />)
    expect(screen.getByRole("button", { name: "Strong" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Character style" }))
    expect(screen.queryByRole("button", { name: "Strong" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Character style" }))
    expect(screen.getByRole("button", { name: "Strong" })).toBeVisible()
  }
)
