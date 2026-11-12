import { fireEvent, screen } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import { LinkPagePicker } from "./link-page-picker"

type PageRow = {
  _id: Id<"pages">
  slug: string
  localizedSlugs?: Record<string, string>
  localizedTitles: Record<string, string>
  status: "draft" | "published" | "archived"
  pageType: "page"
}

type Selection =
  | { status: "available"; page: PageRow }
  | { status: "missing" }
  | { status: "unavailable" }

const mocks = vi.hoisted(() => ({
  pages: undefined as PageRow[] | undefined,
  selection: undefined as Selection | undefined,
  useQuery: vi.fn(),
}))

vi.mock("convex/react", () => ({ useQuery: mocks.useQuery }))

const liveId = "page_live" as Id<"pages">
const archivedId = "page_archived" as Id<"pages">

beforeEach(() => {
  mocks.pages = [
    {
      _id: liveId,
      slug: "services",
      localizedSlugs: { fr: "services-fr" },
      localizedTitles: { en: "Services", fr: "Services français" },
      status: "published",
      pageType: "page",
    },
    {
      _id: archivedId,
      slug: "old-services",
      localizedTitles: { en: "Old services", fr: "Anciens services" },
      status: "archived",
      pageType: "page",
    },
  ]
  mocks.selection = undefined
  mocks.useQuery.mockReset().mockImplementation((reference, args) => {
    if (args === "skip") return undefined
    const name = getFunctionName(reference)
    if (name === "cms/pages:listLinkablePages") return mocks.pages
    if (name === "cms/pages:getLinkablePageSelection") return mocks.selection
    return undefined
  })
})

describe("LinkPagePicker", () => {
  it("searches localized titles and slugs, then emits the selected page id", () => {
    const onChange = vi.fn()
    render(<LinkPagePicker value={undefined} onChange={onChange} locale="fr" />)

    expect(mocks.useQuery).toHaveBeenCalledWith(expect.anything(), {
      locale: "fr",
      limit: 100,
    })
    fireEvent.click(screen.getByRole("button", { name: /select a page/i }))
    fireEvent.change(screen.getByRole("textbox", { name: /search pages/i }), {
      target: { value: "services-fr" },
    })
    fireEvent.click(screen.getByRole("button", { name: /services français/i }))

    expect(onChange).toHaveBeenCalledWith(liveId)
  })

  it("keeps an archived selection visible and diagnoses it", () => {
    mocks.pages = [mocks.pages![0]]
    mocks.selection = {
      status: "available",
      page: {
        _id: archivedId,
        slug: "old-services",
        localizedTitles: { en: "Old services", fr: "Anciens services" },
        status: "archived",
        pageType: "page",
      },
    }
    render(
      <LinkPagePicker value={archivedId} onChange={() => {}} locale="fr" />
    )

    expect(
      screen.getByRole("button", { name: /anciens services/i })
    ).toHaveTextContent("archived")
    expect(screen.getByText(/link will not appear on the site/i)).toBeTruthy()
  })

  it("preserves a missing id and labels the dangling selection", () => {
    mocks.selection = { status: "missing" }
    render(
      <LinkPagePicker
        value={"page_missing" as Id<"pages">}
        onChange={() => {}}
        locale="en"
      />
    )

    const trigger = screen.getByRole("button", { name: /missing page/i })
    expect(trigger).toHaveTextContent("deleted")
    expect(screen.getByText(/linked page no longer exists/i)).toBeTruthy()
  })

  it("does not call an inaccessible selected page deleted", () => {
    mocks.selection = { status: "unavailable" }
    render(
      <LinkPagePicker value={archivedId} onChange={() => {}} locale="en" />
    )

    expect(
      screen.getByRole("button", { name: /page unavailable/i })
    ).toHaveTextContent("unavailable")
    expect(screen.queryByText(/linked page no longer exists/i)).toBeNull()
  })
})
