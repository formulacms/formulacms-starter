import { fireEvent, screen, waitFor } from "@testing-library/react"
import { ConvexError } from "convex/values"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import { ArchiveList } from "./archive-list"

const mocks = vi.hoisted(() => ({
  loadMore: vi.fn(),
  restoreSnapshot: vi.fn(),
  trashSnapshot: vi.fn(),
  confirm: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  refresh: vi.fn(),
  authority: "snapshot_active" as "snapshot_active" | "invalid",
  usePaginatedQuery: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useQuery: () => mocks.authority,
  useMutation: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    const byName: Record<string, unknown> = {
      "cms/publication:restorePage": mocks.restoreSnapshot,
      "cms/publication:softDeletePage": mocks.trashSnapshot,
    }
    if (!byName[name]) throw new Error(`unexpected mutation ${name}`)
    return byName[name]
  },
  usePaginatedQuery: mocks.usePaginatedQuery,
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))

vi.mock("sonner", () => ({
  toast: { error: mocks.error, success: mocks.success },
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
}))

const page = {
  _id: "pages:archived-1",
  _creationTime: 1,
  pageType: "post",
  slug: "archived-post",
  status: "archived",
  content: {},
  effectiveTitles: { en: "Staged archived title" },
} as { _id: string; pageType: "post"; slug: string; status: "archived" }

const AUTHORITY_INCOMPLETE = "Publication authority is incomplete. Run the supported bootstrap or cutover command before managing archived pages."

describe("ArchiveList", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authority = "snapshot_active"
    mocks.restoreSnapshot.mockResolvedValue("ok")
    mocks.trashSnapshot.mockResolvedValue("ok")
    mocks.confirm.mockResolvedValue(true)
  })

  test("shows the first-page loading state", () => {
    mocks.usePaginatedQuery.mockReturnValue({
      status: "LoadingFirstPage",
      results: [],
      loadMore: mocks.loadMore,
    })

    render(<ArchiveList />)

    expect(screen.getByText("Loading archive…")).toBeInTheDocument()
  })

  test("shows the empty state", () => {
    mocks.usePaginatedQuery.mockReturnValue({
      status: "Exhausted",
      results: [],
      loadMore: mocks.loadMore,
    })

    render(<ArchiveList />)

    expect(screen.getByText("Archive is empty.")).toBeInTheDocument()
  })

  test("renders archive interface copy in French", () => {
    mocks.usePaginatedQuery.mockReturnValue({
      status: "Exhausted",
      results: [],
      loadMore: mocks.loadMore,
    })

    render(<ArchiveList />, { locale: "fr" })

    expect(screen.getByText("L’archive est vide.")).toBeInTheDocument()
  })

  test("shows a title from the staged overlay and a load-more control", () => {
    mocks.usePaginatedQuery.mockReturnValue({
      status: "CanLoadMore",
      results: [page],
      loadMore: mocks.loadMore,
    })

    render(<ArchiveList />)

    expect(screen.getByText("Staged archived title")).toBeInTheDocument()
    expect(screen.getByText("Post")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Load more" })
    ).toBeInTheDocument()
  })

  test("restores through the snapshot lifecycle command", async () => {
    mocks.authority = "snapshot_active"
    mocks.usePaginatedQuery.mockImplementation((reference: unknown) =>
      getFunctionName(reference as never) === "cms/publication:listAdminPages"
        ? {
            status: "Exhausted",
            results: [{ ...page, lifecycleGeneration: 4 }],
            loadMore: mocks.loadMore,
          }
        : { status: "LoadingFirstPage", results: [], loadMore: mocks.loadMore }
    )

    render(<ArchiveList />)
    await screen.getByRole("button", { name: "Restore" }).click()

    expect(mocks.restoreSnapshot).toHaveBeenCalledWith({
      pageId: page._id,
      expectedLifecycleGeneration: 4,
    })
  })

  test("keeps the notice for an unfinished publishing setup", () => {
    mocks.authority = "invalid"
    mocks.usePaginatedQuery.mockReturnValue({
      status: "LoadingFirstPage",
      results: [],
      loadMore: mocks.loadMore,
    })

    render(<ArchiveList />)

    expect(screen.getByRole("alert")).toHaveTextContent(
      AUTHORITY_INCOMPLETE
    )
  })

  test("renders a query failure state", () => {
    mocks.usePaginatedQuery.mockImplementation(() => {
      throw new Error("permission denied")
    })

    render(<ArchiveList />)

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Archive is unavailable right now."
    )
  })
  describe("selection and batch actions", () => {
    const rows = [
      {
        ...page,
        _id: "pages:a",
        slug: "a",
        effectiveTitles: { en: "Alpha" },
        lifecycleGeneration: 1,
      },
      {
        ...page,
        _id: "pages:b",
        slug: "b",
        effectiveTitles: { en: "Beta" },
        lifecycleGeneration: 2,
      },
      {
        ...page,
        _id: "pages:c",
        slug: "c",
        effectiveTitles: { en: "Gamma" },
        lifecycleGeneration: 3,
      },
    ]

    function showSnapshotRows() {
      mocks.authority = "snapshot_active"
      mocks.usePaginatedQuery.mockImplementation((reference: unknown) =>
        getFunctionName(reference as never) === "cms/publication:listAdminPages"
          ? { status: "Exhausted", results: rows, loadMore: mocks.loadMore }
          : {
              status: "LoadingFirstPage",
              results: [],
              loadMore: mocks.loadMore,
            }
      )
      render(<ArchiveList />)
    }

    test("select all ticks every row and enables both batch buttons", () => {
      showSnapshotRows()
      expect(
        screen.getByRole("button", { name: "Restore selected" })
      ).toBeDisabled()
      expect(
        screen.getByRole("button", { name: "Move selected to trash" })
      ).toBeDisabled()

      fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))

      for (const title of ["Alpha", "Beta", "Gamma"])
        expect(screen.getByRole("checkbox", { name: title })).toBeChecked()
      expect(screen.getByText("3 selected")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Restore 3" })).toBeEnabled()
      expect(
        screen.getByRole("button", { name: "Move 3 to trash" })
      ).toBeEnabled()
    })

    test("Restore selected restores each selected page once and clears the selection", async () => {
      showSnapshotRows()
      fireEvent.click(screen.getByRole("checkbox", { name: "Alpha" }))
      fireEvent.click(screen.getByRole("checkbox", { name: "Gamma" }))
      fireEvent.click(screen.getByRole("button", { name: "Restore 2" }))

      await waitFor(() =>
        expect(mocks.success).toHaveBeenCalledWith("2 page(s) restored as draft(s)")
      )
      expect(mocks.restoreSnapshot).toHaveBeenCalledTimes(2)
      expect(mocks.restoreSnapshot).toHaveBeenCalledWith({
        pageId: "pages:a",
        expectedLifecycleGeneration: 1,
      })
      expect(mocks.restoreSnapshot).toHaveBeenCalledWith({
        pageId: "pages:c",
        expectedLifecycleGeneration: 3,
      })
      expect(mocks.confirm).not.toHaveBeenCalled()
      expect(
        screen.getByRole("button", { name: "Restore selected" })
      ).toBeDisabled()
    })

    test("Move selected to trash confirms once and trashes each selected page once", async () => {
      showSnapshotRows()
      fireEvent.click(screen.getByRole("checkbox", { name: "Alpha" }))
      fireEvent.click(screen.getByRole("checkbox", { name: "Beta" }))
      fireEvent.click(screen.getByRole("button", { name: "Move 2 to trash" }))

      await waitFor(() =>
        expect(mocks.success).toHaveBeenCalledWith("2 pages moved to trash.")
      )
      expect(mocks.confirm).toHaveBeenCalledTimes(1)
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Move 2 pages to trash?",
          description: "You can restore them later from the trash.",
          confirmText: "Move to trash",
        })
      )
      expect(mocks.trashSnapshot).toHaveBeenCalledTimes(2)
      expect(mocks.trashSnapshot).toHaveBeenCalledWith({
        pageId: "pages:a",
        expectedLifecycleGeneration: 1,
      })
      expect(mocks.trashSnapshot).toHaveBeenCalledWith({
        pageId: "pages:b",
        expectedLifecycleGeneration: 2,
      })
      expect(mocks.refresh).toHaveBeenCalled()
    })

    test("a refused page is named in the toast while the others proceed", async () => {
      mocks.trashSnapshot.mockImplementation(
        ({ pageId }: { pageId: string }) =>
          pageId === "pages:b"
            ? Promise.reject(new ConvexError("PAGE_SOFT_DELETE_MENU_REFERENCE"))
            : Promise.resolve("ok")
      )
      showSnapshotRows()
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
      fireEvent.click(screen.getByRole("button", { name: "Move 3 to trash" }))

      await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1))
      expect(mocks.trashSnapshot).toHaveBeenCalledTimes(3)
      expect(mocks.error).toHaveBeenCalledWith(
        "2 pages moved to trash. “Beta” was not moved to trash. This page is still used in a live menu. Remove the menu link, then try again."
      )
      expect(mocks.success).not.toHaveBeenCalled()
      // The server data decides what stays; the refused row is still listed.
      expect(screen.getByText("Beta")).toBeInTheDocument()
    })

    test("a row's Move to trash opens the Content list confirm and trashes only that page", async () => {
      showSnapshotRows()
      fireEvent.click(
        screen.getAllByRole("button", { name: "Move to trash" })[1]!
      )

      await waitFor(() =>
        expect(mocks.success).toHaveBeenCalledWith("Moved to trash")
      )
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Move this page to trash?",
          description: "You can restore it later from the trash.",
          confirmText: "Move to trash",
        })
      )
      expect(mocks.trashSnapshot).toHaveBeenCalledTimes(1)
      expect(mocks.trashSnapshot).toHaveBeenCalledWith({
        pageId: "pages:b",
        expectedLifecycleGeneration: 2,
      })
    })

    test("cancelling the confirm moves nothing", async () => {
      mocks.confirm.mockResolvedValue(false)
      showSnapshotRows()
      fireEvent.click(
        screen.getAllByRole("button", { name: "Move to trash" })[0]!
      )

      await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
      expect(mocks.trashSnapshot).not.toHaveBeenCalled()
    })
  })
})
