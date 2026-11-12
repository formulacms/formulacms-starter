import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { getFunctionName, type FunctionReturnType } from "convex/server"
import { beforeEach, expect, test, vi } from "vitest"
import { LOCAL_API_KEY_NAMES } from "@/lib/local-api-keys"
import { api } from "@/convex/_generated/api"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import AiSettingsPage from "@/app/(core)/admin/(authenticated)/settings/ai/page"
import { ADMIN_AI_SETTINGS_SERVER_BINDING } from "@/components/admin/contributions/ai-settings.server"

const mocks = vi.hoisted(() => ({
  gate: "on", status: undefined as unknown, creator: undefined as unknown, save: vi.fn(), saveCreator: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), replace: vi.fn(), failStatus: false,
  queries: [] as [string, unknown][],
}))
vi.mock("./admin-module-state-provider", () => ({ useModuleGate: () => ({ state: mocks.gate }) }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }), notFound: () => { throw new Error("NEXT_NOT_FOUND") } }))
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
    expect(name).toBe("cms/aiSettings:setAssistant")
    return mocks.save
  },
}))
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error, info: mocks.info, dismiss: vi.fn() } }))

type Status = FunctionReturnType<typeof api.cms.aiSettings.status>
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
/** Renders the page; `local: false` renders the production body. Opens every card unless `expand` is false. */
async function mount(locale: "en" | "fr" = "en", { local = true, expand = true } = {}) {
  const page = local ? await AiSettingsPage() : await ADMIN_AI_SETTINGS_SERVER_BINDING!.renderSettingsPage({ isLocal: false })
  const mounted = render(<NextIntlClientProvider locale={locale} messages={locale === "en" ? en : fr}>{page}</NextIntlClientProvider>)
  if (expand) document.querySelectorAll<HTMLElement>('[data-slot="accordion-trigger"][aria-expanded="false"]').forEach((trigger) => fireEvent.click(trigger))
  return mounted
}
function toggle(testId: string) {
  const trigger = screen.getByTestId(testId).querySelector<HTMLElement>('[data-slot="accordion-trigger"]')!
  fireEvent.click(trigger)
}
function expanded(testId: string) {
  return screen.getByTestId(testId).querySelector('[data-slot="accordion-trigger"]')!.getAttribute("aria-expanded") === "true"
}
function writing() { return within(screen.getByTestId("assistant-writing")) }
function selects() { return writing().getAllByRole("combobox") }
async function chooseModel(name: string) {
  fireEvent.click(writing().getByRole("button", { name: "Writing assistant Model" }))
  fireEvent.click(await screen.findByRole("button", { name }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  setLocalKeys({ anthropic: true })
  mocks.gate = "on"
  mocks.failStatus = false
  mocks.status = fixture()
  mocks.creator = creatorFixture()
  mocks.queries = []
  mocks.save.mockResolvedValue(null)
  mocks.saveCreator.mockResolvedValue(null)
})

test.each(["en", "fr"] as const)("Q screen %s shows effective settings and only Connections/Assistants", async (locale) => {
  await mount(locale, { local: false })
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(locale === "en" ? "AI" : "IA")
  expect(screen.getByTestId("ai-page-status")).toHaveTextContent(locale === "en" ? "Active" : "Actif")
  expect(screen.getByTestId("connections")).toBeInTheDocument()
  expect(screen.getByTestId("assistants")).toBeInTheDocument()
  expect(screen.queryByText(/Usage|Block creator|subscription|plan credits/i)).not.toBeInTheDocument()
  expect(selects()[1]).toHaveValue("high")
  expect(screen.getByRole("button", { name: locale === "en" ? "Save" : "Enregistrer" })).toBeDisabled()
})

test("Runs with uses status.defaults then the exact tuple is sent to setAssistant", async () => {
  await mount()
  fireEvent.change(selects()[0], { target: { value: "openrouter" } })
  expect(writing().getByRole("button", { name: "Writing assistant Model" })).toHaveTextContent("Provider default")
  expect(selects()[1]).toHaveValue("medium")
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
  expect(selects()[1]).toHaveValue("high")
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
  expect(selects()[1]).toHaveValue("high")
  await chooseModel("Medium onlynew/medium")
  expect(selects()[1]).toHaveValue("medium")
  await chooseModel("Low onlynew/low")
  expect(selects()[1]).toHaveValue("low")
  await chooseModel("Effortlessnew/no-effort")
  expect(selects()[1]).toBeDisabled()
  expect(selects()[1]).toHaveDisplayValue("Not available for this model")
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: "writing", tuple: { mode: "catalog", provider: "anthropic", model: "new/no-effort" } }))
})

test("Translation effort is disabled high and unavailable Translation is hidden", async () => {
  const mounted = await mount()
  const translation = within(screen.getByTestId("assistant-translation"))
  expect(translation.getAllByRole("combobox")[1]).toBeDisabled()
  expect(translation.getAllByRole("combobox")[1]).toHaveValue("high")
  assistant("translation").available = false
  mounted.rerender(<NextIntlClientProvider locale="en" messages={en}>{await AiSettingsPage()}</NextIntlClientProvider>)
  expect(screen.queryByTestId("assistant-translation")).not.toBeInTheDocument()
})

test("a refused connection disables only its assistants; unreachable remains ready", async () => {
  status().connections[0].state = "refused"
  status().connections[0].observedAt = Date.now()
  status().connections[1].state = "unreachable"
  status().connections[1].observedAt = Date.now()
  assistant("help").effective = assistant("help").defaults.openrouter!
  await mount()
  expect(writing().getByRole("button", { name: "Writing assistant Model" })).toBeDisabled()
  expect(selects()[1]).toBeDisabled()
  expect(screen.getByTestId("assistant-status-writing")).toHaveTextContent("Key refused")
  expect(screen.getByTestId("assistant-status-help")).toHaveTextContent("Ready")
  expect(within(screen.getByTestId("assistant-help")).getByRole("button", { name: "Help assistant Model" })).toBeEnabled()
  expect(screen.getByText(/Key refused: Anthropic rejected ANTHROPIC_API_KEY.*today/)).toBeInTheDocument()
  expect(screen.getByText(/Couldn't reach OpenRouter.*today/)).toBeInTheDocument()
})

test("missing keys disable controls and show the environment names", async () => {
  status().connections.forEach((connection) => { connection.state = "missing" })
  status().card = { state: "missing" }
  await mount()
  expect(selects()[0]).toBeDisabled()
  expect(writing().getByRole("button", { name: "Writing assistant Model" })).toBeDisabled()
  expect(screen.getByTestId("ai-page-status")).toHaveTextContent("Not configured: API key is missing")
  expect(screen.getByText("Not configured: OPENAI_API_KEY is missing")).toBeInTheDocument()
})

test("refused wins over missing in the header and older observations use a localized date", async () => {
  status().connections[0].state = "missing"
  status().connections[1] = { ...status().connections[1], state: "refused", observedAt: new Date("2020-01-02T12:30:00Z").getTime() }
  status().card = { state: "refused", provider: "openrouter" }
  await mount("fr")
  expect(screen.getByTestId("ai-page-status")).toHaveTextContent("OpenRouter a refusé la clé")
  expect(screen.getByText(/Clé refusée : OpenRouter.*2020/)).not.toHaveTextContent("aujourd'hui")
})

test("instructions save and Reset clears the custom instructions", async () => {
  assistant().instructions = "Custom directions"
  await mount()
  fireEvent.click(writing().getByRole("button", { name: "Reset to default" }))
  expect(writing().getByRole("textbox")).toHaveValue(en.settings.aiScreen.tasks.writing.prompt)
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

test("AI off unmounts the screen and redirects to Modules with Q's note", async () => {
  const mounted = await mount()
  expect(screen.getByTestId("assistants")).toBeInTheDocument()
  mocks.gate = "off"
  mounted.rerender(<NextIntlClientProvider locale="en" messages={en}>{await AiSettingsPage()}</NextIntlClientProvider>)
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/admin/settings/modules"))
  expect(mocks.info).toHaveBeenCalledWith("AI is not enabled. You can enable it here.")
  expect(screen.queryByTestId("assistants")).not.toBeInTheDocument()
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
  expect(offered).toContain((selects()[1] as HTMLSelectElement).value)
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
  expect(selects()[1]).toHaveValue("high")
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: "writing", tuple: {
    mode: "catalog", provider: "openrouter", model: "new/default-high", reasoning: { kind: "effort", effort: "high" },
  } }))
})

test.each([{ efforts: ["low", "high"] }, { efforts: [] }] as const)("S3 refused saved effort stays visible and unchanged with offered efforts $efforts", async ({ efforts }) => {
  assistant().effective = { mode: "catalog", provider: "openrouter", model: "saved/refused", reasoning: { kind: "effort", effort: "medium" } }
  assistant().choices.openrouter = [{ model: "saved/refused", name: "Saved refused", efforts: [...efforts], providerDefault: "high" }]
  await mount()
  expect(selects()[1]).toHaveValue("medium")
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
  const effort = task.getByRole("combobox", { name: "Effort" })
  expect(effort).toBeEnabled()
  expect(effort).toHaveValue("")
  const selected = within(effort).getByRole("option", { selected: true })
  expect(selected).toHaveTextContent(/^Not set$/)
  expect(selected).toBeDisabled()
  expect(within(effort).getAllByRole("option")[0]).toBe(selected)
  expect(within(effort).getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(["", "high", "medium", "low"])
  if (nextEffort) {
    fireEvent.change(effort, { target: { value: nextEffort } })
    expect(effort).toHaveValue("medium")
    expect(within(effort).queryByRole("option", { name: "Not set" })).not.toBeInTheDocument()
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
  const effort = within(screen.getByTestId("assistant-translation")).getByRole("combobox", { name: "Effort" })
  expect(effort).toBeDisabled()
  expect(effort).toHaveValue("")
  const selected = within(effort).getByRole("option", { selected: true })
  expect(selected).toHaveTextContent(locale === "en" ? /^Not set$/ : /^Non défini$/)
  expect(selected).toBeDisabled()
})

test("collapse: with every key connected the cards start collapsed with their summaries", async () => {
  await mount("en", { expand: false })
  expect(expanded("connections")).toBe(false)
  expect(screen.getByTestId("connections-status")).toHaveTextContent("Ready")
  expect(screen.getByText("3 of 3 API keys connected")).toBeInTheDocument()
  expect(screen.queryByText("API keys")).not.toBeInTheDocument()
  expect(expanded("assistant-writing")).toBe(false)
  expect(writing().queryByRole("combobox")).not.toBeInTheDocument()
  expect(writing().getByText("Anthropic · Sonnet · high")).toBeInTheDocument()
  expect(within(screen.getByTestId("assistant-translation")).getByText("Anthropic · Sonnet")).toBeInTheDocument()
})

test("collapse: a missing key opens Connections; the badge says Ready while another key works", async () => {
  status().connections[2].state = "missing"
  await mount("en", { expand: false })
  expect(expanded("connections")).toBe(true)
  expect(screen.getByTestId("connections-status")).toHaveTextContent("Ready")
  expect(screen.getByText(en.settings.aiScreen.connectionsDescription)).toBeInTheDocument()
  expect(screen.getByText("Not configured: OPENAI_API_KEY is missing")).toBeInTheDocument()
})

test.each(["en", "fr"] as const)("Connections badge in %s: Ready with one working key and none refused", async (locale) => {
  status().connections[1].state = "missing"
  status().connections[2].state = "unreachable"
  status().connections[2].observedAt = Date.now()
  await mount(locale, { expand: false })
  expect(screen.getByTestId("connections-status")).toHaveTextContent(locale === "en" ? "Ready" : "Prêt")
})

test("Connections badge: a refused key means Needs attention, even with a working key", async () => {
  status().connections[2].state = "refused"
  status().connections[2].observedAt = Date.now()
  await mount("en", { expand: false })
  expect(screen.getByTestId("connections-status")).toHaveTextContent("Needs attention")
})

test("Connections badge: no working key means Needs attention", async () => {
  for (const c of status().connections) c.state = "missing"
  await mount("en", { expand: false })
  expect(screen.getByTestId("connections-status")).toHaveTextContent("Needs attention")
})

test("collapse: an assistant that is not ready starts open", async () => {
  status().connections[0].state = "missing"
  await mount("en", { expand: false })
  expect(expanded("assistant-writing")).toBe(true)
  expect(writing().getByText(en.settings.aiScreen.tasks.writing.summary)).toBeInTheDocument()
})

test("collapse: an edit survives closing and reopening the card, and Save sends it", async () => {
  await mount("en", { expand: false })
  toggle("assistant-writing")
  expect(writing().getByText(en.settings.aiScreen.tasks.writing.summary)).toBeInTheDocument()
  fireEvent.change(writing().getByRole("textbox"), { target: { value: "Kept while closed" } })
  toggle("assistant-writing")
  expect(writing().queryByRole("textbox")).not.toBeInTheDocument()
  toggle("assistant-writing")
  expect(writing().getByRole("textbox")).toHaveValue("Kept while closed")
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: "writing", tuple: assistant().effective, instructions: "Kept while closed" }))
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

test("Slice creator with its local key: Ready, collapsed, after Help", async () => {
  await mount("en", { expand: false })
  const rows = [...screen.getByTestId("assistants").querySelectorAll("[data-testid^=assistant-]")].map((row) => row.getAttribute("data-testid"))
  expect(rows.filter((id) => !id!.startsWith("assistant-status"))).toEqual(["assistant-writing", "assistant-translation", "assistant-help", "assistant-sliceCreator"])
  expect(screen.getByTestId("assistant-status-sliceCreator")).toHaveTextContent("Ready")
  expect(expanded("assistant-sliceCreator")).toBe(false)
  expect(creator().getByText("Anthropic · Claude Opus 5.5 · high")).toBeInTheDocument()
})

test("Slice creator with nothing saved uses the first provider that has a local key", async () => {
  setLocalKeys({ openai: true })
  await mount("en", { expand: false })
  expect(screen.getByTestId("assistant-status-sliceCreator")).toHaveTextContent("Ready")
  expect(creator().getByText("OpenAI · Sol · high")).toBeInTheDocument()
})

test.each(["en", "fr"] as const)("Slice creator with no local key at all starts open, names every provider's key in %s", async (locale) => {
  setLocalKeys({})
  await mount(locale, { expand: false })
  const messages = (locale === "en" ? en : fr).settings.aiScreen.sliceCreator
  expect(expanded("assistant-sliceCreator")).toBe(true)
  expect(screen.getByTestId("assistant-status-sliceCreator")).toHaveTextContent(messages.finishSetup)
  expect(creator().getByText(messages.keyMissingAny)).toBeInTheDocument()
  const help = messages.keyHelpAny.replace("{openrouter}", "FORMULACMS_DEV_OPENROUTER_API_KEY")
    .replace("{anthropic}", "FORMULACMS_DEV_ANTHROPIC_API_KEY").replace("{openai}", "FORMULACMS_DEV_OPENAI_API_KEY")
  expect(creator().getByText(help)).toBeInTheDocument()
  expect(creator().queryByText(/API_KEY is missing|API_KEY est manquante/)).not.toBeInTheDocument()
  expect(creator().queryByText(/restart|redémarrez/)).not.toBeInTheDocument()
  const instructions = creator().getByRole("textbox")
  expect(instructions).toHaveValue("")
  expect(instructions).toHaveAttribute("placeholder", messages.prompt)
  expect(creator().queryByRole("button", { name: (locale === "en" ? en : fr).settings.aiScreen.reset })).not.toBeInTheDocument()
})

test.each(["en", "fr"] as const)("Slice creator with a key for another provider names the chosen provider's key in %s", async (locale) => {
  mocks.creator = { ...creatorFixture(), tuple: { mode: "catalog", provider: "openrouter", model: "creator/default", reasoning: { kind: "effort", effort: "medium" } } }
  await mount(locale, { expand: false })
  const messages = (locale === "en" ? en : fr).settings.aiScreen.sliceCreator
  const envVar = "FORMULACMS_DEV_OPENROUTER_API_KEY"
  expect(creator().getByText(messages.keyMissing.replace("{envVar}", envVar))).toBeInTheDocument()
  expect(creator().getByText(messages.keyHelp.replace("{envVar}", envVar))).toBeInTheDocument()
  expect(creator().queryByText(messages.keyMissingAny)).not.toBeInTheDocument()
  expect(creator().queryByText(/restart|redémarrez/)).not.toBeInTheDocument()
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
  expect(screen.getByTestId("assistant-status-sliceCreator")).toHaveTextContent("Finish setup")
  expect(creator().getByText(/FORMULACMS_DEV_OPENROUTER_API_KEY is missing/)).toBeInTheDocument()
  expect(creator().getAllByRole("combobox")[0]).toHaveValue("openrouter")
  expect(within(creator().getAllByRole("combobox")[0]).getByRole("option", { name: "OpenRouter · not set up" })).toBeEnabled()
  expect(creator().getByRole("textbox")).toHaveValue("Saved words")
  fireEvent.click(creator().getByRole("button", { name: "Reset to default" }))
  expect(creator().getByRole("textbox")).toHaveValue("")
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(mocks.saveCreator).toHaveBeenCalledWith({ tuple: mocks.creator && (mocks.creator as Creator).tuple }))
})

test("the page and assistant badges are the same with and without the Slice creator", async () => {
  const badges = () => ["ai-page-status", "assistant-status-writing", "assistant-status-translation", "assistant-status-help"].map((id) => screen.getByTestId(id).textContent)
  status().connections[1].state = "missing"
  const live = await mount("en", { local: false })
  const without = badges()
  live.unmount()
  setLocalKeys({})
  await mount()
  expect(screen.getByTestId("assistant-sliceCreator")).toBeInTheDocument()
  expect(badges()).toEqual(without)
})

test("card header triggers have no border width, so the admin border colour draws no outline", async () => {
  await mount("en", { expand: false })
  const triggers = [...document.querySelectorAll('[data-slot="accordion-trigger"]')]
  expect(triggers).toHaveLength(5)
  for (const trigger of triggers) {
    expect(trigger).toHaveClass("border-0")
    expect(trigger).not.toHaveClass("border")
  }
})
