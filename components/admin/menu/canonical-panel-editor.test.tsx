import { expectLegacyPanel as legacyPanel } from "@/test-utils/menu-panel"
import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { expect, test, vi } from "vitest"
import { NextIntlClientProvider } from "next-intl"
import type { LocaleNavItem } from "@/convex/lib/menu"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { CanonicalPanelEditor } from "./canonical-panel-editor"

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => async () => true,
}))

type Panel = NonNullable<LocaleNavItem["panel"]>

const initial: Panel = {
  columns: 2,
  blocks: [
    { id: "first", kind: "linkGroup", heading: "First", links: [] },
    { id: "second", kind: "linkGroup", heading: "Second", links: [] },
  ],
}

function Harness({
  canEditStructure = true,
  messages = en,
  locale = "en",
}: {
  canEditStructure?: boolean
  messages?: typeof en
  locale?: "en" | "fr"
}) {
  const [panel, setPanel] = useState(initial)
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <output data-testid="shape">
        {legacyPanel(panel).columns}:{legacyPanel(panel).blocks.map((block) => block.id).join(",")}
      </output>
      <output data-testid="kinds">
        {legacyPanel(panel).blocks.map((block) => block.kind).join(",")}
      </output>
      <CanonicalPanelEditor
        panel={panel}
        locale="en"
        onChange={setPanel}
        canEditStructure={canEditStructure}
      />
    </NextIntlClientProvider>
  )
}

test("changes columns and reorders blocks without regenerating IDs", () => {
  const { container } = render(<Harness />)
  fireEvent.change(screen.getByLabelText("Panel columns"), {
    target: { value: "3" },
  })
  expect(screen.getByTestId("shape")).toHaveTextContent("3:first,second")

  const draggable = container.querySelectorAll('[draggable="true"]')
  fireEvent.dragStart(draggable[0]!)
  fireEvent.dragEnter(draggable[1]!)
  fireEvent.drop(draggable[1]!)
  expect(screen.getByTestId("shape")).toHaveTextContent("3:second,first")
})

test("secondary-locale mode removes structural controls", () => {
  render(<Harness canEditStructure={false} />)
  expect(screen.getByLabelText("Panel columns")).toBeDisabled()
  expect(screen.queryByRole("button", { name: /add link group/i })).toBeNull()
  expect(
    screen.queryByRole("button", { name: /add featured block/i })
  ).toBeNull()
  expect(screen.getByDisplayValue("First")).toBeEnabled()
})

test("adds a dynamic list with a bounded active content source", () => {
  render(<Harness />)
  fireEvent.click(
    screen.getAllByRole("button", { name: /add dynamic list/i })[0]!
  )
  expect(screen.getByTestId("kinds")).toHaveTextContent(
    "linkGroup,linkGroup,dynamicList"
  )
  expect(screen.getByLabelText("Content type")).toHaveValue("post")
  expect(screen.getByLabelText("Item limit")).toHaveValue(3)
})

test("renders canonical panel controls in French", () => {
  render(<Harness messages={fr} locale="fr" />)

  expect(screen.getByLabelText("Colonnes du panneau")).toBeEnabled()
  expect(screen.getByText("Blocs du panneau")).toBeInTheDocument()
  expect(
    screen.getAllByRole("button", { name: /Ajouter un groupe de liens —/ })
  ).toHaveLength(2)
  fireEvent.click(
    screen.getAllByRole("button", {
      name: /Ajouter une liste automatique —/,
    })[0]!
  )
  expect(screen.getByRole("option", { name: "Articles" })).toBeInTheDocument()
})

test("new lists have no heading and block widths are bounded by the panel", () => {
  render(<Harness />)
  fireEvent.click(
    screen.getAllByRole("button", {
      name: /add dynamic list — panel blocks/i,
    })[0]!
  )
  expect(screen.getByPlaceholderText("List heading (optional)")).toHaveValue("")
  for (const select of screen.getAllByLabelText("Block width")) {
    expect(
      Array.from(select.querySelectorAll("option")).map(
        (option) => option.value
      )
    ).toEqual(["1", "2"])
  }
  fireEvent.change(screen.getByLabelText("Panel columns"), {
    target: { value: "1" },
  })
  for (const select of screen.getAllByLabelText("Block width"))
    expect(select.querySelectorAll("option")).toHaveLength(1)
})

test("keyboard handles reorder panel and bottom lists independently", () => {
  render(<Harness />)
  const first = screen.getByRole("button", { name: "Move First" })
  fireEvent.keyDown(first, { key: " " })
  fireEvent.keyDown(first, { key: "ArrowDown" })
  fireEvent.keyDown(first, { key: " " })
  expect(screen.getByTestId("shape")).toHaveTextContent("2:second,first")
})


test("R1a old panel editor leaves a stored column panel untouched", () => {
  const panel: Panel = { layout: "columns", columns: [{ id: "left", blocks: [{ id: "feature", kind: "featured", heading: "Title" }] }] }
  const before = JSON.stringify(panel), onChange = vi.fn()
  render(<NextIntlClientProvider locale="en" messages={en}><CanonicalPanelEditor panel={panel} locale="en" onChange={onChange} /></NextIntlClientProvider>)
  expect(onChange).not.toHaveBeenCalled()
  expect(JSON.stringify(panel)).toBe(before)
})
