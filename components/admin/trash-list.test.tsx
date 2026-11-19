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
  deleteImpact: vi.fn(),
  purgeImpact: vi.fn(),
  refresh: vi.fn(),
  remove: vi.fn(),
  purge: vi.fn(),
  restoreLegacy: vi.fn(),
  restoreSnapshot: vi.fn(),
  restoreMedia: vi.fn(),
  purgeMedia: vi.fn(),
  success: vi.fn(),
  authority: "legacy" as "legacy" | "snapshot_active" | "invalid",
  defaultLocale: "en" as string | undefined,
  pages: [] as unknown[],
  snapshotPages: [] as unknown[],
  images: [] as unknown[],
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))

vi.mock("convex/react", () => ({
  useConvex: () => ({
    query: (reference: unknown, args: unknown) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/pages:deleteImpact") return mocks.deleteImpact(args)
      if (name === "cms/publication:pagePurgeImpact")
        return mocks.purgeImpact(args)
      throw new Error(`unexpected query ${name}`)
    },
  }),
  useQuery: vi.fn((reference) => {
    const name = getFunctionName(reference)
    if (name === "cms/settings:getSiteConfig")
      return { defaultLocale: mocks.defaultLocale }
    if (name === "cms/publication:getAdminAuthority") return mocks.authority
    if (name === "cms/pages:list") return mocks.pages
    throw new Error(`unexpected query ${name}`)
  }),
  usePaginatedQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/media:listTrashed")
      return { status: "Exhausted", results: mocks.images, loadMore: vi.fn() }
    if (name === "cms/publication:listAdminPages")
      return {
        status: "Exhausted",
        results: mocks.snapshotPages,
        loadMore: vi.fn(),
      }
    throw new Error(`unexpected paginated query ${name}`)
  },
  useMutation: vi.fn((reference) => {
    const name = getFunctionName(reference)
    const byName: Record<string, unknown> = {
      "cms/pages:restore": mocks.restoreLegacy,
      "cms/publication:restoreSoftDeletedPage": mocks.restoreSnapshot,
      "cms/pages:remove": mocks.remove,
      "cms/publication:purgeTrashedPages": mocks.purge,
      "cms/media:restore": mocks.restoreMedia,
      "cms/media:purgeTrashedMedia": mocks.purgeMedia,
    }
    if (!byName[name]) throw new Error(`unexpected mutation ${name}`)
    return byName[name]
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

function snapshotPage(id: string, title: string, extra: object = {}) {
  return {
    ...page,
    _id: id as Id<"pages">,
    slug: id,
    content: undefined,
    localizedTitles: { en: title },
    lifecycleGeneration: 5,
    ...extra,
  }
}

function image(id: string, filename: string) {
  return {
    _id: id as Id<"media">,
    filename,
    width: 1600,
    height: 900,
    deletedAt: Date.UTC(2026, 10, 16, 12),
    url: `https://example.test/${filename}`,
  }
}

const tick = (name: string) =>
  fireEvent.click(screen.getByRole("checkbox", { name }))

function openImagesTab() {
  const tab = screen.getByRole("tab", { name: "Images" })
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
  fireEvent.click(tab)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.confirm.mockResolvedValue(true)
  mocks.remove.mockResolvedValue(null)
  mocks.restoreLegacy.mockResolvedValue(null)
  mocks.restoreSnapshot.mockResolvedValue({ addressNotices: [] })
  mocks.restoreMedia.mockResolvedValue(null)
  mocks.deleteImpact.mockResolvedValue({ children: [], redirects: 0, menus: [] })
  mocks.purgeImpact.mockImplementation(({ pageIds }: { pageIds: string[] }) =>
    Promise.resolve(
      pageIds.map((pageId) => ({ pageId, canPurge: true, redirects: 0 }))
    )
  )
  mocks.purge.mockImplementation(
    ({ items }: { items: Array<{ pageId: string }> }) =>
      Promise.resolve(
        items.map((item) => ({ pageId: item.pageId, status: "started" }))
      )
  )
  mocks.purgeMedia.mockImplementation(({ ids }: { ids: string[] }) =>
    Promise.resolve(ids.map((id) => ({ id, status: "purged" })))
  )
  mocks.defaultLocale = "en"
  mocks.authority = "legacy"
  mocks.pages = [page]
  mocks.snapshotPages = []
  mocks.images = []
})

describe("TrashList legacy pages", () => {
  test("refuses with menu slugs before opening the confirm", async () => {
    mocks.deleteImpact.mockResolvedValue({
      children: [],
      redirects: 0,
      menus: ["footer", "primary"],
    })

    render(<TrashList />)
    expect(
      screen.queryByText(/deleted for good|Delete forever/)
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    await waitFor(() => {
      expect(mocks.error).toHaveBeenCalledWith(
        "Menus footer, primary link to this page. Remove those links or delete the menus first."
      )
    })
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  test("deletes after the confirm and names the redirects", async () => {
    mocks.deleteImpact.mockResolvedValue({
      children: [],
      redirects: 2,
      menus: [],
    })

    render(<TrashList />)
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    await waitFor(() => {
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Delete permanently?",
          description:
            "“Old page” will be deleted permanently, in every language. This cannot be undone. Also deletes 2 redirects.",
          confirmText: "Delete",
          destructive: true,
          filled: true,
        })
      )
    })
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("1 page deleted permanently.")
    )
    expect(mocks.remove).toHaveBeenCalledWith({ id: page._id })
    expect(mocks.purge).not.toHaveBeenCalled()
  })

  test("a failed pages.remove still says Delete failed", async () => {
    mocks.remove.mockRejectedValue(new Error("server"))
    render(<TrashList />)
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("Delete failed")
    )
  })

  test("renders trash actions in French", () => {
    render(<TrashList />, { locale: "fr" })

    expect(screen.getByRole("button", { name: "Restaurer" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Supprimer" })).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Supprimer la sélection" })
    ).toBeDisabled()
  })
})

describe("TrashList snapshot pages", () => {
  beforeEach(() => {
    mocks.authority = "snapshot_active"
    mocks.pages = []
  })

  test.each(["en", "fr"] as const)(
    "two restored languages stack default-first in %s admin",
    async (admin) => {
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

  test("restores through the lifecycle", async () => {
    mocks.snapshotPages = [snapshotPage("p1", "Snapshot page")]

    render(<TrashList />)
    fireEvent.click(screen.getByRole("button", { name: "Restore" }))

    await waitFor(() => {
      expect(mocks.restoreSnapshot).toHaveBeenCalledWith({
        pageId: "p1",
        expectedLifecycleGeneration: 5,
      })
    })
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("“Snapshot page” restored")
    )
    expect(mocks.restoreLegacy).not.toHaveBeenCalled()
  })

  test("one-row Delete shows the refusal before any confirm", async () => {
    mocks.snapshotPages = [snapshotPage("p1", "Spring offer")]
    mocks.purgeImpact.mockResolvedValue([
      {
        pageId: "p1",
        canPurge: false,
        reason: "incoming_links",
        detail: { count: 2, titles: ["Pricing", "Home"] },
        redirects: 0,
      },
    ])

    render(<TrashList />)
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "“Pricing” and 1 other page link to this page. Remove those links first."
      )
    )
    expect(mocks.purgeImpact).toHaveBeenCalledWith({ pageIds: ["p1"] })
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.purge).not.toHaveBeenCalled()
  })

  test("one-row Delete confirms with the redirect count and purges", async () => {
    mocks.snapshotPages = [snapshotPage("p1", "Summer sale")]
    mocks.purgeImpact.mockResolvedValue([
      { pageId: "p1", canPurge: true, redirects: 2 },
    ])

    render(<TrashList />)
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("1 page is being deleted.")
    )
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          "“Summer sale” will be deleted permanently, in every language. This cannot be undone. Also deletes 2 redirects.",
        confirmText: "Delete",
        filled: true,
        icon: expect.anything(),
      })
    )
    expect(mocks.purge).toHaveBeenCalledWith({
      items: [{ pageId: "p1", expectedLifecycleGeneration: 5 }],
    })
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  test("select all, the live count and the bar buttons", () => {
    mocks.snapshotPages = [
      snapshotPage("p1", "About us"),
      snapshotPage("p2", "Contact"),
      snapshotPage("p3", "Old team news"),
    ]

    render(<TrashList />)
    const all = screen.getByRole("checkbox", { name: "Select all" })
    expect(all).toHaveAttribute("aria-checked", "false")
    expect(screen.getByRole("button", { name: "Restore selected" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Delete selected" })).toBeDisabled()

    tick("About us")
    tick("Contact")
    expect(screen.getByText("2 selected")).toHaveAttribute("aria-live", "polite")
    expect(all).toHaveAttribute("aria-checked", "mixed")
    expect(screen.getByRole("button", { name: "Restore 2" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Delete 2" })).toBeEnabled()

    fireEvent.click(all)
    expect(all).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText("3 selected")).toBeInTheDocument()

    fireEvent.click(all)
    expect(all).toHaveAttribute("aria-checked", "false")
    expect(screen.queryByText(/^\d+ selected$/)).not.toBeInTheDocument()

    // A click on the row's empty area ticks it too.
    fireEvent.click(screen.getByTestId("row-p2"))
    expect(screen.getByRole("checkbox", { name: "Contact" })).toHaveAttribute(
      "aria-checked",
      "true"
    )
  })

  test("French count reads « Sélection : N »", () => {
    mocks.snapshotPages = [
      snapshotPage("p1", "About us"),
      snapshotPage("p2", "Contact"),
    ]
    render(<TrashList />, { locale: "fr" })
    tick("About us")
    tick("Contact")
    expect(screen.getByText("Sélection : 2")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Supprimer 2" })).toBeEnabled()
  })

  test("bar Delete confirms first, then names every refused page in one toast", async () => {
    mocks.snapshotPages = [
      snapshotPage("p1", "About us"),
      snapshotPage("p2", "Contact"),
      snapshotPage("p3", "Old team news"),
    ]
    mocks.purge.mockResolvedValue([
      {
        pageId: "p1",
        status: "refused",
        reason: "children",
        detail: { count: 2 },
      },
      {
        pageId: "p2",
        status: "refused",
        reason: "menus",
        detail: { count: 1, menus: ["main"] },
      },
      { pageId: "p3", status: "started" },
    ])

    render(<TrashList />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete 3" }))

    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1))
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete 3 pages permanently?",
        description:
          "“About us”, “Contact” and “Old team news” will be deleted permanently, in every language. This cannot be undone.",
        confirmText: "Delete 3 pages",
      })
    )
    expect(mocks.confirm.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.purge.mock.invocationCallOrder[0]!
    )
    expect(mocks.purge).toHaveBeenCalledWith({
      items: ["p1", "p2", "p3"].map((pageId) => ({
        pageId,
        expectedLifecycleGeneration: 5,
      })),
    })
    expect(mocks.error).toHaveBeenCalledWith(
      "1 page is being deleted. “About us” was not deleted: it has 2 child pages. Move or delete them first. “Contact” was not deleted: menu main links to it. Remove those links or delete the menu first."
    )
    expect(mocks.success).not.toHaveBeenCalled()
  })

  test("the bar sends every selected page; refusals come from the delete", async () => {
    mocks.snapshotPages = [
      snapshotPage("p1", "Winter campaign"),
      snapshotPage("p2", "Summer sale"),
    ]
    mocks.purgeImpact.mockResolvedValue([
      {
        pageId: "p1",
        canPurge: false,
        reason: "revalidation_pending",
        redirects: 0,
      },
      { pageId: "p2", canPurge: true, redirects: 2 },
    ])
    mocks.purge.mockResolvedValue([
      { pageId: "p1", status: "refused", reason: "revalidation_pending" },
      { pageId: "p2", status: "started" },
    ])

    render(<TrashList />)
    tick("Winter campaign")
    tick("Summer sale")
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }))

    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1))
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("Also deletes 2 redirects."),
      })
    )
    expect(mocks.purge).toHaveBeenCalledTimes(1)
    expect(mocks.purge).toHaveBeenCalledWith({
      items: ["p1", "p2"].map((pageId) => ({
        pageId,
        expectedLifecycleGeneration: 5,
      })),
    })
    expect(mocks.error).toHaveBeenCalledWith(
      "1 page is being deleted. “Winter campaign” was not deleted: it is still being removed from the public site. Try again in a minute."
    )
  })

  test("Cancel keeps every row and calls nothing", async () => {
    mocks.confirm.mockResolvedValue(false)
    mocks.snapshotPages = [
      snapshotPage("p1", "About us"),
      snapshotPage("p2", "Contact"),
    ]
    render(<TrashList />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }))
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
    expect(mocks.purge).not.toHaveBeenCalled()
    expect(screen.getByText("2 selected")).toBeInTheDocument()
  })

  test("more than 25 selected pages go in batches of 25", async () => {
    mocks.snapshotPages = Array.from({ length: 30 }, (_, i) =>
      snapshotPage(`p${i}`, `Page ${i}`)
    )
    render(<TrashList />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete 30" }))
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(
        "30 pages are being deleted."
      )
    )
    expect(mocks.purge).toHaveBeenCalledTimes(2)
    expect(mocks.purge.mock.calls[0]![0].items).toHaveLength(25)
    expect(mocks.purge.mock.calls[1]![0].items).toHaveLength(5)
    expect(mocks.purgeImpact).toHaveBeenCalledTimes(6)
  })

  test.each(["stale", "not_trashed", "home"] as const)(
    "one-row %s refusal says the page changed",
    async (reason) => {
      mocks.snapshotPages = [snapshotPage("p1", "About us")]
      mocks.purge.mockResolvedValue([
        { pageId: "p1", status: "refused", reason },
      ])
      render(<TrashList />)
      fireEvent.click(screen.getByRole("button", { name: "Delete" }))
      await waitFor(() =>
        expect(mocks.error).toHaveBeenCalledWith(
          "“About us” changed since this list loaded. Refresh the page and try again."
        )
      )
    }
  )

  test("one-row language_operation refusal, in French", async () => {
    mocks.snapshotPages = [snapshotPage("p1", "About us")]
    mocks.purgeImpact.mockResolvedValue([
      {
        pageId: "p1",
        canPurge: false,
        reason: "language_operation",
        redirects: 0,
      },
    ])
    render(<TrashList />, { locale: "fr" })
    fireEvent.click(screen.getByRole("button", { name: "Supprimer" }))
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "Un changement de langue est en cours. Réessayez quand il sera terminé."
      )
    )
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  test("bar toast: changed pages by name, the language sentence once", async () => {
    mocks.snapshotPages = [
      snapshotPage("p1", "About us"),
      snapshotPage("p2", "Contact"),
      snapshotPage("p3", "Pricing"),
      snapshotPage("p4", "Home"),
    ]
    mocks.purge.mockResolvedValue([
      { pageId: "p1", status: "refused", reason: "stale" },
      { pageId: "p2", status: "refused", reason: "language_operation" },
      { pageId: "p3", status: "refused", reason: "language_operation" },
      { pageId: "p4", status: "started" },
    ])
    render(<TrashList />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete 4" }))
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "1 page is being deleted. “About us” changed since this list loaded. Refresh the page and try again. A language change is running. Try again when it is finished."
      )
    )
  })

  test("a thrown purge error still says Delete failed", async () => {
    mocks.snapshotPages = [snapshotPage("p1", "About us")]
    mocks.purge.mockRejectedValue(new Error("server"))
    render(<TrashList />)
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("Delete failed")
    )
  })

  test("a stopped delete: own text, Delete retries it, Restore is off", async () => {
    mocks.snapshotPages = [
      snapshotPage("p1", "Old team news", { purgeStalled: true }),
      snapshotPage("p2", "Contact"),
    ]
    // The page's drafts are already gone, so the check alone would refuse.
    mocks.purgeImpact.mockResolvedValue([
      { pageId: "p1", canPurge: false, reason: "not_trashed", redirects: 0 },
    ])
    const view = render(<TrashList />)
    const row = screen.getByTestId("row-p1")
    expect(row).toHaveTextContent(
      "Delete stopped before it finished. Select Delete to try again."
    )
    expect(row).not.toHaveTextContent("Deleting…")
    expect(row).not.toHaveTextContent("Moved")
    expect(
      screen.getByRole("checkbox", { name: "Old team news" })
    ).toBeEnabled()
    const restore = row.querySelectorAll("button:not([role=checkbox])")[0]!
    const remove = row.querySelectorAll("button:not([role=checkbox])")[1]!
    expect(restore).toHaveTextContent("Restore")
    expect(restore).toBeDisabled()
    expect(remove).toBeEnabled()

    // Bar Restore leaves the stopped page out.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    expect(screen.getByText("2 selected")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Restore 1" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Delete 2" })).toBeEnabled()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    tick("Old team news")
    expect(
      screen.getByRole("button", { name: "Restore selected" })
    ).toBeDisabled()
    tick("Old team news")

    // Delete retries it through the real handler; the row then runs again.
    fireEvent.click(remove)
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("1 page is being deleted.")
    )
    expect(mocks.purge).toHaveBeenCalledWith({
      items: [{ pageId: "p1", expectedLifecycleGeneration: 5 }],
    })
    mocks.snapshotPages = [
      snapshotPage("p1", "Old team news", { purging: true }),
      snapshotPage("p2", "Contact"),
    ]
    view.rerender(<TrashList />)
    expect(screen.getByTestId("row-p1")).toHaveTextContent("Deleting…")
    mocks.snapshotPages = [snapshotPage("p2", "Contact")]
    view.rerender(<TrashList />)
    expect(screen.queryByTestId("row-p1")).not.toBeInTheDocument()
  })

  test("pages refused for a selected child or link are sent again", async () => {
    // 26 pages: the parent goes in the first group of 25, its child in the
    // second; a page links to a target in another group.
    mocks.snapshotPages = Array.from({ length: 26 }, (_, i) =>
      snapshotPage(`p${i}`, `Page ${i}`)
    )
    const queued = new Set<string>()
    const blockers: Record<string, { reason: string; needs: string }> = {
      p0: { reason: "children", needs: "p25" },
      p1: { reason: "incoming_links", needs: "p0" },
    }
    mocks.purge.mockImplementation(
      ({ items }: { items: Array<{ pageId: string }> }) =>
        Promise.resolve(
          items.map(({ pageId }) => {
            const blocker = blockers[pageId]
            if (blocker && !queued.has(blocker.needs))
              return {
                pageId,
                status: "refused",
                reason: blocker.reason,
                detail: { count: 1, titles: ["Page x"] },
              }
            queued.add(pageId)
            return { pageId, status: "started" }
          })
        )
    )
    render(<TrashList />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete 26" }))
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(
        "26 pages are being deleted."
      )
    )
    expect(mocks.error).not.toHaveBeenCalled()
    // Groups of 25 and 1, then the two refused pages again: the parent now
    // has its child queued, and the linking page goes in the same call.
    expect(
      mocks.purge.mock.calls.map((call) =>
        call[0].items.map((item: { pageId: string }) => item.pageId)
      )
    ).toEqual([
      Array.from({ length: 25 }, (_, i) => `p${i}`),
      ["p25"],
      ["p0", "p1"],
    ])
  })

  test("resending stops when a round starts no new page", async () => {
    mocks.snapshotPages = [
      snapshotPage("p1", "About us"),
      snapshotPage("p2", "Contact"),
    ]
    mocks.purge.mockImplementation(
      ({ items }: { items: Array<{ pageId: string }> }) =>
        Promise.resolve(
          items.map(({ pageId }) =>
            pageId === "p1"
              ? {
                  pageId,
                  status: "refused",
                  reason: "children",
                  detail: { count: 1 },
                }
              : { pageId, status: "started" }
          )
        )
    )
    render(<TrashList />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }))
    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1))
    expect(mocks.purge).toHaveBeenCalledTimes(2)
    expect(mocks.error).toHaveBeenCalledWith(
      "1 page is being deleted. “About us” was not deleted: it has 1 child page. Move or delete it first."
    )
  })

  test("French started toast", async () => {
    mocks.snapshotPages = [
      snapshotPage("p1", "About us"),
      snapshotPage("p2", "Contact"),
    ]
    render(<TrashList />, { locale: "fr" })
    fireEvent.click(screen.getByRole("checkbox", { name: "Tout sélectionner" }))
    fireEvent.click(screen.getByRole("button", { name: "Supprimer 2" }))
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(
        "Suppression de 2 pages en cours."
      )
    )
  })

  test("the check before the confirm asks about 5 pages at a time", async () => {
    mocks.snapshotPages = Array.from({ length: 12 }, (_, i) =>
      snapshotPage(`p${i}`, `Page ${i}`)
    )
    mocks.purgeImpact.mockImplementation(({ pageIds }: { pageIds: string[] }) =>
      Promise.resolve(
        pageIds.map((pageId) => ({ pageId, canPurge: true, redirects: 1 }))
      )
    )
    render(<TrashList />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete 12" }))
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("12 pages are being deleted.")
    )
    expect(
      mocks.purgeImpact.mock.calls.map((call) => call[0].pageIds.length)
    ).toEqual([5, 5, 2])
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("Also deletes 12 redirects."),
      })
    )
    expect(mocks.purge).toHaveBeenCalledTimes(1)
    expect(mocks.purge.mock.calls[0]![0].items).toHaveLength(12)
  })

  test("a failed check group still lets the bar delete start", async () => {
    mocks.snapshotPages = Array.from({ length: 7 }, (_, i) =>
      snapshotPage(`p${i}`, `Page ${i}`)
    )
    mocks.purgeImpact.mockImplementation(({ pageIds }: { pageIds: string[] }) =>
      pageIds.includes("p0")
        ? Promise.reject(new Error("too many reads"))
        : Promise.resolve(
            pageIds.map((pageId) => ({ pageId, canPurge: true, redirects: 3 }))
          )
    )
    render(<TrashList />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete 7" }))
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("7 pages are being deleted.")
    )
    // Only the group that answered adds its redirects (2 pages × 3).
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("Also deletes 6 redirects."),
      })
    )
    expect(mocks.purge.mock.calls[0]![0].items).toHaveLength(7)
    expect(mocks.error).not.toHaveBeenCalled()
  })

  test("a page still being deleted is greyed with everything disabled", () => {
    mocks.snapshotPages = [
      snapshotPage("p1", "Old team news", { purging: true }),
      snapshotPage("p2", "Contact"),
    ]
    render(<TrashList />)
    const row = screen.getByTestId("row-p1")
    expect(row).toHaveTextContent("Deleting…")
    expect(row).not.toHaveTextContent("Moved")
    expect(
      screen.getByRole("checkbox", { name: "Old team news" })
    ).toBeDisabled()
    for (const button of row.querySelectorAll("button:not([role=checkbox])"))
      expect(button).toBeDisabled()
    expect(screen.getByTestId("row-p2")).toHaveTextContent("Moved")

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    expect(screen.getByText("1 selected")).toBeInTheDocument()
    fireEvent.click(row)
    expect(screen.getByText("1 selected")).toBeInTheDocument()
  })

  test("bar Restore restores one at a time and keeps every address notice", async () => {
    mocks.snapshotPages = [
      snapshotPage("p1", "Workshops"),
      snapshotPage("p2", "Contact"),
    ]
    mocks.restoreSnapshot.mockImplementation(
      ({ pageId }: { pageId: string }) =>
        Promise.resolve({
          addressNotices:
            pageId === "p1"
              ? [
                  {
                    locale: "en",
                    oldPath: "/workshops",
                    newPath: "/workshops-2",
                    check: {
                      kind: "taken",
                      locale: "en",
                      path: "/workshops",
                      holder: {
                        pageId: "holder",
                        pageType: "landing-page",
                        title: "Workshops 2026",
                      },
                    },
                  },
                ]
              : [],
        })
    )

    render(<TrashList />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Restore 2" }))

    await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(2))
    expect(mocks.restoreSnapshot.mock.calls.map((call) => call[0])).toEqual([
      { pageId: "p1", expectedLifecycleGeneration: 5 },
      { pageId: "p2", expectedLifecycleGeneration: 5 },
    ])
    expect(mocks.success.mock.calls[0]?.[0]).toBe("2 pages restored")
    expect(mocks.success.mock.calls[1]?.[0]).toContain("/workshops-2")
    expect(mocks.success.mock.calls[1]?.[0]).toContain("Workshops")
  })
})

describe("TrashList images", () => {
  beforeEach(() => {
    mocks.authority = "snapshot_active"
    mocks.pages = []
    mocks.images = [
      image("i1", "team-photo-2024.jpg"),
      image("i2", "old-logo.png"),
    ]
  })

  test("lists previews, sizes and dates; switching tabs clears the selection", () => {
    mocks.snapshotPages = [snapshotPage("p1", "About us")]
    render(<TrashList />)
    tick("About us")
    expect(screen.getByText("1 selected")).toBeInTheDocument()
    openImagesTab()

    expect(screen.queryByText("1 selected")).not.toBeInTheDocument()
    const row = screen.getByTestId("row-i1")
    expect(row).toHaveTextContent("team-photo-2024.jpg")
    expect(row).toHaveTextContent("1600 × 900")
    expect(row).toHaveTextContent("Moved")
    expect(row.querySelector("[data-testid=thumb] img")).not.toBeNull()
  })

  test("one-image Delete reports who still uses it", async () => {
    mocks.purgeMedia.mockResolvedValue([
      {
        id: "i1",
        status: "refused",
        reason: "in_use",
        detail: {
          count: 3,
          uses: [
            { kind: "setting", name: "logo" },
            { kind: "page", name: "About us", where: "published" },
            { kind: "menu", name: "main" },
          ],
          olderVersionsOnly: false,
        },
      },
    ])
    render(<TrashList />)
    openImagesTab()
    fireEvent.click(
      screen.getAllByRole("button", { name: "Delete" })[0]!
    )

    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1))
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete permanently?",
        description:
          "“team-photo-2024.jpg” will be deleted permanently. This cannot be undone.",
      })
    )
    expect(mocks.purgeMedia).toHaveBeenCalledWith({ ids: ["i1"] })
    expect(mocks.error).toHaveBeenCalledWith(
      "This image is still used by “Logo”, “About us” and the main menu. Remove it there first."
    )
  })

  test("older-version-only and not-ready refusals", async () => {
    mocks.purgeMedia.mockResolvedValue([
      {
        id: "i1",
        status: "refused",
        reason: "in_use",
        detail: {
          count: 1,
          uses: [{ kind: "page", name: "About us", where: "older_version" }],
          olderVersionsOnly: true,
        },
      },
      {
        id: "i2",
        status: "refused",
        reason: "index_pending",
        code: "MEDIA_USAGE_INDEX_PENDING",
      },
    ])
    render(<TrashList />)
    openImagesTab()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }))

    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1))
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete 2 images permanently?",
        confirmText: "Delete 2 images",
      })
    )
    expect(mocks.error).toHaveBeenCalledWith(
      "“team-photo-2024.jpg” is used by an older published version of “About us”. Delete that page permanently first, or keep the image. Image delete is getting ready. Try again in a few minutes."
    )
  })

  test.each(["not_found", "not_trashed"] as const)(
    "image %s refusal says the image changed",
    async (reason) => {
      mocks.purgeMedia.mockResolvedValue([
        { id: "i1", status: "refused", reason },
      ])
      render(<TrashList />, { locale: "fr" })
      const tab = screen.getByRole("tab", { name: "Images" })
      fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
      fireEvent.click(tab)
      fireEvent.click(screen.getAllByRole("button", { name: "Supprimer" })[0]!)
      await waitFor(() =>
        expect(mocks.error).toHaveBeenCalledWith(
          "« team-photo-2024.jpg » a changé depuis l’affichage de la liste. Rechargez la page et réessayez."
        )
      )
    }
  )

  test("bar toast names a changed image in a whole sentence", async () => {
    mocks.purgeMedia.mockResolvedValue([
      { id: "i1", status: "refused", reason: "not_trashed" },
      { id: "i2", status: "purged" },
    ])
    render(<TrashList />)
    openImagesTab()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }))
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "1 image deleted permanently. “team-photo-2024.jpg” changed since this list loaded. Refresh the page and try again."
      )
    )
  })

  test("image delete outside snapshot authority says Delete failed", async () => {
    const { ConvexError } = await import("convex/values")
    mocks.purgeMedia.mockRejectedValue(
      new ConvexError("MEDIA_PURGE_NOT_AVAILABLE")
    )
    render(<TrashList />)
    openImagesTab()
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!)
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("Delete failed")
    )
  })

  test("bar Delete and Restore for images", async () => {
    render(<TrashList />)
    openImagesTab()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }))
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(
        "2 images deleted permanently."
      )
    )
    expect(mocks.purgeMedia).toHaveBeenCalledWith({ ids: ["i1", "i2"] })

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: "Restore 2" }))
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("2 images restored")
    )
    expect(mocks.restoreMedia.mock.calls.map((call) => call[0])).toEqual([
      { id: "i1" },
      { id: "i2" },
    ])
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
    const body = label.parentElement!
    expect(body).toHaveClass("min-w-0", "flex-1")
    const identity = body.parentElement!
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
      name: locale === "fr" ? "Supprimer" : "Delete",
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
