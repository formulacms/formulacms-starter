import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { ConvexError } from "convex/values"
import { NextIntlClientProvider } from "next-intl"
import { toast } from "sonner"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  setBrandingImage: vi.fn(),
  settings: undefined as unknown,
  aiGate: "off",
}))

vi.mock("convex/react", () => ({
  useQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/settings:getSettings") return mocks.settings
    if (name === "cms/settings:getBrandingUrls") {
      return { logo: null, favicon: null, og: null }
    }
    if (name === "cms/revalidate:getRevalidationHealth") {
      return { updateState: "ok" }
    }
    throw new Error(`Unexpected query: ${name}`)
  },
  useMutation: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/settings:updateSettings") return mocks.updateSettings
    if (name === "cms/settings:setBrandingImage") return mocks.setBrandingImage
    if (name === "cms/languageLifecycle:requeueUndeliveredLifecycleIntents") {
      return vi.fn()
    }
    throw new Error(`Unexpected mutation: ${name}`)
  },
}))
vi.mock("./admin-module-state-provider", () => ({
  useModuleGate: (id: string) => ({ state: id === "ai" ? mocks.aiGate : "off" }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("./media-picker", () => ({ MediaPicker: () => null }))
vi.mock("./revalidation-diagnostics", () => ({
  RevalidationDiagnostics: () => null,
}))

import { GeneralSettings } from "./general-settings"

function settingsDoc(overrides: Record<string, unknown> = {}) {
  return {
    siteName: "My site",
    siteUrl: "https://example.com",
    defaultLocale: "en",
    enabledLocales: ["en"],
    ...overrides,
  }
}

/** Radix tabs activate on mouse down. */
function openTab(tab: HTMLElement) {
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
}

function renderGeneral(locale: "en" | "fr" = "en") {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "fr" ? fr : en}
    >
      <GeneralSettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateSettings.mockResolvedValue(null)
  mocks.aiGate = "off"
})

describe("General settings: site description per language", () => {
  test("one language keeps a single description field and no tabs", () => {
    mocks.settings = settingsDoc({
      siteDescriptions: { en: "Hello" },
    })
    renderGeneral()
    expect(screen.getByLabelText("Site description")).toHaveValue("Hello")
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
  })

  test("a not-yet-moved legacy value shows for the default language", () => {
    mocks.settings = settingsDoc({ siteDescription: "Legacy" })
    renderGeneral()
    expect(screen.getByLabelText("Site description")).toHaveValue("Legacy")
  })

  test("several languages show one tab each, default first, with the site name still one field", async () => {
    mocks.settings = settingsDoc({
      defaultLocale: "fr",
      enabledLocales: ["en", "fr"],
      siteDescriptions: { fr: "Bonjour", en: "Hello" },
    })
    renderGeneral()
    const tabs = screen.getAllByRole("tab")
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      expect.stringContaining("Français"),
      expect.stringContaining("English"),
    ])
    expect(screen.getAllByLabelText("Site name")).toHaveLength(1)
    expect(screen.getByLabelText("Site description in Français")).toHaveValue(
      "Bonjour"
    )

    openTab(tabs[1]!)
    expect(screen.getByLabelText("Site description in English")).toHaveValue(
      "Hello"
    )
  })

  test("a language without a description gets a small amber dot, a written one nothing", () => {
    mocks.settings = settingsDoc({
      enabledLocales: ["en", "fr"],
      siteDescriptions: { en: "Hello" },
    })
    renderGeneral()
    const [english, french] = screen.getAllByRole("tab")
    expect(english!.querySelector("[aria-hidden]")).toBeNull()
    expect(english).toHaveTextContent("Has a description")
    const missing = french!.querySelector("[aria-hidden]")
    expect(missing).toHaveClass("bg-amber-500", "size-2", "rounded-full")
    expect(french).toHaveTextContent("No description yet")
  })

  test("the missing dot has a keyboard-reachable tooltip; a written language has none", async () => {
    mocks.settings = settingsDoc({
      enabledLocales: ["en", "fr"],
      siteDescriptions: { en: "Hello" },
    })
    renderGeneral()
    const [english, french] = screen.getAllByRole("tab")
    // Focus on the tab bubbles to the wrapper that triggers the tooltip.
    act(() => french!.focus())
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Not written yet")
    act(() => french!.blur())
    act(() => english!.focus())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })

  test("the selected tab keeps its active state and primary colours even when its tooltip is open", async () => {
    mocks.settings = settingsDoc({
      enabledLocales: ["en", "fr"],
      siteDescriptions: { en: "Hello" },
    })
    renderGeneral()
    const french = screen.getAllByRole("tab")[1]!
    openTab(french)
    act(() => french.focus())
    expect(await screen.findByRole("tooltip")).toBeInTheDocument()
    expect(french).toHaveAttribute("data-state", "active")
    expect(french).toHaveAttribute("aria-selected", "true")
    expect(french).toHaveClass(
      "data-[state=active]:bg-primary",
      "data-[state=active]:text-primary-foreground"
    )
  })

  test("editing a description enables Save; after saving, that tab's amber dot is gone", async () => {
    mocks.settings = settingsDoc({
      enabledLocales: ["en", "fr"],
      siteDescriptions: { en: "Hello" },
    })
    const view = renderGeneral()
    const save = screen.getByRole("button", { name: "Save changes" })
    expect(save).toBeDisabled()
    openTab(screen.getAllByRole("tab")[1]!)
    fireEvent.change(screen.getByLabelText("Site description in Français"), {
      target: { value: "Bonjour" },
    })
    // Not saved yet: the marker stays.
    expect(
      screen.getAllByRole("tab")[1]!.querySelector("[aria-hidden]")
    ).toHaveClass("bg-amber-500")
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledOnce())
    // The reactive settings query now returns the saved text.
    mocks.settings = settingsDoc({
      enabledLocales: ["en", "fr"],
      siteDescriptions: { en: "Hello", fr: "Bonjour" },
    })
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <GeneralSettings />
      </NextIntlClientProvider>
    )
    await waitFor(() =>
      expect(
        screen.getAllByRole("tab")[1]!.querySelector("[aria-hidden]")
      ).toBeNull()
    )
  })

  test("saves every enabled language's text and copies the default text on request", async () => {
    mocks.settings = settingsDoc({
      enabledLocales: ["en", "fr"],
      siteDescriptions: { en: "Hello" },
    })
    renderGeneral()
    openTab(screen.getAllByRole("tab")[1]!)
    fireEvent.click(screen.getByRole("button", { name: "Copy from English" }))
    expect(screen.getByLabelText("Site description in Français")).toHaveValue(
      "Hello"
    )
    fireEvent.change(screen.getByLabelText("Site description in Français"), {
      target: { value: "Bonjour" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledOnce())
    expect(mocks.updateSettings.mock.calls[0]![0]).toMatchObject({
      siteName: "My site",
      siteDescriptions: { en: "Hello", fr: "Bonjour" },
    })
    expect(mocks.updateSettings.mock.calls[0]![0]).not.toHaveProperty(
      "siteDescription"
    )
  })
})

describe("General settings: Brand voice", () => {
  test("shows the Brand voice field while AI is on", () => {
    mocks.aiGate = "on"
    mocks.settings = settingsDoc({ brandVoice: "Warm and direct." })
    renderGeneral()
    expect(screen.getByLabelText("Brand voice")).toHaveValue("Warm and direct.")
  })

  test("hides the Brand voice field while AI is off and saves the stored voice", async () => {
    mocks.aiGate = "off"
    mocks.settings = settingsDoc({ brandVoice: "Warm and direct." })
    renderGeneral()
    expect(screen.queryByLabelText("Brand voice")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Site name"), {
      target: { value: "Renamed site" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledOnce())
    expect(mocks.updateSettings.mock.calls[0]![0]).toMatchObject({
      siteName: "Renamed site",
      brandVoice: "Warm and direct.",
    })
  })
})

const SITE_URL_MESSAGE = {
  en: "Enter a full web address, such as https://example.com",
  fr: "Saisissez une adresse web complète, par exemple https://example.com",
} as const

function generalLabels(locale: "en" | "fr") {
  const messages = locale === "fr" ? fr : en
  return {
    siteUrl: messages.settings.general.identity.siteUrl,
    save: messages.settings.common.save,
  }
}

describe("General settings: Site address check", () => {
  test.each([
    ["en", "https:example.com"],
    ["en", "https:/example.com"],
    ["en", "http:example.com"],
    ["en", "https//example.com"],
    ["en", "example.com"],
    ["en", "ftp://example.com"],
    ["fr", "example.com"],
  ] as const)(
    "%s: %s is refused under the field and nothing saves until corrected",
    async (locale, typed) => {
      mocks.settings = settingsDoc()
      renderGeneral(locale)
      const labels = generalLabels(locale)
      const message = SITE_URL_MESSAGE[locale]
      const field = screen.getByLabelText(labels.siteUrl)
      fireEvent.change(field, { target: { value: typed } })
      fireEvent.click(screen.getByRole("button", { name: labels.save }))
      await act(async () => {})

      expect(mocks.updateSettings).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
      const error = screen.getByText(message)
      expect(field.closest(".space-y-2")).toContainElement(error)
      expect(field).toHaveAttribute("aria-invalid", "true")
      expect(field).toHaveFocus()
      expect(field).toHaveAccessibleDescription(
        expect.stringContaining(message)
      )

      fireEvent.change(field, { target: { value: "http://127.0.0.1:3000" } })
      expect(screen.queryByText(message)).not.toBeInTheDocument()
      expect(field).not.toHaveAttribute("aria-invalid", "true")
      fireEvent.click(screen.getByRole("button", { name: labels.save }))
      await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledOnce())
      expect(mocks.updateSettings.mock.calls[0]![0]).toMatchObject({
        siteUrl: "http://127.0.0.1:3000",
      })
    }
  )

  test("an empty Site address still saves", async () => {
    mocks.settings = settingsDoc()
    renderGeneral()
    fireEvent.change(screen.getByLabelText(generalLabels("en").siteUrl), {
      target: { value: "" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledOnce())
    expect(mocks.updateSettings.mock.calls[0]![0]).toMatchObject({ siteUrl: "" })
    expect(screen.queryByText(SITE_URL_MESSAGE.en)).not.toBeInTheDocument()
  })

  test.each(["en", "fr"] as const)(
    "%s: a server refusal of the Site address shows the same field message",
    async (locale) => {
      mocks.settings = settingsDoc()
      mocks.updateSettings.mockRejectedValue(
        new ConvexError({ code: "SITE_URL_INVALID" })
      )
      renderGeneral(locale)
      const labels = generalLabels(locale)
      const message = SITE_URL_MESSAGE[locale]
      const field = screen.getByLabelText(labels.siteUrl)
      fireEvent.change(field, { target: { value: "https://www.example.org" } })
      fireEvent.click(screen.getByRole("button", { name: labels.save }))

      const error = await screen.findByText(message)
      expect(mocks.updateSettings).toHaveBeenCalledOnce()
      expect(toast.success).not.toHaveBeenCalled()
      expect(field.closest(".space-y-2")).toContainElement(error)
      expect(field).toHaveAttribute("aria-invalid", "true")
      expect(field).toHaveFocus()
      expect(field).toHaveAccessibleDescription(
        expect.stringContaining(message)
      )
    }
  )
})
