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
import { anyProviderSetUp, statusWord, type LocalToolStatus } from "./ai-settings-screen"

const mocks = vi.hoisted(() => ({
  gate: "on", status: undefined as unknown, creator: undefined as unknown, save: vi.fn(), saveCreator: vi.fn(), refreshLists: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), replace: vi.fn(), failStatus: false,
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
    useRouter: () => ({ replace: mocks.replace }),
    notFound: () => { throw new Error("NEXT_NOT_FOUND") },
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => "")),
  }
})
vi.mock("convex/react", () => ({
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference)
    mocks.queries.push([name, args])
    if (name === "cms/aiSettings:sliceCreator") return args === "skip" ? undefined : mocks.creator
    expect(name).toBe("cms/aiSettings:status")
    if (mocks.failStatus) throw new Error("Status unavailable")
    return mocks.status
  },
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference)
    if (name === "cms/aiSettings:setSliceCreator") return mocks.saveCreator
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
type Creator = FunctionReturnType<typeof api.cms.aiSettings.sliceCreator>
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
  // No page badge or page sentence (approved prototype 96be6727).
  expect(screen.queryByTestId("ai-page-status")).not.toBeInTheDocument()
  expect(screen.queryByText(/Active|Actif|Not configured|Non configuré :/)).not.toBeInTheDocument()
  expect(screen.getByTestId("assistants")).toBeInTheDocument()
  expect([...screen.getByTestId("ai-rail").querySelectorAll("a")].map((a) => a.textContent))
    .toEqual(locale === "en" ? ["Assistants", "Your AI providers"] : ["Assistants", "Vos fournisseurs d’IA"])
  expect(screen.getByTestId("rail-assistants")).toHaveAttribute("aria-current", "page")
  // No Block creator or subscription off localhost, and no billing words.
  expect(screen.queryByText(/Block creator|Créateur de blocs|subscription|abonnement|billed|facturé/i)).not.toBeInTheDocument()
  expect(screen.queryByTestId("no-provider")).not.toBeInTheDocument()
  expect(effort()).toHaveValue("high")
  expect(screen.getByRole("button", { name: locale === "en" ? "Save" : "Enregistrer" })).toBeDisabled()
})

test("Provider uses status.defaults then the exact tuple is sent to setAssistant", async () => {
  await mount()
  await chooseProvider("openrouter")
  expect(screen.getByTestId("provider-writing")).toHaveTextContent("OpenRouter")
  expect(writing().getByRole("button", { name: "Writing assistant Model" })).toHaveTextContent("Provider default")
  expect(effort()).toHaveValue("medium")
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: "writing", tuple: assistant().defaults.openrouter }))
  expect(mocks.save).toHaveBeenCalledTimes(1)
  expect(mocks.saveCreator).not.toHaveBeenCalled()
  expect(mocks.success).toHaveBeenCalledWith("Saved")
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

test.each(["en", "fr"] as const)("Your AI providers in %s: one word per API key, from the one word map", async (locale) => {
  const messages = (locale === "en" ? en : fr).settings.aiScreen
  status().connections[0].state = "refused"
  status().connections[1].state = "unreachable"
  status().connections[2].state = "missing"
  await mount(locale, { local: false })
  openTab("providers")
  expect(window.location.search).toBe("?tab=providers")
  expect(screen.getByTestId("rail-providers")).toHaveAttribute("aria-current", "page")
  // The live site: no Subscriptions group, and no .env.local note.
  expect(screen.queryByTestId("group-subscriptions")).not.toBeInTheDocument()
  expect(screen.queryByTestId("keys-note")).not.toBeInTheDocument()
  const rows = [...screen.getByTestId("group-api-keys").querySelectorAll("li")]
  expect(rows.map((row) => [row.dataset.testid, row.dataset.word, row.textContent])).toEqual([
    ["row-anthropic", "invalidKey", `Anthropic${messages.words.invalidKey}`],
    ["row-openai", "notSetUp", `OpenAI${messages.words.notSetUp}`],
    ["row-openrouter", "ready", `OpenRouter${messages.words.ready}`],
  ])
  expect(screen.getByTestId("row-status-anthropic")).toHaveAttribute("data-tone", "bad")
  // No key actions and no command words.
  expect(within(screen.getByTestId("providers")).queryAllByRole("button")).toEqual([])
  expect(within(screen.getByTestId("providers")).queryAllByRole("link")).toEqual([])
})

test("keysNote shows only in local development while an API key has a problem", async () => {
  const first = await mount()
  openTab("providers")
  expect(screen.queryByTestId("keys-note")).not.toBeInTheDocument()
  first.unmount()
  status().connections[2].state = "refused"
  await mount()
  expect(screen.getByTestId("keys-note")).toHaveTextContent("Assistants use the keys set on your Convex deployment. The Block creator uses its own key from .env.local.")
})

test("a refused connection disables only its assistants; unreachable remains ready", async () => {
  status().connections[0].state = "refused"
  status().connections[1].state = "unreachable"
  assistant("help").effective = assistant("help").defaults.openrouter!
  await mount()
  expect(writing().getByRole("button", { name: "Writing assistant Model" })).toBeDisabled()
  expect(effort()).toBeDisabled()
  expect(screen.getByTestId("assistant-status-writing")).toHaveTextContent("Invalid key")
  expect(screen.getByTestId("assistant-status-writing")).toHaveAttribute("data-tone", "warn")
  expect(screen.getByTestId("assistant-status-help")).toHaveTextContent("Ready")
  expect(within(screen.getByTestId("assistant-help")).getByRole("button", { name: "Help assistant Model" })).toBeEnabled()
  // The problem badge links to Your AI providers.
  fireEvent.click(screen.getByTestId("providers-link-writing"))
  expect(window.location.search).toBe("?tab=providers")
  expect(screen.getByTestId("row-anthropic")).toHaveAttribute("data-word", "invalidKey")
})

test("the provider menu groups API keys and shows a word only for a problem", async () => {
  status().connections[2].state = "refused"
  status().connections[1].state = "missing"
  await mount()
  const menu = await providerMenu()
  const group = menu.getByRole("group", { name: "API keys" })
  expect(within(group).getAllByRole("button").map((option) => option.textContent))
    .toEqual(["Anthropic", "OpenAI · Invalid key", "OpenRouter · Not set up"])
  expect(screen.getByTestId("provider-writing")).toHaveTextContent(/^Anthropic$/)
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

test.each(["en", "fr"] as const)("no provider set up in %s: one line links to Your AI providers and no card shows a badge", async (locale) => {
  status().connections.forEach((connection) => { connection.state = "missing" })
  setLocalKeys({})
  await mount(locale)
  const messages = (locale === "en" ? en : fr).settings.aiScreen
  expect(screen.getByTestId("no-provider")).toHaveTextContent(`${messages.noProvider} ${messages.yourProviders}`)
  expect(screen.queryAllByTestId(/^assistant-status-/)).toEqual([])
  expect(writing().getByRole("button", { name: new RegExp(`${messages.model}$`) })).toBeDisabled()
  expect(effort()).toBeDisabled()
  expect(within(screen.getByTestId("assistant-sliceCreator")).getByRole("button", { name: new RegExp(`${messages.model}$`) })).toBeDisabled()
  fireEvent.click(screen.getByTestId("no-provider-link"))
  expect(screen.getAllByTestId(/^row-status-/).map((row) => row.textContent)).toEqual(Array(3).fill(messages.words.notSetUp))
})

test.each(["en", "fr"] as const)("only a Block creator file key in %s: no no-provider line, assistants Not set up, Block creator Ready", async (locale) => {
  status().connections.forEach((connection) => { connection.state = "missing" })
  setLocalKeys({ anthropic: true })
  await mount(locale)
  const messages = (locale === "en" ? en : fr).settings.aiScreen
  expect(screen.queryByTestId("no-provider")).not.toBeInTheDocument()
  for (const id of ["writing", "translation", "help"]) {
    expect(screen.getByTestId(`assistant-status-${id}`)).toHaveTextContent(messages.words.notSetUp)
    expect(screen.getByTestId(`providers-link-${id}`)).toHaveTextContent(messages.yourProviders)
  }
  expect(screen.getByTestId("assistant-status-sliceCreator")).toHaveTextContent(messages.words.ready)
})

test("live site with no key: the provider menu is disabled, as on main", async () => {
  status().connections.forEach((connection) => { connection.state = "missing" })
  await mount("en", { local: false })
  expect(screen.getByTestId("provider-writing")).toBeDisabled()
  expect(screen.getByTestId("no-provider")).toBeInTheDocument()
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
  expect(select).toHaveValue("")
  const selected = within(select).getByRole("option", { selected: true })
  expect(selected).toHaveTextContent(locale === "en" ? /^Not set$/ : /^Non défini$/)
  expect(selected).toBeDisabled()
})

test("every card is open: badge, summary, provider, model, effort and Instructions; no top line or newer-model line", async () => {
  assistant().newerModel = { provider: "anthropic", model: "new/medium", name: "Medium only" }
  await mount()
  for (const id of ["writing", "translation", "help", "sliceCreator"]) {
    const card = within(screen.getByTestId(`assistant-${id}`))
    expect(card.getByLabelText("Instructions")).toBeInTheDocument()
    expect(screen.getByTestId(`assistant-status-${id}`)).toHaveTextContent("Ready")
  }
  expect(screen.queryByText(/^Uses |billed per use|newer model/)).not.toBeInTheDocument()
  expect(document.querySelector('[data-slot="accordion-trigger"]')).toBeNull()
})

test("an unknown or old provider tab shows Assistants", async () => {
  for (const tab of ["nope", "claude-code", "openai-api"]) {
    window.history.replaceState(null, "", `/admin/settings/ai?tab=${tab}`)
    const mounted = await mount()
    expect(screen.getByTestId("assistants")).toBeInTheDocument()
    mounted.unmount()
  }
})

test("a tab change stays in the browser and keeps unsaved edits; Save sends them", async () => {
  await mount()
  fireEvent.change(writing().getByRole("textbox"), { target: { value: "Kept across tabs" } })
  openTab("providers")
  expect(window.location.search).toBe("?tab=providers")
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
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("The model lists were just updated. Try again in a few minutes."))
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

function creator() { return within(screen.getByTestId("assistant-sliceCreator")) }

test("Slice creator is absent and its query skipped outside local development", async () => {
  await mount("en", { local: false })
  expect(screen.queryByTestId("assistant-sliceCreator")).not.toBeInTheDocument()
  expect(mocks.queries.filter(([name]) => name === "cms/aiSettings:sliceCreator").every(([, args]) => args === "skip")).toBe(true)
})

test("Slice creator is absent when the page passes no local keys", async () => {
  render(<NextIntlClientProvider locale="en" messages={en}>{await ADMIN_AI_SETTINGS_SERVER_BINDING!.renderSettingsPage({ isLocal: true })}</NextIntlClientProvider>)
  expect(screen.getByTestId("assistants")).toBeInTheDocument()
  expect(screen.queryByTestId("assistant-sliceCreator")).not.toBeInTheDocument()
  expect(mocks.queries.filter(([name]) => name === "cms/aiSettings:sliceCreator").every(([, args]) => args === "skip")).toBe(true)
})

test("Slice creator with its local key: Ready, after Help", async () => {
  await mount()
  const rows = [...screen.getByTestId("assistants").querySelectorAll("[data-testid^=assistant-]")].map((row) => row.getAttribute("data-testid"))
  expect(rows.filter((id) => !id!.startsWith("assistant-status"))).toEqual(["assistant-writing", "assistant-translation", "assistant-help", "assistant-sliceCreator"])
  expect(screen.getByTestId("assistant-status-sliceCreator")).toHaveTextContent("Ready")
  expect(screen.getByTestId("provider-sliceCreator")).toHaveTextContent("Anthropic")
  expect(creator().getByRole("button", { name: "Block creator Model" })).toHaveTextContent("Claude Opus 5.5")
})

test("Slice creator with nothing saved uses the first provider that has a local key", async () => {
  setLocalKeys({ openai: true })
  await mount()
  expect(screen.getByTestId("provider-sliceCreator")).toHaveTextContent("OpenAI")
  expect(screen.getByTestId("assistant-status-sliceCreator")).toHaveTextContent("Ready")
})

// The Block creator runs on its .env.local key; the assistants and the provider rows read the Convex key.
test.each([
  { file: true, convex: false, creatorWord: "ready", rowWord: "notSetUp" },
  { file: false, convex: true, creatorWord: "notSetUp", rowWord: "ready" },
  { file: true, convex: true, creatorWord: "ready", rowWord: "ready" },
  { file: false, convex: false, creatorWord: "notSetUp", rowWord: "notSetUp" },
] as const)("Block creator badge follows its .env.local key: file $file, Convex $convex", async ({ file, convex, creatorWord, rowWord }) => {
  setLocalKeys({ anthropic: file })
  // OpenRouter and OpenAI stay set up on Convex, so the no-provider line never hides the badges.
  status().connections[0].state = convex ? "connected" : "missing"
  await mount()
  expect(screen.getByTestId("provider-sliceCreator")).toHaveTextContent(/^Anthropic$/)
  const badge = screen.getByTestId("assistant-status-sliceCreator")
  expect(badge).toHaveAttribute("data-word", creatorWord)
  expect(badge).toHaveTextContent(creatorWord === "ready" ? "Ready" : "Not set up")
  expect(badge).toHaveAttribute("data-tone", creatorWord === "ready" ? "ok" : "warn")
  const model = creator().getByRole("button", { name: "Block creator Model" })
  if (creatorWord === "ready") {
    expect(screen.queryByTestId("providers-link-sliceCreator")).not.toBeInTheDocument()
    expect(model).toBeEnabled()
  } else {
    expect(screen.getByTestId("providers-link-sliceCreator")).toHaveTextContent("Your AI providers")
    expect(model).toBeDisabled()
  }
  // Writing, on Anthropic too, keeps the Convex word.
  expect(screen.getByTestId("assistant-status-writing")).toHaveAttribute("data-word", rowWord)
  openTab("providers")
  expect(screen.getByTestId("row-anthropic")).toHaveAttribute("data-word", rowWord)
})

test("Slice creator with nothing saved and two local keys: the first in connection order, Ready from its file key", async () => {
  setLocalKeys({ openai: true, openrouter: true })
  status().connections[1].state = "missing"
  await mount()
  expect(screen.getByTestId("provider-sliceCreator")).toHaveTextContent(/^OpenRouter$/)
  expect(creator().getByRole("button", { name: "Block creator Model" })).toHaveTextContent("Creator default")
  expect(screen.getByTestId("assistant-status-sliceCreator")).toHaveAttribute("data-word", "ready")
})

test("Slice creator on a provider with a problem: its word, no key lines, and model and effort wait", async () => {
  mocks.creator = { ...creatorFixture(), tuple: { mode: "catalog", provider: "openrouter", model: "creator/default", reasoning: { kind: "effort", effort: "medium" } } }
  status().connections[1].state = "missing"
  await mount()
  expect(screen.getByTestId("assistant-status-sliceCreator")).toHaveTextContent("Not set up")
  expect(creator().queryByText(/API_KEY|\.env\.local|restart/)).not.toBeInTheDocument()
  expect(creator().getByRole("button", { name: "Block creator Model" })).toBeDisabled()
  expect(effort("sliceCreator")).toBeDisabled()
  // As on main: the Block creator's API services stay selectable.
  expect((await providerMenu("sliceCreator")).getByTestId("option-anthropic")).toBeEnabled()
})

test("Slice creator Save sends its tuple and instructions together, once, and never setAssistant", async () => {
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

test("Slice creator keeps a saved choice and Reset clears saved instructions", async () => {
  mocks.creator = { ...creatorFixture(), tuple: { mode: "catalog", provider: "openrouter", model: "creator/default", reasoning: { kind: "effort", effort: "medium" } }, instructions: "Saved words" }
  await mount()
  expect(screen.getByTestId("provider-sliceCreator")).toHaveTextContent("OpenRouter")
  expect(creator().getByRole("textbox")).toHaveValue("Saved words")
  fireEvent.click(creator().getByRole("button", { name: "Reset to default" }))
  expect(creator().getByRole("textbox")).toHaveValue("")
  expect(creator().getByRole("textbox")).toHaveAttribute("placeholder", en.settings.aiScreen.sliceCreator.prompt)
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.saveCreator).toHaveBeenCalledWith({ tuple: mocks.creator && (mocks.creator as Creator).tuple }))
})

test("the assistant badges are the same with and without the Slice creator", async () => {
  const badges = () => ["assistant-status-writing", "assistant-status-translation", "assistant-status-help"].map((id) => screen.getByTestId(id).textContent)
  status().connections[1].state = "missing"
  const live = await mount("en", { local: false })
  const without = badges()
  live.unmount()
  setLocalKeys({})
  await mount()
  expect(screen.getByTestId("assistant-sliceCreator")).toBeInTheDocument()
  expect(badges()).toEqual(without)
})

test("the word map and the set-up rule", () => {
  const connections = (state: "missing" | "refused" | "connected" | "unreachable") =>
    (["anthropic", "openrouter", "openai"] as const).map((provider) => ({ provider, state, envVar: "X" }))
  expect((["missing", "refused", "connected", "unreachable"] as const).map((state) => statusWord("openai", connections(state), undefined)))
    .toEqual(["notSetUp", "invalidKey", "ready", "ready"])
  const tools = (status: LocalToolStatus) => ({ tools: [{ tool: "claude" as const, status }, { tool: "codex" as const, status: "signed-out" as const }] })
  expect((["plan", "api-key", "unknown", "signed-out", "not-installed"] as const).map((status) => statusWord("claude", [], tools(status))))
    .toEqual(["ready", "ready", "ready", "signedOut", "signedOut"])
  expect(statusWord("codex", [], undefined)).toBe("signedOut")
  // A subscription alone counts; refused keys do not.
  expect(anyProviderSetUp(connections("refused"), tools("plan"))).toBe(true)
  expect(anyProviderSetUp(connections("refused"), tools("signed-out"))).toBe(false)
  expect(anyProviderSetUp(connections("unreachable"), undefined)).toBe(true)
})
