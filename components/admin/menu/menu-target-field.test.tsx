import { useState } from "react"
import type { Target } from "@/convex/lib/menu"
import { fireEvent, render, screen } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import type { Id } from "@/convex/_generated/dataModel"
import { MenuTargetField } from "./menu-target-field"

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
}))

vi.mock("convex/react", () => ({ useQuery: mocks.useQuery }))

const archivedId = "page_archived" as Id<"pages">

function renderField(
  props: Partial<React.ComponentProps<typeof MenuTargetField>> = {},
  messages: typeof en = en,
  adminLocale: "en" | "fr" = "en"
) {
  return render(
    <NextIntlClientProvider locale={adminLocale} messages={messages}>
      <MenuTargetField
        value={{ type: "internal", pageId: archivedId }}
        onChange={() => {}}
        locale="fr"
        {...props}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  const pages = [
    {
      _id: archivedId,
      slug: "old-services",
      localizedTitles: { en: "Old services", fr: "Anciens services" },
      status: "archived",
      pageType: "page",
    },
    {
      _id: "page_live",
      slug: "services",
      localizedSlugs: { fr: "services-fr" },
      localizedTitles: { en: "Services", fr: "Services français" },
      status: "published",
      pageType: "page",
    },
  ]
  mocks.useQuery.mockReset().mockImplementation((reference) => {
    const name = getFunctionName(reference)
    if (name === "cms/pages:listLinkablePages") return pages
    if (name === "cms/pages:getLinkablePageSelection") {
      return { status: "available", page: pages[0] }
    }
    return undefined
  })
})

describe("MenuTargetField shared page picker", () => {
  it("keeps localized archived diagnostics after promotion", () => {
    renderField()

    const picker = screen.getByRole("button", { name: /select page \(fr\)/i })
    expect(picker).toHaveTextContent("Anciens services")
    expect(picker).toHaveTextContent("archived")
    expect(
      screen.getByText(/link will not appear on the site/i)
    ).toBeInTheDocument()
  })

  it("writes the canonical internal target selected by the shared picker", () => {
    const onChange = vi.fn()
    renderField({
      value: { type: "external", url: "https://example.com" },
      onChange,
    })

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Page" }))
    fireEvent.click(screen.getByRole("button", { name: /select page \(fr\)/i }))
    fireEvent.click(screen.getByRole("button", { name: /services français/i }))

    expect(onChange).toHaveBeenLastCalledWith({
      type: "internal",
      pageId: "page_live",
    })
  })

  it("renders the empty-target state in French", () => {
    renderField({ value: undefined }, fr, "fr")

    expect(
      screen.getByText("Aucune destination n’est définie pour ce lien.")
    ).toBeInTheDocument()
  })
})

it("marks unpublished languages from publication states, not the page's overall status", () => {
  mocks.useQuery.mockImplementation((reference) => {
    const page = {
      _id: archivedId,
      slug: "services",
      localizedTitles: { fr: "Services" },
      status: "published",
      pageType: "page",
      localePublicationStates: { fr: "published", en: "not_translated" },
    }
    return getFunctionName(reference) === "cms/pages:listLinkablePages"
      ? [page]
      : { status: "available", page }
  })
  renderField({}, fr, "fr")
  expect(
    screen.getByText(
      "Pas encore publiée en EN : en EN, les visiteurs voient le libellé sans lien."
    )
  ).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Choisir une page (FR)" }))
  expect(screen.getByText("EN non publiée")).toBeTruthy()
  expect(screen.getByText("/services")).toBeTruthy()
})

it("URL errors start on blur, update as typed, and use visible accessible labels", () => {
  function Harness() {
    const [value, setValue] = useState<Target | undefined>({
      type: "external",
      url: "",
    })
    return (
      <NextIntlClientProvider locale="en" messages={en}>
        <MenuTargetField value={value} onChange={setValue} locale="en" />
      </NextIntlClientProvider>
    )
  }
  render(<Harness />)
  const input = screen.getByRole("textbox", { name: "External URL" })
  expect(screen.queryByRole("alert")).toBeNull()
  fireEvent.change(input, { target: { value: "/" } })
  expect(screen.queryByRole("alert")).toBeNull()
  fireEvent.blur(input)
  expect(input).toHaveAttribute("aria-invalid", "true")
  expect(screen.getByRole("alert")).toHaveTextContent(en.menus.link.urlError)
  fireEvent.change(input, { target: { value: "https://example.com" } })
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.getByRole("checkbox", { name: "Open in a new tab" })).toBeTruthy()
})

it.each([true, false])("offers no anchor chooser with allowEmpty=%s; leaves stored anchor unchanged", (allowEmpty) => {
  const onChange = vi.fn()
  const value: Target = { type: "anchor", anchor: "#retained" }
  renderField({ value, onChange, allowEmpty })
  expect(screen.queryByRole("tab", { name: /jump/i })).toBeNull()
  expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-state"))).toHaveLength(allowEmpty ? 3 : 2)
  expect(onChange).not.toHaveBeenCalled()
  expect(value).toEqual({ type: "anchor", anchor: "#retained" })
  fireEvent.mouseDown(screen.getByRole("tab", { name: "URL" }))
  expect(onChange).toHaveBeenCalledWith({ type: "external", url: "", openInNewTab: true })
})
