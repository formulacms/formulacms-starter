import { fireEvent, screen } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import { ChangePassword } from "./change-password"

const mocks = vi.hoisted(() => ({ changeMyPassword: vi.fn() }))

vi.mock("convex/react", () => ({ useMutation: () => mocks.changeMyPassword }))

function fill(current: string, next: string, confirm = next) {
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: current },
  })
  fireEvent.change(screen.getByLabelText("New password (min 10 chars)"), {
    target: { value: next },
  })
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: confirm },
  })
}

const submit = () => screen.getByRole("button", { name: "Change password" })

beforeEach(() => {
  mocks.changeMyPassword.mockReset()
})

describe("Settings > Account: change password", () => {
  test("enables the button only with a current password and 10+ matching characters", () => {
    render(<ChangePassword />)
    expect(submit()).toBeDisabled()
    fill("old-password-1", "short")
    expect(submit()).toBeDisabled()
    fill("old-password-1", "brand-new-pass-1", "different-pass-2")
    expect(submit()).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent("Passwords don’t match.")
    fill("", "brand-new-pass-1")
    expect(submit()).toBeDisabled()
    fill("old-password-1", "brand-new-pass-1")
    expect(submit()).toBeEnabled()
  })

  test("a changed password shows the notice and clears the fields", async () => {
    mocks.changeMyPassword.mockResolvedValue({ status: "changed" })
    render(<ChangePassword />)
    fill("correct-horse-1", "brand-new-pass-1")
    fireEvent.click(submit())
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Password changed."
    )
    expect(mocks.changeMyPassword).toHaveBeenCalledWith({
      currentPassword: "correct-horse-1",
      newPassword: "brand-new-pass-1",
    })
    expect(screen.getByLabelText("Current password")).toHaveValue("")
  })

  test.each([
    [{ status: "wrong_password" }, "Check your password."],
    [
      { status: "rate_limited", retryAfterMs: 59_001 },
      "Too many attempts. Try again in 60 seconds.",
    ],
    [
      { status: "invalid_input", error: "PASSWORD_TOO_SHORT" },
      "Choose a longer password.",
    ],
    [
      { status: "invalid_input", error: "PASSWORD_TOO_LONG" },
      "Choose a shorter password.",
    ],
    [
      { status: "invalid_input", error: "NOT_LOGGED_IN" },
      "Something went wrong",
    ],
  ])("maps %o to its message", async (result, message) => {
    mocks.changeMyPassword.mockResolvedValue(result)
    render(<ChangePassword />)
    fill("wrong-password-1", "brand-new-pass-1")
    fireEvent.click(submit())
    expect(await screen.findByRole("alert")).toHaveTextContent(message)
    expect(submit()).toBeEnabled()
  })

  test.each([
    ["PASSWORD_TOO_COMMON", "This password is too common. Choose another."],
    [
      "PASSWORD_HAS_SURROUNDING_WHITESPACE",
      "Remove spaces at the start or end of the password.",
    ],
  ])("shows %s under the new password field", async (error, message) => {
    mocks.changeMyPassword.mockResolvedValue({ status: "invalid_input", error })
    render(<ChangePassword />)
    fill("correct-horse-1", "brand-new-pass-1")
    fireEvent.click(submit())

    const alert = await screen.findByText(message)
    expect(
      screen
        .getByLabelText("New password (min 10 chars)")
        .closest(".space-y-1\\.5")
    ).toContainElement(alert)
    fireEvent.change(screen.getByLabelText("New password (min 10 chars)"), {
      target: { value: "another-pass-1" },
    })
    expect(screen.queryByText(message)).not.toBeInTheDocument()
  })

  test("a thrown call (signed out, offline) shows the general error", async () => {
    mocks.changeMyPassword.mockRejectedValue(new Error("UNAUTHENTICATED"))
    render(<ChangePassword />)
    fill("correct-horse-1", "brand-new-pass-1")
    fireEvent.click(submit())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something went wrong"
    )
    expect(screen.queryByText("UNAUTHENTICATED")).not.toBeInTheDocument()
  })

  test("renders in French", () => {
    render(<ChangePassword />, { locale: "fr" })
    expect(
      screen.getByRole("button", { name: "Changer le mot de passe" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Mot de passe actuel")).toBeInTheDocument()
  })
})
