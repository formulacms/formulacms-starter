import { fireEvent, screen, waitFor } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { render } from "@/test-utils/admin-i18n"
import { TrashList } from "./trash-list"

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
  query: vi.fn(),
  refresh: vi.fn(),
  remove: vi.fn(),
  restoreLegacy: vi.fn(),
  restoreSnapshot: vi.fn(),
  success: vi.fn(),
  authority: "legacy" as "legacy" | "snapshot_active" | "invalid",
  defaultLocale: "en" as string | undefined,
  pages: [] as unknown[],
  snapshotPages: [] as unknown[],
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: mocks.query }),
  useQuery: vi.fn((reference) => {
    const name = getFunctionName(reference)
    if (name === "cms/settings:getSiteConfig")
      return { defaultLocale: mocks.defaultLocale }
    return name === "cms/publication:getAdminAuthority"
      ? mocks.authority
      : mocks.pages
  }),
  usePaginatedQuery: () => ({
    status: "Exhausted",
    results: mocks.snapshotPages,
    loadMore: vi.fn(),
  }),
  useMutation: vi.fn((reference) => {
    const name = getFunctionName(reference)
    if (name === "cms/pages:restore") return mocks.restoreLegacy
    if (name === "cms/publication:restoreSoftDeletedPage") {
      return mocks.restoreSnapshot
    }
    return mocks.remove
  }),
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
}))

vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error, dismiss: mocks.dismiss },
}))

const page = {
  _id: "page-id" as Id<"pages">,
  _creationTime: 1,
  slug: "old-page",
  pageType: "landing-page",
  status: "archived",
  content: { en: { title: "Old page", slices: [] } },
  createdAt: 1,
  updatedAt: 1,
  deletedAt: 2,
} as Doc<"pages">

describe("TrashList permanent deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.confirm.mockResolvedValue(true)
    mocks.remove.mockResolvedValue(null)
    mocks.restoreLegacy.mockResolvedValue(null)
    mocks.restoreSnapshot.mockResolvedValue(null)
    mocks.defaultLocale = "en"
    mocks.authority = "legacy"
    mocks.pages = [page]
    mocks.snapshotPages = []
  })

  test("fails closed with menu slugs before opening confirmation", async () => {
    mocks.query.mockResolvedValue({
      children: [],
      redirects: 0,
      menus: ["footer", "primary"],
    })

    render(<TrashList />)
    fireEvent.click(screen.getByRole("button", { name: "Delete forever" }))

    await waitFor(() => {
      expect(mocks.error).toHaveBeenCalledWith(
        expect.stringMatching(/footer.*primary/)
      )
    })
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  test("keeps permanent deletion available when no references remain", async () => {
    mocks.query.mockResolvedValue({
      children: [],
      redirects: 2,
      menus: [],
    })

    render(<TrashList />)
    fireEvent.click(screen.getByRole("button", { name: "Delete forever" }))

    await waitFor(() => {
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining("Also deletes 2 redirects."),
        })
      )
    })
    expect(mocks.remove).toHaveBeenCalledWith({ id: page._id })
  })

  test.each(["en", "fr"] as const)(
    "two restored languages stack default-first in %s admin",
    async (admin) => {
      mocks.authority = "snapshot_active"
      mocks.defaultLocale = "en"
      mocks.snapshotPages = [
        {
          ...page,
          localizedTitles: { en: "Workshops", fr: "Ateliers" },
          content: undefined,
          lifecycleGeneration: 5,
        },
      ]
      const notice = (locale: string, title: string, path: string) => ({
        locale,
        oldPath: path,
        newPath: path + "-2",
        check: {
          kind: "taken",
          locale,
          path,
          holder: { pageId: "holder", pageType: "landing-page", title },
        },
      })
      mocks.restoreSnapshot.mockResolvedValue({
        addressNotices: [
          notice("fr", "Ateliers 2026", "/ateliers"),
          notice("en", "Workshops 2026", "/workshops"),
        ],
      })
      render(<TrashList />, { locale: admin })
      fireEvent.click(
        screen.getByRole("button", {
          name: admin === "en" ? "Restore" : "Restaurer",
        })
      )
      await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(2))
      expect(mocks.success.mock.calls[0]?.[0]).toContain("Workshops")
      expect(mocks.success.mock.calls[0]?.[0]).toContain("/workshops-2")
      expect(mocks.success.mock.calls[1]?.[0]).toContain("Ateliers")
      expect(mocks.success.mock.calls[1]?.[0]).toContain("/fr/ateliers-2")
      expect(mocks.success.mock.calls.every((call) => call.length === 1)).toBe(
        true
      )
      expect(mocks.dismiss).not.toHaveBeenCalled()
    }
  )

  test("snapshot trash restores through lifecycle and never offers permanent deletion", async () => {
    mocks.authority = "snapshot_active"
    mocks.pages = []
    mocks.snapshotPages = [
      {
        ...page,
        content: undefined,
        deletedAt: undefined,
        localizedTitles: { en: "Snapshot page" },
        lifecycleGeneration: 5,
      },
    ]

    render(<TrashList />)
    expect(
      screen.queryByRole("button", { name: "Delete forever" })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Restore" }))

    await waitFor(() => {
      expect(mocks.restoreSnapshot).toHaveBeenCalledWith({
        pageId: page._id,
        expectedLifecycleGeneration: 5,
      })
    })
    expect(mocks.restoreLegacy).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  test("renders trash actions in French without changing lifecycle authority", () => {
    render(<TrashList />, { locale: "fr" })

    expect(
      screen.getByRole("button", { name: "Restaurer" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Supprimer définitivement" })
    ).toBeInTheDocument()
    expect(mocks.authority).toBe("legacy")
  })
})

const trashScenarios = (["en", "fr"] as const).flatMap((locale) =>
  [false, true].flatMap((multilingual) =>
    [
      "Short title",
      "Annual community health report ".repeat(4).trim(),
      "社区健康计划与区域合作伙伴关系年度报告".repeat(4),
    ].flatMap((title, titleKind) =>
      [
        "about",
        "annual-report-community-health-programmes-regional-partnerships-2026",
        "report-communityhealthprogrammesandregionalpartnerships2026",
      ].map((slug) => ({ locale, multilingual, title, titleKind, slug }))
    )
  )
)

test.each(trashScenarios)(
  "Trash $locale M05=$multilingual title=$titleKind URL=$slug",
  ({ locale, multilingual, title, titleKind, slug }) => {
    mocks.authority = "legacy"
    const contentLocale = titleKind === 2 ? "zh" : locale
    mocks.defaultLocale = contentLocale
    const content = { [contentLocale]: { title, slices: [] } }
    // Trash needs no module-state subscription; exercise legacy and localized-title payloads.
    mocks.pages = [
      {
        ...page,
        slug,
        content: multilingual ? undefined : content,
        localizedTitles: multilingual ? { [contentLocale]: title } : undefined,
      },
    ]
    const view = render(<TrashList />, { locale })
    const label = screen.getByText(title)
    expect(label).toHaveClass("min-w-0", "wrap-break-word")
    expect(label.className).not.toMatch(/truncate|line-clamp/)
    expect(label).not.toHaveAttribute("title")
    expect(label).toHaveAttribute("lang", contentLocale)
    expect(label).toHaveAttribute("dir", "auto")
    const identity = label.parentElement!
    expect(identity).toHaveClass("min-w-[140px]", "flex-1")
    expect(identity.parentElement).toHaveClass(
      "flex-wrap",
      "items-start",
      "gap-x-4",
      "gap-y-2"
    )
    const url = identity.querySelector("[title]")!
    expect(url).toHaveAttribute("title", slug)
    expect(url).toHaveAttribute("lang", contentLocale)
    expect(url).toHaveAttribute("dir", "auto")
    expect(url.firstElementChild).toHaveClass("min-w-0", "truncate")
    expect(url.children).toHaveLength(
      slug.length > 32 && slug.endsWith("-2026") ? 2 : 1
    )
    const restore = screen.getByRole("button", {
      name: locale === "fr" ? "Restaurer" : "Restore",
    })
    const remove = screen.getByRole("button", {
      name: locale === "fr" ? "Supprimer définitivement" : "Delete forever",
    })
    expect(restore.parentElement).toBe(remove.parentElement)
    expect(restore.parentElement).toHaveClass(
      "ml-auto",
      "shrink-0",
      "flex-wrap",
      "justify-end",
      "sm:-mt-1.5"
    )
    expect(view.container.querySelector(".w-28")).toBeNull()
  }
)

test.each([
  {
    name: "French content and English slug",
    content: { fr: { title: "Bonjour" } },
    title: "Bonjour",
    titleLocale: "fr",
    defaultLocale: "en",
  },
  {
    name: "localized title and English slug",
    content: {},
    localizedTitles: { fr: "Titre localisé" },
    title: "Titre localisé",
    titleLocale: "fr",
    defaultLocale: "en",
  },
  {
    name: "empty content skips to localized key",
    content: { en: { title: "" } },
    localizedTitles: { fr: "Titre localisé" },
    title: "Titre localisé",
    titleLocale: "fr",
    defaultLocale: "en",
  },
  {
    name: "slug as title uses default",
    content: {},
    title: "old-page",
    titleLocale: "en",
    defaultLocale: "en",
  },
  {
    name: "unknown default slug as title inherits",
    content: {},
    title: "old-page",
    titleLocale: undefined,
    defaultLocale: undefined,
  },
  {
    name: "unknown default with real title",
    content: { fr: { title: "Bonjour" } },
    title: "Bonjour",
    titleLocale: "fr",
    defaultLocale: undefined,
  },
  {
    name: "admin untitled inherits",
    content: {},
    slug: "",
    titleLocale: undefined,
    defaultLocale: "en",
  },
])("Trash provenance: $name", (scenario) => {
  mocks.authority = "legacy"
  mocks.defaultLocale = scenario.defaultLocale
  mocks.pages = [{ ...page, ...scenario, slug: scenario.slug ?? page.slug }]
  render(<TrashList />, { locale: "fr" })
  const title = screen.getByText(scenario.title ?? "Sans titre", {
    selector: "p",
  })
  if (scenario.titleLocale)
    expect(title).toHaveAttribute("lang", scenario.titleLocale)
  else expect(title).not.toHaveAttribute("lang")
  const url = title.parentElement!.querySelector("[title]")!
  expect(url).toHaveAttribute("title", scenario.slug ?? page.slug)
  if (scenario.defaultLocale && (scenario.slug ?? page.slug))
    expect(url).toHaveAttribute("lang", scenario.defaultLocale)
  else expect(url).not.toHaveAttribute("lang")
})
