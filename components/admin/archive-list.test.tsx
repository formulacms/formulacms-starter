import { screen } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import { ArchiveList } from "./archive-list"

const mocks = vi.hoisted(() => ({
  loadMore: vi.fn(),
  restoreLegacy: vi.fn(),
  restoreSnapshot: vi.fn(),
  refresh: vi.fn(),
  authority: "legacy" as "legacy" | "snapshot_active" | "invalid",
  usePaginatedQuery: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useQuery: () => mocks.authority,
  useMutation: (reference: unknown) =>
    getFunctionName(reference as never) === "cms/publication:restorePage"
      ? mocks.restoreSnapshot
      : mocks.restoreLegacy,
  usePaginatedQuery: mocks.usePaginatedQuery,
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
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

describe("ArchiveList", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authority = "legacy"
    mocks.restoreLegacy.mockResolvedValue("ok")
    mocks.restoreSnapshot.mockResolvedValue("ok")
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

  test("restores an archived document to draft", async () => {
    mocks.usePaginatedQuery.mockReturnValue({
      status: "Exhausted",
      results: [page],
      loadMore: mocks.loadMore,
    })

    render(<ArchiveList />)
    await screen.getByRole("button", { name: "Restore" }).click()

    expect(mocks.restoreLegacy).toHaveBeenCalledWith({
      id: page._id,
      status: "draft",
    })
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
    expect(mocks.restoreLegacy).not.toHaveBeenCalled()
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
})
