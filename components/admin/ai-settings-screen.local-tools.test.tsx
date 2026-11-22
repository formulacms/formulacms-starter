import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { getFunctionName, type FunctionReturnType } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type { api } from "@/convex/_generated/api"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import AiSettingsPage from "@/app/(core)/admin/(authenticated)/settings/ai/page"
import { ADMIN_AI_SETTINGS_SERVER_BINDING } from "@/components/admin/contributions/ai-settings.server"
import { builtInLocalToolModels, localToolMenus } from "@/scripts/lib/dev-ai-selection"
import type { LocalToolsData, LocalToolStatus } from "./ai-settings-screen"

// Settings › AI local tools (AI-LOCAL-1): one test per approved prototype state.
// No real tool command and no real local file: both are replaced here.
const mocks = vi.hoisted(() => ({
  status: undefined as unknown, creator: undefined as unknown,
  save: vi.fn(), saveCreator: vi.fn(), saveLocal: vi.fn(), success: vi.fn(), error: vi.fn(),
  isLocalToolRequest: vi.fn(async () => false),
  inspectLocalTools: vi.fn(),
  readLocalToolChoices: vi.fn(() => ({})),
  readDevAiSelection: vi.fn(() => null),
  requireInstallationOwner: vi.fn(async () => ({ authId: "owner-auth" })),
  aiOutcome: "on" as string,
  fetchAuthQuery: vi.fn(),
  spawn: vi.fn(),
  execFile: vi.fn(),
  readFileSync: vi.fn(),
  loadLocalToolModels: vi.fn(),
  urlListeners: new Set<() => void>(),
}))
// Generic fallback for the guards: any process start or file read that is not
// one of the named seams is recorded here.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
  execFile: mocks.execFile,
}))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  mocks.readFileSync.mockImplementation(actual.readFileSync as never)
  return { ...actual, readFileSync: mocks.readFileSync }
})
// The owner check and the AI module state that come before any local effect.
vi.mock("@/lib/owner-server", () => ({ requireInstallationOwner: mocks.requireInstallationOwner }))
vi.mock("@/lib/auth/server", () => ({ fetchAuthQuery: mocks.fetchAuthQuery }))
vi.mock("./admin-module-state-provider", () => ({ useModuleGate: () => ({ state: "on" }) }))
// `useSearchParams` follows `history.pushState`, as Next.js does (no server render).
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react")
  const subscribe = (listener: () => void) => { mocks.urlListeners.add(listener); return () => { mocks.urlListeners.delete(listener) } }
  return {
    useRouter: () => ({ replace: vi.fn() }),
    notFound: () => { throw new Error("NEXT_NOT_FOUND") },
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => "")),
  }
})
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error, info: vi.fn(), dismiss: vi.fn() } }))
vi.mock("@/lib/local-request", () => ({ isLocalToolRequest: mocks.isLocalToolRequest }))
// No test reads a real .env.local: the page's key reader finds no key.
vi.mock("@/lib/local-api-keys-file", () => ({
  localProviderKeyPresenceNow: () => ({ anthropic: false, openai: false, openrouter: false }),
}))
vi.mock("@/scripts/lib/dev-ai-connections", () => ({ inspectLocalTools: mocks.inspectLocalTools }))
vi.mock("@/scripts/lib/dev-ai-selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/scripts/lib/dev-ai-selection")>()),
  readLocalToolChoices: mocks.readLocalToolChoices,
  readDevAiSelection: mocks.readDevAiSelection,
}))
vi.mock("@/app/(core)/admin/(authenticated)/settings/ai/actions", () => ({ saveLocalToolChoices: mocks.saveLocal }))
// The model lists: never the installed Codex or the machine's `.formulacms/local/` mirror.
vi.mock("@/scripts/lib/local-tool-models", () => ({ loadLocalToolModels: mocks.loadLocalToolModels }))
vi.mock("convex/react", () => ({
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) =>
    getFunctionName(reference) === "cms/aiSettings:blockCreator" ? (args === "skip" ? undefined : mocks.creator) : mocks.status,
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference)
    return name === "cms/aiSettings:setBlockCreator" ? mocks.saveCreator : name === "cms/aiSettings:setAssistant" ? mocks.save : vi.fn()
  },
}))

type Status = NonNullable<FunctionReturnType<typeof api.cms.aiSettings.status>>
type Creator = FunctionReturnType<typeof api.cms.aiSettings.blockCreator>
const anthropic = { mode: "catalog", provider: "anthropic", model: "claude-haiku-5-5", reasoning: { kind: "effort", effort: "low" } } as const
const openrouter = { mode: "catalog", provider: "openrouter", model: "or/default", reasoning: { kind: "effort", effort: "medium" } } as const
const openai = { mode: "catalog", provider: "openai", model: "gpt-6.1-luna", reasoning: { kind: "effort", effort: "low" } } as const
const choices = {
  anthropic: [{ model: anthropic.model, name: "Claude Haiku 5.5", efforts: ["low", "medium", "high"], providerDefault: "high" }],
  openrouter: [{ model: openrouter.model, name: "OR default", efforts: ["medium"], providerDefault: "medium" }],
  openai: [{ model: openai.model, name: "Luna", efforts: ["low"], providerDefault: "low" }],
} as const
function statusFixture(): Status {
  return {
    connections: [
      { provider: "anthropic", state: "connected", envVar: "ANTHROPIC_API_KEY" },
      { provider: "openrouter", state: "connected", envVar: "OPENROUTER_API_KEY" },
      { provider: "openai", state: "missing", envVar: "OPENAI_API_KEY" },
    ],
    card: { state: "active" },
    assistants: (["writing", "translation", "help"] as const).map((id) => ({
      id, available: true, provider: "anthropic", ready: true, effective: anthropic, tuple: anthropic,
      defaults: { anthropic, openrouter, openai }, choices,
    })),
  } as unknown as Status
}
function creatorFixture(): Creator {
  return { tuple: anthropic, choices, defaults: { anthropic, openrouter, openai }, newerModels: [{ for: { provider: "anthropic", model: "claude-haiku-5-5" }, provider: "anthropic", model: "claude-sonnet-5-5", name: "Sonnet 5.5" }] } as unknown as Creator
}
const noKeys = { anthropic: false, openrouter: false, openai: false }
function localTools(claude: LocalToolStatus, codex: LocalToolStatus, saved: LocalToolsData["choices"] = {}): LocalToolsData {
  return {
    tools: [{ tool: "claude", status: claude }, { tool: "codex", status: codex }],
    choices: saved,
    menus: localToolMenus() as LocalToolsData["menus"],
    save: mocks.saveLocal,
  }
}
/** Renders the route body with the given server props. */
async function mount(props: { isLocal: boolean; localKeys?: typeof noKeys; localTools?: LocalToolsData }, { locale = "en" as "en" | "fr" } = {}) {
  const page = await ADMIN_AI_SETTINGS_SERVER_BINDING!.renderSettingsPage(props)
  render(<NextIntlClientProvider locale={locale} messages={locale === "en" ? en : fr}>{page}</NextIntlClientProvider>)
}
const local = (tools: LocalToolsData, keys = noKeys) => mount({ isLocal: true, localKeys: keys, localTools: tools })
const row = (id: string) => within(screen.getByTestId(`assistant-${id}`))
/** The card's provider field (a menu button that shows the name only). */
const provider = (id: string) => screen.getByTestId(`provider-${id}`)
/** Opens a card's provider menu and returns it. */
async function menu(id: string) {
  fireEvent.click(provider(id))
  return within(await screen.findByTestId(`provider-menu-${id}`))
}
async function choose(id: string, value: string) {
  fireEvent.click((await menu(id)).getByTestId(`option-${value}`))
}
/** The menu's options as shown, with whether each can be chosen; the menu closes again. */
async function options(id: string) {
  const shown = (await menu(id)).getAllByRole("button").map((b) => [b.textContent, !(b as HTMLButtonElement).disabled] as const)
  fireEvent.click(provider(id))
  await waitFor(() => expect(screen.queryByTestId(`provider-menu-${id}`)).not.toBeInTheDocument())
  return shown
}
const model = (id: string) => screen.getByTestId(`assistant-${id}`).querySelector<HTMLButtonElement>("button[aria-label$=Model], button[aria-label$=Modèle]")!
const openTab = (tab: string) => fireEvent.click(screen.getByTestId(`rail-${tab}`))
const anthropicKey = { ...noKeys, anthropic: true }

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, "", "/admin/settings/ai")
  const push = History.prototype.pushState
  vi.spyOn(window.history, "pushState").mockImplementation(function (this: History, ...args: Parameters<History["pushState"]>) {
    push.apply(window.history, args)
    mocks.urlListeners.forEach((listener) => listener())
  })
  mocks.aiOutcome = "on"
  mocks.loadLocalToolModels.mockImplementation(async () => builtInLocalToolModels())
  mocks.fetchAuthQuery.mockImplementation(async (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/modules:effective") return { version: 1, modules: [{ id: "ai", outcome: mocks.aiOutcome }] }
    if (name === "cms/aiSettings:blockCreator") {
      if (mocks.aiOutcome === "off") throw new Error("AI_OFF")
      return { tuple: undefined }
    }
    throw new Error(`unexpected query ${name}`)
  })
  mocks.status = statusFixture()
  mocks.creator = creatorFixture()
  mocks.save.mockResolvedValue(null)
  mocks.saveCreator.mockResolvedValue(null)
  mocks.saveLocal.mockImplementation(async (changes: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== null)))
})

describe("Settings › AI local tools on localhost", () => {
  test("both tools signed in with a plan: Your AI providers and the local options for every assistant", async () => {
    await local({ ...localTools("plan", "plan"), claudePlan: "max" })
    expect([...screen.getByTestId("ai-rail").querySelectorAll("a")].map((a) => a.dataset.testid)).toEqual(["rail-assistants", "rail-providers"])
    for (const id of ["writing", "translation", "help", "blockCreator"]) {
      const shown = await options(id)
      expect(shown.slice(0, 2)).toEqual([["Claude Code", true], ["Codex", true]])
    }
    openTab("providers")
    const group = screen.getByTestId("group-subscriptions")
    expect(group).toHaveTextContent("SubscriptionsUses Claude Code or Codex signed in on this computer.")
    // The plan name only while Ready; no setup link, command or billing words.
    expect(screen.getByTestId("row-claude")).toHaveTextContent("Claude CodeClaude Max planReady")
    expect(screen.getByTestId("row-codex")).toHaveTextContent("CodexChatGPT planReady")
    expect(within(screen.getByTestId("providers")).queryAllByRole("link")).toEqual([])
    expect(screen.queryByText(/billed|charges|caps|terminal/i)).not.toBeInTheDocument()
  })

  test("subscription only: Claude Code signed in and no API key is Ready, with no no-provider line", async () => {
    const status = statusFixture() as unknown as { connections: { state: string }[] }
    for (const connection of status.connections) connection.state = "missing"
    mocks.status = status
    await local(localTools("plan", "signed-out", { writing: { engine: "claude", model: "claude-sonnet-5-5", effort: "medium" } }))
    expect(screen.queryByTestId("no-provider")).not.toBeInTheDocument()
    expect(screen.getByTestId("assistant-status-writing")).toHaveTextContent("Ready")
    // Cards on a key that is not set up keep their own word and link.
    expect(screen.getByTestId("assistant-status-help")).toHaveTextContent("Not set up")
    expect(screen.getByTestId("providers-link-help")).toHaveTextContent("Your AI providers")
    openTab("providers")
    expect(screen.getByTestId("row-claude")).toHaveAttribute("data-word", "ready")
    // Plan not detected: no plan name.
    expect(screen.queryByTestId("plan-claude")).not.toBeInTheDocument()
    expect(screen.getByTestId("row-codex")).toHaveTextContent(/^CodexSigned out$/)
    expect(screen.getAllByTestId(/^row-status-(anthropic|openai|openrouter)$/).map((b) => b.textContent)).toEqual(["Not set up", "Not set up", "Not set up"])
    expect(screen.getByTestId("keys-note")).toHaveTextContent("Assistants use the keys set on your Convex deployment. The Block creator uses its own key from .env.local.")
  })

  test("no subscription signed in and no API key: the no-provider line and no card badges", async () => {
    const status = statusFixture() as unknown as { connections: { state: string }[] }
    for (const connection of status.connections) connection.state = "missing"
    mocks.status = status
    await local(localTools("signed-out", "not-installed"))
    expect(screen.getByTestId("no-provider")).toHaveTextContent("No AI provider is set up. Your AI providers")
    expect(screen.queryAllByTestId(/^assistant-status-/)).toEqual([])
    // The menus stay usable, so the owner can pick what they will set up.
    expect(provider("writing")).toBeEnabled()
  })

  test("Writing and Translation offer the local tools, with their own defaults", async () => {
    await local(localTools("plan", "plan"))
    await choose("writing", "claude")
    await choose("translation", "codex")
    expect(provider("writing")).toHaveTextContent("Claude Code")
    expect(model("writing")).toHaveTextContent("Sonnet 5.5")
    expect(screen.getByTestId("effort-writing")).toHaveValue("medium")
    expect(model("translation")).toHaveTextContent("GPT-6.1 Terra")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(mocks.saveLocal).toHaveBeenCalledWith({
        writing: { engine: "claude", model: "claude-sonnet-5-5", effort: "medium" },
        translation: { engine: "codex", model: "gpt-6.1-terra", effort: "low" },
      })
    )
    expect(mocks.save).not.toHaveBeenCalled()
  })

  test("choosing Claude Code for Help saves the local file only, with the Help defaults", async () => {
    await local(localTools("plan", "plan"))
    await choose("help", "claude")
    expect(model("help")).toHaveTextContent("Haiku 5.5")
    expect(screen.getByTestId("effort-help")).toHaveValue("low")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mocks.saveLocal).toHaveBeenCalledWith({ help: { engine: "claude", model: "claude-haiku-5-5", effort: "low" } }))
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.saveCreator).not.toHaveBeenCalled()
    expect(mocks.success).toHaveBeenCalledWith("Saved")
  })

  test("Help saved on Claude Code: model list, and back to its API service", async () => {
    await local(localTools("plan", "plan", { help: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" } }))
    expect(screen.getByTestId("assistant-status-help")).toHaveTextContent("Ready")
    expect(provider("help")).toHaveTextContent("Claude Code")
    fireEvent.click(model("help"))
    expect(await screen.findByRole("button", { name: /^Opus 5\.5claude-opus-5-5/ })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement!, { key: "Escape" })
    await choose("help", "anthropic")
    expect(model("help")).toHaveTextContent("Claude Haiku 5.5")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mocks.saveLocal).toHaveBeenCalledWith({ help: null }))
    // Same API service as saved in Convex: nothing to change there.
    expect(mocks.save).not.toHaveBeenCalled()
  })

  // Work item 4 (walk1c3 4d): switching back never lands on the first row.
  test("switch back: Claude Code (saved Sonnet 5.5) → Anthropic → Claude Code shows Sonnet 5.5", async () => {
    await local(localTools("plan", "plan", { help: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" } }))
    await choose("help", "anthropic")
    await choose("help", "claude")
    expect(model("help")).toHaveTextContent("Sonnet 5.5")
    expect(screen.getByTestId("effort-help")).toHaveValue("high")
    // Back to the saved choice: nothing to save.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    // Without a saved choice for that tool, its default for this assistant (never its first row).
    await choose("help", "codex")
    expect(model("help")).toHaveTextContent("GPT-6 Luna")
  })

  test("Help saved on a Codex model that is no longer offered: shown as saved, not offered, never replaced", async () => {
    await local(localTools("plan", "plan", { help: { engine: "codex", model: "gpt-5.6-luna", effort: "low" } }))
    expect(provider("help")).toHaveTextContent("Codex")
    expect(model("help")).toHaveTextContent("gpt-5.6-luna")
    expect(screen.getByTestId("effort-help")).toHaveValue("low")
    fireEvent.click(model("help"))
    expect(await screen.findByRole("button", { name: /^GPT-6 Lunagpt-6-luna/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^gpt-5\.6-luna/ })).not.toBeInTheDocument()
    expect(mocks.saveLocal).not.toHaveBeenCalled()
  })

  // Owner 2026-11-15: the menu lists versioned ids; a choice saved before as
  // an alias is never rewritten and shows its id, as any off-list choice.
  test.each(["sonnet", "fable"])("Help saved on the alias %s: shown as saved, not in the list, never replaced", async (alias) => {
    await local(localTools("plan", "plan", { help: { engine: "claude", model: alias, effort: "high" } }))
    expect(model("help")).toHaveTextContent(alias)
    expect(screen.getByTestId("effort-help")).toHaveValue("high")
    fireEvent.click(model("help"))
    expect(await screen.findByRole("button", { name: /^Opus 5\.5claude-opus-5-5/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: new RegExp(`^${alias}$`, "i") })).not.toBeInTheDocument()
    expect(mocks.saveLocal).not.toHaveBeenCalled()
  })

  // Approved prototype (picker.prototype.tsx at 72ba3f4c, owner 2026-11-15):
  // a Fable row without a Max or Ultra plan is listed, greyed, labelled and
  // cannot be chosen. A plan that is not detected says so.
  test.each([
    ["en", "pro", "Needs Max or Ultra"],
    ["fr", "pro", "Nécessite Max ou Ultra"],
    ["en", undefined, "Needs Max or Ultra · plan not detected"],
    ["fr", undefined, "Nécessite Max ou Ultra · forfait non détecté"],
  ] as const)("a greyed Fable row is labelled and cannot be chosen (%s, plan %s)", async (locale, plan, label) => {
    const tools = { ...localTools("plan", "plan", { help: { engine: "claude", model: "claude-opus-5-5", effort: "high" } }), ...(plan ? { claudePlan: plan } : {}) }
    await mount({ isLocal: true, localKeys: noKeys, localTools: tools }, { locale })
    fireEvent.click(model("help"))
    const fable = await screen.findByRole("button", { name: /^Fable 5\.2claude-fable-5-2/ })
    expect(fable).toHaveAttribute("aria-disabled", "true")
    expect(fable).toHaveTextContent(label)
    expect(fable.querySelector("svg")).toHaveClass("invisible")
    fireEvent.click(fable)
    // Still open, nothing chosen: the field keeps the saved model.
    expect(screen.getByRole("button", { name: /^Fable 5\.2claude-fable-5-2/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Opus 5\.5claude-opus-5-5/ })).not.toHaveAttribute("aria-disabled")
    expect(mocks.saveLocal).not.toHaveBeenCalled()
  })

  test("a saved Fable the plan cannot use keeps its versioned name and shows the plan line", async () => {
    await local({ ...localTools("plan", "plan", { help: { engine: "claude", model: "claude-fable-5-2", effort: "low" } }), claudePlan: "pro" })
    expect(model("help")).toHaveTextContent("Fable 5.2")
    expect(row("help").getByTestId("fable-plan")).toHaveTextContent("Fable needs a Claude Max or Ultra plan.")
    expect(row("writing").queryByTestId("fable-plan")).not.toBeInTheDocument()
  })

  // Item 10 (AI-SETTINGS-BUGS): Save refuses any change to a model that is not
  // offered, so its Effort select is locked and keeps the saved effort.
  test.each([
    ["a Codex model no longer listed", true, { engine: "codex", model: "gpt-5.6-luna", effort: "low" }],
    ["a greyed Fable (no Max or Ultra plan)", true, { engine: "claude", model: "claude-fable-5-2", effort: "low" }],
    ["a listed Claude model", false, { engine: "claude", model: "claude-opus-5-5", effort: "high" }],
  ] as const)("Effort for %s: locked %s, showing the saved effort", async (_label, locked, help) => {
    await local({ ...localTools("plan", "plan", { help }), claudePlan: "pro" })
    const effort = screen.getByTestId("effort-help") as HTMLSelectElement
    expect(effort).toHaveValue(help.effort)
    if (locked) expect(effort).toBeDisabled()
    else expect(effort).toBeEnabled()
    expect(screen.getByTestId("effort-writing")).toBeEnabled()
  })

  // SMALL-FIXES item 1 (img1, owner 2026-11-17): a set-up tool whose shown
  // model is not offered says "Choose another model", not "Ready".
  test("a set-up tool whose saved model it no longer lists: Choose another model, on an assistant and the Block creator", async () => {
    const luna = { engine: "codex", model: "gpt-5.6-luna", effort: "low" } as const
    await local(localTools("plan", "plan", { help: luna, blockCreator: luna }))
    expect(screen.getByTestId("assistant-status-help")).toHaveTextContent("Choose another model")
    expect(screen.getByTestId("assistant-status-help")).toHaveAttribute("data-tone", "warn")
    expect(screen.getByTestId("assistant-status-blockCreator")).toHaveTextContent("Choose another model")
    expect(screen.getByTestId("assistant-status-writing")).toHaveTextContent("Ready")
  })

  test("a saved Fable on a Claude Pro plan: Choose another model, the picker stays usable, and an offered model makes it Ready", async () => {
    await local({ ...localTools("plan", "plan", { help: { engine: "claude", model: "claude-fable-5-2", effort: "low" } }), claudePlan: "pro" })
    const badge = screen.getByTestId("assistant-status-help")
    expect(badge).toHaveTextContent("Choose another model")
    expect(badge).toHaveAttribute("data-tone", "warn")
    expect(model("help")).toBeEnabled()
    fireEvent.click(model("help"))
    fireEvent.click(await screen.findByRole("button", { name: /^Opus 5\.5claude-opus-5-5/ }))
    expect(screen.getByTestId("assistant-status-help")).toHaveTextContent("Ready")
    expect(screen.getByTestId("assistant-status-help")).toHaveAttribute("data-tone", "ok")
    expect(mocks.saveLocal).not.toHaveBeenCalled()
  })

  test("a saved Claude model the installed tool no longer lists keeps its readable name", async () => {
    const claude = [{ model: "claude-sonnet-5-5", name: "Sonnet 5.5", efforts: ["low", "medium", "high"] }] as const
    await local({
      ...localTools("plan", "plan", { help: { engine: "claude", model: "claude-opus-5-5", effort: "high" } }),
      menus: localToolMenus({ ...builtInLocalToolModels(), claude: { source: "installed", models: claude } }) as LocalToolsData["menus"],
    })
    expect(model("help")).toHaveTextContent("Opus 5.5")
    expect(model("help")).not.toHaveTextContent("claude-opus-5-5")
    expect(mocks.saveLocal).not.toHaveBeenCalled()
  })

  test("Help on a local tool with no API key: an API service stays selectable, and saving it clears the local choice", async () => {
    const status = statusFixture() as unknown as { connections: { state: string }[] }
    for (const connection of status.connections) connection.state = "missing"
    mocks.status = status
    await local(localTools("plan", "plan", { help: { engine: "claude", model: "sonnet", effort: "high" } }))
    expect(provider("help")).toBeEnabled()
    expect((await options("help")).slice(2)).toEqual([["Anthropic · Not set up", true], ["OpenAI · Not set up", true], ["OpenRouter · Not set up", true]])
    await choose("help", "openai")
    expect(provider("help")).toHaveTextContent("OpenAI")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mocks.saveLocal).toHaveBeenCalledWith({ help: null }))
    expect(mocks.save).toHaveBeenCalledWith({ id: "help", tuple: openai })
    // Help now shows its provider's word.
    await waitFor(() => expect(screen.getByTestId("assistant-status-help")).toHaveTextContent("Not set up"))
  })

  test("leaving a local tool for another API service: its default goes to Convex, then the local choice is removed", async () => {
    await local(localTools("plan", "plan", { writing: { engine: "claude", model: "claude-sonnet-5-5", effort: "medium" } }))
    await choose("writing", "openrouter")
    expect(model("writing")).toHaveTextContent("OR default")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mocks.saveLocal).toHaveBeenCalledWith({ writing: null }))
    expect(mocks.save).toHaveBeenCalledWith({ id: "writing", tuple: openrouter })
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.saveLocal.mock.invocationCallOrder[0]!)
  })

  // Guard for the defect class "metadata lost at an adapter": the Codex
  // default effort reaches the effort field when the owner switches model
  // (design §3); a model without one keeps today's rule.
  describe("switching the Codex model for Help", () => {
    const codexModels = [
      { model: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"] },
      { model: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["low", "medium", "high"], defaultEffort: "low" },
      { model: "gpt-6.2-nova", name: "GPT-6.2-Nova", efforts: ["low", "medium", "high"] },
    ] as const
    const withCodexList = (effort: string): LocalToolsData => ({
      ...localTools("plan", "plan", { help: { engine: "codex", model: "gpt-6.1-sol", effort } }),
      menus: localToolMenus({ ...builtInLocalToolModels(), codex: { source: "installed", models: codexModels } }) as LocalToolsData["menus"],
    })
    test.each([
      ["xhigh", "GPT-6 Luna", "gpt-6-luna", "low"],
      ["high", "GPT-6 Luna", "gpt-6-luna", "low"],
      ["high", "GPT-6.2-Nova", "gpt-6.2-nova", "high"],
    ])("from %s to %s (%s): effort %s", async (from, name, id, effort) => {
      await local(withCodexList(from))
      fireEvent.click(model("help"))
      fireEvent.click(await screen.findByRole("button", { name: `${name}${id}` }))
      expect(screen.getByTestId("effort-help")).toHaveValue(effort)
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
      await waitFor(() => expect(mocks.saveLocal).toHaveBeenCalledWith({ help: { engine: "codex", model: id, effort } }))
    })
  })

  // Work item 3: the Block creator on Codex starts at the effort Codex lists for its model.
  test("choosing Codex for the Block creator starts at the effort Codex recommends", async () => {
    const codexModels = [{ model: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" }] as const
    await local({
      ...localTools("plan", "plan"),
      menus: localToolMenus({ ...builtInLocalToolModels(), codex: { source: "installed", models: codexModels } }) as LocalToolsData["menus"],
    })
    await choose("blockCreator", "codex")
    expect(model("blockCreator")).toHaveTextContent("GPT-6.1 Sol")
    expect(screen.getByTestId("effort-blockCreator")).toHaveValue("medium")
  })

  test("a tool signed in with an API key or an unknown method is Ready; plan names show only for a plan", async () => {
    await local({ ...localTools("api-key", "unknown"), claudePlan: "max" })
    openTab("providers")
    expect(screen.getByTestId("row-claude")).toHaveTextContent(/^Claude CodeReady$/)
    expect(screen.getByTestId("row-codex")).toHaveTextContent(/^CodexReady$/)
  })

  test("a tool that is not installed or not signed in is shown as Signed out and cannot be chosen", async () => {
    await local(localTools("signed-out", "not-installed"))
    openTab("providers")
    expect(screen.getByTestId("row-claude")).toHaveAttribute("data-word", "signedOut")
    expect(screen.getByTestId("row-codex")).toHaveAttribute("data-word", "signedOut")
    expect(screen.getByTestId("row-status-codex")).toHaveAttribute("data-tone", "off")
    expect(screen.queryByText(/Not installed/)).not.toBeInTheDocument()
    openTab("assistants")
    expect((await options("help")).slice(0, 2)).toEqual([["Claude Code · Signed out", false], ["Codex · Signed out", false]])
    expect((await options("blockCreator")).slice(0, 2)).toEqual([["Claude Code · Signed out", false], ["Codex · Signed out", false]])
  })

  test("Block creator on Codex: Ready, no key lines, and both saves", async () => {
    await local(localTools("plan", "plan", { blockCreator: { engine: "codex", model: "gpt-6.1-sol", effort: "high" } }))
    expect(provider("blockCreator")).toHaveTextContent("Codex")
    expect(screen.getByTestId("assistant-status-blockCreator")).toHaveTextContent("Ready")
    // Instructions still go to Convex with the saved API service.
    fireEvent.change(row("blockCreator").getByRole("textbox"), { target: { value: "Block rules" } })
    await choose("blockCreator", "anthropic")
    expect(row("blockCreator").queryByText(/API_KEY|\.env\.local/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mocks.saveLocal).toHaveBeenCalledWith({ blockCreator: null }))
    expect(mocks.saveCreator).toHaveBeenCalledWith({ tuple: anthropic, instructions: "Block rules" })
  })

  test("Save runs one at a time: each assistant, then the Block creator, then the local file", async () => {
    await local(localTools("plan", "plan"), anthropicKey)
    fireEvent.change(row("translation").getByRole("textbox"), { target: { value: "Translate words" } })
    fireEvent.change(row("writing").getByRole("textbox"), { target: { value: "Write words" } })
    fireEvent.change(row("blockCreator").getByRole("textbox"), { target: { value: "Block words" } })
    await choose("help", "claude")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Saved"))
    const order = [
      ...mocks.save.mock.invocationCallOrder.map((at, i) => [at, `setAssistant:${(mocks.save.mock.calls[i]![0] as { id: string }).id}`] as const),
      ...mocks.saveCreator.mock.invocationCallOrder.map((at) => [at, "setBlockCreator"] as const),
      ...mocks.saveLocal.mock.invocationCallOrder.map((at) => [at, "localFile"] as const),
    ].sort((a, b) => a[0] - b[0]).map(([, name]) => name)
    expect(order).toEqual(["setAssistant:translation", "setAssistant:writing", "setBlockCreator", "localFile"])
    expect(mocks.saveLocal).toHaveBeenCalledWith({ help: { engine: "claude", model: "claude-haiku-5-5", effort: "low" } })
  })

  test("FR: the rail, Vos fournisseurs d’IA and the provider options", async () => {
    await mount({ isLocal: true, localKeys: noKeys, localTools: { ...localTools("plan", "signed-out"), claudePlan: "max" } }, { locale: "fr" })
    expect(screen.getByTestId("ai-rail")).toHaveTextContent("AssistantsVos fournisseurs d’IA")
    const help = await menu("help")
    expect(help.getByRole("group", { name: "Abonnements" })).toHaveTextContent("Claude CodeCodex · Déconnecté")
    expect(help.getByRole("group", { name: "Clés API" })).toHaveTextContent("AnthropicOpenAI · Non configuréOpenRouter")
    fireEvent.click(provider("help"))
    openTab("providers")
    expect(screen.getByTestId("group-subscriptions")).toHaveTextContent("AbonnementsUtilise votre session Claude Code ou Codex ouverte sur cet ordinateur.")
    expect(screen.getByTestId("row-claude")).toHaveTextContent("Claude CodeForfait Claude MaxPrêt")
    expect(screen.getByTestId("row-codex")).toHaveTextContent("CodexDéconnecté")
    expect(screen.getByTestId("keys-note")).toHaveTextContent("Les assistants utilisent les clés définies sur votre déploiement Convex. Le créateur de blocs utilise sa propre clé dans .env.local.")
    expect(screen.getByTestId("row-openai")).toHaveTextContent("OpenAINon configuré")
  })
})

describe("off localhost", () => {
  test("the live site shows no local tools and no local choice", async () => {
    await mount({ isLocal: false })
    openTab("providers")
    expect(screen.queryByTestId("group-subscriptions")).not.toBeInTheDocument()
    openTab("assistants")
    expect(await options("help")).toEqual([["Anthropic", true], ["OpenAI · Not set up", false], ["OpenRouter", true]])
  })

  test("another device in local development: no Subscriptions group and no local tool option", async () => {
    window.history.replaceState(null, "", "/admin/settings/ai?tab=providers")
    await mount({ isLocal: true, localKeys: noKeys })
    expect(screen.queryByTestId("group-subscriptions")).not.toBeInTheDocument()
    expect(screen.getByTestId("group-api-keys")).toBeInTheDocument()
    openTab("assistants")
    // The Block creator's words follow its .env.local keys, and this computer has none.
    expect((await options("blockCreator")).map(([label]) => label)).toEqual(["Anthropic · Not set up", "OpenAI · Not set up", "OpenRouter · Not set up"])
    expect((await options("help")).map(([label]) => label)).toEqual(["Anthropic", "OpenAI · Not set up", "OpenRouter"])
  })

  test("guard: a request from another device gets no local tools; no status command runs and the file is not read", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(false)
    await expect(ADMIN_AI_SETTINGS_SERVER_BINDING!.loadLocalTools()).resolves.toBeUndefined()
    const element = await AiSettingsPage()
    expect((element as { props: Record<string, unknown> }).props).not.toHaveProperty("localTools")
    expect(mocks.inspectLocalTools).not.toHaveBeenCalled()
    expect(mocks.readLocalToolChoices).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  test.each([
    ["anyone but the owner", () => { mocks.requireInstallationOwner.mockRejectedValueOnce(new Error("owner only")) }],
    ["the AI module off", () => { mocks.aiOutcome = "off" }],
    ["the module state unreadable", () => { mocks.aiOutcome = "error" }],
  ])("guard: %s on this computer gets no local tools; no status command runs and the file is not read", async (_label, arrange) => {
    mocks.isLocalToolRequest.mockResolvedValue(true)
    arrange()
    await expect(ADMIN_AI_SETTINGS_SERVER_BINDING!.loadLocalTools()).resolves.toBeUndefined()
    expect(mocks.inspectLocalTools).not.toHaveBeenCalled()
    expect(mocks.readLocalToolChoices).not.toHaveBeenCalled()
    expect(mocks.isLocalToolRequest).not.toHaveBeenCalled()
    expect(mocks.readFileSync).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  test.each([
    ["anyone but the owner", () => { mocks.requireInstallationOwner.mockRejectedValueOnce(new Error("owner only")) }],
    ["the AI module off", () => { mocks.aiOutcome = "off" }],
  ])("guard: the Block creator readiness for %s is not ready and reads no local file", async (_label, arrange) => {
    mocks.isLocalToolRequest.mockResolvedValue(true)
    arrange()
    await expect(ADMIN_AI_SETTINGS_SERVER_BINDING!.resolveBlockCreatorReady()).resolves.toBe(false)
    expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
    expect(mocks.readFileSync).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  test("the AI module needing setup still shows the local tools (the screen renders then)", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(true)
    mocks.aiOutcome = "needs_setup"
    mocks.inspectLocalTools.mockResolvedValue({ claude: "plan", codex: "plan" })
    await expect(ADMIN_AI_SETTINGS_SERVER_BINDING!.loadLocalTools()).resolves.toMatchObject({ choices: {} })
    expect(mocks.inspectLocalTools).toHaveBeenCalledOnce()
  })

  test("a request from this computer gets the method only and the saved choices", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(true)
    const claudeSignIn = { status: "plan", loggedIn: true, authMethod: "oauth_token", envKey: false }
    mocks.inspectLocalTools.mockResolvedValue({ claude: "plan", codex: "unknown", claudeSignIn })
    mocks.readLocalToolChoices.mockReturnValue({ help: { engine: "codex", model: "gpt-6-luna", effort: "low" } })
    const nova = { model: "gpt-6.2-nova", name: "GPT-6.2-Nova", efforts: ["high"] }
    const builtIn = builtInLocalToolModels()
    mocks.loadLocalToolModels.mockResolvedValueOnce({ ...builtIn, codex: { source: "installed", models: [nova] } })
    const tools = await ADMIN_AI_SETTINGS_SERVER_BINDING!.loadLocalTools()
    expect(tools).toMatchObject({
      tools: [{ tool: "claude", status: "plan" }, { tool: "codex", status: "unknown" }],
      choices: { help: { engine: "codex", model: "gpt-6-luna", effort: "low" } },
      save: mocks.saveLocal,
    })
    // The menus come from the installed tools' lists, read for their status.
    expect(mocks.loadLocalToolModels).toHaveBeenCalledWith({ codex: "unknown", claude: claudeSignIn })
    expect(tools?.menus.codex.models).toEqual([nova])
    expect(tools).not.toHaveProperty("claudePlan")
    // The plan's closed name comes with the list read, never the raw string.
    mocks.loadLocalToolModels.mockResolvedValueOnce({ ...builtIn, claude: { ...builtIn.claude, plan: "max" } })
    await expect(ADMIN_AI_SETTINGS_SERVER_BINDING!.loadLocalTools()).resolves.toMatchObject({ claudePlan: "max" })
    mocks.readLocalToolChoices.mockImplementation(() => { throw new Error("Invalid dev AI selection") })
    await expect(ADMIN_AI_SETTINGS_SERVER_BINDING!.loadLocalTools()).resolves.toMatchObject({ choices: {} })
  })
})
