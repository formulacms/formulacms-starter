// Media details dialog: "No folder" must clear the folder. The server keeps the
// folder when `folder` is omitted, so the dialog sends `null` to clear it.
import type { ReactNode } from "react"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"

const mocks = vi.hoisted(() => ({
  update: vi.fn(async () => null),
  folders: ["Portraits", "Team"],
}))

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: vi.fn() }),
  useMutation: () => mocks.update,
  useQuery: () => mocks.folders,
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

vi.mock("./media-browser", () => ({
  MediaBrowser: ({ onItemClick }: { onItemClick: (media: never) => void }) => (
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
          folder: "Portraits",
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

// A native select stands in for the Radix Select chrome (not under test).
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <select
      aria-label="Folder"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}))

import { MediaLibrary } from "./media-library"

beforeEach(() => {
  mocks.update.mockClear()
})

function openAndPick(label: string) {
  render(<MediaLibrary />)
  fireEvent.click(screen.getByRole("button", { name: "Open fixture" }))
  const select = screen.getByRole("combobox", { name: "Folder" })
  expect(select).toHaveValue("Portraits")
  const option = screen.getByRole("option", { name: label }) as HTMLOptionElement
  fireEvent.change(select, { target: { value: option.value } })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
}

test("'No folder' clears the folder by sending null", async () => {
  openAndPick("No folder")
  await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
  expect(mocks.update).toHaveBeenCalledWith(
    expect.objectContaining({ id: "media-1", folder: null })
  )
})

test("picking a folder sends that folder name", async () => {
  openAndPick("Team")
  await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
  expect(mocks.update).toHaveBeenCalledWith(
    expect.objectContaining({ id: "media-1", folder: "Team" })
  )
})
