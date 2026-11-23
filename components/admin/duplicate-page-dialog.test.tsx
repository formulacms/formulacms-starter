import { fireEvent, screen, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  duplicate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}))

import { DuplicatePageDialog } from "./duplicate-page-dialog"

describe("DuplicatePageDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.duplicate.mockResolvedValue("duplicate-page-id")
  })

  test("waits for confirmation and submits the edited title", async () => {
    const onDuplicated = vi.fn()
    const onClose = vi.fn()

    render(
      <DuplicatePageDialog
        onDuplicate={mocks.duplicate}
        sourceTitle="About"
        onDuplicated={onDuplicated}
        onClose={onClose}
      />
    )

    expect(mocks.duplicate).not.toHaveBeenCalled()
    const titleInput = screen.getByRole("textbox", { name: "New title" })
    expect(titleInput).toHaveValue("About (Copy)")

    fireEvent.change(titleInput, { target: { value: "  Our story  " } })
    fireEvent.click(screen.getByRole("button", { name: "Duplicate page" }))

    await waitFor(() => {
      expect(mocks.duplicate).toHaveBeenCalledWith("Our story")
    })
    expect(onDuplicated).toHaveBeenCalledWith("duplicate-page-id")
    expect(onClose).toHaveBeenCalledOnce()
    expect(mocks.success).toHaveBeenCalledWith('Created "Our story"')
  })

  test("does not duplicate when the editor cannot save the source", async () => {
    const beforeDuplicate = vi.fn().mockResolvedValue(false)

    render(
      <DuplicatePageDialog
        onDuplicate={mocks.duplicate}
        sourceTitle="About"
        beforeDuplicate={beforeDuplicate}
        onDuplicated={vi.fn()}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Duplicate page" }))

    await waitFor(() => expect(beforeDuplicate).toHaveBeenCalledOnce())
    expect(mocks.duplicate).not.toHaveBeenCalled()
  })

  test("renders and reports the duplicate flow in French", async () => {
    render(
      <DuplicatePageDialog
        onDuplicate={mocks.duplicate}
        sourceTitle="À propos"
        onDuplicated={vi.fn()}
        onClose={vi.fn()}
      />,
      { locale: "fr" }
    )

    expect(screen.getByRole("textbox", { name: "Nouveau titre" })).toHaveValue(
      "À propos (copie)"
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Dupliquer la page" })
    )

    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("« À propos (copie) » créée")
    )
  })

  test("shows a failed duplicate in the dialog, never a success", async () => {
    mocks.duplicate.mockRejectedValue(new Error("server"))
    const onDuplicated = vi.fn()
    render(
      <DuplicatePageDialog
        onDuplicate={mocks.duplicate}
        sourceTitle="About"
        onDuplicated={onDuplicated}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Duplicate page" }))

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(mocks.success).not.toHaveBeenCalled()
    expect(onDuplicated).not.toHaveBeenCalled()
  })

  test("lets the caller place focus as the dialog closes", async () => {
    const opener = document.createElement("button")
    const target = document.createElement("input")
    document.body.append(opener, target)
    opener.focus()
    const props = {
      onDuplicate: mocks.duplicate,
      sourceTitle: "About",
      onDuplicated: vi.fn(),
      onClose: vi.fn(),
    }
    const view = render(
      <DuplicatePageDialog
        {...props}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          target.focus()
        }}
      />
    )
    await screen.findByRole("dialog")
    view.rerender(<></>)
    await waitFor(() => expect(target).toHaveFocus())
    opener.remove()
    target.remove()
  })
})
