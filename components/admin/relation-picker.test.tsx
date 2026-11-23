import { fireEvent, screen } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import { MultiRelationPicker } from "./relation-picker"

const mocks = vi.hoisted(() => ({
  onChange: vi.fn(),
  useQuery: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
}))

vi.mock("@/lib/use-debounced-value", () => ({
  useDebouncedValue: (value: string) => value,
}))

describe("MultiRelationPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useQuery.mockImplementation((reference) => {
      if (getFunctionName(reference).endsWith("searchTargets")) {
        return [
          {
            id: "about-page" as Id<"pages">,
            type: "page",
            title: "About us",
          },
        ]
      }
      return undefined
    })
  })

  test("keeps an allowed Page target selectable without archive filtering", () => {
    render(
      <MultiRelationPicker
        pageTypes={["page"]}
        value={[]}
        onChange={mocks.onChange}
        locale="en"
      />
    )

    expect(
      screen.getByRole("option", { name: /About us/i })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("option", { name: /About us/i }))
    expect(mocks.onChange).toHaveBeenCalledWith(["about-page"])
    expect(
      mocks.useQuery.mock.calls.some(([reference]) =>
        getFunctionName(reference).endsWith("getArchivedContentTypes")
      )
    ).toBe(false)
  })
})
