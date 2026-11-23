import type { ReactElement, ReactNode } from "react"
import {
  act,
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
  waitFor,
} from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  buildLiveOwnerCodeCommand,
  buildOwnerCodeCommand,
} from "@/lib/setup/owner-code-command"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { SetupWizard } from "./setup-wizard"

type TestLocale = "en" | "fr"

/**
 * The wizard opens on the client-only "Language and region" step. Most tests
 * are about the steps after it, so by default this helper accepts the prefilled
 * choices and continues; pass `{ stayOnLanguage: true }` to test step 1 itself.
 */
function render(
  ui: ReactElement,
  locale: TestLocale = "en",
  options: { stayOnLanguage?: boolean } = {}
) {
  const messages = locale === "fr" ? fr : en
  const view = renderWithTestingLibrary(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale={locale} messages={messages}>
        {children}
      </NextIntlClientProvider>
    ),
  })
  if (
    !options.stayOnLanguage &&
    document.getElementById("bootstrapDefaultLocale")
  ) {
    fireEvent.click(
      screen.getByRole("button", {
        name: locale === "fr" ? "Continuer" : "Continue",
      })
    )
  }
  return view
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

type TestOnboardingProgress = {
  account: boolean
  identity: boolean
  locales: boolean
  ai: boolean
  finished: boolean
}

const mocks = vi.hoisted(() => ({
  convexAuthenticated: true,
  ownerSessionReady: true,
  claimAvailable: true,
  ownerEstablished: false,
  storedAdminLocale: null as string | null | undefined,
  role: "viewer",
  progress: {
    account: false,
    identity: false,
    locales: false,
    ai: false,
    finished: false,
  } as TestOnboardingProgress | undefined,
  // A browser session exists (cookie); Convex Auth reports it as loading
  // until the Convex client confirms it (`convexAuthenticated`).
  session: { signedIn: true } as { signedIn: true } | null,
  push: vi.fn(),
  assign: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  createOwnerAccount: vi.fn(),
  httpQuery: vi.fn(),
  bootstrapInstallation: vi.fn(),
  setAdminLocale: vi.fn(),
  mutation: vi.fn(),
  action: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
    replace: mocks.replace,
    refresh: mocks.refresh,
  }),
}))

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    query = mocks.httpQuery
  },
}))

vi.mock("convex/react", () => ({
  useConvex: () => ({ url: "http://convex.example.invalid" }),
  useConvexAuth: () => ({
    isAuthenticated: mocks.session !== null && mocks.convexAuthenticated,
    isLoading: mocks.session !== null && !mocks.convexAuthenticated,
  }),
  useQuery: mocks.useQuery,
  useMutation: (reference: unknown) => mocks.useMutation(reference),
  useAction: () => mocks.action,
}))

vi.mock("@/lib/auth/client", () => ({
  useUsernamePasswordSignIn: () => ({ signIn: mocks.signIn, pending: false }),
  useSignOut: () => mocks.signOut,
}))

/**
 * `mocks.progress` is typed `| undefined` because one test blanks it to
 * simulate the loading state. Every other test runs after `beforeEach` has
 * restored a full object, so reach for it through this accessor: it states the
 * invariant once and fails loudly instead of throwing a bare TypeError.
 */
// The wizard leaves setup with a hard navigation so the root layout reloads in
// the saved interface language; stand in for `window.location.assign`.
beforeEach(() => {
  vi.stubGlobal("location", { ...window.location, assign: mocks.assign })
})

function progressMock(): TestOnboardingProgress {
  if (!mocks.progress) {
    throw new Error("mocks.progress was not initialised by beforeEach")
  }
  return mocks.progress
}

describe("SetupWizard auth bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.convexAuthenticated = true
    mocks.ownerSessionReady = true
    mocks.claimAvailable = true
    mocks.ownerEstablished = false
    mocks.role = "viewer"
    mocks.progress = {
      account: false,
      identity: false,
      locales: false,
      ai: false,
      finished: false,
    }
    mocks.session = { signedIn: true }
    mocks.httpQuery.mockResolvedValue({ available: true })
    mocks.createOwnerAccount.mockResolvedValue({ status: "created" })
    mocks.bootstrapInstallation.mockResolvedValue({
      phase: "snapshot_active",
      revision: 1,
      onboardingCompletedAt: 1,
    })
    mocks.setAdminLocale.mockResolvedValue(null)
    mocks.mutation.mockResolvedValue(null)
    mocks.useMutation.mockImplementation((reference) => {
      const name = getFunctionName(reference)
      if (name === "cms/owner:createOwnerAccount") {
        return mocks.createOwnerAccount
      }
      if (name === "cms/settings:bootstrapInstallation") {
        return mocks.bootstrapInstallation
      }
      if (name === "cms/userPreferences:setAdminLocale") {
        return mocks.setAdminLocale
      }
      return mocks.mutation
    })
    mocks.signIn.mockResolvedValue({ status: "complete" })
    mocks.signOut.mockResolvedValue(undefined)
    mocks.useQuery.mockImplementation((reference, args) => {
      if (args === "skip") return undefined
      const name = getFunctionName(reference)
      if (name === "cms/settings:getOnboardingProgress") {
        return mocks.progress
      }
      if (name === "cms/owner:getOwnerClaimAvailability") {
        return { available: mocks.claimAvailable }
      }
      if (name === "cms/owner:getOwnerEstablished") {
        return { established: mocks.ownerEstablished }
      }
      if (name === "cms/userPreferences:getAdminLocale") {
        return mocks.storedAdminLocale
      }
      if (name === "cms/owner:getOwnerSession") {
        if (!mocks.ownerSessionReady) return undefined
        return {
          ownerId: "owner-1",
          authId: "owner-1",
          email: null,
          displayName: "First Owner",
          role: mocks.role,
          permissions: [],
        }
      }
      return undefined
    })
  })

  test("keeps admin-only setup queries paused while the new identity is still a viewer", () => {
    render(<SetupWizard />)

    expect(queryArgsFor("cms/settings:getSettings")).toBe("skip")
  })

  test("does not show account creation while setup status is loading", () => {
    mocks.progress = undefined

    render(<SetupWizard />)

    expect(
      screen.getByRole("heading", { name: "Checking setup status" })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText("Owner setup code")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Create account" })
    ).not.toBeInTheDocument()
  })

  test("leaves setup when onboarding already finished", () => {
    if (!mocks.progress) throw new Error("Test progress is unavailable")
    progressMock().finished = true

    render(<SetupWizard />)

    expect(
      screen.getByRole("heading", { name: "Setup is complete" })
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open admin" })).toHaveAttribute(
      "href",
      "/admin"
    )
    expect(screen.queryByLabelText("Owner setup code")).not.toBeInTheDocument()
  })

  test("starts admin-only setup queries after the owner role is established", () => {
    mocks.role = "admin"

    render(<SetupWizard />)

    expect(queryArgsFor("cms/settings:getSettings")).toEqual({})
  })

  test("reads neither AI readiness nor email settings during setup", () => {
    mocks.ownerEstablished = true
    mocks.role = "admin"

    render(<SetupWizard />)

    const queried = mocks.useQuery.mock.calls.map(([reference]) =>
      getFunctionName(reference)
    )
    expect(queried).not.toContain("cms/ai:isConfigured")
    expect(queried).not.toContain("email:getEmailSettingsForAdmin")
    expect(screen.queryByLabelText("SMTP host")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Sender address")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Send test email" })
    ).not.toBeInTheDocument()
  })

  test("finishes a clean install through the atomic one-locale bootstrap", async () => {
    mocks.ownerEstablished = true
    mocks.role = "admin"

    render(<SetupWizard />, "en", { stayOnLanguage: true })
    fireEvent.change(screen.getByLabelText("Site language"), {
      target: { value: "ja" },
    })
    fireEvent.change(screen.getByLabelText("Timezone"), {
      target: { value: "Europe/Paris" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(screen.getByLabelText("Site name"), {
      target: { value: "Snapshot site" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }))

    await waitFor(() => {
      expect(mocks.bootstrapInstallation).toHaveBeenCalledWith({
        siteName: "Snapshot site",
        siteUrl: window.location.origin,
        siteDescription: undefined,
        timezone: "Europe/Paris",
        defaultLocale: "ja",
      })
    })
    expect(mocks.assign).toHaveBeenCalledWith("/admin")
    expect(mocks.push).not.toHaveBeenCalled()
  })

  test("Site address is suggested once from the address setup was opened on, with its hint", async () => {
    mocks.ownerEstablished = true
    mocks.role = "admin"

    render(<SetupWizard />, "en", { stayOnLanguage: true })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    const field = screen.getByLabelText("Site address")
    expect(field).toHaveValue(window.location.origin)
    expect(
      screen.getByText(
        "The address where visitors see your site, e.g. https://www.example.com. Suggested from the address you opened setup on."
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/Site URL/)).not.toBeInTheDocument()
  })

  test("an edited Site address is kept and a cleared one stays cleared", async () => {
    mocks.ownerEstablished = true
    mocks.role = "admin"

    render(<SetupWizard />, "en", { stayOnLanguage: true })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(screen.getByLabelText("Site name"), {
      target: { value: "Site" },
    })
    fireEvent.change(screen.getByLabelText("Site address"), {
      target: { value: "https://www.example.com" },
    })
    expect(screen.getByLabelText("Site address")).toHaveValue(
      "https://www.example.com"
    )
    fireEvent.change(screen.getByLabelText("Site address"), {
      target: { value: "" },
    })
    // Nothing puts the suggestion back after the owner cleared it.
    expect(screen.getByLabelText("Site address")).toHaveValue("")
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }))

    await waitFor(() =>
      expect(mocks.bootstrapInstallation).toHaveBeenCalledWith(
        expect.objectContaining({ siteUrl: undefined })
      )
    )
  })

  test("a saved Site address is never replaced by the suggestion", () => {
    mocks.ownerEstablished = true
    mocks.role = "admin"
    const base = mocks.useQuery.getMockImplementation()!
    mocks.useQuery.mockImplementation((reference, args) =>
      getFunctionName(reference) === "cms/settings:getSettings" &&
      args !== "skip"
        ? {
            siteUrl: "https://saved.example.com",
            defaultLocale: "en",
            timezone: "UTC",
            siteName: "Saved",
          }
        : base(reference, args)
    )

    render(<SetupWizard />, "en", { stayOnLanguage: true })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(screen.getByLabelText("Site address")).toHaveValue(
      "https://saved.example.com"
    )
  })

  test("renders the French setup dictionary and the rewritten language hint", () => {
    mocks.ownerEstablished = true
    mocks.role = "admin"

    render(<SetupWizard />, "fr", { stayOnLanguage: true })

    expect(screen.getByLabelText("Langue du site")).toBeInTheDocument()
    expect(
      screen.getByText(
        "Choisissez la langue initiale du site. La configuration et votre administration l’utilisent aussi ; après la configuration, activez le multilingue dans Paramètres pour ajouter d’autres langues."
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }))
    expect(
      screen.getByRole("button", { name: "Terminer la configuration" })
    ).toBeInTheDocument()
  })

  test("drops the starter-content step and the multilingual toggle", () => {
    const progress = progressMock()
    progress.account = true
    progress.identity = true
    mocks.role = "admin"

    render(<SetupWizard />)

    expect(screen.queryByTitle("Starter content")).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Enable multilingual starter/i)
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
  })

  test("resumes bookmarks from retired steps at the one-step bootstrap", () => {
    const progress = progressMock()
    progress.account = true
    progress.identity = true
    progress.locales = true
    progress.ai = true
    mocks.ownerEstablished = true
    mocks.role = "admin"

    render(<SetupWizard />)

    expect(screen.getByText("Site identity: step 3 of 3")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Finish setup" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Save and continue|Go to admin/ })
    ).not.toBeInTheDocument()
  })

  function fillNewAccount(
    messages: typeof en = en,
    code = "one-time-owner-code"
  ) {
    fireEvent.change(screen.getByLabelText(messages.setup.fields.name), {
      target: { value: "First Owner" },
    })
    fireEvent.change(screen.getByLabelText(messages.setup.fields.username), {
      target: { value: "owner" },
    })
    fireEvent.change(screen.getByLabelText(messages.setup.fields.newPassword), {
      target: { value: "password123" },
    })
    fireEvent.change(
      screen.getByLabelText(messages.setup.fields.confirmPassword),
      { target: { value: "password123" } }
    )
    fireEvent.change(screen.getByLabelText(messages.setup.fields.ownerCode), {
      target: { value: code },
    })
    fireEvent.click(
      screen.getByRole("button", { name: messages.setup.actions.createAccount })
    )
  }

  test("offers existing owner sign-in when setup resumes without a session", async () => {
    progressMock().account = true
    mocks.session = null
    mocks.convexAuthenticated = false

    const view = render(<SetupWizard />)

    expect(
      screen.getByRole("heading", { name: "Sign in to resume setup" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Username")).toBeInTheDocument()
    expect(screen.getByLabelText("Account password")).toBeInTheDocument()
    expect(screen.queryByLabelText("Site name")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Owner setup code")).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: " owner " },
    })
    fireEvent.change(screen.getByLabelText("Account password"), {
      target: { value: "password123" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in and resume" }))

    await waitFor(() =>
      expect(mocks.signIn).toHaveBeenCalledWith({
        username: "owner",
        password: "password123",
      })
    )
    expect(mocks.createOwnerAccount).not.toHaveBeenCalled()

    mocks.session = { signedIn: true }
    mocks.convexAuthenticated = true
    mocks.role = "admin"
    view.rerender(<SetupWizard />)

    expect(screen.getByLabelText("Site name")).toBeInTheDocument()
    expect(screen.getByText(/Resuming from/)).toHaveTextContent(
      "Resuming from Site identity"
    )
    expect(mocks.createOwnerAccount).not.toHaveBeenCalled()
  })

  test("requires the existing owner to sign in when the setup row is missing", () => {
    mocks.ownerEstablished = true
    mocks.session = null
    mocks.convexAuthenticated = false

    render(<SetupWizard />)

    expect(
      screen.getByRole("heading", { name: "Sign in to resume setup" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Username")).toBeInTheDocument()
    expect(screen.queryByLabelText("Owner setup code")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Create account" })
    ).not.toBeInTheDocument()
  })

  test.each([
    [{ error: "INVALID_CREDENTIALS" }, "Could not sign in."],
    [{ error: "USER_NOT_FOUND" }, "Could not sign in."],
    [
      { error: "OTHER_ERROR", cause: new Error("network unavailable") },
      "Could not sign in.",
    ],
    [
      { error: "RATE_LIMITED", retryAfterMs: 60_000 },
      "Too many attempts. Wait a minute, then try again.",
    ],
  ])(
    "keeps the resume gate available after a refused sign-in (%o)",
    async (userError, expected) => {
      progressMock().account = true
      mocks.session = null
      mocks.convexAuthenticated = false
      mocks.signIn.mockResolvedValue({ status: "error", userError })

      render(<SetupWizard />)

      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "owner" },
      })
      fireEvent.change(screen.getByLabelText("Account password"), {
        target: { value: "incorrect-password" },
      })
      fireEvent.click(
        screen.getByRole("button", { name: "Sign in and resume" })
      )

      expect(await screen.findByText(expected)).toBeInTheDocument()
      expect(
        screen.getByRole("heading", { name: "Sign in to resume setup" })
      ).toBeInTheDocument()
      expect(
        screen.getByRole("button", { name: "Sign in and resume" })
      ).toBeEnabled()
      expect(mocks.createOwnerAccount).not.toHaveBeenCalled()
    }
  )

  test("keeps resumed setup hidden while Convex authentication connects", () => {
    progressMock().account = true
    mocks.convexAuthenticated = false

    render(<SetupWizard />)

    expect(
      screen.getByRole("heading", { name: "Connecting your account" })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText("Site name")).not.toBeInTheDocument()
    expect(queryArgsFor("cms/settings:getSettings")).toBe("skip")
  })

  test("blocks a non-admin account from resumed setup and allows retry", async () => {
    progressMock().account = true
    mocks.role = "viewer"

    render(<SetupWizard />)

    expect(
      screen.getByRole("heading", {
        name: "This account can't resume setup",
      })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Another account is signed in, but only the site owner can continue setup."
      )
    ).toBeInTheDocument()
    expect(screen.queryByLabelText("Site name")).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole("button", {
        name: "Sign out and try another account",
      })
    )

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce())
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(mocks.createOwnerAccount).not.toHaveBeenCalled()
    expect(queryArgsFor("cms/settings:getSettings")).toBe("skip")
  })

  test("keeps wrong-account retry available after sign-out fails", async () => {
    progressMock().account = true
    mocks.role = "viewer"
    mocks.signOut.mockRejectedValue(new Error("network unavailable"))

    render(<SetupWizard />)

    fireEvent.click(
      screen.getByRole("button", {
        name: "Sign out and try another account",
      })
    )

    expect(
      await screen.findByText("Could not sign out. Try again.")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: "Sign out and try another account",
      })
    ).toBeEnabled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  test("keeps resumed setup hidden while the owner session loads", () => {
    progressMock().account = true
    mocks.ownerSessionReady = false

    render(<SetupWizard />)

    expect(
      screen.getByRole("heading", { name: "Checking setup access" })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText("Site name")).not.toBeInTheDocument()
    expect(queryArgsFor("cms/settings:getSettings")).toBe("skip")
  })

  test("creates the owner in one call, signs in, then waits for Convex authentication", async () => {
    mocks.session = null
    mocks.convexAuthenticated = false

    const view = render(<SetupWizard />)
    fillNewAccount()

    await waitFor(() => expect(mocks.signIn).toHaveBeenCalledOnce())
    expect(mocks.createOwnerAccount).toHaveBeenCalledWith({
      code: "one-time-owner-code",
      name: "First Owner",
      username: "owner",
      password: "password123",
    })
    expect(mocks.signIn).toHaveBeenCalledWith({
      username: "owner",
      password: "password123",
    })
    expect(screen.queryByRole("status")).not.toBeInTheDocument()

    mocks.session = { signedIn: true }
    mocks.convexAuthenticated = true
    mocks.role = "admin"
    view.rerender(<SetupWizard />)

    expect(
      await screen.findByRole("status", {}, { timeout: 1_000 })
    ).toHaveTextContent(/Owner account created for owner/)
    expect(screen.getByLabelText("Site name")).toBeInTheDocument()
  })

  test("trims copied setup-code whitespace before creating the owner", async () => {
    mocks.session = null

    render(<SetupWizard />)
    fillNewAccount(en, "  one-time-owner-code  ")

    await waitFor(() =>
      expect(mocks.createOwnerAccount).toHaveBeenCalledWith(
        expect.objectContaining({ code: "one-time-owner-code" })
      )
    )
  })

  test("shows the optional notification email before the setup code and sends it trimmed", async () => {
    mocks.session = null

    render(<SetupWizard />)

    expect(
      Array.from(document.querySelectorAll("label"), (label) =>
        label.textContent?.trim()
      )
    ).toEqual([
      "Your name",
      "Username",
      "Account password (min 10 chars)",
      "Confirm password",
      "Notification email (optional)",
      "Owner setup code",
    ])
    expect(
      screen.getByText("Enter your email to receive formulacms automatic notifications.")
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Notification email (optional)"), {
      target: { value: " owner@example.com " },
    })
    fillNewAccount()

    await waitFor(() =>
      expect(mocks.createOwnerAccount).toHaveBeenCalledWith({
        code: "one-time-owner-code",
        name: "First Owner",
        username: "owner",
        password: "password123",
        notificationEmail: "owner@example.com",
      })
    )
  })

  test("names the notification email when the server refuses it", async () => {
    mocks.session = null
    mocks.createOwnerAccount.mockResolvedValue({
      status: "invalid_input",
      error: "EMAIL_INVALID",
    })

    render(<SetupWizard />)
    fireEvent.change(screen.getByLabelText("Notification email (optional)"), {
      target: { value: "not-an-email" },
    })
    fillNewAccount()

    expect(await screen.findByRole("alert")).toHaveTextContent(
      en.caughtErrors.invalidEmail
    )
    expect(mocks.signIn).not.toHaveBeenCalled()
  })

  test.each([
    ["en", "PASSWORD_TOO_COMMON", "This password is too common. Choose another."],
    [
      "fr",
      "PASSWORD_HAS_SURROUNDING_WHITESPACE",
      "Retirez les espaces au début ou à la fin du mot de passe.",
    ],
  ] as const)(
    "shows %s %s under the password field",
    async (locale, error, message) => {
      mocks.session = null
      mocks.createOwnerAccount.mockResolvedValue({
        status: "invalid_input",
        error,
      })

      render(<SetupWizard />, locale)
      const messages = locale === "fr" ? fr : en
      fillNewAccount(messages)

      const alert = await screen.findByText(message)
      expect(
        screen
          .getByLabelText(messages.setup.fields.newPassword)
          .closest(".space-y-1\\.5")
      ).toContainElement(alert)
      expect(
        screen.queryByText(messages.setup.errors.createOwner)
      ).not.toBeInTheDocument()
      expect(mocks.signIn).not.toHaveBeenCalled()

      fireEvent.change(
        screen.getByLabelText(messages.setup.fields.newPassword),
        { target: { value: "another-password-1" } }
      )
      expect(screen.queryByText(message)).not.toBeInTheDocument()
    }
  )

  test("does not sign in when the owner account was not created", async () => {
    mocks.session = null
    mocks.createOwnerAccount.mockResolvedValue({
      status: "invalid_input",
      error: "PASSWORD_TOO_SHORT",
    })

    render(<SetupWizard />)
    fillNewAccount()

    expect(await screen.findByRole("alert")).toHaveTextContent(
      en.setup.errors.createOwner
    )
    expect(mocks.signIn).not.toHaveBeenCalled()
  })

  // Used codes cannot be recovered, only replaced, so the replacement command
  // has to be reachable from here.
  describe("owner setup code recovery", () => {
    test("names the way out when the code has already been used", () => {
      mocks.claimAvailable = false
      mocks.session = null
      mocks.role = "viewer"

      render(
        <SetupWizard
          ownerCodeTarget={{
            kind: "live",
            deployment: "calm-fox-9",
            command: buildLiveOwnerCodeCommand("calm-fox-9"),
          }}
        />
      )

      expect(screen.getByText(/missing or already used/i)).toBeInTheDocument()
      expect(screen.getByText(/set this site up yourself/i)).toBeInTheDocument()
      expect(
        screen.getByText(/convex env set FORMULACMS_OWNER_CLAIM/)
      ).toBeInTheDocument()
    })

    describe("folder- and deployment-bound command", () => {
      const folder = "/Users/ada/Sites/it's-mine"
      const command = buildOwnerCodeCommand(folder, "happy-animal-123")
      const textOf = (element: HTMLElement) => element.textContent ?? ""

      test.each([
        [
          "en",
          /Run these lines in a terminal\. They start in this site’s folder, /,
        ],
        [
          "fr",
          /Exécutez ces lignes dans un terminal\. Elles démarrent dans le dossier de ce site, /,
        ],
      ] as const)(
        "shows the bound block and names the folder (%s)",
        (locale, sentence) => {
          mocks.claimAvailable = false
          mocks.session = null
          mocks.role = "viewer"

          render(
            <SetupWizard
              ownerCodeTarget={{ kind: "local", folder, command }}
            />,
            locale
          )

          const block = document.querySelector("pre code") as HTMLElement
          expect(textOf(block)).toBe(command)
          expect(textOf(block)).toContain(
            "cd '/Users/ada/Sites/it'\\''s-mine' &&"
          )
          expect(textOf(block)).toContain("--deployment happy-animal-123 &&")
          expect(screen.getByText(sentence)).toHaveTextContent(folder)
          expect(screen.queryByText(/--prod/)).not.toBeInTheDocument()
        }
      )

      test.each([
        ["en", /can’t tell which Convex deployment/],
        ["fr", /ne peut pas savoir quel déploiement Convex/],
      ] as const)(
        "shows no command when the deployment is unknown (%s)",
        (locale, sentence) => {
          mocks.claimAvailable = false
          mocks.session = null
          mocks.role = "viewer"

          render(
            <SetupWizard ownerCodeTarget={{ kind: "local-unbound" }} />,
            locale
          )

          expect(screen.getByText(sentence)).toBeInTheDocument()
          expect(document.querySelector("pre")).toBeNull()
          expect(screen.queryByText(/convex env set/)).not.toBeInTheDocument()
        }
      )

      test.each([
        [
          "en",
          /Run these lines in a terminal in this site’s project folder\. They set the code on this site’s live deployment, /,
        ],
        [
          "fr",
          /Exécutez ces lignes dans un terminal, dans le dossier du projet de ce site\. Elles enregistrent le code sur le déploiement en ligne de ce site, /,
        ],
      ] as const)(
        "shows the live block with no cd and names the deployment (%s)",
        (locale, sentence) => {
          mocks.claimAvailable = false
          mocks.session = null
          mocks.role = "viewer"
          const liveCommand = buildLiveOwnerCodeCommand("calm-fox-9")

          render(
            <SetupWizard
              ownerCodeTarget={{
                kind: "live",
                deployment: "calm-fox-9",
                command: liveCommand,
              }}
            />,
            locale
          )

          const block = document.querySelector("pre code") as HTMLElement
          expect(textOf(block)).toBe(liveCommand)
          expect(textOf(block)).toContain("--deployment calm-fox-9 &&")
          expect(textOf(block)).not.toContain("cd ")
          expect(screen.getByText(sentence)).toHaveTextContent("calm-fox-9")
          expect(screen.queryByText(/--prod/)).not.toBeInTheDocument()
        }
      )

      test.each([
        ["en", /can’t tell which Convex deployment this live site uses/],
        ["fr", /ne peut pas savoir quel déploiement Convex ce site en ligne/],
      ] as const)(
        "shows no command when the live deployment is unknown (%s)",
        (locale, sentence) => {
          mocks.claimAvailable = false
          mocks.session = null
          mocks.role = "viewer"

          render(
            <SetupWizard ownerCodeTarget={{ kind: "live-unbound" }} />,
            locale
          )

          expect(screen.getByText(sentence)).toBeInTheDocument()
          expect(document.querySelector("pre")).toBeNull()
          expect(screen.queryByText(/convex env set/)).not.toBeInTheDocument()
        }
      )
    })

    // A wrong code must blame the code, not the deployment: "not available"
    // sends people looking for a broken site instead of a mistyped code.
    test("blames the code, not the site, when the code is wrong", async () => {
      mocks.session = null
      mocks.role = "viewer"
      mocks.createOwnerAccount.mockResolvedValue({ status: "unavailable" })

      render(<SetupWizard />)
      fillNewAccount(en, "wrong-code")

      expect(
        await screen.findByText(/doesn't match the one this site is expecting/i)
      ).toBeInTheDocument()
      expect(
        screen.queryByText(/not available|not possible/i)
      ).not.toBeInTheDocument()
      expect(mocks.signIn).not.toHaveBeenCalled()
    })

    test("uses the current claim availability after a pending refusal", async () => {
      mocks.session = null
      mocks.role = "viewer"
      const created = deferred<{ status: "unavailable" }>()
      mocks.createOwnerAccount.mockReturnValue(created.promise)

      const view = render(<SetupWizard />)
      fillNewAccount()

      await waitFor(() =>
        expect(mocks.createOwnerAccount).toHaveBeenCalledOnce()
      )
      mocks.claimAvailable = false
      view.rerender(<SetupWizard />)
      await act(async () => {
        created.resolve({ status: "unavailable" })
      })

      expect(screen.getByRole("alert")).toHaveTextContent(
        /missing or already used/i
      )
      expect(screen.getByRole("alert")).not.toHaveTextContent(
        /doesn't match the one this site is expecting/i
      )
      expect(mocks.signIn).not.toHaveBeenCalled()
    })

    test.each(["en", "fr"] as const)(
      "waits for fresh availability after a consumed-code refusal (%s)",
      async (locale) => {
        mocks.session = null
        const availability = deferred<{ available: boolean }>()
        mocks.httpQuery.mockReturnValue(availability.promise)
        mocks.createOwnerAccount.mockResolvedValue({ status: "unavailable" })
        const messages = locale === "fr" ? fr : en
        render(<SetupWizard />, locale)
        fillNewAccount(messages)
        await waitFor(() => expect(mocks.httpQuery).toHaveBeenCalledOnce())
        expect(
          screen.queryByText(messages.setup.errors.ownerCodeMismatch)
        ).not.toBeInTheDocument()
        expect(mocks.httpQuery).toHaveBeenCalledWith(expect.anything(), {})
        await act(async () => {
          availability.resolve({ available: false })
        })
        expect(screen.getByRole("alert")).toHaveTextContent(
          messages.setup.errors.ownerCodeUnavailable
        )
        expect(screen.getByRole("alert")).not.toHaveTextContent(
          messages.setup.errors.ownerCodeMismatch
        )
      }
    )

    test.each([
      {
        name: "failed availability read",
        result: { status: "unavailable" },
        readFails: true,
        consumeLater: false,
        expected: en.setup.errors.ownerCodeUnavailable,
      },
      {
        name: "later consumption of a confirmed unused code",
        result: { status: "unavailable" },
        readFails: false,
        consumeLater: true,
        expected: en.setup.errors.ownerCodeMismatch,
      },
      {
        name: "rate limit",
        result: { status: "invalid_input", error: "RATE_LIMITED" },
        readFails: false,
        consumeLater: false,
        expected: en.setup.errors.tooManyAttempts,
      },
    ])(
      "keeps truthful account copy after $name",
      async ({ result, readFails, consumeLater, expected }) => {
        mocks.session = null
        if (readFails) mocks.httpQuery.mockRejectedValue(new Error("Read failed"))
        mocks.createOwnerAccount.mockResolvedValue(result)
        const view = render(<SetupWizard />)
        fillNewAccount()
        expect(await screen.findByRole("alert")).toHaveTextContent(expected)
        if (result.status === "invalid_input") {
          expect(mocks.httpQuery).not.toHaveBeenCalled()
        }
        if (consumeLater) {
          mocks.claimAvailable = false
          view.rerender(<SetupWizard />)
          expect(screen.getByRole("alert")).toHaveTextContent(
            en.setup.errors.ownerCodeUnavailable
          )
          expect(screen.getByRole("alert")).not.toHaveTextContent(
            en.setup.errors.ownerCodeMismatch
          )
        }
        expect(mocks.signIn).not.toHaveBeenCalled()
      }
    )

    // A rejected password or name is not a wrong setup code. Blaming the code
    // sends people to re-paste a correct one and rotate a working claim.
    test.each([
      ["en", "PASSWORD_TOO_SHORT"],
      ["fr", "USERNAME_HAS_INVALID_CHARACTERS"],
      ["en", "NAME_INVALID"],
      ["fr", "UNKNOWN_SERVER_CODE"],
    ] as const)(
      "translates invalid input %s %s without blaming the setup code",
      async (locale, error) => {
        mocks.session = null
        mocks.role = "viewer"
        mocks.createOwnerAccount.mockResolvedValue({
          status: "invalid_input",
          error,
        })

        render(<SetupWizard />, locale)
        const messages = locale === "fr" ? fr : en
        fillNewAccount(messages)

        expect(
          await screen.findByText(messages.setup.errors.createOwner)
        ).toBeInTheDocument()
        expect(screen.queryByText(error)).not.toBeInTheDocument()
        expect(
          screen.queryByText(messages.setup.errors.ownerCodeMismatch)
        ).not.toBeInTheDocument()
      }
    )

    test("confirms in plain words once the owner account exists", async () => {
      mocks.session = null
      mocks.role = "viewer"

      const view = render(<SetupWizard />)
      fillNewAccount()
      await waitFor(() => expect(mocks.signIn).toHaveBeenCalledOnce())
      mocks.session = { signedIn: true }
      mocks.convexAuthenticated = true
      mocks.role = "admin"
      view.rerender(<SetupWizard />)

      const notice = await screen.findByRole("status", {}, { timeout: 1_000 })
      expect(notice).toHaveTextContent(/Owner account created for owner/i)
      expect(notice).toHaveTextContent(/setup code is used up/i)
    })

    test("keeps the replacement command reachable from the code field", () => {
      mocks.session = null
      mocks.role = "viewer"

      render(
        <SetupWizard
          ownerCodeTarget={{
            kind: "live",
            deployment: "calm-fox-9",
            command: buildLiveOwnerCodeCommand("calm-fox-9"),
          }}
        />
      )

      expect(screen.getByLabelText(/owner setup code/i)).toBeInTheDocument()
      expect(
        screen.getByText(/convex env set FORMULACMS_OWNER_CLAIM/)
      ).toBeInTheDocument()
    })

    test("offers no owner replacement by setup code (ADR-0056 rule 4)", () => {
      progressMock().finished = true
      mocks.ownerEstablished = true
      mocks.claimAvailable = true
      mocks.role = "viewer"

      render(<SetupWizard />)

      expect(
        screen.queryByRole("button", { name: /Replace owner/ })
      ).not.toBeInTheDocument()
    })
  })
})

const wizardMessages = {
  en: { setup: en.setup, caughtErrors: en.caughtErrors },
  fr: { setup: fr.setup, caughtErrors: fr.caughtErrors },
}

describe("SetupWizard language-first onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.convexAuthenticated = true
    mocks.ownerSessionReady = true
    mocks.claimAvailable = true
    mocks.ownerEstablished = false
    mocks.role = "viewer"
    mocks.progress = {
      account: false,
      identity: false,
      locales: false,
      ai: false,
      finished: false,
    }
    mocks.session = null
    mocks.httpQuery.mockResolvedValue({ available: true })
    mocks.createOwnerAccount.mockResolvedValue({ status: "created" })
    mocks.bootstrapInstallation.mockResolvedValue({
      phase: "snapshot_active",
      revision: 1,
      onboardingCompletedAt: 1,
    })
    mocks.setAdminLocale.mockResolvedValue(null)
    mocks.mutation.mockResolvedValue(null)
    mocks.signIn.mockResolvedValue({ status: "complete" })
    mocks.useMutation.mockImplementation((reference) => {
      const name = getFunctionName(reference)
      if (name === "cms/owner:createOwnerAccount") {
        return mocks.createOwnerAccount
      }
      if (name === "cms/settings:bootstrapInstallation") {
        return mocks.bootstrapInstallation
      }
      if (name === "cms/userPreferences:setAdminLocale") {
        return mocks.setAdminLocale
      }
      return mocks.mutation
    })
    mocks.useQuery.mockImplementation((reference, args) => {
      if (args === "skip") return undefined
      const name = getFunctionName(reference)
      if (name === "cms/settings:getOnboardingProgress") return mocks.progress
      if (name === "cms/owner:getOwnerClaimAvailability") {
        return { available: mocks.claimAvailable }
      }
      if (name === "cms/owner:getOwnerEstablished") {
        return { established: mocks.ownerEstablished }
      }
      if (name === "cms/userPreferences:getAdminLocale") {
        return mocks.storedAdminLocale
      }
      if (name === "cms/owner:getOwnerSession") {
        return {
          ownerId: "owner-1",
          authId: "owner-1",
          email: null,
          displayName: "First Owner",
          role: mocks.role,
          permissions: [],
        }
      }
      return undefined
    })
  })

  test("a fresh install opens on language and region, then account, then site identity", async () => {
    render(<SetupWizard />, "en", { stayOnLanguage: true })

    expect(
      screen.getByText("Language and region: step 1 of 3")
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Site language")).toBeInTheDocument()
    expect(screen.getByLabelText("Timezone")).toBeInTheDocument()
    expect(screen.queryByLabelText("Owner setup code")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled()
    expect(screen.getByTestId("timezone-now")).toHaveTextContent(/·\s*\d\d:\d\d/)

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(screen.getByText("Account: step 2 of 3")).toBeInTheDocument()
    expect(screen.getByLabelText("Owner setup code")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(
      screen.getByText("Language and region: step 1 of 3")
    ).toBeInTheDocument()
  })

  test("a resumed owner sees language first, then sign-in, then the site identity", () => {
    mocks.progress = {
      account: true,
      identity: false,
      locales: false,
      ai: false,
      finished: false,
    }
    mocks.ownerEstablished = true
    mocks.role = "admin"
    mocks.session = { signedIn: true }

    const view = render(<SetupWizard />, "en", { stayOnLanguage: true })
    expect(
      screen.getByText("Language and region: step 1 of 3")
    ).toBeInTheDocument()

    mocks.session = null
    mocks.convexAuthenticated = false
    view.rerender(<SetupWizard />)
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(
      screen.getByRole("heading", { name: "Sign in to resume setup" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Username")).toBeInTheDocument()

    mocks.session = { signedIn: true }
    mocks.convexAuthenticated = true
    view.rerender(<SetupWizard />)
    expect(screen.getByText("Site identity: step 3 of 3")).toBeInTheDocument()
  })

  test("prefills the language and time zone from the saved settings of a signed-in owner", () => {
    mocks.ownerEstablished = true
    mocks.role = "admin"
    mocks.session = { signedIn: true }
    const baseQuery = mocks.useQuery.getMockImplementation()!
    mocks.useQuery.mockImplementation((reference, args) => {
      if (
        args !== "skip" &&
        getFunctionName(reference) === "cms/settings:getSettings"
      ) {
        return { defaultLocale: "es", timezone: "America/Toronto" }
      }
      return baseQuery(reference, args)
    })

    render(<SetupWizard />, "en", { stayOnLanguage: true })

    expect(screen.getByLabelText("Site language")).toHaveValue("es")
    expect(screen.getByLabelText("Timezone")).toHaveValue("America/Toronto")
  })

  test("re-renders the whole wizard in French as soon as French is chosen", () => {
    render(<SetupWizard messages={wizardMessages} />, "en", {
      stayOnLanguage: true,
    })
    expect(screen.getByText("Language and region: step 1 of 3")).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("Site language"), {
      target: { value: "fr" },
    })

    expect(
      screen.getByText("Langue et région : étape 1 sur 3")
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Langue du site")).toBeInTheDocument()
    expect(document.documentElement.lang).toBe("fr")
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }))
    expect(screen.getByLabelText("Code de configuration du propriétaire")).toBeInTheDocument()
    expect(screen.getByLabelText("Nom d’utilisateur")).toBeInTheDocument()
  })

  test("a locale without an admin dictionary keeps the wizard in English with one short note", () => {
    render(<SetupWizard messages={wizardMessages} />, "en", {
      stayOnLanguage: true,
    })
    expect(screen.queryByTestId("language-english-note")).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("Site language"), {
      target: { value: "ja" },
    })

    expect(screen.getByLabelText("Site language")).toHaveValue("ja")
    // The hint must not promise setup/admin in a language they cannot use.
    expect(
      screen.getByText(
        "Choose the site’s starting language. After setup, turn on Multilingual in Settings to add more languages."
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/Setup and your admin use it too/)).toBeNull()
    expect(screen.getByTestId("language-english-note")).toHaveTextContent(
      "Setup and your admin stay in English for this language. Your site will still use it."
    )
    expect(
      screen.getByText("Language and region: step 1 of 3")
    ).toBeInTheDocument()
    expect(document.documentElement.lang).toBe("en")
  })

  test("account creation needs a matching confirmation and has show/hide eyes", async () => {
    render(<SetupWizard />)

    expect(screen.getByLabelText("Username")).toBeInTheDocument()
    expect(
      screen.getByText(
        "You’ll use it to sign in. Never shown on your site."
      )
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Owner" },
    })
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "owner@example.com" },
    })
    fireEvent.change(screen.getByLabelText("Owner setup code"), {
      target: { value: "one-time-owner-code" },
    })
    fireEvent.change(screen.getByLabelText("Account password (min 10 chars)"), {
      target: { value: "password123" },
    })
    const create = screen.getByRole("button", { name: "Create account" })
    expect(create).toBeDisabled()

    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "password12" },
    })
    expect(screen.getByRole("alert")).toHaveTextContent("Passwords don’t match.")
    expect(create).toBeDisabled()

    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "password123" },
    })
    expect(screen.queryByText("Passwords don’t match.")).not.toBeInTheDocument()
    expect(create).toBeEnabled()

    const password = screen.getByLabelText("Account password (min 10 chars)")
    const confirm = screen.getByLabelText("Confirm password")
    expect(password).toHaveAttribute("type", "password")
    const eyes = screen.getAllByRole("button", { name: "Show password" })
    expect(eyes).toHaveLength(2)
    expect(eyes[0]).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(eyes[0]!)
    expect(password).toHaveAttribute("type", "text")
    expect(confirm).toHaveAttribute("type", "password")
    expect(
      screen.getByRole("button", { name: "Hide password" })
    ).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }))
    expect(password).toHaveAttribute("type", "password")
  })

  test("the resume sign-in keeps one password field with an eye and the plain Username label", () => {
    mocks.progress = {
      account: true,
      identity: false,
      locales: false,
      ai: false,
      finished: false,
    }
    mocks.ownerEstablished = true

    render(<SetupWizard />)

    expect(screen.getByLabelText("Username")).toBeInTheDocument()
    expect(screen.queryByLabelText("Confirm password")).not.toBeInTheDocument()
    const password = screen.getByLabelText("Account password")
    expect(password).toHaveAttribute("type", "password")
    fireEvent.click(screen.getByRole("button", { name: "Show password" }))
    expect(password).toHaveAttribute("type", "text")
  })

  test("the bootstrap receives the language and time zone chosen on step 1", async () => {
    mocks.ownerEstablished = true
    mocks.role = "admin"
    mocks.session = { signedIn: true }
    mocks.progress = {
      account: true,
      identity: false,
      locales: false,
      ai: false,
      finished: false,
    }

    render(<SetupWizard messages={wizardMessages} />, "en", {
      stayOnLanguage: true,
    })
    fireEvent.change(screen.getByLabelText("Site language"), {
      target: { value: "fr" },
    })
    fireEvent.change(screen.getByLabelText("Fuseau horaire"), {
      target: { value: "Europe/Paris" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }))
    fireEvent.change(screen.getByLabelText("Nom du site"), {
      target: { value: "Mon site" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Terminer la configuration" })
    )

    await waitFor(() =>
      expect(mocks.bootstrapInstallation).toHaveBeenCalledWith({
        siteName: "Mon site",
        siteUrl: window.location.origin,
        siteDescription: undefined,
        timezone: "Europe/Paris",
        defaultLocale: "fr",
      })
    )
  })

  test.each([
    { locale: "fr", saved: true },
    { locale: "en", saved: true },
    { locale: "ja", saved: false },
  ])(
    "saves the admin language $locale only when an admin dictionary exists ($saved)",
    async ({ locale, saved }) => {
      mocks.ownerEstablished = true
      mocks.role = "admin"
      mocks.session = { signedIn: true }

      render(<SetupWizard messages={wizardMessages} />, "en", {
        stayOnLanguage: true,
      })
      fireEvent.change(screen.getByLabelText("Site language"), {
        target: { value: locale },
      })
      expect(mocks.setAdminLocale).not.toHaveBeenCalled()
      fireEvent.click(
        screen.getByRole("button", {
          name: locale === "fr" ? "Continuer" : "Continue",
        })
      )

      if (saved) {
        await waitFor(() =>
          expect(mocks.setAdminLocale).toHaveBeenCalledWith({ locale })
        )
      } else {
        await act(async () => {})
        expect(mocks.setAdminLocale).not.toHaveBeenCalled()
      }
    }
  )

  test("resets a stored admin language to English when the new site language has no admin text, even after a reload", async () => {
    // A reload loses the per-session ref; the stored preference is the truth.
    mocks.storedAdminLocale = "fr"
    mocks.ownerEstablished = true
    mocks.role = "admin"
    mocks.session = { signedIn: true }

    render(<SetupWizard messages={wizardMessages} />, "en", {
      stayOnLanguage: true,
    })
    fireEvent.change(screen.getByLabelText("Site language"), {
      target: { value: "ja" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() =>
      expect(mocks.setAdminLocale).toHaveBeenCalledWith({ locale: "en" })
    )
  })

  test("Continue on step 1 locks in the values even when saved settings load afterwards", async () => {
    mocks.ownerEstablished = true
    mocks.role = "admin"
    mocks.session = { signedIn: true }
    mocks.progress = {
      account: true,
      identity: false,
      locales: false,
      ai: false,
      finished: false,
    }
    let settingsLoaded = false
    const baseQuery = mocks.useQuery.getMockImplementation()!
    mocks.useQuery.mockImplementation((reference, args) => {
      if (
        args !== "skip" &&
        getFunctionName(reference) === "cms/settings:getSettings"
      ) {
        return settingsLoaded
          ? { defaultLocale: "de", timezone: "Asia/Tokyo" }
          : undefined
      }
      return baseQuery(reference, args)
    })

    // Accept the browser-suggested values without touching the fields.
    const view = render(<SetupWizard />, "en", { stayOnLanguage: true })
    const confirmedLocale = (
      screen.getByLabelText("Site language") as HTMLSelectElement
    ).value
    const confirmedTimezone = (
      screen.getByLabelText("Timezone") as HTMLSelectElement
    ).value
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    settingsLoaded = true
    view.rerender(<SetupWizard />)
    fireEvent.change(screen.getByLabelText("Site name"), {
      target: { value: "My site" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }))

    await waitFor(() =>
      expect(mocks.bootstrapInstallation).toHaveBeenCalledWith(
        expect.objectContaining({
          timezone: confirmedTimezone,
          defaultLocale: confirmedLocale,
        })
      )
    )
    expect(confirmedLocale).not.toBe("de")
  })

  test("going Back and choosing another language saves the new admin language", async () => {
    mocks.ownerEstablished = true
    mocks.role = "admin"
    mocks.session = { signedIn: true }
    mocks.progress = {
      account: true,
      identity: false,
      locales: false,
      ai: false,
      finished: false,
    }

    render(<SetupWizard />, "en", { stayOnLanguage: true })
    fireEvent.change(screen.getByLabelText("Site language"), {
      target: { value: "fr" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() =>
      expect(mocks.setAdminLocale).toHaveBeenLastCalledWith({ locale: "fr" })
    )

    // Site identity -> account -> language, then pick another language.
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    fireEvent.change(screen.getByLabelText("Site language"), {
      target: { value: "en" },
    })
    expect(mocks.setAdminLocale).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() =>
      expect(mocks.setAdminLocale).toHaveBeenLastCalledWith({ locale: "en" })
    )
    expect(mocks.setAdminLocale).toHaveBeenCalledTimes(2)
  })

  test("going Back to a language without admin text resets the admin language to English", async () => {
    mocks.ownerEstablished = true
    mocks.role = "admin"
    mocks.session = { signedIn: true }
    mocks.progress = {
      account: true,
      identity: false,
      locales: false,
      ai: false,
      finished: false,
    }

    render(<SetupWizard />, "en", { stayOnLanguage: true })
    fireEvent.change(screen.getByLabelText("Site language"), {
      target: { value: "fr" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() =>
      expect(mocks.setAdminLocale).toHaveBeenLastCalledWith({ locale: "fr" })
    )

    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    fireEvent.change(screen.getByLabelText("Site language"), {
      target: { value: "ja" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() =>
      expect(mocks.setAdminLocale).toHaveBeenLastCalledWith({ locale: "en" })
    )
    expect(mocks.setAdminLocale).toHaveBeenCalledTimes(2)
  })

  test("the resume sign-in has a Back button that returns to the language step", () => {
    mocks.progress = {
      account: true,
      identity: false,
      locales: false,
      ai: false,
      finished: false,
    }
    mocks.ownerEstablished = true

    render(<SetupWizard />)

    expect(
      screen.getByRole("heading", { name: "Sign in to resume setup" })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByLabelText("Site language")).toBeInTheDocument()
    expect(
      screen.queryByRole("heading", { name: "Sign in to resume setup" })
    ).not.toBeInTheDocument()
  })

  test("a failure saving the admin language never blocks setup", async () => {
    mocks.ownerEstablished = true
    mocks.role = "admin"
    mocks.session = { signedIn: true }
    mocks.setAdminLocale.mockRejectedValue(new Error("offline"))

    render(<SetupWizard />)

    await waitFor(() => expect(mocks.setAdminLocale).toHaveBeenCalled())
    expect(screen.getByLabelText("Site name")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

function queryArgsFor(functionName: string) {
  return mocks.useQuery.mock.calls.find(
    ([reference]) => getFunctionName(reference) === functionName
  )?.[1]
}
