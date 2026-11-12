import type { ModuleGateState } from "./module-gate"
const moduleTestGate = vi.hoisted(() => ({ state: "on" as ModuleGateState }))
vi.mock("./admin-module-state-provider", () => ({
  useModuleGate: () => ({ state: moduleTestGate.state }),
}))
import { act, fireEvent, render, screen } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { LanguagesSettings } from "./multilingual-languages-settings"

const mocks = vi.hoisted(() => ({
  queryCalls: [] as Array<{ name: string; args: unknown }>,
  queries: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}))

function mutation(name: string) {
  let fn = mocks.mutations.get(name)
  if (!fn) {
    fn = vi.fn().mockResolvedValue(null)
    mocks.mutations.set(name, fn)
  }
  return fn
}

vi.mock("convex/react", () => ({
  useQuery: (
    reference: Parameters<typeof getFunctionName>[0],
    args: unknown
  ) => {
    mocks.queryCalls.push({ name: getFunctionName(reference), args })
    return args === "skip"
      ? undefined
      : mocks.queries.get(getFunctionName(reference))
  },
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) =>
    mutation(getFunctionName(reference)),
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("./language-transition", () => ({
  LanguageTransition: () => <div data-testid="language-transition" />,
}))

function multilingualState(overrides: Record<string, unknown> = {}) {
  return {
    lifecycleState: "S4",
    origin: null,
    moduleEnabled: true,
    moduleConfigurationVersion: 9,
    version: 4,
    defaultLocale: "en",
    enabledLocales: ["en", "fr"],
    openOperation: null,
    defaultMigration: null,
    latestPreviews: [],
    commandTokens: {
      settingsUpdatedAt: 42,
      moduleConfigurationVersion: 9,
      authorityVersion: 4,
    },
    ...overrides,
  }
}

function renderSettings(messages: typeof en = en, locale = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <LanguagesSettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  moduleTestGate.state = "on"
  mocks.queryCalls.length = 0
  mocks.queries.clear()
  mocks.mutations.clear()
  mocks.queries.set(
    "cms/multilingual:getMultilingualState",
    multilingualState()
  )
  mocks.queries.set("cms/settings:getSettings", {
    updatedAt: 42,
    defaultLocale: "en",
    enabledLocales: ["en", "fr"],
    siteDescriptions: { en: "Design and build for small studios." },
  })
  mocks.queries.set("cms/languageLifecycle:getLanguageLifecycleStatus", {
    updating: false,
    notDelivered: true,
    failing: true,
    localUnreachable: false,
    oldestUndelivered: null,
    operation: null,
  })
})

describe("LanguagesSettings container", () => {
  test("waits for the language state", () => {
    mocks.queries.delete("cms/multilingual:getMultilingualState")
    renderSettings()

    expect(screen.getByText("Loading…")).toBeInTheDocument()
  })

  test("shows no delivery notice even when an update was not delivered (A2)", () => {
    renderSettings()

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText("Public site updates")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Retry now" })
    ).not.toBeInTheDocument()
  })

  test("shows the card for any lifecycle state without naming it", () => {
    for (const lifecycleState of ["S0", "S1", "S2", "S3", "S4"]) {
      mocks.queries.set(
        "cms/multilingual:getMultilingualState",
        multilingualState({ lifecycleState, enabledLocales: ["en"] })
      )
      const view = renderSettings()
      expect(
        screen.getByRole("heading", { level: 1, name: "Languages" })
      ).toBeInTheDocument()
      expect(
        screen.queryByText(/adopt|adoption|Enabled languages|Return to one language/i)
      ).not.toBeInTheDocument()
      view.unmount()
    }
  })

  test("Make default calls setDefaultLanguage with the state's tokens and opens no dialog", async () => {
    renderSettings()

    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Français" }), {
      key: "Enter",
    })
    fireEvent.click(await screen.findByRole("menuitem", { name: /Make default/ }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(mutation("cms/multilingual:setDefaultLanguage")).toHaveBeenCalledWith({
      toLocale: "fr",
      expectedAuthorityVersion: 4,
      expectedModuleConfigurationVersion: 9,
    })
  })

  test("the menu status line reads countMenuTextMissing for the non-default languages", () => {
    mocks.queries.set("cms/menus:countMenuTextMissing", { fr: 2 })
    renderSettings()

    const call = mocks.queryCalls.find(
      (entry) => entry.name === "cms/menus:countMenuTextMissing"
    )
    expect(call?.args).toEqual({ locales: ["fr"] })
    expect(screen.getByTestId("menu-status")).toHaveTextContent(
      "Menu text missing (2 items)"
    )
  })

  test("a one-language site does not ask for menu text counts", () => {
    mocks.queries.set(
      "cms/multilingual:getMultilingualState",
      multilingualState({ lifecycleState: "S1", enabledLocales: ["en"] })
    )
    renderSettings()

    const call = mocks.queryCalls.find(
      (entry) => entry.name === "cms/menus:countMenuTextMissing"
    )
    expect(call?.args).toBe("skip")
  })
})

describe("LanguagesSettings wiring", () => {
  async function pickAndAdd(label: RegExp) {
    fireEvent.keyDown(screen.getByRole("button", { name: "Language to add" }), {
      key: "ArrowDown",
    })
    fireEvent.click(await screen.findByRole("option", { name: label }))
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await act(async () => {
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    Element.prototype.hasPointerCapture = () => false
    Element.prototype.setPointerCapture = () => {}
    Element.prototype.releasePointerCapture = () => {}
    Element.prototype.scrollIntoView = () => {}
  })

  test("adding sends the tokens the state returned to addSiteLanguage, with no dialog", async () => {
    mocks.queries.set(
      "cms/multilingual:getMultilingualState",
      multilingualState({
        lifecycleState: "S0",
        version: null,
        enabledLocales: ["en"],
        commandTokens: {
          settingsUpdatedAt: 77,
          moduleConfigurationVersion: 3,
          authorityVersion: null,
        },
      })
    )
    renderSettings()

    await pickAndAdd(/Español/)

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(mutation("cms/multilingual:addSiteLanguage")).toHaveBeenCalledWith({
      locale: "es",
      expectedSettingsUpdatedAt: 77,
      expectedModuleConfigurationVersion: 3,
      expectedAuthorityVersion: null,
    })
  })

  test("an unadopted site prepares through prepareLanguageChange only after Continue in the Remove dialog", async () => {
    mocks.queries.set(
      "cms/multilingual:getMultilingualState",
      multilingualState({ lifecycleState: "S2" })
    )
    renderSettings()
    expect(mutation("cms/multilingual:prepareLanguageChange")).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Français" }), {
      key: "Enter",
    })
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove/ }))
    await act(async () => {
      await Promise.resolve()
    })
    // Choosing Remove alone writes nothing.
    expect(mutation("cms/multilingual:prepareLanguageChange")).not.toHaveBeenCalled()

    fireEvent.click(
      await screen.findByRole("button", { name: "Count what is affected" })
    )
    await act(async () => {
      await Promise.resolve()
    })

    expect(mutation("cms/multilingual:prepareLanguageChange")).toHaveBeenCalledWith({
      expectedSettingsUpdatedAt: 42,
      expectedModuleConfigurationVersion: 9,
      expectedAuthorityVersion: 4,
    })
  })
})

describe("admin messages", () => {
  test("French and English Languages and Modules messages keep identical keys", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([key, child]) =>
            keys(child, `${prefix}${key}.`)
          )
        : [prefix]

    expect(keys(fr.settings.multilingualLanguages).sort()).toEqual(
      keys(en.settings.multilingualLanguages).sort()
    )
    expect(keys(fr.settings.languages).sort()).toEqual(
      keys(en.settings.languages).sort()
    )
    expect(keys(fr.settings.languageLifecycle).sort()).toEqual(
      keys(en.settings.languageLifecycle).sort()
    )
    expect(keys(fr.settings.modules).sort()).toEqual(
      keys(en.settings.modules).sort()
    )
    expect(keys(fr.common.localeTabs).sort()).toEqual(
      keys(en.common.localeTabs).sort()
    )
  })
})


test("committed off state withholds Languages optional controls", () => {
  moduleTestGate.state = "off"
  renderSettings()
  expect(screen.queryByRole("button", { name: /Actions for/ })).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Language to add" })).not.toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "Languages" })).toBeInTheDocument()
})
