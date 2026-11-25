import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { getFunctionName, type FunctionReturnType } from "convex/server"
import { ConvexError } from "convex/values"
import { beforeEach, expect, test, vi } from "vitest"
import { LOCAL_API_KEY_NAMES } from "@/lib/local-api-keys"
import { api } from "@/convex/_generated/api"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import AiSettingsPage from "@/app/(core)/admin/(authenticated)/settings/ai/page"
import { ADMIN_AI_SETTINGS_SERVER_BINDING } from "@/components/admin/contributions/ai-settings.server"
import { SettingsAiScreen, statusWord, type LocalToolStatus } from "./ai-settings-screen"

const mocks = vi.hoisted(() => ({
  gate: "on", status: undefined as unknown, creator: undefined as unknown, save: vi.fn(), saveCreator: vi.fn(), refreshLists: vi.fn(), success: vi.fn(), refresh: vi.fn(), error: vi.fn(), info: vi.fn(), replace: vi.fn(), failStatus: false,
  queries: [] as [string, unknown][],
  urlListeners: new Set<() => void>(),
}))
vi.mock("./admin-module-state-provider", () => ({ useModuleGate: () => ({ state: mocks.gate }) }))
// The page reads .env.local at each call; here the reader maps the stubbed
// environment (`setLocalKeys`) instead, so no test reads a real .env.local.
vi.mock("@/lib/local-api-keys-file", async () => {
  const { localProviderKeyPresence } = await import("@/lib/local-api-keys")
  return { localProviderKeyPresenceNow: () => localProviderKeyPresence(process.env) }
})
// `useSearchParams` follows `history.pushState`, as Next.js does (no server render).
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react")
  const subscribe = (listener: () => void) => { mocks.urlListeners.add(listener); return () => { mocks.urlListeners.delete(listener) } }
  return {
    useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
    notFound: () => { throw new Error("NEXT_NOT_FOUND") },
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => "")),
  }
})
vi.mock("convex/react", () => ({
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference)
    mocks.queries.push([name, args])
    if (name === "cms/aiSettings:blockCreator") return args === "skip" ? undefined : mocks.creator
    expect(name).toBe("cms/aiSettings:status")
    if (mocks.failStatus) throw new Error("Status unavailable")
    return mocks.status
  },
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference)
    if (name === "cms/aiSettings:setBlockCreator") return mocks.saveCreator
    if (name === "cms/vendorModelCatalog:refreshModelCatalogs") return mocks.refreshLists
    expect(name).toBe("cms/aiSettings:setAssistant")
    return mocks.save
  },
}))
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error, info: mocks.info, dismiss: vi.fn() } }))

type Status = NonNullable<FunctionReturnType<typeof api.cms.aiSettings.status>>
type Assistant = Status["assistants"][number]
function fixture(): Status {
  const anthropic = { mode: "catalog", provider: "anthropic", model: "claude-sonnet-5-5", reasoning: { kind: "effort", effort: "high" } } as const
  const openai = { mode: "catalog", provider: "openai", model: "gpt-6.1-terra", reasoning: { kind: "effort", effort: "low" } } as const
  const openrouter = { mode: "catalog", provider: "openrouter", model: "new/provider-default", reasoning: { kind: "effort", effort: "medium" } } as const
  return {
    connections: [
      { provider: "anthropic", state: "connected", envVar: "ANTHROPIC_API_KEY" },
      { provider: "openrouter", state: "connected", envVar: "OPENROUTER_API_KEY" },
      { provider: "openai", state: "connected", envVar: "OPENAI_API_KEY" },
    ],
    card: { state: "active" },
    assistants: (["writing", "translation", "help"] as const).map((id) => ({
      id, available: true, provider: "anthropic", ready: true, effective: anthropic, tuple: anthropic,
      defaults: { anthropic, openrouter: id === "translation" ? { ...openrouter, reasoning: { kind: "effort", effort: "high" } } : openrouter, openai },
      choices: {
        anthropic: [
          { model: anthropic.model, name: "Sonnet", efforts: ["low", "medium", "high"], providerDefault: "high" },
          { model: "new/medium", name: "Medium only", efforts: ["medium"], providerDefault: "medium" },
          { model: "new/low", name: "Low only", efforts: ["low"], providerDefault: "low" },
          { model: "new/no-effort", name: "Effortless", efforts: [], providerDefault: null },
        ],
        openrouter: [{ model: openrouter.model, name: "Provider default", efforts: ["high", "medium", "low"], providerDefault: "medium" }],
        openai: [{ model: openai.model, name: "Terra", efforts: ["low", "high"], providerDefault: "low" }],
      },
    })),
  }
}
type Creator = FunctionReturnType<typeof api.cms.aiSettings.blockCreator>
function creatorFixture(): Creator {
  const anthropic = { mode: "catalog", provider: "anthropic", model: "claude-opus-5-5", reasoning: { kind: "effort", effort: "high" } } as const
  const openrouter = { mode: "catalog", provider: "openrouter", model: "creator/default", reasoning: { kind: "effort", effort: "medium" } } as const
  const openai = { mode: "catalog", provider: "openai", model: "gpt-6.1-sol", reasoning: { kind: "effort", effort: "high" } } as const
  return {
    choices: {
      anthropic: [
        { model: anthropic.model, name: "Claude Opus 5.5", efforts: ["low", "medium", "high"], providerDefault: "high" },
        { model: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"], providerDefault: "high" },
      ],
      openrouter: [{ model: openrouter.model, name: "Creator default", efforts: ["medium"], providerDefault: "medium" }],
      openai: [{ model: openai.model, name: "Sol", efforts: ["high"], providerDefault: "high" }],
    },
    defaults: { anthropic, openrouter, openai },
    catalog: [],
    newerModels: [],
  }
}
function setLocalKeys(present: Partial<Record<keyof typeof LOCAL_API_KEY_NAMES, boolean>>) {
  for (const [provider, names] of Object.entries(LOCAL_API_KEY_NAMES) as [keyof typeof LOCAL_API_KEY_NAMES, readonly string[]][]) {
    for (const name of names) vi.stubEnv(name, "")
    if (present[provider]) vi.stubEnv(names[0], "test-key")
  }
}
function status() { return mocks.status as Status }
function assistant(id: Assistant["id"] = "writing") { return status().assistants.find((a) => a.id === id)! }
/** Renders the page; `local: false` renders the production body. */
async function mount(locale: "en" | "fr" = "en", { local = true } = {}) {
  const page = local ? await AiSettingsPage() : await ADMIN_AI_SETTINGS_SERVER_BINDING!.renderSettingsPage({ isLocal: false })
  return render(<NextIntlClientProvider locale={locale} messages={locale === "en" ? en : fr}>{page}</NextIntlClientProvider>)
}
/** Opens a tab from the AI rail, in the browser only. */
function openTab(tab: string) {
  fireEvent.click(screen.getByTestId(`rail-${tab}`))
}
function writing() { return within(screen.getByTestId("assistant-writing")) }
function effort(id = "writing") { return screen.getByTestId(`effort-${id}`) }
/** Opens a card's provider menu and returns it. */
async function providerMenu(id = "writing") {
  fireEvent.click(screen.getByTestId(`provider-${id}`))
  return within(await screen.findByTestId(`provider-menu-${id}`))
}
async function chooseProvider(provider: string, id = "writing") {
  fireEvent.click((await providerMenu(id)).getByTestId(`option-${provider}`))
}
async function chooseModel(name: string) {
  fireEvent.click(writing().getByRole("button", { name: "Writing assistant Model" }))
  fireEvent.click(await screen.findByRole("button", { name }))
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, "", "/admin/settings/ai")
  const push = History.prototype.pushState
  vi.spyOn(window.history, "pushState").mockImplementation(function (this: History, ...args: Parameters<History["pushState"]>) {
    push.apply(window.history, args)
    mocks.urlListeners.forEach((listener) => listener())
  })
  vi.unstubAllEnvs()
  setLocalKeys({ anthropic: true })
  mocks.gate = "on"
  mocks.failStatus = false
  mocks.status = fixture()
  mocks.creator = creatorFixture()
  mocks.queries = []
  mocks.save.mockResolvedValue(null)
  mocks.saveCreator.mockResolvedValue(null)
  mocks.refreshLists.mockResolvedValue(null)
})

test.each(["en", "fr"] as const)("Q screen %s shows effective settings, the rail and the Assistants tab", async (locale) => {
  await mount(locale, { local: false })
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(locale === "en" ? "AI" : "IA")
  // Restored approved status badge; description is associated and screen-reader only.
  expect(screen.getByTestId("ai-page-status")).toHaveTextContent(locale === "en" ? "Active" : "Actif")
  expect(document.getElementById("ai-description")).toHaveClass("sr-only")
  expect(screen.getByTestId("assistants")).toBeInTheDocument()
  expect([...screen.getByTestId("ai-rail").querySelectorAll("a")].map((a) => a.textContent))
    .toEqual(locale === "en" ? ["Assistants", "Anthropic APIReady", "OpenAI APIReady", "OpenRouter APIReady"] : ["Assistants", "Anthropic APIPrêt", "OpenAI APIPrêt", "OpenRouter APIPrêt"])
  expect(screen.getByTestId("rail-assistants")).toHaveAttribute("aria-current", "page")
  // No Block creator or subscription off localhost, and no billing words.
  expect(screen.queryByTestId("assistant-blockCreator")).not.toBeInTheDocument()
  expect(screen.queryByTestId("group-subscriptions")).not.toBeInTheDocument()
  expect(screen.queryByTestId("no-provider")).not.toBeInTheDocument()
  expect(effort()).toHaveValue("high")
  expect(screen.getByRole("button", { name: locale === "en" ? "Save" : "Enregistrer" })).toBeDisabled()
})

test("Provider uses status.defaults then the exact tuple is sent to setAssistant", async () => {
  await mount()
  await chooseProvider("openrouter")
  expect(screen.getByTestId("provider-writing")).toHaveTextContent("OpenRouter API")
  expect(writing().getByRole("button", { name: "Writing assistant Model" })).toHaveTextContent("Provider default")
  expect(effort()).toHaveValue("medium")
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: "writing", tuple: assistant().defaults.openrouter }))
  expect(mocks.save).toHaveBeenCalledTimes(1)
  expect(mocks.saveCreator).not.toHaveBeenCalled()
  expect(mocks.success).toHaveBeenCalledWith("Saved")
})

test.each([
  {
    locale: "en" as const,
    writingSummary: "Writes a whole new page from a short brief.",
    translationSummary: "Translates a whole page into a language that is still empty. You review it before saving.",
  },
  {
    locale: "fr" as const,
    writingSummary: "Écrit une nouvelle page entière à partir d'un court brief.",
    translationSummary: "Traduit une page entière dans une langue encore vide. Vous la relisez avant d'enregistrer.",
  },
])("AI Settings describes only whole-page writing and translation in $locale", async ({ locale, writingSummary, translationSummary }) => {
  await mount(locale)

  expect(screen.getByTestId("assistant-writing")).toHaveAccessibleDescription(writingSummary)
  expect(screen.getByTestId("assistant-translation")).toHaveAccessibleDescription(translationSummary)
  expect(screen.getByTestId("assistant-writing")).toHaveAttribute("aria-describedby", "assistant-summary-writing")
  expect(document.getElementById("assistant-presets")).toBeNull()
})

test("an explicit effective model is never replaced by an offered default", async () => {
  assistant().effective = { mode: "catalog", provider: "openrouter", model: "saved/removed", reasoning: { kind: "effort", effort: "high" } }
  await mount()
  expect(writing().getByRole("button", { name: "Writing assistant Model" })).toHaveTextContent("saved/removed")
  expect(effort()).toHaveValue("high")
})

test("legacy-chain display uses its exact first model, then choosing a model writes an explicit tuple", async () => {
  assistant().effective = { mode: "legacy", provider: "openrouter", model: "legacy/first" }
  await mount()
  expect(writing().getByRole("button", { name: "Writing assistant Model" })).toHaveTextContent("legacy/first")
  await chooseModel("Provider defaultnew/provider-default")
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: "writing", tuple: assistant().defaults.openrouter }))
})

test("search filters names and IDs, reports no match, and has no price/default row", async () => {
  await mount()
  fireEvent.click(writing().getByRole("button", { name: "Writing assistant Model" }))
  const search = await screen.findByRole("textbox", { name: "Search 4 models…" })
  expect(search).toHaveFocus()
  fireEvent.change(search, { target: { value: "NO-EFFORT" } })
  expect(screen.getByRole("button", { name: "Effortlessnew/no-effort" })).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Sonnetclaude-sonnet-5-5" })).not.toBeInTheDocument()
  fireEvent.change(search, { target: { value: "not-a-model" } })
  expect(screen.getByText('No models match “not-a-model”')).toBeInTheDocument()
  expect(screen.queryByText(/USD|\/ 1M|Default →/)).not.toBeInTheDocument()
})

test("model effort retains a supported value, else medium, else providerDefault; effortless saves no reasoning", async () => {
  await mount()
  await chooseModel("Sonnetclaude-sonnet-5-5")
  expect(effort()).toHaveValue("high")
  await chooseModel("Medium onlynew/medium")
  expect(effort()).toHaveValue("medium")
  await chooseModel("Low onlynew/low")
  expect(effort()).toHaveValue("low")
  await chooseModel("Effortlessnew/no-effort")
  expect(effort()).toBeDisabled()
  expect(effort()).toHaveDisplayValue("Not available for this model")
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: "writing", tuple: { mode: "catalog", provider: "anthropic", model: "new/no-effort" } }))
})

test("Translation effort is disabled high and unavailable Translation is hidden", async () => {
  const mounted = await mount()
  expect(effort("translation")).toBeDisabled()
  expect(effort("translation")).toHaveValue("high")
  assistant("translation").available = false
  mounted.rerender(<NextIntlClientProvider locale="en" messages={en}>{await AiSettingsPage()}</NextIntlClientProvider>)
  expect(screen.queryByTestId("assistant-translation")).not.toBeInTheDocument()
})

test.each(["en", "fr"] as const)("provider tabs in %s restore status, exact setup commands, models and Used by", async (locale) => {
  status().connections[0].state = "refused"
  status().connections[0].observedAt = Date.now()
  status().connections[1].state = "unreachable"
  status().connections[1].observedAt = Date.now()
  status().connections[2].state = "missing"
  await mount(locale, { local: false })
  openTab("anthropic-api")
  expect(screen.getByTestId("rail-anthropic-api")).toHaveAttribute("aria-current", "page")
  expect(screen.getByTestId("provider-status")).toHaveAttribute("data-word", "invalidKey")
  expect(screen.getByTestId("provider-refused")).toHaveTextContent("ANTHROPIC_API_KEY")
  expect(screen.getByTestId("steps-deployment-code")).toHaveTextContent(/^npx convex env set ANTHROPIC_API_KEY sk-ant-\.\.\.$/)
  expect(screen.getByTestId("steps-deployment")).toHaveTextContent(process.cwd())
  expect(screen.getByTestId("get-key-anthropic-api")).toHaveAttribute("href", "https://platform.claude.com/settings/keys")
  expect(screen.getByTestId("setup-anthropic")).toBeInTheDocument()
  expect(screen.getByTestId("provider-models")).toBeInTheDocument()
  expect(screen.getByTestId("used-by-names")).toHaveTextContent(locale === "en" ? "Writing assistant" : "Assistant de rédaction")
  expect(screen.queryByTestId("key-local")).not.toBeInTheDocument()
  openTab("openai-api")
  expect(screen.getByTestId("provider-status")).toHaveTextContent(locale === "en" ? "Not set up" : "Non configuré")
  expect(screen.getByTestId("steps-deployment-code")).toHaveTextContent("npx convex env set OPENAI_API_KEY sk-...")
  openTab("openrouter-api")
  expect(screen.getByTestId("provider-status")).toHaveAttribute("data-word", "ready")
  expect(screen.queryByTestId("setup-openrouter")).not.toBeInTheDocument()
  expect(screen.getByTestId("provider-unreachable")).toBeInTheDocument()
})

test.each(["en", "fr"] as const)("a missing local Block creator key in %s names the actual file and reload step", async (locale) => {
  setLocalKeys({})
  await mount(locale)
  openTab("anthropic-api")
  expect(screen.getByTestId("steps-local")).toHaveTextContent(`${process.cwd()}/.env.local`)
  expect(screen.getByTestId("steps-local")).toHaveTextContent(locale === "en" ? "reload this page" : "rechargez cette page")
  expect(screen.getByTestId("steps-local-code")).toHaveTextContent("FORMULACMS_DEV_ANTHROPIC_API_KEY=sk-ant-...")
  expect(screen.queryByTestId("setup-anthropic")).not.toBeInTheDocument()
})

test("a refused connection disables only its assistants; unreachable remains ready", async () => {
  status().connections[0].state = "refused"
  status().connections[1].state = "unreachable"
  assistant("help").effective = assistant("help").defaults.openrouter!
  await mount()
  expect(writing().getByRole("button", { name: "Writing assistant Model" })).toBeDisabled()
  expect(effort()).toBeDisabled()
  expect(screen.getByTestId("assistant-status-writing")).toHaveTextContent("Key refused")
  expect(screen.getByTestId("assistant-status-writing")).toHaveAttribute("data-tone", "warn")
  expect(screen.getByTestId("assistant-status-help")).toHaveTextContent("Ready")
  expect(within(screen.getByTestId("assistant-help")).getByRole("button", { name: "Help assistant Model" })).toBeEnabled()
  // The problem badge links to Your AI providers.
  fireEvent.click(screen.getByTestId("providers-link-writing"))
  expect(window.location.search).toBe("?tab=anthropic-api")
  expect(screen.getByTestId("provider-status")).toHaveAttribute("data-word", "invalidKey")
})

test("the provider menu groups API keys and shows a word only for a problem", async () => {
  status().connections[2].state = "refused"
  status().connections[1].state = "missing"
  await mount()
  const menu = await providerMenu()
  const group = menu.getByRole("group", { name: "API keys" })
  expect(within(group).getAllByRole("button").map((option) => option.textContent))
    .toEqual(["Anthropic API", "OpenAI API · Key refused", "OpenRouter API · Not set up"])
  expect(screen.getByTestId("provider-writing")).toHaveTextContent(/^Anthropic API$/)
})

test.each(["en", "fr"] as const)("a saved model the list no longer offers: Choose another model in %s, unless the key has a problem", async (locale) => {
  assistant("writing").effective = { ...assistant("writing").effective, model: "gone/model" }
  status().connections[1].state = "refused"
  assistant("help").effective = { ...assistant("help").defaults.openrouter!, model: "gone/model" }
  await mount(locale)
  const messages = (locale === "en" ? en : fr).settings.aiScreen
  expect(screen.getByTestId("assistant-status-writing")).toHaveTextContent(messages.chooseAnotherModel)
  expect(screen.getByTestId("assistant-status-writing")).toHaveAttribute("data-tone", "warn")
  expect(writing().getByRole("button", { name: new RegExp(`${messages.model}$`) })).toBeEnabled()
  // A provider with a problem keeps its own word first.
  expect(screen.getByTestId("assistant-status-help")).toHaveTextContent(messages.words.invalidKey)
  expect(screen.getByTestId("assistant-status-translation")).toHaveTextContent(messages.words.ready)
})

test.each(["en", "fr"] as const)("no provider set up in %s: each disabled card links directly to its setup", async (locale) => {
  status().connections.forEach((connection) => { connection.state = "missing" })
  setLocalKeys({})
  await mount(locale)
  const messages = (locale === "en" ? en : fr).settings.aiScreen
  expect(screen.queryByTestId("no-provider")).not.toBeInTheDocument()
  expect(screen.getAllByTestId(/^assistant-status-/)).toHaveLength(4)
  expect(screen.getByTestId("assistant-reason-writing")).toHaveTextContent(messages.words.notSetUp)
  expect(writing().getByRole("button", { name: new RegExp(`${messages.model}$`) })).toBeDisabled()
  expect(effort()).toBeDisabled()
  expect(within(screen.getByTestId("assistant-blockCreator")).getByRole("button", { name: new RegExp(`${messages.model}$`) })).toBeDisabled()
  fireEvent.click(screen.getByTestId("providers-link-writing"))
  expect(screen.getByTestId("provider-status")).toHaveTextContent(messages.words.notSetUp)
})

test.each(["en", "fr"] as const)("only a Block creator file key in %s: no no-provider line, assistants Not set up, Block creator Ready", async (locale) => {
  status().connections.forEach((connection) => { connection.state = "missing" })
  setLocalKeys({ anthropic: true })
  await mount(locale)
  const messages = (locale === "en" ? en : fr).settings.aiScreen
  expect(screen.queryByTestId("no-provider")).not.toBeInTheDocument()
  for (const id of ["writing", "translation", "help"]) {
    expect(screen.getByTestId(`assistant-status-${id}`)).toHaveTextContent(messages.words.notSetUp)
    expect(screen.getByTestId(`providers-link-${id}`)).toHaveTextContent("Anthropic API")
  }
  expect(screen.getByTestId("assistant-status-blockCreator")).toHaveTextContent(messages.words.ready)
})

test("live site with no key: the provider menu is disabled, as on main", async () => {
  status().connections.forEach((connection) => { connection.state = "missing" })
  await mount("en", { local: false })
  expect(screen.getByTestId("provider-writing")).toBeDisabled()
  expect(screen.getByTestId("assistant-reason-writing")).toHaveTextContent("Not set up")
  expect(screen.getByTestId("providers-link-writing")).toHaveAttribute("href", "?tab=anthropic-api")
})

test("instructions save and Reset clears the custom instructions", async () => {
  assistant().instructions = "Custom directions"
  await mount()
  expect(writing().getByLabelText("Instructions")).toHaveValue("Custom directions")
  fireEvent.click(writing().getByRole("button", { name: "Reset to default" }))
  expect(writing().getByRole("textbox")).toHaveValue(en.settings.aiScreen.tasks.writing.prompt)
  expect(writing().queryByRole("button", { name: "Reset to default" })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: "writing", tuple: assistant().effective }))
})

test("save refusal reuses the existing generic save error and preserves edits", async () => {
  mocks.save.mockRejectedValueOnce(new Error("INVALID_AI_ASSISTANT_SELECTION"))
  await mount()
  fireEvent.change(writing().getByRole("textbox"), { target: { value: "Unsaved instructions" } })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(en.settings.common.failedSave))
  expect(writing().getByRole("textbox")).toHaveValue("Unsaved instructions")
  expect(mocks.success).not.toHaveBeenCalled()
})

test.each(["en", "fr"] as const)("AI off in %s: only the off line with its Modules link, and no AI read", async (locale) => {
  const mounted = await mount(locale)
  expect(screen.getByTestId("assistants")).toBeInTheDocument()
  mocks.gate = "off"
  mocks.queries = []
  mounted.rerender(<NextIntlClientProvider locale={locale} messages={locale === "en" ? en : fr}>{await AiSettingsPage()}</NextIntlClientProvider>)
  expect(screen.getByTestId("ai-off")).toHaveTextContent(locale === "en" ? "AI is off. Turn it on in Modules." : "L’IA est désactivée. Activez-la dans Modules.")
  expect(screen.getByRole("link", { name: "Modules" })).toHaveAttribute("href", "/admin/settings/modules")
  expect(screen.queryByTestId("assistants")).not.toBeInTheDocument()
  expect(screen.queryByRole("heading")).not.toBeInTheDocument()
  expect(mocks.queries).toEqual([])
  expect(mocks.replace).not.toHaveBeenCalled()
})

test("needs_setup renders the screen; gate loading and error hide it", async () => {
  mocks.gate = "needs_setup"
  const mounted = await mount()
  expect(screen.getByTestId("assistants")).toBeInTheDocument()
  mocks.gate = "loading"
  mounted.rerender(<NextIntlClientProvider locale="en" messages={en}>{await AiSettingsPage()}</NextIntlClientProvider>)
  expect(screen.queryByTestId("assistants")).not.toBeInTheDocument()
  mocks.gate = "error"
  const report = vi.spyOn(console, "error").mockImplementation(() => {})
  mounted.rerender(<NextIntlClientProvider locale="en" messages={en}>{await AiSettingsPage()}</NextIntlClientProvider>)
  expect(screen.getByRole("alert")).toHaveTextContent("AI settings couldn't load")
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
  report.mockRestore()
})

test("S3 catalog drift: choosing a model always selects one of its offered efforts", async () => {
  assistant().effective = { mode: "catalog", provider: "openrouter", model: "google/gemini-3-flash-preview", reasoning: { kind: "effort", effort: "medium" } }
  assistant().choices.openrouter = [
    { model: "google/gemini-3-flash-preview", name: "Primary", efforts: ["medium"], providerDefault: "medium" },
    { model: "new/reasoning", name: "New reasoning model", efforts: ["low", "high"], providerDefault: "medium" },
  ]
  await mount()
  await chooseModel("New reasoning modelnew/reasoning")
  const offered = assistant().choices.openrouter[1].efforts
  expect(offered).toContain((effort() as HTMLSelectElement).value)
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalled())
  const saved = mocks.save.mock.calls[0][0]
  expect(offered).toContain(saved.tuple.reasoning.effort)
})

test("S3 model change uses an offered providerDefault before the first effort when medium is absent", async () => {
  assistant().effective = { mode: "catalog", provider: "openrouter", model: "current", reasoning: { kind: "effort", effort: "medium" } }
  assistant().choices.openrouter = [
    { model: "current", name: "Current", efforts: ["medium"], providerDefault: "medium" },
    { model: "new/default-high", name: "Default high", efforts: ["low", "high"], providerDefault: "high" },
  ]
  await mount()
  await chooseModel("Default highnew/default-high")
  expect(effort()).toHaveValue("high")
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: "writing", tuple: {
    mode: "catalog", provider: "openrouter", model: "new/default-high", reasoning: { kind: "effort", effort: "high" },
  } }))
})

test.each([{ efforts: ["low", "high"] }, { efforts: [] }] as const)("S3 refused saved effort stays visible and unchanged with offered efforts $efforts", async ({ efforts }) => {
  assistant().effective = { mode: "catalog", provider: "openrouter", model: "saved/refused", reasoning: { kind: "effort", effort: "medium" } }
  assistant().choices.openrouter = [{ model: "saved/refused", name: "Saved refused", efforts: [...efforts], providerDefault: "high" }]
  await mount()
  expect(effort()).toHaveValue("medium")
  fireEvent.change(writing().getByRole("textbox"), { target: { value: "Keep refused tuple" } })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: "writing", tuple: assistant().effective, instructions: "Keep refused tuple" }))
})

test.each([
  { id: "writing", nextEffort: undefined },
  { id: "writing", nextEffort: "medium" },
  { id: "help", nextEffort: undefined },
  { id: "help", nextEffort: "medium" },
] as const)("S3 saved absent reasoning shows Not set for $id before choosing $nextEffort", async ({ id, nextEffort }) => {
  const saved = assistant(id)
  saved.effective = { mode: "catalog", provider: "openrouter", model: "google/gemini-3-flash-preview" }
  saved.tuple = saved.effective
  saved.choices.openrouter = [{ model: saved.effective.model, name: "Gemini", efforts: ["high", "medium", "low"], providerDefault: "medium" }]
  await mount()
  const task = within(screen.getByTestId(`assistant-${id}`))
  const select = task.getByRole("combobox", { name: "Effort" })
  expect(select).toBeEnabled()
  expect(select).toHaveValue("")
  const selected = within(select).getByRole("option", { selected: true })
  expect(selected).toHaveTextContent(/^Not set$/)
  expect(selected).toBeDisabled()
  expect(within(select).getAllByRole("option")[0]).toBe(selected)
  expect(within(select).getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(["", "high", "medium", "low"])
  if (nextEffort) {
    fireEvent.change(select, { target: { value: nextEffort } })
    expect(select).toHaveValue("medium")
    expect(within(select).queryByRole("option", { name: "Not set" })).not.toBeInTheDocument()
  }
  fireEvent.change(task.getByRole("textbox"), { target: { value: "Keep saved choice" } })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({
    id,
    tuple: nextEffort ? { ...saved.effective, reasoning: { kind: "effort", effort: "medium" } } : saved.effective,
    instructions: "Keep saved choice",
  }))
  expect(mocks.save).toHaveBeenCalledTimes(1)
})

test.each(["en", "fr"] as const)("S3 saved absent reasoning shows disabled Translation Not set in %s", async (locale) => {
  const saved = assistant("translation")
  saved.effective = { mode: "catalog", provider: "openrouter", model: "google/gemini-3-flash-preview" }
  saved.tuple = saved.effective
  saved.choices.openrouter = [{ model: saved.effective.model, name: "Gemini", efforts: ["high", "medium", "low"], providerDefault: "medium" }]
  await mount(locale)
  const select = within(screen.getByTestId("assistant-translation")).getByRole("combobox", { name: "Effort" })
  expect(select).toBeDisabled()
  expect(document.getElementById("effort-locked-translation")).toHaveClass("sr-only")
  expect(select).toHaveAttribute("aria-describedby", "effort-locked-translation")
  expect(select).toHaveValue("")
  const selected = within(select).getByRole("option", { selected: true })
  expect(selected).toHaveTextContent(locale === "en" ? /^Not set$/ : /^Non défini$/)
  expect(selected).toBeDisabled()
})

test.each((["en", "fr"] as const).flatMap((locale) => (["anthropic", "openai", "openrouter"] as const).map((provider) => ({ locale, provider }))))
("$locale $provider: cards keep billing and hidden descriptions without model recommendation actions", async ({ locale, provider }) => {
  for (const item of status().assistants) {
    item.effective = item.defaults[provider]!
    item.newerModel = { provider, model: item.effective.model, name: "Suggested model" }
  }
  const creator = creatorFixture()
  const tuple = creator.defaults[provider]!
  mocks.creator = { ...creator, tuple, newerModels: [{ for: { provider, model: tuple.model }, provider, model: tuple.model, name: "Suggested model" }] }
  setLocalKeys({ [provider]: true })
  await mount(locale)
  for (const id of ["writing", "translation", "help", "blockCreator"]) {
    const card = within(screen.getByTestId(`assistant-${id}`))
    expect(card.getByLabelText("Instructions")).toBeInTheDocument()
    expect(screen.getByTestId(`assistant-status-${id}`)).toHaveTextContent(locale === "en" ? "Ready" : "Prêt")
    expect(screen.getByTestId(`top-line-${id}`)).toHaveTextContent((locale === "en" ? en : fr).settings.aiScreen.redesign.billing.api)
  }
  expect(screen.queryAllByTestId("newer-model")).toHaveLength(0)
  expect(screen.queryByRole("button", { name: /^(Use|Utiliser) Suggested model$/ })).not.toBeInTheDocument()
  expect(document.getElementById("effort-locked-translation")).toHaveClass("sr-only")
  expect(effort("translation")).toHaveAttribute("aria-describedby", "effort-locked-translation")
  expect(document.getElementById("assistant-summary-writing")).toHaveClass("sr-only")
  expect(document.querySelector('[data-slot="accordion-trigger"]')).toBeNull()
})

test.each((["en", "fr"] as const).flatMap((locale) => (["anthropic", "openai", "openrouter"] as const).map((provider) => ({ locale, provider }))))
("$locale $provider: one delivered key-status update unlocks all API assistants without a page reload", async ({ locale, provider }) => {
  for (const item of status().assistants) {
    item.effective = item.defaults[provider]!
    item.ready = false // Old per-assistant metadata must never override the shared connection.
  }
  status().connections.find((connection) => connection.provider === provider)!.state = "missing"
  const localKeys = { anthropic: false, openai: false, openrouter: false }
  // Render the same client tree again to deliver the next useQuery result.
  // Never call the server page/loader, refresh the router or remount the screen.
  const client = () => <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : fr}><SettingsAiScreen isLocal localKeys={localKeys} siteFolder="/site" /></NextIntlClientProvider>
  const mounted = render(client())
  for (const id of ["writing", "translation", "help"]) expect(screen.getByTestId(`assistant-status-${id}`)).toHaveAttribute("data-word", "notSetUp")
  const draft = within(screen.getByTestId("assistant-writing")).getByRole("textbox")
  fireEvent.change(draft, { target: { value: "Keep this unsaved instruction" } })
  const next = structuredClone(status())
  next.connections.find((connection) => connection.provider === provider)!.state = "connected"
  mocks.status = next
  mounted.rerender(client())
  expect(screen.getByTestId(`rail-dot-${provider}-api`)).toHaveClass("bg-emerald-500")
  expect(screen.getByTestId("ai-page-status")).toHaveTextContent(locale === "en" ? "Active" : "Actif")
  for (const id of ["writing", "translation", "help"]) {
    expect(screen.getByTestId(`assistant-status-${id}`)).toHaveAttribute("data-word", "ready")
    expect(screen.queryByTestId(`assistant-reason-${id}`)).not.toBeInTheDocument()
    expect(within(screen.getByTestId(`assistant-${id}`)).getByRole("button", { name: / (Model|Modèle)$/ })).toBeEnabled()
  }
  expect(effort("writing")).toBeEnabled()
  expect(effort("translation")).toBeDisabled()
  expect(draft).toHaveValue("Keep this unsaved instruction")
  expect(screen.getByTestId("assistant-status-blockCreator")).toHaveAttribute("data-word", "notSetUp")
  const options = await providerMenu()
  expect(options.getByTestId(`option-${provider}`)).not.toHaveTextContent(locale === "en" ? "Not set up" : "Non configuré")
  fireEvent.keyDown(document.activeElement!, { key: "Escape" })
  openTab(`${provider}-api`)
  expect(screen.getByTestId("provider-status")).toHaveTextContent(locale === "en" ? "Connected" : "Connecté")
  expect(mocks.refresh).not.toHaveBeenCalled()
  expect(mocks.save).not.toHaveBeenCalled()
})

test.each(["en", "fr"] as const)("%s: a connected OpenRouter key with no catalog never asks for key setup", async (locale) => {
  for (const item of status().assistants) {
    item.effective = item.defaults.openrouter!
    item.choices.openrouter = []
    item.defaults.openrouter = null
  }
  status().connections.find((connection) => connection.provider === "openrouter")!.state = "missing"
  const client = () => <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : fr}><SettingsAiScreen isLocal={false} siteFolder="/site" /></NextIntlClientProvider>
  const mounted = render(client())
  for (const id of ["writing", "translation", "help"]) expect(screen.getByTestId(`assistant-status-${id}`)).toHaveAttribute("data-word", "notSetUp")
  const connected = structuredClone(status())
  connected.connections.find((connection) => connection.provider === "openrouter")!.state = "connected"
  mocks.status = connected
  mounted.rerender(client())
  expect(screen.getByTestId("rail-dot-openrouter-api")).toHaveClass("bg-emerald-500")
  for (const id of ["writing", "translation", "help"]) {
    expect(screen.getByTestId(`assistant-status-${id}`)).toHaveAttribute("data-word", "chooseAnotherModel")
    expect(screen.queryByTestId(`assistant-reason-${id}`)).not.toBeInTheDocument()
    expect(screen.queryByTestId(`providers-link-${id}`)).not.toBeInTheDocument()
  }
  // A later catalog delivery makes the saved selections offered, on this same tree.
  const offered = fixture()
  const catalog = structuredClone(status())
  for (const item of catalog.assistants) {
    const entry = offered.assistants.find((candidate) => candidate.id === item.id)!
    item.choices.openrouter = entry.choices.openrouter
    item.defaults.openrouter = entry.defaults.openrouter
  }
  mocks.status = catalog
  mounted.rerender(client())
  for (const id of ["writing", "translation", "help"]) expect(screen.getByTestId(`assistant-status-${id}`)).toHaveAttribute("data-word", "ready")
  expect(mocks.refresh).not.toHaveBeenCalled()
  expect(mocks.refreshLists).not.toHaveBeenCalled()
})

test("an unknown or old provider tab shows Assistants", async () => {
  for (const tab of ["nope", "claude-code", "constructor"]) {
    window.history.replaceState(null, "", `/admin/settings/ai?tab=${tab}`)
    const mounted = await mount()
    expect(screen.getByTestId("assistants")).toBeInTheDocument()
    mounted.unmount()
  }
})

test("a tab change stays in the browser and keeps unsaved edits; Save sends them", async () => {
  await mount()
  fireEvent.change(writing().getByRole("textbox"), { target: { value: "Kept across tabs" } })
  openTab("anthropic-api")
  expect(window.location.search).toBe("?tab=anthropic-api")
  expect(screen.queryByTestId("assistants")).not.toBeInTheDocument()
  openTab("assistants")
  expect(window.location.search).toBe("?tab=assistants")
  expect(writing().getByRole("textbox")).toHaveValue("Kept across tabs")
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: "writing", tuple: assistant().effective, instructions: "Kept across tabs" }))
})

test("lists footer in the model picker: Refresh, then Updated once a list read succeeds; a refusal within 5 minutes says so", async () => {
  status().catalogSync = {
    anthropic: { status: "success", lastSuccessAt: new Date("2020-01-02T12:30:00Z").getTime(), keyRefused: false },
    openrouter: { status: "never", keyRefused: false },
    openai: { status: "success", lastSuccessAt: Date.now() - 60_000, keyRefused: false },
  }
  const mounted = await mount()
  const rerender = async () => mounted.rerender(<NextIntlClientProvider locale="en" messages={en}>{await AiSettingsPage()}</NextIntlClientProvider>)
  fireEvent.click(writing().getByRole("button", { name: "Writing assistant Model" }))
  expect(await screen.findByTestId("lists-updated")).toHaveTextContent(/Lists updated .*2020.* · Refresh/)
  mocks.refreshLists.mockRejectedValueOnce(new ConvexError({ kind: "RateLimited", name: "modelCatalogRefresh", retryAfter: 1000 }))
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  await waitFor(() => expect(mocks.refreshLists).toHaveBeenCalledTimes(1))
  expect(mocks.error).not.toHaveBeenCalled()
  mocks.refreshLists.mockResolvedValueOnce(null)
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  await waitFor(() => expect(mocks.refreshLists).toHaveBeenCalledTimes(2))
  status().catalogSync = { ...status().catalogSync!, anthropic: { status: "success", lastSuccessAt: new Date("2020-01-02T12:31:00Z").getTime(), keyRefused: false } }
  await rerender()
  await waitFor(() => expect(screen.getByTestId("lists-updated")).toHaveTextContent(/Updated$/))
})

test("switching Provider back restores the saved API choice, not the first row", async () => {
  assistant().effective = { mode: "catalog", provider: "anthropic", model: "new/low", reasoning: { kind: "effort", effort: "low" } }
  await mount()
  await chooseProvider("openai")
  expect(writing().getByRole("button", { name: "Writing assistant Model" })).toHaveTextContent("Terra")
  await chooseProvider("anthropic")
  expect(writing().getByRole("button", { name: "Writing assistant Model" })).toHaveTextContent("Low only")
  expect(effort()).toHaveValue("low")
})

function creator() { return within(screen.getByTestId("assistant-blockCreator")) }

test("Block creator is absent and its query skipped outside local development", async () => {
  await mount("en", { local: false })
  expect(screen.queryByTestId("assistant-blockCreator")).not.toBeInTheDocument()
  expect(mocks.queries.filter(([name]) => name === "cms/aiSettings:blockCreator").every(([, args]) => args === "skip")).toBe(true)
})

test("Block creator is absent when the page passes no local keys", async () => {
  render(<NextIntlClientProvider locale="en" messages={en}>{await ADMIN_AI_SETTINGS_SERVER_BINDING!.renderSettingsPage({ isLocal: true })}</NextIntlClientProvider>)
  expect(screen.getByTestId("assistants")).toBeInTheDocument()
  expect(screen.queryByTestId("assistant-blockCreator")).not.toBeInTheDocument()
  expect(mocks.queries.filter(([name]) => name === "cms/aiSettings:blockCreator").every(([, args]) => args === "skip")).toBe(true)
})

test("Block creator with its local key: Ready, after Help", async () => {
  await mount()
  const rows = [...screen.getByTestId("assistants").querySelectorAll("[data-testid^=assistant-]")].map((row) => row.getAttribute("data-testid"))
  expect(rows.filter((id) => !id!.startsWith("assistant-status"))).toEqual(["assistant-writing", "assistant-translation", "assistant-help", "assistant-blockCreator"])
  expect(screen.getByTestId("assistant-status-blockCreator")).toHaveTextContent("Ready")
  expect(screen.getByTestId("provider-blockCreator")).toHaveTextContent("Anthropic API")
  expect(creator().getByRole("button", { name: "Block creator Model" })).toHaveTextContent("Claude Opus 5.5")
})

test("Block creator with nothing saved uses the first provider that has a local key", async () => {
  setLocalKeys({ openai: true })
  await mount()
  expect(screen.getByTestId("provider-blockCreator")).toHaveTextContent("OpenAI API")
  expect(screen.getByTestId("assistant-status-blockCreator")).toHaveTextContent("Ready")
})

// The Block creator runs on its .env.local key; the assistants and the provider rows read the Convex key.
test.each([
  { file: true, convex: false, creatorWord: "ready", rowWord: "notSetUp" },
  { file: false, convex: true, creatorWord: "notSetUp", rowWord: "ready" },
  { file: true, convex: true, creatorWord: "ready", rowWord: "ready" },
  { file: false, convex: false, creatorWord: "notSetUp", rowWord: "notSetUp" },
] as const)("Block creator badge follows its .env.local key: file $file, Convex $convex", async ({ file, convex, creatorWord, rowWord }) => {
  setLocalKeys({ anthropic: file })
  // OpenRouter API and OpenAI API stay set up on Convex, so the no-provider line never hides the badges.
  status().connections[0].state = convex ? "connected" : "missing"
  await mount()
  expect(screen.getByTestId("provider-blockCreator")).toHaveTextContent(/^Anthropic API$/)
  const badge = screen.getByTestId("assistant-status-blockCreator")
  expect(badge).toHaveAttribute("data-word", creatorWord)
  expect(badge).toHaveTextContent(creatorWord === "ready" ? "Ready" : "Not set up")
  expect(badge).toHaveAttribute("data-tone", creatorWord === "ready" ? "ok" : "warn")
  const model = creator().getByRole("button", { name: "Block creator Model" })
  if (creatorWord === "ready") {
    expect(screen.queryByTestId("providers-link-blockCreator")).not.toBeInTheDocument()
    expect(model).toBeEnabled()
  } else {
    expect(screen.getByTestId("providers-link-blockCreator")).toHaveTextContent("Anthropic API")
    expect(model).toBeDisabled()
  }
  // Writing, on Anthropic API too, keeps the Convex word.
  expect(screen.getByTestId("assistant-status-writing")).toHaveAttribute("data-word", rowWord)
  openTab("anthropic-api")
  expect(screen.getByTestId("provider-status")).toHaveAttribute("data-word", rowWord)
})

test("Block creator with nothing saved and two local keys: the first in connection order, Ready from its file key", async () => {
  setLocalKeys({ openai: true, openrouter: true })
  status().connections[1].state = "missing"
  await mount()
  expect(screen.getByTestId("provider-blockCreator")).toHaveTextContent(/^OpenRouter API$/)
  expect(creator().getByRole("button", { name: "Block creator Model" })).toHaveTextContent("Creator default")
  expect(screen.getByTestId("assistant-status-blockCreator")).toHaveAttribute("data-word", "ready")
})

test("Block creator on a provider with a problem: its word, no key lines, and model and effort wait", async () => {
  mocks.creator = { ...creatorFixture(), tuple: { mode: "catalog", provider: "openrouter", model: "creator/default", reasoning: { kind: "effort", effort: "medium" } } }
  status().connections[1].state = "missing"
  await mount()
  expect(screen.getByTestId("assistant-status-blockCreator")).toHaveTextContent("Not set up")
  expect(creator().queryByText(/API_KEY|\.env\.local|restart/)).not.toBeInTheDocument()
  expect(creator().getByRole("button", { name: "Block creator Model" })).toBeDisabled()
  expect(effort("blockCreator")).toBeDisabled()
  // As on main: the Block creator's API services stay selectable.
  expect((await providerMenu("blockCreator")).getByTestId("option-anthropic")).toBeEnabled()
})

test("Block creator Save sends its tuple and instructions together, once, and never setAssistant", async () => {
  await mount()
  fireEvent.click(creator().getByRole("button", { name: "Block creator Model" }))
  fireEvent.click(await screen.findByRole("button", { name: "Claude Sonnet 5.5claude-sonnet-5-5" }))
  fireEvent.change(creator().getByRole("textbox"), { target: { value: "Prefer simple fields." } })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.saveCreator).toHaveBeenCalledWith({
    tuple: { mode: "catalog", provider: "anthropic", model: "claude-sonnet-5-5", reasoning: { kind: "effort", effort: "high" } },
    instructions: "Prefer simple fields.",
  }))
  expect(mocks.saveCreator).toHaveBeenCalledTimes(1)
  expect(mocks.save).not.toHaveBeenCalled()
})

test("Block creator keeps a saved choice and Reset clears saved instructions", async () => {
  mocks.creator = { ...creatorFixture(), tuple: { mode: "catalog", provider: "openrouter", model: "creator/default", reasoning: { kind: "effort", effort: "medium" } }, instructions: "Saved words" }
  await mount()
  expect(screen.getByTestId("provider-blockCreator")).toHaveTextContent("OpenRouter API")
  expect(creator().getByRole("textbox")).toHaveValue("Saved words")
  fireEvent.click(creator().getByRole("button", { name: "Reset to default" }))
  expect(creator().getByRole("textbox")).toHaveValue("")
  expect(creator().getByRole("textbox")).toHaveAttribute("placeholder", en.settings.aiScreen.blockCreator.prompt)
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.saveCreator).toHaveBeenCalledWith({ tuple: mocks.creator && (mocks.creator as Creator).tuple }))
})

test("the assistant badges are the same with and without the Block creator", async () => {
  const badges = () => ["assistant-status-writing", "assistant-status-translation", "assistant-status-help"].map((id) => screen.getByTestId(id).textContent)
  status().connections[1].state = "missing"
  const live = await mount("en", { local: false })
  const without = badges()
  live.unmount()
  setLocalKeys({})
  await mount()
  expect(screen.getByTestId("assistant-blockCreator")).toBeInTheDocument()
  expect(badges()).toEqual(without)
})

test("the word map keeps missing tools distinct from signed-out tools", () => {
  const connections = (state: "missing" | "refused" | "connected" | "unreachable") =>
    (["anthropic", "openrouter", "openai"] as const).map((provider) => ({ provider, state, envVar: "X" }))
  expect((["missing", "refused", "connected", "unreachable"] as const).map((state) => statusWord("openai", connections(state), undefined)))
    .toEqual(["notSetUp", "invalidKey", "ready", "ready"])
  const tools = (status: LocalToolStatus) => ({ tools: [{ tool: "claude" as const, status }, { tool: "codex" as const, status: "signed-out" as const }] })
  expect((["plan", "api-key", "unknown", "signed-out", "not-installed"] as const).map((status) => statusWord("claude", [], tools(status))))
    .toEqual(["ready", "ready", "ready", "signedOut", "notInstalled"])
  expect(statusWord("codex", [], undefined)).toBe("notInstalled")
})

test.each(["en", "fr"] as const)("API setup links in %s follow the actual connection state for every provider", async (locale) => {
  await mount(locale)
  for (const provider of ["anthropic", "openai", "openrouter"] as const) {
    const tab = `${provider}-api`
    for (const state of ["connected", "missing", "refused"] as const) {
      status().connections.find((connection) => connection.provider === provider)!.state = state
      openTab(tab)
      // Tab navigation re-renders with the latest query snapshot.
      expect(screen.queryByTestId(`setup-${provider}`) !== null).toBe(state !== "connected")
      expect(screen.queryByTestId("steps-deployment-code") !== null).toBe(state !== "connected")
      if (state !== "connected") expect(screen.getByTestId("steps-deployment-code")).toHaveTextContent(`npx convex env set ${provider.toUpperCase()}_API_KEY`)
      openTab("assistants")
    }
  }
})

test("Copy copies only the exact displayed command or local line and reports success and failure", async () => {
  setLocalKeys({})
  const writeText = vi.fn().mockResolvedValue(undefined)
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  try {
    status().connections[0].state = "missing"
    await mount()
    openTab("anthropic-api")
    fireEvent.click(screen.getByTestId("steps-deployment-copy"))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("npx convex env set ANTHROPIC_API_KEY sk-ant-..."))
    expect(screen.getByTestId("steps-deployment-copy")).toHaveAttribute("data-copy-state", "copied")
    fireEvent.click(screen.getByTestId("steps-local-copy"))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("FORMULACMS_DEV_ANTHROPIC_API_KEY=sk-ant-..."))
    writeText.mockRejectedValueOnce(new Error("Denied"))
    fireEvent.click(screen.getByTestId("steps-local-copy"))
    await waitFor(() => expect(screen.getByTestId("steps-local-copy")).toHaveAttribute("data-copy-state", "failed"))
    expect(screen.getByText("Could not copy. Select the text and copy it.")).toBeInTheDocument()
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original)
    else Reflect.deleteProperty(navigator, "clipboard")
  }
})

test.each(["en", "fr"] as const)("restored descriptions in %s are hidden, unique and associated with real owners", async (locale) => {
  await mount(locale)
  const check = () => {
    const owners = [...document.querySelectorAll("[aria-describedby]")]
    for (const helper of document.querySelectorAll<HTMLElement>("[data-helper-copy]")) {
      expect(helper).toHaveClass("sr-only")
      expect(helper.id).not.toBe("")
      expect(document.querySelectorAll(`[id="${helper.id}"]`)).toHaveLength(1)
      expect(owners.some((owner) => owner.getAttribute("aria-describedby")!.split(/\s+/).includes(helper.id))).toBe(true)
      expect(helper.closest("[aria-hidden=true], [hidden]")).toBeNull()
    }
    for (const li of document.querySelectorAll("ul > li")) expect(li.getAttribute("role")).toBeNull()
  }
  check()
  for (const tab of ["anthropic-api", "openai-api", "openrouter-api"]) { openTab(tab); check() }
})

test("provider model checks retain real provider timestamps on rate limiting and show newly offered rows after a successful read", async () => {
  const at = new Date("2026-11-22T12:30:00Z").getTime()
  status().catalogSync = {
    anthropic: { status: "success", lastSuccessAt: at, keyRefused: false },
    openrouter: { status: "never", keyRefused: false },
    openai: { status: "success", lastSuccessAt: at - 60_000, keyRefused: false },
  }
  const mounted = await mount()
  openTab("anthropic-api")
  const checked = screen.getByTestId("models-checked").textContent
  expect(screen.getAllByTestId("check-models")).toHaveLength(1)
  mocks.refreshLists.mockRejectedValueOnce(new ConvexError({ kind: "RateLimited", name: "modelCatalogRefresh", retryAfter: 1000 }))
  fireEvent.click(screen.getByTestId("check-models"))
  await waitFor(() => expect(screen.getByTestId("check-models")).toBeEnabled())
  expect(mocks.error).not.toHaveBeenCalled()
  expect(screen.getByTestId("models-checked").textContent).toBe(checked)
  fireEvent.click(screen.getByTestId("check-models"))
  await waitFor(() => expect(mocks.refreshLists).toHaveBeenCalledTimes(2))
  expect(screen.getByTestId("models-checked").textContent).toBe(checked)
  const newer = { model: "new/discovered", name: "Newly offered", efforts: ["high"] as const, providerDefault: "high" as const }
  assistant().choices.anthropic.push({ ...newer, efforts: [...newer.efforts] })
  status().catalogSync!.anthropic.lastSuccessAt = at + 60_000
  mounted.rerender(<NextIntlClientProvider locale="en" messages={en}>{await AiSettingsPage()}</NextIntlClientProvider>)
  expect(within(screen.getByTestId("provider-models")).getByText("Newly offered").closest("li")).toHaveTextContent("New")
  expect(screen.getByTestId("models-checked").textContent).not.toBe(checked)
  openTab("openai-api")
  expect(within(screen.getByTestId("provider-models")).queryByText("Newly offered")).not.toBeInTheDocument()
})
