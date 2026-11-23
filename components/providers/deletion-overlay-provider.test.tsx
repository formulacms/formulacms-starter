import { render } from "@/test-utils/admin-i18n"
import { fireEvent, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DeleteBlockResult } from "@/app/(core)/admin/(authenticated)/blocks/actions"
import type { Id } from "@/convex/_generated/dataModel"
import {
  DeletionOverlayProvider,
  useBlockDeletion,
} from "./deletion-overlay-provider"

const mocks = vi.hoisted(() => ({
  deleteBlockAction: vi.fn(),
}))

vi.mock("@/app/(core)/admin/(authenticated)/blocks/actions", () => ({
  deleteBlockAction: mocks.deleteBlockAction,
  retryBlockDeletionCleanupAction: vi.fn(),
}))

function Start() {
  const { startDeletion } = useBlockDeletion()
  return (
    <button
      type="button"
      onClick={() => startDeletion({ type: "quote", label: "Quote" })}
    >
      Start
    </button>
  )
}

function renderOverlay(locale?: "en" | "fr") {
  render(
    <DeletionOverlayProvider>
      <Start />
    </DeletionOverlayProvider>,
    locale ? { locale } : undefined
  )
  fireEvent.click(screen.getByRole("button", { name: "Start" }))
}

const usage = {
  archived: true,
  complete: true,
  hasHistory: false,
  pageCount: 1,
  deletedPageCount: 0,
  usageCount: 2,
  pages: [
    {
      pageId: "p1" as Id<"pages">,
      title: "About us",
      slug: "about",
      locales: ["en", "fr"],
      count: 2,
      deleted: false,
      uses: [],
    },
  ],
}

describe("DeletionOverlayProvider", () => {
  beforeEach(() => vi.clearAllMocks())

  it.each<[string, DeleteBlockResult, string]>([
    [
      "a system block",
      { status: "blocked", reason: "system", message: "raw system" },
      "Built-in blocks can never be deleted. You can archive this one instead.",
    ],
    [
      "a use found by the Delete check",
      { status: "blocked", reason: "referenced", message: "raw referenced" },
      "It is still used in a draft, a published version, a page in Trash or an AI suggestion. Remove each use shown on the block page, then try again.",
    ],
    [
      "an unfinished Delete check",
      { status: "blocked", reason: "incomplete", message: "raw incomplete" },
      "The check of where this Block Type is used could not finish. Nothing was deleted.",
    ],
    [
      "an unfinished final usage read",
      {
        ...usage,
        complete: false,
        status: "blocked",
        reason: "in_use",
        message: "raw in use",
      },
      "The check of where this Block Type is used could not finish. Nothing was deleted.",
    ],
  ])("shows a plain message for %s", async (_case, result, message) => {
    mocks.deleteBlockAction.mockResolvedValue(result)
    renderOverlay()

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByText(/^raw /)).toBeNull()
    expect(screen.queryByText("About us")).toBeNull()
  })

  it("lists the pages that still use the block, with a translated use count", async () => {
    mocks.deleteBlockAction.mockResolvedValue({
      ...usage,
      status: "blocked",
      reason: "in_use",
      message: "Still used.",
    })
    renderOverlay("fr")

    expect(await screen.findByText("About us")).toBeInTheDocument()
    expect(screen.getByText(/2 utilisations · EN, FR/)).toBeInTheDocument()
  })

  it("shows the French system refusal", async () => {
    mocks.deleteBlockAction.mockResolvedValue({
      status: "blocked",
      reason: "system",
      message: "raw",
    })
    renderOverlay("fr")

    expect(
      await screen.findByText(
        "Les blocs intégrés ne peuvent jamais être supprimés. Vous pouvez archiver celui-ci à la place."
      )
    ).toBeInTheDocument()
  })
})
