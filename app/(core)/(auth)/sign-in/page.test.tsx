import {
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
  waitFor,
} from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { ConvexError } from "convex/values"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import SignInPage from "./page"

const mocks = vi.hoisted(() => ({
  owner: undefined as { established: boolean } | undefined,
  search: "",
  replace: vi.fn(),
  refresh: vi.fn(),
  signIn: vi.fn(),
  useQuery: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: mocks.replace,
    refresh: mocks.refresh,
  }),
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

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
}))

vi.mock("@/lib/auth/client", () => ({
  useUsernamePasswordSignIn: () => ({ signIn: mocks.signIn, pending: false }),
}))

function failed(userError: Record<string, unknown>) {
  return { status: "error", userError }
}

function renderPage(locale: "en" | "fr" = "en") {
  return renderWithTestingLibrary(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "fr" ? fr : en}
    >
      <SignInPage />
    </NextIntlClientProvider>
  )
}

describe("sign-in experience", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.owner = { established: true }
    mocks.search = ""
    mocks.signIn.mockResolvedValue({ status: "complete" })
    mocks.useQuery.mockImplementation((reference) => {
      const name = getFunctionName(reference)
      if (name === "cms/owner:getOwnerEstablished") return mocks.owner
      return undefined
    })
  })

  test("does not show credentials while account status is loading", () => {
    mocks.owner = undefined

    renderPage()

    expect(
      screen.getByRole("heading", { name: "Checking this site" })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument()
  })

  test("uses the sanitized owner-presence reader", () => {
    renderPage()

    expect(
      mocks.useQuery.mock.calls.map(([reference]) => getFunctionName(reference))
    ).toContain("cms/owner:getOwnerEstablished")
  })

  test("recovers after the sign-in service cannot be reached", async () => {
    mocks.signIn.mockResolvedValue(
      failed({ error: "OTHER_ERROR", cause: new Error("network unavailable") })
    )

    renderPage()

    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "owner" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t reach the sign-in service. Check your connection and try again."
    )
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled()
  })

  test("explains a genuinely fresh site without making sign-in a dead end", () => {
    mocks.owner = { established: false }

    renderPage()

    expect(
      screen.getByRole("heading", { name: "This site isn't set up yet" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Set up this site" })
    ).toHaveAttribute("href", "/setup")
    fireEvent.click(
      screen.getByRole("button", {
        name: "I already have an account — let me sign in",
      })
    )
    expect(screen.getByLabelText("Username")).toBeInTheDocument()
  })

  test.each(["USER_NOT_FOUND", "INVALID_CREDENTIALS", "PASSWORD_TOO_SHORT"])(
    "answers %s with one message that never says whether the username exists",
    async (error) => {
      mocks.signIn.mockResolvedValue(failed({ error, minimumLength: 10 }))

      renderPage()

      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "owner" },
      })
      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: "incorrect-password" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Check your username and password."
      )
      expect(mocks.signIn).toHaveBeenCalledWith({
        username: "owner",
        password: "incorrect-password",
      })
      expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled()
    }
  )

  test("says how long to wait after too many attempts", async () => {
    mocks.signIn.mockResolvedValue(
      failed({ error: "RATE_LIMITED", retryAfterMs: 59_001 })
    )

    renderPage()

    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "owner" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "incorrect-password" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Try again in 60 seconds."
    )
  })

  test.each([
    [
      "INVALID_CREDENTIALS",
      undefined,
      "Vérifiez votre nom d’utilisateur et votre mot de passe.",
    ],
    [
      "OTHER_ERROR",
      new ConvexError("English deployment diagnostic with internal details"),
      "Échec de la connexion. Réessayez.",
    ],
  ])(
    "French sign-in maps %s without leaking deployment prose and permits retry",
    async (error, cause, expected) => {
      mocks.signIn.mockResolvedValueOnce(failed({ error, cause }))
      renderPage("fr")
      fireEvent.change(screen.getByLabelText("Nom d’utilisateur"), {
        target: { value: "owner" },
      })
      fireEvent.change(screen.getByLabelText("Mot de passe"), {
        target: { value: "incorrect-password" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Se connecter" }))
      expect(await screen.findByRole("alert")).toHaveTextContent(expected)
      expect(
        screen.queryByText(/English deployment diagnostic/)
      ).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Se connecter" })).toBeEnabled()
      fireEvent.click(screen.getByRole("button", { name: "Se connecter" }))
      await waitFor(() => {
        expect(mocks.signIn).toHaveBeenCalledTimes(2)
        expect(mocks.replace).toHaveBeenCalledWith("/admin")
        expect(mocks.refresh).toHaveBeenCalledOnce()
      })
    }
  )

  test("offers no Google sign-in, no password reset by email and no invitation line (ADR-0056)", () => {
    renderPage()

    expect(screen.queryByText(/Need access\?/)).not.toBeInTheDocument()

    expect(
      screen.queryByRole("button", { name: /Google/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("link", { name: /Forgot password/ })
    ).not.toBeInTheDocument()
  })

  test("uses a safe next path and refreshes the authenticated app", async () => {
    mocks.search = "next=%2Fadmin%2Fpages"

    renderPage()

    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "owner" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/admin/pages")
      expect(mocks.refresh).toHaveBeenCalledOnce()
    })
  })

  test("renders the credential form in French", () => {
    renderPage("fr")

    expect(
      screen.getByRole("heading", { name: "Connexion" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Nom d’utilisateur")).toBeInTheDocument()
    expect(screen.getByLabelText("Mot de passe")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Se connecter" })
    ).toBeInTheDocument()
  })
})
