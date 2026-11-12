import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import { ContentTypeLifecyclePanel } from "./content-type-lifecycle-panel"

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  owner: null as
    | undefined
    | null
    | { ownerId: string; authId: string; email: string; role: "admin" },
  refresh: vi.fn(),
  setContentTypeArchivedAction: vi.fn(),
  setContentTypeStarterAction: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  useQuery: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
}))

vi.mock("@/app/(core)/admin/(authenticated)/content-types/actions", () => ({
  setContentTypeArchivedAction: mocks.setContentTypeArchivedAction,
  setContentTypeStarterAction: mocks.setContentTypeStarterAction,
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
}))

vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}))

function renderPanel({
  archived = false,
  starter = { included: true },
  locale = "en",
}: {
  archived?: boolean | null
  starter?: { included: boolean } | null
  locale?: "en" | "fr"
} = {}) {
  return render(
    <ContentTypeLifecyclePanel
      type="author"
      label="Author"
      archived={archived}
      starter={starter}
    />,
    { locale }
  )
}

describe("ContentTypeLifecyclePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.confirm.mockResolvedValue(true)
    mocks.owner = {
      ownerId: "owner-1",
      authId: "owner-auth-1",
      email: "owner@example.com",
      role: "admin",
    }
    mocks.useQuery.mockImplementation(() => mocks.owner)
    mocks.setContentTypeArchivedAction.mockResolvedValue(undefined)
    mocks.setContentTypeStarterAction.mockResolvedValue(["author"])
  })

  test("archives after confirmation and can curate starter membership", async () => {
    renderPanel()

    fireEvent.click(screen.getByRole("button", { name: "Archive" }))
    await waitFor(() => {
      expect(mocks.setContentTypeArchivedAction).toHaveBeenCalledWith({
        type: "author",
        archived: true,
      })
    })
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmText: "Archive" })
    )

    fireEvent.click(screen.getByRole("button", { name: "Remove from starter" }))
    await waitFor(() => {
      expect(mocks.setContentTypeStarterAction).toHaveBeenCalledWith({
        type: "author",
        inStarter: false,
      })
    })
  })

  test("restores without confirmation and disables lifecycle for an unrelated account", async () => {
    renderPanel({ archived: true, starter: null })

    fireEvent.click(screen.getByRole("button", { name: "Restore" }))
    await waitFor(() => {
      expect(mocks.setContentTypeArchivedAction).toHaveBeenCalledWith({
        type: "author",
        archived: false,
      })
    })
    expect(mocks.confirm).not.toHaveBeenCalled()

    mocks.owner = null
    renderPanel({ archived: false, starter: null })
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled()
    expect(
      screen.getByText(
        "Only settings administrators can change lifecycle state."
      )
    ).toBeInTheDocument()
  })

  test("keeps archive control disabled while lifecycle state is loading", () => {
    renderPanel({ archived: null, starter: null })

    expect(screen.getByText("Loading")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Loading lifecycle" })
    ).toBeDisabled()
  })

  test("renders lifecycle controls in French", () => {
    renderPanel({ locale: "fr" })

    expect(screen.getByRole("button", { name: "Archiver" })).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Retirer du modèle de départ" })
    ).toBeInTheDocument()
  })
})
