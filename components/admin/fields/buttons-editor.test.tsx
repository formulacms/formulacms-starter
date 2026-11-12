import { fireEvent, screen } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { expect, test, vi } from "vitest"
import type { ButtonField } from "@/convex/lib/slices"
import { ButtonsEditor } from "./buttons-editor"

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => []),
}))

function button(id: string, label: string): ButtonField {
  return {
    id,
    label,
    link: { type: "none" },
    variant: "primary",
    withIcon: false,
    enabled: true,
  }
}

test("renders duplicate stored ids safely and repairs them on edit", () => {
  const onChange = vi.fn<(next: ButtonField[]) => void>()
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

  try {
    render(
      <ButtonsEditor
        value={[button("Id", "First"), button("Id", "Second")]}
        onChange={onChange}
      />
    )

    expect(screen.getByDisplayValue("First")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Second")).toBeInTheDocument()
    expect(
      consoleError.mock.calls.some((args) =>
        args.join(" ").includes("same key")
      )
    ).toBe(false)

    fireEvent.change(screen.getByDisplayValue("First"), {
      target: { value: "Updated" },
    })
    expect(onChange).toHaveBeenCalledTimes(1)

    const repaired = onChange.mock.calls[0][0]
    const ids = repaired.map((item) => item.id)
    expect(repaired.map((item) => item.label)).toEqual(["Updated", "Second"])
    expect(ids).toEqual(ids.map(() => expect.any(String)))
    expect(new Set(ids).size).toBe(ids.length)
  } finally {
    consoleError.mockRestore()
  }
})

test("names every button selector for assistive technologies", () => {
  render(
    <ButtonsEditor
      value={[
        {
          ...button("button-1", "Learn more"),
          link: { type: "internal" },
        },
      ]}
      onChange={vi.fn()}
    />
  )

  expect(
    screen.getByRole("combobox", { name: "Button 1 variant" })
  ).toHaveValue("primary")
  expect(
    screen.getByRole("combobox", { name: "Button 1 link type" })
  ).toHaveValue("internal")
  expect(
    screen.getByRole("combobox", { name: "Button 1 internal page" })
  ).toBeInTheDocument()
})
