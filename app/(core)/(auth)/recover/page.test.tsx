import { fireEvent, screen } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import RecoverPage from "./page"

const mocks = vi.hoisted(() => ({
  search: "token=one-time-token",
  replace: vi.fn(),
  refresh: vi.fn(),
  claim: vi.fn(),
  signIn: vi.fn(),
  linkState: undefined as
    | undefined
    | { status: "open"; expiresAt: number }
    | { status: "closed" },
  queryArgs: [] as unknown[],
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
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

// Like Convex: a skipped query answers undefined.
vi.mock("convex/react", () => ({
  useMutation: () => mocks.claim,
  useQuery: (_query: unknown, args: unknown) => {
    mocks.queryArgs.push(args)
    return args === "skip" ? undefined : mocks.linkState
  },
}))

vi.mock("@/lib/auth/client", () => ({
  useUsernamePasswordSignIn: () => ({ signIn: mocks.signIn, pending: false }),
}))

const EXPIRED =
  "This recovery link has expired or was already used. Run the recovery command again to get a new link."

function fill(username: string, password: string, confirm = password) {
  fireEvent.change(screen.getByLabelText("New username"), {
    target: { value: username },
  })
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: password },
  })
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: confirm },
  })
  fireEvent.click(screen.getByRole("button", { name: "Take over ownership" }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.search = "token=one-time-token"
  mocks.linkState = { status: "open", expiresAt: Date.now() + 15 * 60_000 }
  mocks.queryArgs = []
  mocks.claim.mockResolvedValue({ status: "claimed" })
  mocks.signIn.mockResolvedValue({ status: "complete" })
})

describe("/recover", () => {
  test("a link without a token shows the expired state with a way back", () => {
    mocks.search = ""
    render(<RecoverPage />)

    expect(screen.getByText(EXPIRED)).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Back to sign in" })
    ).toHaveAttribute("href", "/sign-in")
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.queryArgs.every((args) => args === "skip")).toBe(true)
  })

  test("an open link shows the form and asks about that link", () => {
    render(<RecoverPage />)

    expect(screen.getByLabelText("New username")).toBeInTheDocument()
    expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument()
    expect(mocks.queryArgs[0]).toEqual({ token: "one-time-token" })
  })

  test.each([
    ["a closed link", { status: "closed" as const }],
    [
      "an open link already past its expiry",
      { status: "open" as const, expiresAt: Date.now() - 1000 },
    ],
  ])("%s shows the expired state at once, without the form", (_, state) => {
    mocks.linkState = state
    render(<RecoverPage />)

    expect(screen.getByText(EXPIRED)).toBeInTheDocument()
    expect(screen.queryByLabelText("New username")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument()
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  test("while the link check loads, neither the form nor the expired state shows", () => {
    mocks.linkState = undefined
    render(<RecoverPage />)

    expect(screen.queryByLabelText("New username")).not.toBeInTheDocument()
    expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument()
  })

  test("the link closing during a successful claim never replaces the success screen", async () => {
    let finishClaim: (result: { status: "claimed" }) => void = () => {}
    mocks.claim.mockImplementation(
      () => new Promise((resolve) => (finishClaim = resolve))
    )
    const { rerender } = render(<RecoverPage />)
    fill("newowner", "brand-new-pass-1")
    await vi.waitFor(() => expect(mocks.claim).toHaveBeenCalled())

    // The live check flips to closed before the claim result arrives.
    mocks.linkState = { status: "closed" }
    rerender(<RecoverPage />)
    expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument()
    expect(screen.getByLabelText("New username")).toBeInTheDocument()

    finishClaim({ status: "claimed" })
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Owner access moved to newowner."
    )
    rerender(<RecoverPage />)
    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument()
    expect(mocks.signIn).toHaveBeenCalled()
  })

  test("mismatched passwords never reach the server", async () => {
    render(<RecoverPage />)
    fill("newowner", "brand-new-pass-1", "different-pass-2")

    expect(await screen.findByText("Passwords don’t match.")).toBeInTheDocument()
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  test("a short password is refused before the server", async () => {
    render(<RecoverPage />)
    fill("newowner", "short")

    expect(
      await screen.findByText("Use at least 10 characters.")
    ).toBeInTheDocument()
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  test("a claim signs the new account in and opens the admin", async () => {
    render(<RecoverPage />)
    fill("  newowner ", "brand-new-pass-1")

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Owner access moved to newowner. The previous account is no longer the site owner."
    )
    expect(mocks.claim).toHaveBeenCalledWith({
      token: "one-time-token",
      username: "newowner",
      password: "brand-new-pass-1",
    })
    expect(mocks.signIn).toHaveBeenCalledWith({
      username: "newowner",
      password: "brand-new-pass-1",
    })
    fireEvent.click(screen.getByRole("button", { name: "Open admin" }))
    expect(mocks.replace).toHaveBeenCalledWith("/admin")
    expect(mocks.refresh).toHaveBeenCalled()
  })

  test.each(["RECOVERY_INVALID", "RECOVERY_USED", "RECOVERY_EXPIRED"])(
    "%s shows the expired state",
    async (status) => {
      mocks.claim.mockResolvedValue({ status })
      render(<RecoverPage />)
      fill("newowner", "brand-new-pass-1")

      expect(await screen.findByText(EXPIRED)).toBeInTheDocument()
      expect(mocks.signIn).not.toHaveBeenCalled()
    }
  )

  const GENERAL =
    "Could not create the owner account. Check the details above and try again."

  test.each([
    ["PASSWORD_TOO_SHORT", "Use at least 10 characters.", "New password"],
    ["PASSWORD_TOO_LONG", "Choose a shorter password.", "New password"],
    [
      "PASSWORD_TOO_COMMON",
      "This password is too common. Choose another.",
      "New password",
    ],
    [
      "PASSWORD_HAS_SURROUNDING_WHITESPACE",
      "Remove spaces at the start or end of the password.",
      "New password",
    ],
    [
      "USERNAME_TAKEN",
      "That username is taken. Choose a new one.",
      "New username",
    ],
    ["USERNAME_HAS_INVALID_CHARACTERS", GENERAL, "New username"],
  ])(
    "invalid input %s keeps the form with a message on its field",
    async (error, message, fieldLabel) => {
      mocks.claim.mockResolvedValue({ status: "invalid_input", error })
      render(<RecoverPage />)
      fill("newowner", "brand-new-pass-1")

      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(screen.getByLabelText(fieldLabel)).toHaveAttribute(
        "aria-invalid",
        "true"
      )
      expect(screen.queryByText(error)).not.toBeInTheDocument()
      expect(
        screen.getByRole("button", { name: "Take over ownership" })
      ).toBeEnabled()
      expect(mocks.signIn).not.toHaveBeenCalled()
    }
  )

  test("renders in French", () => {
    render(<RecoverPage />, { locale: "fr" })

    expect(
      screen.getByRole("heading", { name: "Récupérer l’accès propriétaire" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Nouveau nom d’utilisateur")).toBeInTheDocument()
  })
})
