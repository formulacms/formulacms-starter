import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { ConfirmProvider } from "@/components/providers/confirm-provider"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { EmailSettings } from "./email-settings"

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  save: vi.fn(),
  activate: vi.fn(),
  deactivate: vi.fn(),
  check: vi.fn(),
  sendTest: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
  useMutation: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "email:saveEmailProviderConfiguration") return mocks.save
    if (name === "email:activateEmailProvider") return mocks.activate
    if (name === "email:deactivateEmailProvider") return mocks.deactivate
    throw new Error(`Unexpected email settings mutation: ${name}`)
  },
  useAction: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "email:checkEmailProviderConfiguration") return mocks.check
    if (name === "email:sendTestEmail") return mocks.sendTest
    throw new Error(`Unexpected email settings action: ${name}`)
  },
}))

vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}))

const owner = {
  ownerId: "owner-row",
  authId: "owner-auth",
  email: "owner@example.com",
  role: "admin" as const,
}

const catalogue = [
  {
    id: "resend",
    label: "Resend",
    description: "Transactional email delivery through Resend.",
    registered: true,
    bundled: true,
    documentationUrl: "https://resend.com/docs",
  },
  {
    id: "custom",
    label: "Custom provider",
    description:
      "Register a reviewed provider implementation in this application build.",
    registered: false,
    bundled: false,
    documentationUrl:
      "https://github.com/convex/better-auth/tree/main/examples/next",
  },
]

function emailSettings(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    catalogue,
    configuredProviderId: null,
    activeProviderId: null,
    readiness: "fallback",
    configurationVersion: 0,
    ...overrides,
  }
}

let ownerState: typeof owner | null | undefined
let settingsState: Record<string, unknown> | undefined

function emailSettingsTree(locale: "en" | "fr" = "en") {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "fr" ? fr : en}
    >
      <ConfirmProvider>
        <EmailSettings />
      </ConfirmProvider>
    </NextIntlClientProvider>
  )
}

function renderEmailSettings(locale: "en" | "fr" = "en") {
  return render(emailSettingsTree(locale))
}

const activeResend = {
  configuredProviderId: "resend",
  activeProviderId: "resend",
  readiness: "ready",
  sender: { address: "sender@example.com" },
  configurationVersion: 4,
}

beforeEach(() => {
  vi.clearAllMocks()
  ownerState = owner
  settingsState = emailSettings()
  mocks.useQuery.mockImplementation((reference, args) => {
    const name = getFunctionName(reference)
    if (name === "cms/owner:getOwnerSession") return ownerState
    if (name === "email:getEmailProviderSettings") {
      return args === "skip" ? undefined : settingsState
    }
    throw new Error(`Unexpected email settings query: ${name}`)
  })
  mocks.save.mockResolvedValue({
    providerId: "resend",
    configurationVersion: 1,
    status: "configured",
  })
  mocks.activate.mockResolvedValue({
    providerId: "resend",
    configurationVersion: 1,
    status: "active",
  })
  mocks.deactivate.mockResolvedValue({
    providerId: "resend",
    configurationVersion: 5,
    status: "configured",
  })
  mocks.check.mockResolvedValue({
    providerId: "resend",
    readiness: "ready",
  })
  mocks.sendTest.mockResolvedValue({
    status: "queued",
    configurationVersion: 1,
  })
})

describe("EmailSettings E05 provider flow", () => {
  test("shows the truthful fallback first and hides sender and test controls", () => {
    renderEmailSettings()

    expect(
      screen.getByRole("heading", { name: "No delivery provider active" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Messages are not sent until you add and activate a provider."
      )
    ).toBeInTheDocument()
    expect(screen.queryByLabelText("From address")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Send test email" })
    ).not.toBeInTheDocument()
  })

  test("shows the provider list with nothing configured, without an add button or search box", () => {
    renderEmailSettings()

    expect(
      screen.getByRole("region", { name: "Email providers" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Resend/ })).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Custom provider/ })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Add email provider" })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument()
    expect(
      screen.queryByPlaceholderText("Search providers")
    ).not.toBeInTheDocument()
  })

  test("keeps an unregistered provider documentation-only", () => {
    renderEmailSettings()
    fireEvent.click(screen.getByRole("button", { name: /Custom provider/ }))

    const documentation = screen.getByRole("link", {
      name: "Add this provider",
    })
    expect(documentation).toHaveAttribute(
      "href",
      "https://github.com/convex/better-auth/tree/main/examples/next"
    )
    expect(documentation).toHaveAttribute("target", "_blank")
    expect(mocks.save).not.toHaveBeenCalled()
  })

  test("implements mobile list-to-detail navigation inside the desktop split view", () => {
    renderEmailSettings()
    const list = screen.getByRole("region", { name: "Email providers" })
    expect(list).toHaveClass("block")

    fireEvent.click(screen.getByRole("button", { name: /Resend/ }))
    expect(list).toHaveClass("hidden")
    const back = screen.getByRole("button", { name: "Back to providers" })
    expect(back).toHaveClass("lg:hidden")

    fireEvent.click(back)
    expect(list).toHaveClass("block")
  })

  test("shows missing and ready server setup without exposing a credential", async () => {
    settingsState = emailSettings({
      configuredProviderId: "resend",
      readiness: "needs_setup",
      sender: { address: "sender@example.com", name: "Example" },
      configurationVersion: 1,
    })
    const view = renderEmailSettings()

    expect(screen.getByText("Not detected")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Send test email" })
    ).toBeDisabled()
    expect(screen.queryByText(/secret-resend-key/i)).not.toBeInTheDocument()

    mocks.check.mockResolvedValueOnce({
      providerId: "resend",
      readiness: "ready",
    })
    fireEvent.click(screen.getByRole("button", { name: "Check configuration" }))
    await waitFor(() =>
      expect(screen.getByText("Detected")).toBeInTheDocument()
    )
    expect(
      screen.getByRole("button", { name: "Send test email" })
    ).toBeEnabled()

    view.unmount()
  })

  test("keeps activation disabled until the current test is provider-accepted", () => {
    settingsState = emailSettings({
      configuredProviderId: "resend",
      readiness: "ready",
      sender: { address: "sender@example.com" },
      configurationVersion: 3,
      lastTest: { state: "queued", updatedAt: 100 },
    })
    const view = renderEmailSettings()
    expect(screen.getByText(/Test queued/)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Activate Resend" })
    ).toBeDisabled()

    settingsState = emailSettings({
      configuredProviderId: "resend",
      readiness: "ready",
      sender: { address: "sender@example.com" },
      configurationVersion: 3,
      lastTest: {
        state: "provider_accepted",
        receiptExpiresAt: Date.now() + 60_000,
        updatedAt: 101,
      },
    })
    view.rerender(emailSettingsTree())
    expect(screen.getByText(/Provider accepted the test/)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Activate Resend" })
    ).toBeEnabled()
  })

  test.each([
    ["failed", "The provider did not accept the test."],
    ["unknown", "Delivery is uncertain. Send a new test before activation."],
  ])("shows truthful %s test state", (state, copy) => {
    settingsState = emailSettings({
      configuredProviderId: "resend",
      readiness: "ready",
      sender: { address: "sender@example.com" },
      configurationVersion: 2,
      lastTest: {
        state,
        reason: state === "unknown" ? "delivery_unknown" : "provider_rejected",
        updatedAt: 100,
      },
    })
    renderEmailSettings()
    expect(screen.getByText(copy)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Activate Resend" })
    ).toBeDisabled()
  })

  test("shows active delivery without claiming inbox delivery", () => {
    settingsState = emailSettings(activeResend)
    renderEmailSettings()

    expect(
      screen.getByRole("heading", { name: "Resend is active" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/does not guarantee inbox delivery/)
    ).toBeInTheDocument()
    expect(screen.getByText("Resend is on.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Turn off" })).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Send test email" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Resend active|Activate Resend/ })
    ).not.toBeInTheDocument()
  })

  test("asks before turning the active provider off and Cancel changes nothing", async () => {
    settingsState = emailSettings(activeResend)
    renderEmailSettings()

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }))
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByRole("heading", { name: "Turn off Resend?" })
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        "Your site stops sending emails, including contact form messages and password resets. To turn it back on you'll send a new test."
      )
    ).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    )
    expect(mocks.deactivate).not.toHaveBeenCalled()
    expect(mocks.success).not.toHaveBeenCalled()
  })

  test("confirm calls deactivateEmailProvider with the provider id and confirms with a toast", async () => {
    settingsState = emailSettings(activeResend)
    renderEmailSettings()

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off" }))

    await waitFor(() =>
      expect(mocks.deactivate).toHaveBeenCalledWith({ providerId: "resend" })
    )
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("Resend is off")
    )
    expect(mocks.error).not.toHaveBeenCalled()
  })

  test("disables Turn off while the call runs and reports a failure", async () => {
    settingsState = emailSettings(activeResend)
    let rejectCall: ((reason: unknown) => void) | undefined
    mocks.deactivate.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectCall = reject
      })
    )
    renderEmailSettings()

    const button = screen.getByRole("button", { name: "Turn off" })
    fireEvent.click(button)
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off" }))
    await waitFor(() => expect(button).toBeDisabled())

    rejectCall?.(new Error("CMS_EMAIL_PROVIDER_CONFIGURATION_REQUIRED"))
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "Resend was not turned off. Try again."
      )
    )
    expect(button).toBeEnabled()
    expect(mocks.success).not.toHaveBeenCalled()
  })

  test("shows the French status sentence, button and dialog", async () => {
    settingsState = emailSettings(activeResend)
    renderEmailSettings("fr")

    expect(screen.getByText("Resend est activé.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Désactiver" }))
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByRole("heading", { name: "Désactiver Resend ?" })
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        "Votre site n’enverra plus d’e-mails, y compris les messages du formulaire de contact et les réinitialisations de mot de passe. Pour le réactiver, vous devrez envoyer un nouveau test."
      )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole("button", { name: "Annuler" })
    ).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: "Désactiver" }))
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("Resend est désactivé")
    )
  })

  test("shows sending state and queues only the owner-derived test action", async () => {
    settingsState = emailSettings({
      configuredProviderId: "resend",
      readiness: "ready",
      sender: { address: "sender@example.com" },
      configurationVersion: 1,
    })
    let resolveTest:
      | ((value: { status: "queued"; configurationVersion: number }) => void)
      | undefined
    mocks.sendTest.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTest = resolve
      })
    )
    renderEmailSettings()

    const button = screen.getByRole("button", { name: "Send test email" })
    fireEvent.click(button)
    expect(button).toBeDisabled()
    expect(mocks.sendTest).toHaveBeenCalledWith({})

    resolveTest?.({ status: "queued", configurationVersion: 1 })
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(
        "Test queued. Provider acceptance is still pending."
      )
    )
  })

  test("does not run the protected settings query for a non-owner", () => {
    ownerState = null
    renderEmailSettings()

    expect(
      screen.getByText(
        "Only the site owner can change email delivery settings."
      )
    ).toBeInTheDocument()
    const settingsCall = mocks.useQuery.mock.calls.find(
      ([reference]) =>
        getFunctionName(reference) === "email:getEmailProviderSettings"
    )
    expect(settingsCall?.[1]).toBe("skip")
  })
})
