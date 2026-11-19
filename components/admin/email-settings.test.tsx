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
  enable: vi.fn(),
  disable: vi.fn(),
  check: vi.fn(),
  sendTest: vi.fn(),
  setNotificationEmail: vi.fn(),
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
  useMutation: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "email:saveEmailProviderConfiguration") return mocks.save
    if (name === "email:enableEmailProvider") return mocks.enable
    if (name === "email:disableEmailProvider") return mocks.disable
    if (name === "cms/owner:setNotificationEmail") {
      return mocks.setNotificationEmail
    }
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
  toast: Object.assign(mocks.toast, {
    success: mocks.success,
    error: mocks.error,
  }),
}))

const owner = {
  ownerId: "owner-row",
  authId: "owner-auth",
  email: null,
  role: "admin" as const,
}

// The server's catalogue (convex/lib/email/providerMetadata.ts): SMTP, Resend
// and the unregistered documentation entry.
const catalogue = [
  {
    id: "smtp",
    label: "SMTP",
    description: "Send email through your own mail server with SMTP.",
    registered: true,
    bundled: true,
    documentationUrl: "https://nodemailer.com/smtp",
    environment: [
      { name: "EMAIL_SMTP_HOST", required: true, present: true },
      { name: "EMAIL_SMTP_PORT", required: false, present: true },
      { name: "EMAIL_SMTP_USER", required: true, present: true },
      { name: "EMAIL_SMTP_PASSWORD", required: true, present: true },
    ],
    readiness: "ready",
  },
  {
    id: "resend",
    label: "Resend",
    description: "Transactional email delivery through Resend.",
    registered: true,
    bundled: true,
    documentationUrl: "https://resend.com/docs",
    environment: [{ name: "RESEND_API_KEY", required: true, present: true }],
    readiness: "ready",
  },
  {
    id: "custom",
    label: "Custom provider",
    description:
      "Register a reviewed provider implementation in this application build.",
    registered: false,
    bundled: false,
    documentationUrl:
      "https://github.com/formulacms/formulacms-starter/blob/main/docs/starter/operations.md#register-another-email-provider",
  },
]

function emailSettings(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    catalogue,
    preselectedProviderId: "smtp",
    enabledProviderId: null,
    activeProviderId: null,
    readiness: "fallback",
    configurationVersion: 0,
    ...overrides,
  }
}

const sender = { address: "sender@example.com", name: "My Site" }
const smtpEnabled = {
  enabledProviderId: "smtp",
  readiness: "ready",
  sender,
  configurationVersion: 2,
}
const smtpActive = { ...smtpEnabled, activeProviderId: "smtp" }

const SMTP_NAMES = [
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_USER",
  "EMAIL_SMTP_PASSWORD",
  "EMAIL_SMTP_PORT",
]

function checked(
  readiness: "ready" | "needs_setup",
  present: Record<string, boolean>
) {
  return {
    providerId: "smtp",
    readiness,
    environment: SMTP_NAMES.map((name) => ({
      name,
      required: name !== "EMAIL_SMTP_PORT",
      present: present[name] ?? false,
    })),
  }
}

const allSmtpSet = {
  EMAIL_SMTP_HOST: true,
  EMAIL_SMTP_USER: true,
  EMAIL_SMTP_PASSWORD: true,
}

let ownerState: typeof owner | null | undefined
let settingsState: Record<string, unknown> | undefined
let notificationEmailState: string | null | undefined

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

const list = () => screen.getByRole("region", { name: "Email providers" })
const panel = (name = "SMTP") => screen.getByRole("region", { name })
const listRow = (id: string) =>
  document.querySelector(`[data-provider="${id}"]`) as HTMLElement
const checkButton = () =>
  screen.getByRole("button", { name: "Check configuration" })
const testButton = () => screen.getByRole("button", { name: "Send test email" })

async function check(result: ReturnType<typeof checked>) {
  mocks.check.mockResolvedValueOnce(result)
  fireEvent.click(checkButton())
  await waitFor(() => expect(mocks.check).toHaveBeenCalled())
}

beforeEach(() => {
  vi.clearAllMocks()
  ownerState = owner
  settingsState = emailSettings()
  notificationEmailState = "owner@example.com"
  mocks.useQuery.mockImplementation((reference, args) => {
    const name = getFunctionName(reference)
    if (name === "cms/owner:getOwnerSession") return ownerState
    if (name === "cms/owner:getNotificationEmail") {
      return args === "skip" ? undefined : notificationEmailState
    }
    if (name === "email:getEmailProviderSettings") {
      return args === "skip" ? undefined : settingsState
    }
    throw new Error(`Unexpected email settings query: ${name}`)
  })
  const stateResult = {
    enabledProviderId: "smtp",
    configurationVersion: 1,
    status: "inactive",
  }
  mocks.save.mockResolvedValue(stateResult)
  mocks.enable.mockResolvedValue(stateResult)
  mocks.disable.mockResolvedValue({
    enabledProviderId: null,
    configurationVersion: 3,
    status: "disabled",
  })
  mocks.check.mockResolvedValue(checked("ready", allSmtpSet))
  mocks.setNotificationEmail.mockResolvedValue({ status: "saved" })
  mocks.sendTest.mockResolvedValue({
    status: "queued",
    configurationVersion: 2,
  })
})

describe("EmailSettings first visit (step 1)", () => {
  test("opens SMTP with both providers disabled and inactive", () => {
    renderEmailSettings()

    expect(
      screen.getByRole("heading", { name: "No delivery provider active" })
    ).toBeInTheDocument()
    expect(list().querySelectorAll("[data-provider]")).toHaveLength(3)
    for (const id of ["smtp", "resend"]) {
      const row = within(listRow(id))
      const badge = row.getByText("Inactive")
      expect(badge).toHaveAttribute("data-variant", "outline")
      expect(row.getByRole("checkbox")).not.toBeChecked()
      expect(row.getByText("Disabled")).toBeInTheDocument()
    }
    const more = within(listRow("custom"))
    expect(more.getByText("More providers")).toBeInTheDocument()
    expect(
      more.getByText("Add another provider with a small code change.")
    ).toBeInTheDocument()
    expect(more.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(more.queryByText("Inactive")).not.toBeInTheDocument()
    expect(screen.queryByText("Default")).not.toBeInTheDocument()
    expect(screen.queryByText("Included")).not.toBeInTheDocument()

    const detail = within(panel())
    expect(
      detail.getByRole("checkbox", { name: "Turn SMTP on or off" })
    ).not.toBeChecked()
    expect(
      within(listRow("smtp")).getByText(
        "Send through any mail server: a Gmail account, your own host or a mail service."
      )
    ).toBeInTheDocument()
    expect(detail.getByTestId("provider-state-line")).toHaveTextContent(
      "SMTP is disabled. Enable it to use it for your site's email."
    )
    expect(detail.getByText("Not checked")).toBeInTheDocument()
    expect(
      Array.from(
        detail.getByTestId("setting-names").querySelectorAll("code")
      ).map((node) => node.textContent)
    ).toEqual(SMTP_NAMES)
    expect(detail.getByText("optional, 465 by default")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Activate|Turn off/ })
    ).not.toBeInTheDocument()
  })

  test("greys out the whole Server setup card while the provider is disabled (step 13)", () => {
    renderEmailSettings()
    const detail = within(panel())

    expect(checkButton()).toBeDisabled()
    const howTo = detail.getByTestId("how-to-set")
    expect(howTo.tagName).toBe("SPAN")
    expect(howTo).toHaveTextContent("How to set them")
    expect(howTo).toHaveClass("text-muted-foreground")
    expect(detail.queryByRole("link", { name: "How to set them" })).toBeNull()
    for (const node of detail
      .getByTestId("setting-names")
      .querySelectorAll("code")) {
      expect(node).toHaveClass("text-muted-foreground")
    }
    expect(detail.getByText("Not checked")).toHaveClass(
      "text-muted-foreground"
    )
    expect(testButton()).toBeDisabled()
  })
})

describe("EmailSettings sender (steps 2 and 9)", () => {
  test("saves only the sender, with no confirmation and no enable", async () => {
    renderEmailSettings()

    fireEvent.change(screen.getByLabelText("From address"), {
      target: { value: "hello@example.com" },
    })
    fireEvent.change(screen.getByLabelText("From name"), {
      target: { value: "My Site" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }))

    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        senderAddress: "hello@example.com",
        senderName: "My Site",
      })
    )
    expect(mocks.success).toHaveBeenCalledWith("Email configuration saved")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(mocks.enable).not.toHaveBeenCalled()
    expect(testButton()).toBeDisabled()
  })

  test("reports a sender the server refused", async () => {
    mocks.save.mockRejectedValueOnce(
      new Error("CMS_EMAIL_PROVIDER_CONFIGURATION_INVALID")
    )
    renderEmailSettings()

    fireEvent.change(screen.getByLabelText("From address"), {
      target: { value: "not-an-address" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }))

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "Email configuration was not saved. Check the sender details and try again."
      )
    )
  })
})

describe("EmailSettings enable control (steps 3, 10, 12, 13)", () => {
  test("enables a provider at once when nothing is enabled", async () => {
    renderEmailSettings()

    fireEvent.click(within(listRow("resend")).getByRole("checkbox"))

    await waitFor(() =>
      expect(mocks.enable).toHaveBeenCalledWith({ providerId: "resend" })
    )
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    // A click on the list control also opens that provider.
    expect(panel("Resend")).toBeInTheDocument()
  })

  test("shows an enabled provider as orange Inactive with a working Server setup card", () => {
    settingsState = emailSettings(smtpEnabled)
    renderEmailSettings()

    const row = within(listRow("smtp"))
    expect(row.getByRole("checkbox")).toBeChecked()
    expect(row.getByText("Enabled")).toBeInTheDocument()
    expect(row.getByText("Inactive")).toHaveClass("text-amber-600")
    const detail = within(panel())
    expect(detail.getByRole("checkbox")).toBeChecked()
    expect(
      detail.getAllByText("Inactive").every((badge) =>
        badge.classList.contains("text-amber-600")
      )
    ).toBe(true)
    expect(detail.getByTestId("provider-state-line")).toHaveTextContent(
      "SMTP is enabled but not active yet. It becomes active when the mail server accepts a test email."
    )
    expect(detail.getByTestId("provider-state-line")).toHaveClass(
      "text-amber-600"
    )
    expect(
      screen.getByRole("heading", { name: "No delivery provider active" })
    ).toBeInTheDocument()
    expect(checkButton()).toBeEnabled()
    const howTo = detail.getByRole("link", { name: "How to set them" })
    expect(howTo).toHaveAttribute("href", "https://nodemailer.com/smtp")
    expect(howTo).toHaveAttribute("target", "_blank")
    // Not checked yet: the test stays unavailable.
    expect(testButton()).toBeDisabled()
  })

  test("asks before switching to another provider; Cancel changes nothing", async () => {
    settingsState = emailSettings(smtpActive)
    renderEmailSettings()

    fireEvent.click(within(listRow("resend")).getByRole("checkbox"))
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByRole("heading", { name: "Switch to Resend?" })
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        "SMTP is disabled now. Your site sends no email until Resend passes a test."
      )
    ).toBeInTheDocument()
    const confirmButton = within(dialog).getByRole("button", {
      name: "Switch to Resend",
    })
    expect(confirmButton).toHaveClass("bg-destructive", "dark:bg-destructive")

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    )
    expect(mocks.enable).not.toHaveBeenCalled()
    // Resend opened with the click; SMTP stays enabled and active.
    expect(within(panel("Resend")).getByRole("checkbox")).not.toBeChecked()
    expect(within(listRow("smtp")).getByRole("checkbox")).toBeChecked()

    fireEvent.click(within(listRow("resend")).getByRole("checkbox"))
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Switch to Resend",
      })
    )
    await waitFor(() =>
      expect(mocks.enable).toHaveBeenCalledWith({ providerId: "resend" })
    )
    expect(mocks.disable).not.toHaveBeenCalled()
  })

  test("asks before disabling the active provider, then says it is off", async () => {
    settingsState = emailSettings(smtpActive)
    renderEmailSettings()

    fireEvent.click(within(panel()).getByRole("checkbox"))
    let dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByRole("heading", { name: "Turn off SMTP?" })
    ).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    )
    expect(mocks.disable).not.toHaveBeenCalled()

    fireEvent.click(within(panel()).getByRole("checkbox"))
    dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off" }))
    await waitFor(() =>
      expect(mocks.disable).toHaveBeenCalledWith({ providerId: "smtp" })
    )
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("SMTP is off")
    )
  })

  test("reports a failed disable of the active provider", async () => {
    settingsState = emailSettings(smtpActive)
    mocks.disable.mockRejectedValueOnce(new Error("failed"))
    renderEmailSettings()

    fireEvent.click(within(panel()).getByRole("checkbox"))
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Turn off",
      })
    )
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "SMTP was not turned off. Try again."
      )
    )
    expect(mocks.success).not.toHaveBeenCalled()
  })

  test("disables an enabled provider that is not active without asking", async () => {
    settingsState = emailSettings(smtpEnabled)
    renderEmailSettings()

    fireEvent.click(within(panel()).getByRole("checkbox"))
    await waitFor(() =>
      expect(mocks.disable).toHaveBeenCalledWith({ providerId: "smtp" })
    )
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(mocks.success).not.toHaveBeenCalled()
  })

  test("keeps the controls unavailable while a change runs", async () => {
    let finish: ((value: unknown) => void) | undefined
    mocks.enable.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    renderEmailSettings()

    const control = within(panel()).getByRole("checkbox")
    fireEvent.click(control)
    await waitFor(() => expect(control).toBeDisabled())
    expect(within(listRow("resend")).getByRole("checkbox")).toBeDisabled()
    finish?.({ enabledProviderId: "smtp", configurationVersion: 1, status: "inactive" })
    await waitFor(() => expect(control).toBeEnabled())
  })
})

describe("EmailSettings server setup check (steps 4, 5, 6)", () => {
  test("shows what is missing as an error", async () => {
    settingsState = emailSettings(smtpEnabled)
    renderEmailSettings()

    await check(checked("needs_setup", {}))

    expect(mocks.check).toHaveBeenCalledWith({ providerId: "smtp" })
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "SMTP server setup was not detected"
      )
    )
    expect(mocks.success).not.toHaveBeenCalled()
    const detail = within(panel())
    const badges = detail.getAllByText("Not detected")
    // The card badge and the three required rows.
    expect(badges).toHaveLength(4)
    expect(badges[0]).toHaveAttribute("data-variant", "destructive")
    expect(detail.getByText("Not set, 465 is used")).toBeInTheDocument()
    expect(testButton()).toBeDisabled()
  })

  test("detected setup is a success and allows the test", async () => {
    settingsState = emailSettings(smtpEnabled)
    renderEmailSettings()

    await check(checked("ready", allSmtpSet))

    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("SMTP server setup detected")
    )
    const detail = within(panel())
    expect(detail.getAllByText("Detected")).toHaveLength(4)
    expect(detail.getByText("Not set, 465 is used")).toBeInTheDocument()
    expect(testButton()).toBeEnabled()
  })

  test("keeps each provider's last check while the screen is open", async () => {
    settingsState = emailSettings(smtpEnabled)
    renderEmailSettings()
    await check(checked("ready", allSmtpSet))
    await waitFor(() => expect(testButton()).toBeEnabled())

    fireEvent.click(within(listRow("resend")).getByRole("button"))
    expect(within(panel("Resend")).getByText("Not checked")).toBeInTheDocument()
    fireEvent.click(within(listRow("smtp")).getByRole("button"))
    expect(within(panel()).getAllByText("Detected")).toHaveLength(4)
    expect(testButton()).toBeEnabled()
  })

  test("keeps the last check in grey and blocks the card and the test after a disable (step 13)", async () => {
    settingsState = emailSettings(smtpEnabled)
    const view = renderEmailSettings()
    await check(checked("ready", allSmtpSet))
    await waitFor(() => expect(testButton()).toBeEnabled())

    settingsState = emailSettings({ sender })
    view.rerender(emailSettingsTree())

    const detail = within(panel())
    const detected = detail.getAllByText("Detected")
    // The card badge and the three required rows are still there, in grey.
    expect(detected).toHaveLength(4)
    for (const node of detected) {
      const marked = node.closest("span") as HTMLElement
      expect(marked).toHaveClass("text-muted-foreground")
      expect(marked.className).not.toMatch(/emerald/)
    }
    expect(detail.getByTestId("how-to-set").tagName).toBe("SPAN")
    expect(checkButton()).toBeDisabled()
    expect(testButton()).toBeDisabled()
  })

  test("names Resend's single setting", () => {
    settingsState = emailSettings({ enabledProviderId: "resend" })
    renderEmailSettings()
    fireEvent.click(within(listRow("resend")).getByRole("button"))

    const detail = within(panel("Resend"))
    expect(detail.getByText("RESEND_API_KEY")).toBeInTheDocument()
    expect(
      detail.getByText("Set this on your server. Its value is never shown here.")
    ).toBeInTheDocument()
    expect(detail.getByRole("link", { name: "How to set it" })).toHaveAttribute(
      "href",
      "https://resend.com/docs"
    )
  })
})

describe("EmailSettings delivery test (steps 6, 7, 8)", () => {
  test.each([
    ["not enabled", { sender }],
    ["no sender", { enabledProviderId: "smtp" }],
  ])("keeps the test unavailable when %s", async (_, overrides) => {
    settingsState = emailSettings(overrides)
    renderEmailSettings()
    if (!checkButton().hasAttribute("disabled")) {
      await check(checked("ready", allSmtpSet))
      await waitFor(() => expect(mocks.success).toHaveBeenCalled())
    }
    expect(testButton()).toBeDisabled()
  })

  test("keeps the test unavailable while the sender has unsaved changes", async () => {
    settingsState = emailSettings(smtpEnabled)
    renderEmailSettings()
    await check(checked("ready", allSmtpSet))
    await waitFor(() => expect(testButton()).toBeEnabled())

    fireEvent.change(screen.getByLabelText("From name"), {
      target: { value: "Other" },
    })
    expect(testButton()).toBeDisabled()
  })

  test("queues the test and says so with a neutral notification", async () => {
    settingsState = emailSettings(smtpEnabled)
    renderEmailSettings()
    await check(checked("ready", allSmtpSet))
    await waitFor(() => expect(testButton()).toBeEnabled())
    mocks.success.mockClear()

    fireEvent.click(testButton())
    expect(mocks.sendTest).toHaveBeenCalledWith({})
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        "Test queued. Provider acceptance is still pending."
      )
    )
    expect(mocks.success).not.toHaveBeenCalled()
  })

  test("reports a blocked test", async () => {
    settingsState = emailSettings(smtpEnabled)
    mocks.sendTest.mockResolvedValueOnce({
      status: "blocked",
      reason: "owner_email_missing",
    })
    renderEmailSettings()
    await check(checked("ready", allSmtpSet))
    await waitFor(() => expect(testButton()).toBeEnabled())

    fireEvent.click(testButton())
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "Add a notification email above to send a test."
      )
    )
  })

  test.each([
    [
      "sign_in_refused",
      "Sign-in refused. Check EMAIL_SMTP_USER and EMAIL_SMTP_PASSWORD.",
    ],
    [
      "could_not_connect",
      "Could not connect. Check EMAIL_SMTP_HOST and EMAIL_SMTP_PORT.",
    ],
    [
      "secure_connection_failed",
      "Could not make a secure connection. The mail server needs a trusted certificate.",
    ],
    [
      "sender_refused",
      "The mail server refused the From address. Use an address this server allows.",
    ],
    ["message_refused", "The mail server refused the message."],
  ])("shows the %s reason under a refused test", (category, sentence) => {
    settingsState = emailSettings({
      ...smtpEnabled,
      lastTest: {
        providerId: "smtp",
        state: "failed",
        reason: "provider_rejected",
        category,
        updatedAt: 1,
      },
    })
    renderEmailSettings()

    const state = within(panel()).getByTestId("test-state")
    expect(state).toHaveClass("text-destructive")
    expect(state).toHaveTextContent("The provider did not accept the test.")
    expect(state).toHaveTextContent(sentence)
    expect(within(listRow("smtp")).getByText("Inactive")).toHaveClass(
      "text-amber-600"
    )
  })

  test("shows only the refusal line when the server gives no reason", () => {
    settingsState = emailSettings({
      ...smtpEnabled,
      lastTest: {
        providerId: "smtp",
        state: "failed",
        reason: "provider_rejected",
        updatedAt: 1,
      },
    })
    renderEmailSettings()

    expect(within(panel()).getByTestId("test-state").textContent).toBe(
      "The provider did not accept the test."
    )
  })

  test("shows an uncertain result in orange", () => {
    settingsState = emailSettings({
      ...smtpEnabled,
      lastTest: {
        providerId: "smtp",
        state: "unknown",
        reason: "delivery_unknown",
        updatedAt: 1,
      },
    })
    renderEmailSettings()

    const state = within(panel()).getByTestId("test-state")
    expect(state).toHaveTextContent(
      "Delivery is uncertain. Send a new test before activation."
    )
    expect(state).toHaveClass("text-amber-600")
  })

  test("shows a provider's result only on its own panel", () => {
    settingsState = emailSettings({
      ...smtpEnabled,
      lastTest: { providerId: "smtp", state: "queued", updatedAt: 1 },
    })
    renderEmailSettings()
    expect(within(panel()).getByTestId("test-state")).toHaveTextContent(
      "Test queued. Waiting for the provider result."
    )

    fireEvent.click(within(listRow("resend")).getByRole("button"))
    expect(within(panel("Resend")).queryByTestId("test-state")).toBeNull()
  })

  test("an accepted test shows the provider active in three places and says so once", async () => {
    settingsState = emailSettings({
      ...smtpEnabled,
      lastTest: { providerId: "smtp", state: "queued", updatedAt: 1 },
    })
    const view = renderEmailSettings()
    expect(mocks.success).not.toHaveBeenCalled()

    settingsState = emailSettings({ ...smtpActive, configurationVersion: 2 })
    view.rerender(emailSettingsTree())

    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("SMTP activated")
    )
    expect(
      screen.getByRole("heading", { name: "SMTP is active" })
    ).toBeInTheDocument()
    const badges = screen.getAllByText("Active")
    // The top card, the list row and the panel title.
    expect(badges).toHaveLength(3)
    for (const badge of badges) expect(badge).toHaveClass("text-emerald-600")
    expect(within(panel()).getByTestId("test-state")).toHaveTextContent(
      "The mail server accepted the test. SMTP is active."
    )
    expect(within(panel()).getByTestId("test-state")).toHaveClass(
      "text-emerald-600"
    )
    expect(within(panel()).queryByTestId("provider-state-line")).toBeNull()

    view.rerender(emailSettingsTree())
    expect(mocks.success).toHaveBeenCalledTimes(1)
  })

  test("does not announce a provider that was already active when the screen opened", () => {
    settingsState = emailSettings(smtpActive)
    renderEmailSettings()

    expect(mocks.success).not.toHaveBeenCalled()
  })

  test("a refused re-test of the active provider keeps it active", () => {
    settingsState = emailSettings({
      ...smtpActive,
      lastTest: {
        providerId: "smtp",
        state: "failed",
        reason: "provider_rejected",
        category: "sign_in_refused",
        updatedAt: 1,
      },
    })
    renderEmailSettings()

    expect(screen.getAllByText("Active")).toHaveLength(3)
    expect(within(panel()).getByTestId("test-state")).toHaveTextContent(
      "The provider did not accept the test."
    )
  })
})

describe("EmailSettings More providers (step 14)", () => {
  test("lists the services and opens the developer guide", () => {
    renderEmailSettings()
    fireEvent.click(within(listRow("custom")).getByRole("button"))

    const detail = within(panel("More providers"))
    expect(
      detail.getByText(
        "The email library in formulacms supports these services. A developer adds one in a few steps."
      )
    ).toBeInTheDocument()
    expect(detail.getByText("Postmark")).toBeInTheDocument()
    expect(detail.getByText("Microsoft Graph")).toBeInTheDocument()
    const guide = detail.getByRole("link", { name: "Open the developer guide" })
    expect(guide).toHaveAttribute(
      "href",
      "https://github.com/formulacms/formulacms-starter/blob/main/docs/starter/operations.md#register-another-email-provider"
    )
    expect(guide).toHaveAttribute("target", "_blank")
    expect(
      detail.getByText("Most of these services also work today through SMTP.")
    ).toBeInTheDocument()
    expect(detail.queryByRole("checkbox")).toBeNull()
    expect(detail.queryByText("Inactive")).toBeNull()
  })
})

describe("EmailSettings narrow screen (step 16)", () => {
  test("opens SMTP, hides the list and goes back to it", async () => {
    renderEmailSettings()
    expect(list()).toHaveClass("hidden")

    fireEvent.click(within(panel()).getByRole("checkbox"))
    await waitFor(() =>
      expect(mocks.enable).toHaveBeenCalledWith({ providerId: "smtp" })
    )

    const back = screen.getByRole("button", { name: "Back to providers" })
    expect(back).toHaveClass("lg:hidden")
    fireEvent.click(back)
    expect(list()).toHaveClass("block")
  })
})

describe("EmailSettings in French (step 15)", () => {
  test("first visit, enabled and active words", () => {
    settingsState = emailSettings()
    const view = renderEmailSettings("fr")
    const detail = within(screen.getByRole("region", { name: "SMTP" }))
    expect(within(listRow("smtp")).getByText("Inactif")).toBeInTheDocument()
    expect(within(listRow("smtp")).getByText("Désactivé")).toBeInTheDocument()
    expect(detail.getByTestId("provider-state-line")).toHaveTextContent(
      "SMTP est désactivé. Activez-le pour l’utiliser pour les e-mails de votre site."
    )
    expect(
      screen.getByRole("button", { name: "Vérifier la configuration" })
    ).toBeDisabled()
    expect(within(listRow("custom")).getByText("Autres fournisseurs")).toBeInTheDocument()

    settingsState = emailSettings(smtpEnabled)
    view.rerender(emailSettingsTree("fr"))
    expect(within(listRow("smtp")).getByText("Activé")).toBeInTheDocument()
    expect(detail.getByTestId("provider-state-line")).toHaveTextContent(
      "SMTP est activé mais pas encore actif. Il devient actif quand le serveur de messagerie accepte un e-mail de test."
    )

    settingsState = emailSettings(smtpActive)
    view.rerender(emailSettingsTree("fr"))
    expect(detail.getByTestId("test-state")).toHaveTextContent(
      "Le serveur de messagerie a accepté le test. SMTP est actif."
    )
    expect(screen.getAllByText("Actif")).toHaveLength(3)
    expect(mocks.success).toHaveBeenCalledWith("SMTP activé")
  })

  test("switch confirmation and notifications", async () => {
    settingsState = emailSettings(smtpEnabled)
    renderEmailSettings("fr")

    mocks.check.mockResolvedValueOnce(checked("needs_setup", {}))
    fireEvent.click(
      screen.getByRole("button", { name: "Vérifier la configuration" })
    )
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "Configuration serveur SMTP non détectée"
      )
    )
    expect(screen.getByText("Non défini, 465 est utilisé")).toBeInTheDocument()

    fireEvent.click(within(listRow("resend")).getByRole("checkbox"))
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByRole("heading", { name: "Passer à Resend ?" })
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        "SMTP est désactivé dès maintenant. Votre site n’envoie aucun e-mail tant que Resend n’a pas réussi un test."
      )
    ).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: "Annuler" }))
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    )
    expect(mocks.enable).not.toHaveBeenCalled()
    fireEvent.click(within(listRow("resend")).getByRole("checkbox"))
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Passer à Resend",
      })
    )
    await waitFor(() =>
      expect(mocks.enable).toHaveBeenCalledWith({ providerId: "resend" })
    )
  })
})

describe("EmailSettings access", () => {
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

describe("EmailSettings notifications card (ADR-0056 rule 5)", () => {
  const saveButton = () => screen.getByRole("button", { name: "Save" })
  const field = () => screen.getByLabelText("Notification email (optional)")

  test("Save turns on only when the field differs from the saved value", () => {
    renderEmailSettings()

    expect(field()).toHaveValue("owner@example.com")
    expect(saveButton()).toBeDisabled()
    fireEvent.change(field(), { target: { value: "other@example.com" } })
    expect(saveButton()).toBeEnabled()
    fireEvent.change(field(), { target: { value: "owner@example.com" } })
    expect(saveButton()).toBeDisabled()
  })

  test("saves the trimmed email and says Saved", async () => {
    notificationEmailState = null
    renderEmailSettings()

    fireEvent.change(field(), { target: { value: "  owner@example.com " } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Saved"))
    expect(mocks.setNotificationEmail).toHaveBeenCalledWith({
      email: "owner@example.com",
    })
  })

  test("an emptied field clears the saved email", async () => {
    renderEmailSettings()

    fireEvent.change(field(), { target: { value: "" } })
    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(mocks.setNotificationEmail).toHaveBeenCalledWith({ email: null })
    )
  })

  test("an invalid email is refused with the shared message", async () => {
    notificationEmailState = null
    mocks.setNotificationEmail.mockResolvedValue({ status: "invalid_email" })
    renderEmailSettings()

    fireEvent.change(field(), { target: { value: "not-an-email" } })
    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("Enter a valid email address.")
    )
    expect(mocks.success).not.toHaveBeenCalled()
    expect(saveButton()).toBeEnabled()
  })

  test("the sender and test lines name the notification email", () => {
    renderEmailSettings()

    expect(
      screen.getByText(
        "This identity appears in the From field. Contact notifications go to the notification email."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Send a fixed test only to owner@example.com. The provider becomes active when the test is accepted."
      )
    ).toBeInTheDocument()
  })

  test("without a notification email the test line names the owner account", () => {
    notificationEmailState = null
    renderEmailSettings()

    expect(
      screen.getByText(
        "Send a fixed test only to the site owner's account. The provider becomes active when the test is accepted."
      )
    ).toBeInTheDocument()
  })

  test("skips the notification email query for a non-owner", () => {
    ownerState = null
    renderEmailSettings()

    const call = mocks.useQuery.mock.calls.find(
      ([reference]) =>
        getFunctionName(reference) === "cms/owner:getNotificationEmail"
    )
    expect(call?.[1]).toBe("skip")
  })
})
