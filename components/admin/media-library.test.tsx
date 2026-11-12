import { fireEvent, screen, waitFor } from "@testing-library/react"
import { ConvexError } from "convex/values"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  mutation: vi.fn(),
  query: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: mocks.query }),
  useMutation: () => mocks.mutation,
  useQuery: () => [],
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
}))

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
  },
}))

vi.mock("./media-browser", () => ({
  MediaBrowser: ({
    onItemClick,
  }: {
    onItemClick: (media: never) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onItemClick({
          _id: "media-1",
          _creationTime: 1,
          filename: "portrait.jpg",
          mimeType: "image/jpeg",
          size: 1024,
          url: "/portrait.jpg",
          width: 400,
          height: 300,
          tags: [],
        } as never)
      }
    >
      Open fixture
    </button>
  ),
}))

vi.mock("./media-image-editor", () => ({
  ImageTransformEditorDialog: () => null,
}))

vi.mock("./tag-field", () => ({
  TagField: () => null,
}))

import { MediaLibrary } from "./media-library"

describe("MediaLibrary admin i18n", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("renders the inventory and detail controls in French", () => {
    render(<MediaLibrary />, { locale: "fr" })

    expect(screen.getByRole("heading", { name: "Médiathèque" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open fixture" }))

    expect(screen.getByRole("button", { name: "Modifier l’image" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Corbeille" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeInTheDocument()
  })

  test.each([
    {
      locale: "en" as const,
      trash: "Trash",
      expected:
        "This image is still in use. Remove it from Pages or site settings, then try again.",
    },
    {
      locale: "fr" as const,
      trash: "Corbeille",
      expected:
        "Cette image est encore utilisée. Retirez-la des Pages ou des paramètres du site, puis réessayez.",
    },
  ])("maps a media refusal to $locale plain copy", async (fixture) => {
    mocks.query.mockResolvedValue({ settings: [], pages: [] })
    mocks.confirm.mockResolvedValue(true)
    mocks.mutation.mockRejectedValue(
      new ConvexError({
        code: "MEDIA_SOFT_DELETE_REFERENCED",
        pageIds: ["page-1"],
        settings: [],
        snapshotReferences: [],
        truncated: false,
      })
    )

    render(<MediaLibrary />, { locale: fixture.locale })
    fireEvent.click(screen.getByRole("button", { name: "Open fixture" }))
    fireEvent.click(screen.getByRole("button", { name: fixture.trash }))

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(fixture.expected)
    )
  })

  test.each([
    {
      locale: "en" as const,
      trash: "Trash",
      description:
        "It will leave the library. Restoring images from the trash is not available yet.",
    },
    {
      locale: "fr" as const,
      trash: "Corbeille",
      description:
        "Elle quittera la bibliothèque. La restauration des images depuis la corbeille n’est pas encore disponible.",
    },
  ])("asks about an unused image ($locale)", async (fixture) => {
    mocks.query.mockResolvedValue({ settings: [], pages: [] })
    mocks.confirm.mockResolvedValue(false)

    render(<MediaLibrary />, { locale: fixture.locale })
    fireEvent.click(screen.getByRole("button", { name: "Open fixture" }))
    fireEvent.click(screen.getByRole("button", { name: fixture.trash }))

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce())
    expect(mocks.confirm.mock.calls[0]![0]).toMatchObject({
      description: fixture.description,
    })
    expect(mocks.mutation).not.toHaveBeenCalled()
  })

  test.each([
    { settings: [{ key: "logo" }], pages: [] },
    { settings: [], pages: [{ _id: "page-1" }] },
  ])("refuses an image in use at once, with no dialog", async (usage) => {
    mocks.query.mockResolvedValue(usage)

    render(<MediaLibrary />)
    fireEvent.click(screen.getByRole("button", { name: "Open fixture" }))
    fireEvent.click(screen.getByRole("button", { name: "Trash" }))

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "This image is still in use. Remove it from Pages or site settings, then try again."
      )
    )
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.mutation).not.toHaveBeenCalled()
  })
})
