import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"
const mock = vi.hoisted(() => ({
  contract: "title",
  block: "heading",
  headingLevel: 2 as number | null,
  command: vi.fn(),
  headingResult: undefined as string | undefined,
  subheadingResult: undefined as string | undefined,
}))
vi.mock("./visual-tweak-store", () => ({
  useVisualTweak: () => ({
    mode: "edit",
    activeText: {
      field: { path: "primary.title", contract: mock.contract },
      block: mock.block,
      headingLevel: mock.headingLevel,
      headingResult: mock.headingResult,
      subheadingResult: mock.subheadingResult,
      marks: [],
    },
    formatSample: mock.command,
  }),
}))
import { SimTextFormatting, SimTypographyBadge } from "./sim-text-formatting"
import { SimInspectorSection } from "./sim-inspector-section"

function Typography() {
  return (
    <SimInspectorSection
      name="typography"
      label="Typography"
      headerExtras={<SimTypographyBadge />}
    >
      <SimTextFormatting />
    </SimInspectorSection>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  mock.contract = "title"
  mock.block = "heading"
  mock.headingLevel = 2
  mock.headingResult = undefined
  mock.subheadingResult = undefined
  mock.command.mockClear()
})
test("titles expose semantic marks and a real heading badge, without body or link controls", () => {
  mock.contract = "title"
  mock.block = "heading"
  mock.headingLevel = 2
  mock.command.mockClear()
  render(
    <>
      <input aria-label="Retained focus" />
      <Typography />
    </>
  )
  expect(screen.getByLabelText("Current text block H2")).toHaveTextContent("H2")
  const typography = screen.getByRole("region", { name: "Typography" })
  const character = within(typography).getByRole("region", {
    name: "Character style",
  })
  expect(
    within(character).getByRole("button", { name: "Strong" })
  ).toBeVisible()
  expect(screen.queryByRole("region", { name: "Paragraph style" })).toBeNull()
  expect(
    screen.queryByRole("heading", { name: "Text" })
  ).toBeNull()
  expect(screen.queryByRole("radiogroup", { name: "Text block" })).toBeNull()
  const emphasis = screen.getByRole("button", { name: "Emphasis" })
  expect(emphasis.querySelector("em")).toHaveTextContent("em")
  expect(emphasis).toHaveAttribute("title", "Emphasis (<em>)")
  fireEvent.click(emphasis)
  expect(mock.command).toHaveBeenCalledWith("italic")
  fireEvent.click(screen.getByRole("button", { name: "Strong" }))
  expect(mock.command).toHaveBeenCalledWith("bold")
  const input = screen.getByLabelText("Retained focus")
  input.focus()
  const more = screen.getByRole("button", { name: "More text formatting" })
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
  fireEvent(more, down)
  expect(down.defaultPrevented).toBe(true)
  fireEvent.click(more)
  expect(document.activeElement).toBe(input)
  for (const [label, command] of [
    ["Strikethrough", "strike"],
    ["Underline", "underline"],
    ["Highlight", "highlight"],
    ["Subscript", "subscript"],
    ["Superscript", "superscript"],
  ]) {
    const control = screen.getByRole("button", { name: label })
    expect(control).toBeVisible()
    fireEvent.click(control)
    expect(mock.command).toHaveBeenCalledWith(command)
  }
  expect(screen.queryByRole("button", { name: /link/i })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Line break" }))
  expect(mock.command).toHaveBeenCalledWith("lineBreak")
})
test("plain labels have no toolbar; actual basic bodies offer relative structure", () => {
  mock.contract = "plain"
  const { rerender } = render(<Typography />)
  expect(screen.queryByRole("region", { name: "Character style" })).toBeNull()
  expect(screen.queryByRole("region", { name: "Paragraph style" })).toBeNull()
  expect(screen.queryByLabelText("Current text block H2")).toBeNull()
  mock.contract = "basic"
  mock.block = "paragraph"
  mock.headingLevel = null
  rerender(<Typography />)
  expect(screen.getByLabelText("Current text block P")).toHaveTextContent("P")
  expect(
    screen.getByRole("region", { name: "Paragraph style" })
  ).toContainElement(screen.getByRole("radiogroup", { name: "Text block" }))
  for (const label of [
    "Paragraph",
    "Bullets",
    "Numbering",
    "Heading",
    "Subheading",
  ])
    expect(screen.getByRole("radio", { name: label })).toBeVisible()
  fireEvent.click(screen.getByRole("radio", { name: "Heading" }))
  expect(mock.command).toHaveBeenCalledWith("heading")
  mock.contract = "inline"
  rerender(<Typography />)
  expect(screen.queryByRole("radio", { name: "Heading" })).toBeNull()
  expect(screen.getByRole("button", { name: "Emphasis" })).toBeVisible()
})

test("heading choices display actual result, fixed tooltips, paragraph toggle and empty badge", () => {
  mock.contract = "basic"
  mock.block = "heading"
  mock.headingLevel = 4
  mock.headingResult = "H4"
  mock.subheadingResult = "P"
  const { rerender } = render(<Typography />)
  const heading = screen.getByRole("radio", { name: "Heading H4" })
  expect(heading).toHaveTextContent("H4")
  expect(heading).toHaveAttribute(
    "title",
    "Heading — one level below the block title"
  )
  const subheading = screen.getByRole("radio", { name: "Subheading P" })
  expect(subheading).toHaveTextContent("P")
  expect(subheading).toHaveAttribute("title", "Subheading — two levels below")
  fireEvent.click(subheading)
  expect(mock.command).toHaveBeenCalledWith("subheading")
  mock.headingLevel = null
  mock.headingResult = "empty"
  mock.subheadingResult = "unavailable"
  rerender(<Typography />)
  expect(
    screen.getByLabelText("Empty heading — omitted from output")
  ).toHaveTextContent("—")
  expect(screen.getByRole("radio", { name: "Heading —" })).toHaveTextContent(
    "—"
  )
  expect(
    screen.getByRole("radio", { name: "Subheading Unavailable" })
  ).toBeDisabled()
})

test("formatting disclosures preserve independent choices across field contracts", () => {
  mock.contract = "basic"
  const { rerender } = render(<Typography />)
  fireEvent.click(
    screen.getByRole("button", { name: "Character style" })
  )
  expect(screen.queryByRole("button", { name: "Strong" })).toBeNull()
  expect(screen.getByRole("radio", { name: "Paragraph" })).toBeVisible()
  mock.contract = "title"
  rerender(<Typography />)
  expect(screen.queryByRole("region", { name: "Paragraph style" })).toBeNull()
  expect(
    screen.getByRole("button", { name: "Character style" })
  ).toHaveAttribute("aria-expanded", "false")
  mock.contract = "full"
  rerender(<Typography />)
  expect(screen.getByRole("radio", { name: "Paragraph" })).toBeVisible()
  fireEvent.click(
    screen.getByRole("button", { name: "Character style" })
  )
  expect(screen.getByRole("button", { name: "Strong" })).toBeVisible()
})
