import {
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import ResetPasswordPage from "./page"

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  resetPassword: vi.fn(),
  search: "",
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}))

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    resetPassword: mocks.resetPassword,
  },
}))

function renderPage(locale: "en" | "fr" = "en") {
  return renderWithTestingLibrary(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "fr" ? fr : en}
    >
      <ResetPasswordPage />
    </NextIntlClientProvider>
  )
}

describe("reset-password experience", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.search = ""
    mocks.resetPassword.mockResolvedValue({ error: null })
  })

  test("keeps an invalid link on the recovery path", () => {
    renderPage()

    expect(
      screen.getByRole("heading", { name: "Invalid or expired link" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Request a new reset link" })
    ).toHaveAttribute("href", "/forgot-password")
  })

  test("submits the token and requires a fresh sign-in", async () => {
    mocks.search = "token=reset-token"
    renderPage()

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "password123" },
    })
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "password123" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Update password" }))

    await waitFor(() => {
      expect(mocks.resetPassword).toHaveBeenCalledWith({
        newPassword: "password123",
        token: "reset-token",
      })
      expect(mocks.push).toHaveBeenCalledWith("/sign-in?reset=ok")
    })
  })

  test("renders the reset form in French", () => {
    mocks.search = "token=reset-token"
    renderPage("fr")

    expect(
      screen.getByRole("heading", {
        name: "Choisir un nouveau mot de passe",
      })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Nouveau mot de passe")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Modifier le mot de passe" })
    ).toBeInTheDocument()
  })
})
