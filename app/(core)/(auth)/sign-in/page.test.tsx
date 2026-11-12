import {
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
  waitFor,
} from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import SignInPage from "./page"

const mocks = vi.hoisted(() => ({
  owner: undefined as { established: boolean } | undefined,
  providers: { google: false } as { google: boolean } | undefined,
  search: "",
  replace: vi.fn(),
  refresh: vi.fn(),
  signInEmail: vi.fn(),
  signInSocial: vi.fn(),
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

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: mocks.signInEmail,
      social: mocks.signInSocial,
    },
  },
}))

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
    mocks.providers = { google: false }
    mocks.search = ""
    mocks.signInEmail.mockResolvedValue({ error: null })
    mocks.signInSocial.mockResolvedValue({ error: null })
    mocks.useQuery.mockImplementation((reference) => {
      const name = getFunctionName(reference)
      if (name === "cms/owner:getOwnerEstablished") return mocks.owner
      if (name === "auth:getProvidersAvailable") return mocks.providers
      return undefined
    })
  })

  test("does not show credentials while account status is loading", () => {
    mocks.owner = undefined

    renderPage()

    expect(
      screen.getByRole("heading", { name: "Checking this site" })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument()
  })

  test("uses the sanitized owner-presence reader", () => {
    renderPage()

    expect(
      mocks.useQuery.mock.calls.map(([reference]) => getFunctionName(reference))
    ).toContain("cms/owner:getOwnerEstablished")
  })

  test("recovers after the sign-in service cannot be reached", async () => {
    mocks.signInEmail.mockRejectedValue(new Error("network unavailable"))

    renderPage()

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@example.com" },
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
    expect(screen.getByLabelText("Email")).toBeInTheDocument()
  })

  test("shows the authentication service error and allows another attempt", async () => {
    mocks.signInEmail.mockResolvedValue({
      error: { message: "Invalid email or password" },
    })

    renderPage()

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@example.com" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "incorrect-password" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign in failed. Try again."
    )
    expect(
      screen.queryByText("Invalid email or password")
    ).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled()
  })

  test.each([
    [
      "INVALID_EMAIL_OR_PASSWORD",
      "Vérifiez votre adresse e-mail et votre mot de passe.",
    ],
    ["UNRECOGNIZED_PROVIDER_FAILURE", "Échec de la connexion. Réessayez."],
  ])(
    "French sign-in maps %s without leaking provider prose and permits retry",
    async (code, expected) => {
      const providerMessage =
        "English provider diagnostic with internal details"
      mocks.signInEmail.mockResolvedValueOnce({
        error: { code, message: providerMessage },
      })
      renderPage("fr")
      fireEvent.change(screen.getByLabelText("E-mail"), {
        target: { value: "owner@example.com" },
      })
      fireEvent.change(screen.getByLabelText("Mot de passe"), {
        target: { value: "incorrect-password" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Se connecter" }))
      expect(await screen.findByRole("alert")).toHaveTextContent(expected)
      expect(screen.queryByText(providerMessage)).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Se connecter" })).toBeEnabled()
      fireEvent.click(screen.getByRole("button", { name: "Se connecter" }))
      await waitFor(() => {
        expect(mocks.signInEmail).toHaveBeenCalledTimes(2)
        expect(mocks.replace).toHaveBeenCalledWith("/admin")
        expect(mocks.refresh).toHaveBeenCalledOnce()
      })
    }
  )

  test("recovers after Google sign-in cannot be reached", async () => {
    mocks.providers = { google: true }
    mocks.signInSocial.mockRejectedValue(new Error("network unavailable"))

    renderPage()

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" })
    )

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t reach Google sign-in. Check your connection and try again."
    )
    expect(
      screen.getByRole("button", { name: "Continue with Google" })
    ).toBeEnabled()
  })

  test("uses a safe next path and refreshes the authenticated app", async () => {
    mocks.search = "next=%2Fadmin%2Fpages"

    renderPage()

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@example.com" },
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
    expect(screen.getByLabelText("E-mail")).toBeInTheDocument()
    expect(screen.getByLabelText("Mot de passe")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Se connecter" })
    ).toBeInTheDocument()
  })
})
