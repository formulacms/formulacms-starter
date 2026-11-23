import { fireEvent, screen, waitFor } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import fr from "@/messages/admin/fr.json"
import { CONTENT_TYPES } from "@/convex/lib/contentTypes"
import { adminContentTypeDetail } from "@/lib/admin/content-types"
import { render } from "@/test-utils/admin-i18n"
import { ContentTypeCatalog } from "./content-type-catalog"

const isActive = (type: string) =>
  (CONTENT_TYPES as readonly string[]).includes(type)

// The routing badge is read from the registry, so it only appears when the
// site actually activates a non-routable type. A generated starter may not.
const hasNonRoutableType = CONTENT_TYPES.some(
  (type) => adminContentTypeDetail(type)?.routable === false
)

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }))

vi.mock("convex/react", () => ({ useQuery: mocks.useQuery }))

describe("ContentTypeCatalog", () => {
  beforeEach(() => vi.clearAllMocks())

  test("shows loading before the bounded usage query resolves", () => {
    mocks.useQuery.mockReturnValue(undefined)

    render(<ContentTypeCatalog />)

    expect(screen.getByText("Loading Content Types…")).toBeInTheDocument()
  })

  test("shows active cards with routing and bounded usage", () => {
    mocks.useQuery.mockImplementation((reference) => {
      const name = getFunctionName(reference)
      if (name.endsWith("getArchivedContentTypes")) return []
      if (!name.endsWith("getContentTypeUsage")) return undefined
      return [
        { type: "author", count: 1, capped: false },
        { type: "testimonial", count: 0, capped: false },
        { type: "page", count: 26, capped: true },
        { type: "landing-page", count: 25, capped: false },
        { type: "post", count: 2, capped: false },
        { type: "job", count: 0, capped: false },
      ].filter((row) => isActive(row.type))
    })

    render(<ContentTypeCatalog />)

    expect(screen.getByText("Pages")).toBeInTheDocument()
    expect(
      screen.getByText("25+ documents (includes Trash)")
    ).toBeInTheDocument()
    if (hasNonRoutableType) {
      expect(screen.getByText("Non-routable")).toBeInTheDocument()
    }
    expect(
      screen.getByText("25 documents (includes Trash)")
    ).toBeInTheDocument()
  })

  test("renders a query failure boundary", () => {
    mocks.useQuery.mockImplementation(() => {
      throw new Error("denied")
    })

    render(<ContentTypeCatalog />)

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Content Types are unavailable right now."
    )
  })

  test("renders catalog loading copy in French", () => {
    mocks.useQuery.mockReturnValue(undefined)

    render(<ContentTypeCatalog />, { locale: "fr" })

    expect(
      screen.getByText("Chargement des types de contenu…")
    ).toBeInTheDocument()
  })

  test("separates archived types and marks starter membership", async () => {
    mocks.useQuery.mockImplementation((reference) => {
      const name = getFunctionName(reference)
      if (name.endsWith("getContentTypeUsage")) {
        return [
          { type: "landing-page", count: 1, capped: false },
          { type: "page", count: 0, capped: false },
        ]
      }
      if (name.endsWith("getArchivedContentTypes")) return ["landing-page"]
      return undefined
    })

    render(<ContentTypeCatalog starterContentTypes={new Set(["page"])} />)

    expect(screen.getByText("In starter")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Archived/ })).toHaveTextContent("1")
    expect(screen.queryByText("Landing pages")).not.toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole("tab", { name: /Archived/ }), {
      button: 0,
      ctrlKey: false,
    })

    await waitFor(() =>
      expect(screen.getByText("Landing pages")).toBeInTheDocument()
    )
    expect(screen.getAllByText("Archived").length).toBeGreaterThanOrEqual(2)
  })

  test("minimal Page/Landing selection keeps catalog counts and archives independent of optional types", async () => {
    vi.resetModules()
    vi.doMock("@/convex/lib/contentTypes/starterSelection", () => ({
      STARTER_CONTENT_TYPES: ["landing-page", "page"],
    }))
    try {
      const { ContentTypeCatalog: Catalog } =
        await import("./content-type-catalog")
      let archived: string[] = []
      mocks.useQuery.mockImplementation((reference) => {
        const name = getFunctionName(reference)
        if (name.endsWith("getArchivedContentTypes")) return archived
        if (name.endsWith("getContentTypeUsage"))
          return [
            { type: "page", count: 26, capped: true },
            { type: "landing-page", count: 25, capped: false },
          ]
        return undefined
      })
      const view = render(<Catalog starterContentTypes={new Set(["page"])} />)
      expect(screen.getByText("Pages")).toBeInTheDocument()
      expect(screen.getByText("Landing pages")).toBeInTheDocument()
      expect(
        screen.getByText("25+ documents (includes Trash)")
      ).toBeInTheDocument()
      expect(
        screen.getByText("25 documents (includes Trash)")
      ).toBeInTheDocument()
      expect(screen.queryByText("Authors")).not.toBeInTheDocument()
      expect(screen.queryByText("Posts")).not.toBeInTheDocument()
      expect(screen.queryByText("Non-routable")).not.toBeInTheDocument()
      expect(screen.getByText("In starter")).toBeInTheDocument()
      archived = ["landing-page"]
      view.rerender(<Catalog starterContentTypes={new Set(["page"])} />)
      expect(screen.getByRole("tab", { name: /Archived/ })).toHaveTextContent(
        "1"
      )
      expect(screen.queryByText("Landing pages")).not.toBeInTheDocument()
      fireEvent.mouseDown(screen.getByRole("tab", { name: /Archived/ }), {
        button: 0,
        ctrlKey: false,
      })
      await waitFor(() =>
        expect(screen.getByText("Landing pages")).toBeInTheDocument()
      )
    } finally {
      vi.doUnmock("@/convex/lib/contentTypes/starterSelection")
      vi.resetModules()
    }
  })

  test("labels a selected type beyond the shipped four from the admin messages", async () => {
    // What `content-type:new` writes: the type joins the selection and gets
    // `sidebar.contentType.<type>` in every admin messages file.
    vi.resetModules()
    vi.doMock("@/convex/lib/contentTypes/starterSelection", () => ({
      STARTER_CONTENT_TYPES: [
        "landing-page",
        "page",
        "post",
        "author",
        "testimonial",
      ],
    }))
    try {
      const { ContentTypeCatalog: Catalog } =
        await import("./content-type-catalog")
      mocks.useQuery.mockReturnValue([
        { type: "testimonial", count: 3, capped: false },
      ])
      const messages = {
        ...fr,
        sidebar: {
          ...fr.sidebar,
          contentType: {
            ...fr.sidebar.contentType,
            testimonial: { singular: "Témoignage", plural: "Témoignages" },
          },
        },
      }

      render(
        <NextIntlClientProvider locale="fr" messages={messages}>
          <Catalog />
        </NextIntlClientProvider>,
        { locale: "fr" }
      )

      expect(screen.getByText("Témoignages")).toBeInTheDocument()
      expect(screen.queryByText("Testimonials")).not.toBeInTheDocument()
    } finally {
      vi.doUnmock("@/convex/lib/contentTypes/starterSelection")
      vi.resetModules()
    }
  })
})
