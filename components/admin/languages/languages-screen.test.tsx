import type { ModuleGateState } from "../module-gate"
const moduleTestGate = vi.hoisted(() => ({ state: "on" as ModuleGateState, forced: null as ModuleGateState | null }))
vi.mock("../admin-module-state-provider", () => ({ useModuleGate: () => ({ state: moduleTestGate.state }) }))
import { StrictMode } from "react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { ConvexError } from "convex/values"
import { NextIntlClientProvider } from "next-intl"
import { toast } from "sonner"
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { STALL_AFTER_MS } from "./default-migration-panel"
import { DisclosureItems } from "./impact-review"
import { LanguagesScreen } from "./languages-screen"
import type {
  DefaultMigration,
  DefaultReadiness,
  ImpactPageResult,
  ImpactPreview,
  LanguagesActions,
  LanguagesQueries,
  LanguagesState,
  NeedsReviewResult,
} from "./types"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The legacy workflow is rendered only to finish or stop a change left open.
vi.mock("../language-transition", () => ({
  LanguageTransition: () => <div data-testid="language-transition" />,
}))

const previewId = "preview1" as Id<"siteLanguageImpactPreviews">
const migrationId = "migration1" as Id<"siteDefaultLanguageMigrations">

function makeState(overrides: Partial<LanguagesState> = {}): LanguagesState {
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

function oneLanguage(overrides: Partial<LanguagesState> = {}) {
  return makeState({
    lifecycleState: "S1",
    moduleEnabled: false,
    version: 1,
    enabledLocales: ["en"],
    commandTokens: {
      settingsUpdatedAt: 42,
      moduleConfigurationVersion: 3,
      authorityVersion: 1,
    },
    ...overrides,
  })
}

/** One language with Multilingual switched on in Modules (S3, not adopted). */
function oneLanguageOn(overrides: Partial<LanguagesState> = {}) {
  return oneLanguage({
    lifecycleState: "S3",
    moduleEnabled: true,
    ...overrides,
  })
}

function makePreview(overrides: Partial<ImpactPreview> = {}): ImpactPreview {
  return {
    previewId,
    kind: "remove",
    locale: "fr",
    phase: "complete",
    count: { publicPages: 3, routes: 4, manualRules: 1, menus: 2 },
    digest: "preview-digest",
    pageCount: 1,
    reviewedThroughOrdinal: -1,
    generation: 1,
    updatedAt: 10,
    ...overrides,
  }
}

function makeMigration(
  overrides: Partial<DefaultMigration> = {}
): DefaultMigration {
  return {
    migrationId,
    fromLocale: "en",
    toLocale: "fr",
    phase: "ready",
    generation: 2,
    counts: {
      rows: 1,
      shadowedByCurrent: 0,
      shadowedByHistorical: 0,
      manualRulesShadowed: 0,
      manualRulesShifted: 0,
      manualRulesUnprefixed: 0,
      carriedShadowedSkipped: 0,
      blockers: 0,
    },
    disclosurePageCount: 1,
    reviewedThroughOrdinal: -1,
    readinessVersion: 7,
    ...overrides,
  }
}

const reviewPage: ImpactPageResult = {
  stale: false,
  ordinal: 0,
  pageCount: 1,
  section: "selections",
  items: [
    {
      kind: "selection",
      pageId: "page1" as Id<"pages">,
      path: "/a-propos",
      title: "À propos",
    },
  ],
  digest: "page-digest",
}

/** A review page for any ordinal, with its own digest and one item. */
function pageAt(ordinal: number, pageCount: number): ImpactPageResult {
  return {
    stale: false,
    ordinal,
    pageCount,
    section: "selections",
    items: [
      {
        kind: "selection",
        pageId: `page${ordinal}` as Id<"pages">,
        path: `/page-${ordinal}`,
        title: `Page ${ordinal}`,
      },
    ],
    digest: `digest-${ordinal}`,
  }
}

type Setup = {
  actions: { [K in keyof LanguagesActions]: ReturnType<typeof vi.fn> }
  queries: { [K in keyof LanguagesQueries]: ReturnType<typeof vi.fn> }
}

function makeProps(
  options: {
    needsReview?: NeedsReviewResult | undefined
    readiness?: DefaultReadiness | undefined
    impactPage?: ImpactPageResult | undefined
    disclosurePage?: unknown
    menuTextMissing?: Record<string, number>
  } = {}
): Setup {
  const resolved = (value: unknown = null) => vi.fn().mockResolvedValue(value)
  return {
    actions: {
      addSiteLanguage: resolved({ ok: true, operationKind: "add" }),
      setDefaultLanguage: resolved({ ok: true, authorityVersion: 5 }),
      prepareLanguageReview: resolved({ cancelReturnsToOneLanguage: true }),
      prepareLanguageChange: resolved({
        authorityVersion: 5,
        moduleConfigurationVersion: 10,
        settingsUpdatedAt: 43,
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
      }),
      removeLastExtraLanguage: resolved({ removedLocale: "fr" }),
      addLanguage: resolved({ operationKind: "reveal" }),
      removeLanguage: resolved({ locale: "fr" }),
      startLanguageImpactPreview: resolved({ previewId }),
      recordLanguageImpactReview: resolved({ stale: false }),
      startDefaultLanguageMigration: resolved({ migrationId }),
      continueDefaultLanguageMigration: resolved(),
      recordDefaultMigrationReview: resolved({ stale: false }),
      activateDefaultLanguageMigration: resolved(),
      cancelDefaultLanguageMigration: resolved(),
      copySiteDescription: resolved({ copied: true }),
    },
    queries: {
      useMenuTextMissing: vi.fn().mockReturnValue(options.menuTextMissing),
      useNeedsReviewToAddLanguage: vi
        .fn()
        .mockReturnValue(
          "needsReview" in options
            ? options.needsReview
            : { needsReview: false, reasons: [] }
        ),
      useImpactPage: vi
        .fn()
        .mockImplementation((args: unknown) =>
          args === "skip"
            ? undefined
            : "impactPage" in options
              ? options.impactPage
              : reviewPage
        ),
      useDefaultRoutes: vi.fn().mockReturnValue({
        results: [
          {
            pageId: "page1",
            fromPath: "/about",
            locale: "en",
            origin: "old_default_current",
          },
        ],
        status: "Exhausted",
        loadMore: vi.fn(),
      }),
      useMigrationDisclosure: vi
        .fn()
        .mockImplementation((args: unknown) =>
          args === "skip"
            ? undefined
            : (options.disclosurePage ?? {
                stale: false,
                ordinal: 0,
                pageCount: 1,
                section: "shadowed",
                items: [
                  {
                    kind: "shadowed_row",
                    pageId: "page1",
                    fromPath: "/about",
                    destinationLocale: "fr",
                    reason: "to_current",
                  },
                ],
                digest: "disclosure-digest",
              })
        ),
      useDefaultReadiness: vi
        .fn()
        .mockReturnValue(
          "readiness" in options
            ? options.readiness
            : { homePublished: true, menuText: true, siteDescription: true }
        ),
    },
  }
}

function renderScreen(
  state: LanguagesState,
  setup: Setup = makeProps(),
  locale: "en" | "fr" = "en"
) {
  const tree = (current: LanguagesState) => {
    moduleTestGate.state = moduleTestGate.forced ?? (current.moduleEnabled ? "on" : "off")
    return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? en : fr}
    >
      <LanguagesScreen
        state={current}
        actions={setup.actions as unknown as LanguagesActions}
        queries={setup.queries as unknown as LanguagesQueries}
      />
    </NextIntlClientProvider>
  )
  }
  const view = render(tree(state))
  return {
    ...setup,
    update: (next: LanguagesState) => view.rerender(tree(next)),
  }
}

/** Radix opens menus and pickers from the keyboard in jsdom. */
function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" })
  return screen.findByRole("menu")
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeAll(() => {
  // Radix Select measures and scrolls; jsdom has neither.
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
})

beforeEach(() => {
  moduleTestGate.forced = null
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("the card", () => {
  test("a one-language site shows one row with Default and no row menu", async () => {
    renderScreen(oneLanguage())

    expect(screen.getByRole("heading", { name: "Languages" })).toBeInTheDocument()
    expect(
      screen.queryByText("Your site is in English.")
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Site languages")).not.toBeInTheDocument()
    expect(screen.queryByText("Changes apply as soon as you confirm them.")).not.toBeInTheDocument()
    const rows = within(screen.getByRole("list")).getAllByRole("listitem")
    expect(rows).toHaveLength(1)
    expect(within(rows[0]!).getByText("English")).toBeInTheDocument()
    expect(within(rows[0]!).getByText("en")).toBeInTheDocument()
    expect(within(rows[0]!).getByText("Default")).toBeInTheDocument()

    // Multilingual is off: nothing to change from a menu (owner, 2026-11-05).
    expect(screen.queryByRole("button", { name: "Actions for English" })).not.toBeInTheDocument()
    expect(screen.queryByText(/Change language/)).not.toBeInTheDocument()
  })

  test("a change left open does not open by itself; the banner's Continue reopens it", async () => {
    renderScreen(
      oneLanguage({
        openOperation: { kind: "language_transition", phase: "preparing" },
      })
    )

    await flush()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }))
    const dialog = await screen.findByRole("dialog", { name: "Change site language" })
    expect(within(dialog).getByTestId("language-transition")).toBeInTheDocument()
    // Closing it leaves the banner to reopen it.
    fireEvent.keyDown(dialog, { key: "Escape" })
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }))
    expect(
      within(await screen.findByRole("dialog", { name: "Change site language" })).getByTestId(
        "language-transition"
      )
    ).toBeInTheDocument()
  })

  test("with Multilingual off, Add is replaced by a link to Modules and no picker or Add button shows", () => {
    renderScreen(oneLanguage())

    expect(screen.queryByRole("button", { name: "Language to add" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument()
    const note = screen.getByTestId("add-needs-module")
    expect(note).toHaveTextContent(
      "To publish in more languages, turn on Multilingual in Modules."
    )
    expect(within(note).getByRole("link", { name: "Modules" })).toHaveAttribute(
      "href",
      "/admin/settings/modules"
    )
  })

  test("with Multilingual on, the picker and Add show and the note is gone", () => {
    renderScreen(oneLanguageOn())

    expect(screen.getByRole("button", { name: "Language to add" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument()
    expect(screen.queryByTestId("add-needs-module")).not.toBeInTheDocument()
  })

  test("Change language… is not offered, with Multilingual on or off", async () => {
    renderScreen(oneLanguage())
    expect(screen.queryByRole("button", { name: "Actions for English" })).not.toBeInTheDocument()
    expect(screen.queryByText(/Change language/)).not.toBeInTheDocument()
    cleanup()
    renderScreen(oneLanguageOn())
    expect(screen.queryByRole("button", { name: "Actions for English" })).not.toBeInTheDocument()
    expect(screen.queryByText(/Change language/)).not.toBeInTheDocument()
  })

  test("an open change opens no dialog and makes no call on load, even in StrictMode", async () => {
    // A language change left open waits behind the banner. For a one-language
    // site that still has Multilingual on, loading must not run a write.
    const setup = makeProps()
    render(
      <StrictMode>
        <NextIntlClientProvider locale="en" messages={en}>
          <LanguagesScreen
            state={oneLanguage({
              lifecycleState: "S4",
              moduleEnabled: true,
              openOperation: { kind: "language_transition", phase: "preparing" },
            })}
            actions={setup.actions as unknown as LanguagesActions}
            queries={setup.queries as unknown as LanguagesQueries}
          />
        </NextIntlClientProvider>
      </StrictMode>
    )
    await flush()

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(setup.actions.prepareLanguageChange).not.toHaveBeenCalled()
  })

  test("a site with several languages lists the default first and gates the row menu", async () => {
    renderScreen(
      makeState({ enabledLocales: ["fr", "en", "es"], defaultLocale: "en" })
    )

    const card = screen.getByRole("list").closest("[data-slot=card]")! as HTMLElement
    const names = within(card)
      .getAllByRole("listitem")
      .map((row) => row.textContent)
    expect(names[0]).toContain("English")
    expect(names[0]).toContain("Default")
    expect(names[1]).toContain("Français")
    expect(names[2]).toContain("Español")
    expect(screen.queryByText("The languages your site is published in.")).not.toBeInTheDocument()

    const defaultMenu = await openMenu("Actions for English")
    expect(within(defaultMenu).queryByRole("menuitem", { name: /Make default/ })).not.toBeInTheDocument()
    expect(within(defaultMenu).getByRole("menuitem", { name: /Remove/ })).toHaveAttribute("aria-disabled", "true")
    fireEvent.keyDown(defaultMenu, { key: "Escape" })

    const otherMenu = await openMenu("Actions for Français")
    expect(within(otherMenu).getByRole("menuitem", { name: /Make default/ })).not.toHaveAttribute("aria-disabled", "true")
    expect(within(otherMenu).getByRole("menuitem", { name: /Remove/ })).not.toHaveAttribute("aria-disabled", "true")
  })

  test("once the open change is stopped, its dialog closes and no new change can start", async () => {
    const view = renderScreen(
      oneLanguage({
        openOperation: { kind: "language_transition", phase: "preparing" },
      })
    )
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }))
    await screen.findByTestId("language-transition")

    // The change was stopped: the server no longer reports an open operation.
    view.update(oneLanguage({ openOperation: null }))
    await flush()

    expect(screen.queryByTestId("language-transition")).not.toBeInTheDocument()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  describe("the Add picker keyboard (WAI-ARIA combobox with listbox)", () => {
    async function openPicker() {
      renderScreen(oneLanguageOn())
      const trigger = screen.getByRole("button", { name: "Language to add" })
      fireEvent.keyDown(trigger, { key: "ArrowDown" })
      const input = await screen.findByRole("combobox", { name: "Search languages…" })
      return { trigger, input }
    }
    const activeName = (input: HTMLElement) =>
      document.getElementById(input.getAttribute("aria-activedescendant")!)!.textContent

    test("the field points at its listbox and the first option is active", async () => {
      const { input } = await openPicker()
      const list = screen.getByRole("listbox")
      expect(input).toHaveAttribute("aria-controls", list.id)
      expect(input).toHaveAttribute("aria-expanded", "true")
      expect(activeName(input)).toContain("Français")
      for (const option of screen.getAllByRole("option")) {
        expect(option).toHaveAttribute("tabindex", "-1")
      }
    })

    test("ArrowDown and ArrowUp move the active option and wrap", async () => {
      const { input } = await openPicker()
      const names = screen.getAllByRole("option").map((o) => o.textContent)
      fireEvent.keyDown(input, { key: "ArrowDown" })
      expect(activeName(input)).toBe(names[1])
      fireEvent.keyDown(input, { key: "ArrowUp" })
      fireEvent.keyDown(input, { key: "ArrowUp" })
      expect(activeName(input)).toBe(names.at(-1))
      fireEvent.keyDown(input, { key: "ArrowDown" })
      expect(activeName(input)).toBe(names[0])
    })

    test("Home and End jump to the first and last option", async () => {
      const { input } = await openPicker()
      const names = screen.getAllByRole("option").map((o) => o.textContent)
      fireEvent.keyDown(input, { key: "End" })
      expect(activeName(input)).toBe(names.at(-1))
      fireEvent.keyDown(input, { key: "Home" })
      expect(activeName(input)).toBe(names[0])
    })

    test("Enter picks the active option, which is the first match by default", async () => {
      const { input, trigger } = await openPicker()
      fireEvent.change(input, { target: { value: "pt" } })
      expect(activeName(input)).toContain("Português")
      fireEvent.keyDown(input, { key: "ArrowDown" })
      fireEvent.keyDown(input, { key: "Enter" })
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
      expect(trigger).toHaveTextContent(/Português/)
      expect(trigger).toHaveFocus()
    })

    test("typing resets the active option to the first match", async () => {
      const { input } = await openPicker()
      fireEvent.keyDown(input, { key: "End" })
      fireEvent.change(input, { target: { value: "e" } })
      expect(activeName(input)).toBe(screen.getAllByRole("option")[0]!.textContent)
    })

    test("Escape closes the list and returns focus to the trigger without picking", async () => {
      const { input, trigger } = await openPicker()
      fireEvent.keyDown(input, { key: "Escape" })
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
      expect(trigger).not.toHaveTextContent(/Français/)
    })
  })

  test("typing in the Add picker filters the list by name or code", async () => {
    renderScreen(oneLanguageOn())

    fireEvent.keyDown(screen.getByRole("button", { name: "Language to add" }), { key: "ArrowDown" })
    const search = await screen.findByRole("combobox", { name: "Search languages…" })
    fireEvent.change(search, { target: { value: "fran" } })
    const options = screen.getAllByRole("option")
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent("Français")
    fireEvent.change(search, { target: { value: "xyzzy" } })
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
    expect(screen.getByText("No language matches.")).toBeInTheDocument()
    fireEvent.change(search, { target: { value: "PT" } })
    expect(screen.getAllByRole("option")).toHaveLength(2)
  })

  test("the Add picker offers only languages that are not added", async () => {
    renderScreen(makeState())

    fireEvent.keyDown(screen.getByRole("button", { name: "Language to add" }), { key: "ArrowDown" })
    const options = await screen.findAllByRole("option")
    const labels = options.map((option) => option.textContent)
    expect(labels).not.toContainEqual(expect.stringContaining("English"))
    expect(labels).not.toContainEqual(expect.stringContaining("Français"))
    expect(labels).toContainEqual(expect.stringContaining("Español"))
    expect(screen.getByRole("button", { name: "Add", hidden: true })).toBeDisabled()
  })

  test("an invalid setup shows one plain message and nothing to click", () => {
    renderScreen(makeState({ lifecycleState: "IX", defaultLocale: null, enabledLocales: [], version: null }))

    expect(screen.getByRole("alert")).toHaveTextContent("The language setup has a problem. Nothing was changed.")
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument()
  })

  test("renders in French", async () => {
    renderScreen(oneLanguage(), makeProps(), "fr")

    expect(screen.getByRole("heading", { name: "Langues" })).toBeInTheDocument()
    expect(
      screen.queryByText("Votre site est en English.")
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Actions pour English" })).not.toBeInTheDocument()
    expect(screen.queryByText(/Changer de langue/)).not.toBeInTheDocument()
  })
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function pickLanguage(label: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: "Language to add" }), { key: "ArrowDown" })
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(label) }))
}

describe("add a language, silently", () => {
  test("one click calls addSiteLanguage with the tokens, opens no dialog and toasts", async () => {
    const view = renderScreen(oneLanguageOn())

    await pickLanguage("Français")
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await flush()

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(view.actions.addSiteLanguage).toHaveBeenCalledTimes(1)
    expect(view.actions.addSiteLanguage).toHaveBeenCalledWith({
      locale: "fr",
      expectedSettingsUpdatedAt: 42,
      expectedModuleConfigurationVersion: 3,
      expectedAuthorityVersion: 1,
    })
    expect(view.actions.prepareLanguageReview).not.toHaveBeenCalled()
    expect(view.queries.useNeedsReviewToAddLanguage).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith("Français was added.")
  })

  test("passes a null authority version when no authority row exists yet", async () => {
    const view = renderScreen(
      oneLanguageOn({
        lifecycleState: "S0",
        version: null,
        commandTokens: {
          settingsUpdatedAt: 42,
          moduleConfigurationVersion: 3,
          authorityVersion: null,
        },
      })
    )

    await pickLanguage("Français")
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await flush()

    expect(view.actions.addSiteLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAuthorityVersion: null })
    )
  })

  test("a re-added language is silent too: one plain toast, no page list, no dialog", async () => {
    const setup = makeProps()
    setup.actions.addSiteLanguage.mockResolvedValue({ ok: true, operationKind: "reveal" })
    renderScreen(oneLanguageOn(), setup)

    await pickLanguage("Français")
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await flush()

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith("Français was added.")
    expect(toast.error).not.toHaveBeenCalled()
  })

  test("an address conflict keeps the language selected and shows the conflicts beside Add", async () => {
    const setup = makeProps()
    setup.actions.addSiteLanguage.mockResolvedValue({
      ok: false,
      code: "LANGUAGE_ADDRESS_CONFLICT",
      conflicts: [
        { kind: "page", publicPath: "/fr/about", pageId: "page9" },
        { kind: "former_address", publicPath: "/fr/old", pageId: "page8" },
        { kind: "redirect", publicPath: "/fr", redirectId: "redirect1" },
      ],
      moreConflicts: false,
    })
    renderScreen(oneLanguageOn(), setup)

    await pickLanguage("Français")
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await flush()

    const alert = screen.getByTestId("add-conflict")
    expect(alert).toHaveTextContent(
      "Français wasn’t added. Existing addresses already use /fr. Change those addresses first."
    )
    expect(within(alert).getByRole("link", { name: "/fr/about (page)" })).toHaveAttribute("href", "/admin/pages/page9")
    expect(within(alert).getByRole("link", { name: "/fr/old (former address)" })).toHaveAttribute("href", "/admin/pages/page8")
    expect(within(alert).getByRole("link", { name: "/fr (redirect)" })).toHaveAttribute("href", "/admin/redirects")
    expect(alert).not.toHaveTextContent("and more")
    expect(screen.getByRole("button", { name: "Language to add" })).toHaveTextContent("Français")
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  test("more conflicts than listed say so, in French too, and the message clears on the next try", async () => {
    const setup = makeProps()
    setup.actions.addSiteLanguage.mockResolvedValueOnce({
      ok: false,
      code: "LANGUAGE_ADDRESS_CONFLICT",
      conflicts: [{ kind: "page", publicPath: "/fr/a", pageId: "page1" }],
      moreConflicts: true,
    })
    renderScreen(oneLanguageOn(), setup, "fr")

    fireEvent.keyDown(screen.getByRole("button", { name: "Langue à ajouter" }), { key: "ArrowDown" })
    fireEvent.click(await screen.findByRole("option", { name: /Français/ }))
    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }))
    await flush()

    const alert = screen.getByTestId("add-conflict")
    expect(alert).toHaveTextContent("n’a pas été ajouté. Des adresses existantes utilisent déjà /fr. Modifiez d’abord ces adresses.")
    expect(alert).toHaveTextContent("et d’autres")

    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }))
    await flush()
    expect(screen.queryByTestId("add-conflict")).not.toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  test("picking a different language clears the old conflict message", async () => {
    const setup = makeProps()
    setup.actions.addSiteLanguage.mockResolvedValue({
      ok: false,
      code: "LANGUAGE_ADDRESS_CONFLICT",
      conflicts: [{ kind: "page", publicPath: "/fr/a", pageId: "page1" }],
      moreConflicts: false,
    })
    renderScreen(oneLanguageOn(), setup)

    await pickLanguage("Français")
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await flush()
    expect(screen.getByTestId("add-conflict")).toBeInTheDocument()

    await pickLanguage("Español")
    expect(screen.queryByTestId("add-conflict")).not.toBeInTheDocument()
  })

  test("a stale result is the stale toast, never a conflict message or a dialog", async () => {
    const setup = makeProps()
    setup.actions.addSiteLanguage.mockResolvedValue({
      ok: false,
      code: "SITE_LANGUAGE_VERSION_CHANGED",
    })
    renderScreen(oneLanguageOn(), setup)

    await pickLanguage("Français")
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await flush()

    expect(toast.error).toHaveBeenCalledWith(
      "The languages changed in another window. The list is up to date now; try again."
    )
    expect(screen.queryByTestId("add-conflict")).not.toBeInTheDocument()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  test("any other refusal is a toast with no dialog", async () => {
    const setup = makeProps()
    setup.actions.addSiteLanguage.mockRejectedValue(
      new ConvexError("LANGUAGE_OPERATION_OPEN")
    )
    renderScreen(oneLanguageOn(), setup)

    await pickLanguage("Français")
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await flush()

    expect(toast.error).toHaveBeenCalledWith(
      "Finish or stop the language change in progress first."
    )
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  test("shows the same error in French", async () => {
    const setup = makeProps()
    setup.actions.addSiteLanguage.mockRejectedValue(new ConvexError("LOCALE_ALREADY_ENABLED"))
    renderScreen(oneLanguageOn(), setup, "fr")

    fireEvent.keyDown(screen.getByRole("button", { name: "Langue à ajouter" }), { key: "ArrowDown" })
    fireEvent.click(await screen.findByRole("option", { name: /Español/ }))
    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }))
    await flush()

    expect(toast.error).toHaveBeenCalledWith("Cette langue est déjà ajoutée.")
  })

  test("the picker, the Add button and every row menu are disabled while it runs", async () => {
    const setup = makeProps()
    const pending = deferred<unknown>()
    setup.actions.addSiteLanguage.mockReturnValue(pending.promise)
    renderScreen(makeState(), setup)

    await pickLanguage("Español")
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await flush()

    expect(screen.getByRole("button", { name: "Language to add" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Actions for English" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Actions for Français" })).toBeDisabled()

    await act(async () => {
      pending.resolve({ operationKind: "add" })
      await pending.promise
    })
    expect(screen.getByRole("button", { name: "Actions for English" })).toBeEnabled()
  })
})

describe("remove with counts", () => {
  async function openRemove(label: string) {
    const menu = await openMenu(`Actions for ${label}`)
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Remove/ }))
    return screen.findByRole("dialog")
  }

  test("two languages: counts, the /fr/ warning, a checked list, then the combined command", async () => {
    const view = renderScreen(makeState({ latestPreviews: [makePreview()] }))

    const dialog = await openRemove("Français")
    expect(within(dialog).getByRole("heading", { name: "Remove Français?" })).toBeInTheDocument()
    expect(
      within(dialog).getByText(/Addresses that start with \/fr\/ will show “not found”\./)
    ).toBeInTheDocument()
    expect(view.actions.startLanguageImpactPreview).toHaveBeenCalledWith({
      kind: "remove",
      locale: "fr",
    })
    // The started preview is matched by id, so it needs the id in state.
    await flush()
    const counts = within(dialog).getByRole("list", { name: "What this changes" })
    expect(counts).toHaveTextContent("3 published pages")
    expect(counts).not.toHaveTextContent("4 addresses")
    expect(counts).not.toHaveTextContent("1 redirect")
    expect(counts).toHaveTextContent("2 menus")
    // The whole list is shown; opening it records nothing.
    const list = within(dialog).getByRole("region", { name: "Items to check" })
    expect(within(list).getByText("Page “À propos” uses /fr/a-propos.")).toBeInTheDocument()
    expect(view.actions.recordLanguageImpactReview).not.toHaveBeenCalled()
    expect(within(dialog).queryByRole("button", { name: /I have checked/ })).not.toBeInTheDocument()

    // One button: it records the receipt, then removes.
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }))
    await flush()
    await flush()
    expect(view.actions.recordLanguageImpactReview).toHaveBeenCalledWith({
      previewId,
      ordinal: 0,
      pageDigest: "page-digest",
    })
    expect(view.actions.removeLastExtraLanguage).toHaveBeenCalledTimes(1)
  })

  test("a complete preview with no published pages or menus hides counts and completion text", async () => {
    renderScreen(makeState({
      latestPreviews: [makePreview({
        count: { publicPages: 0, routes: 2, manualRules: 1, menus: 0 },
        pageCount: 0,
      })],
    }))

    const dialog = await openRemove("Français")
    await flush()

    expect(within(dialog).queryByRole("list", { name: "What this changes" })).not.toBeInTheDocument()
    expect(within(dialog).queryByText("Everything has been checked.")).not.toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Remove" })).toBeEnabled()
  })

  test("each address is shown in its own language: prefixed for the removed language, external untouched", async () => {
    const setup = makeProps({
      impactPage: {
        stale: false,
        ordinal: 0,
        pageCount: 1,
        section: "selections",
        items: [
          { kind: "selection", pageId: "p1" as Id<"pages">, path: "/", title: "Accueil" },
          { kind: "selection", pageId: "p2" as Id<"pages">, path: "/a-propos", title: "À propos" },
          { kind: "historical_route", pageId: "p2" as Id<"pages">, fromPath: "/ancien" },
          {
            kind: "manual_rule",
            ruleId: "r1" as Id<"redirects">,
            fromPath: "/vieux",
            destination: { kind: "path", toPath: "/nouveau" },
            statusCode: 301,
            status: "silenced",
          },
          {
            kind: "manual_rule",
            ruleId: "r2" as Id<"redirects">,
            fromPath: "/autre",
            destination: { kind: "external", url: "https://example.com/x" },
            statusCode: 301,
            status: "silenced",
          },
        ],
        digest: "d",
      },
    })
    renderScreen(makeState({ latestPreviews: [makePreview()] }), setup)

    const dialog = await openRemove("Français")
    await flush()
    const list = within(dialog).getByRole("region", { name: "Items to check" })
    expect(within(list).getByText("Page “Accueil” uses /fr.")).toBeInTheDocument()
    expect(within(list).getByText("Page “À propos” uses /fr/a-propos.")).toBeInTheDocument()
    expect(within(list).getByText("Old address /fr/ancien remains reserved.")).toBeInTheDocument()
    expect(within(list).getByText("Redirect /fr/vieux points to /fr/nouveau.")).toBeInTheDocument()
    expect(within(list).getByText("Redirect /fr/autre points to https://example.com/x.")).toBeInTheDocument()
  })

  test("a default-language address is never prefixed", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <DisclosureItems
          addressContext={{ locale: "en", defaultLocale: "en" }}
          items={[
            { kind: "selection", pageId: "p1" as Id<"pages">, path: "/about", title: "About" },
            { kind: "selection", pageId: "p0" as Id<"pages">, path: "/", title: "Home" },
          ]}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("Page “About” uses /about.")).toBeInTheDocument()
    expect(screen.getByText("Page “Home” uses /.")).toBeInTheDocument()
  })

  test("Remove stays disabled while a page of the list is still loading", async () => {
    const setup = makeProps()
    setup.queries.useImpactPage.mockImplementation((args: unknown) =>
      args === "skip"
        ? undefined
        : (args as { ordinal: number }).ordinal === 1
          ? undefined
          : pageAt(0, 2)
    )
    renderScreen(makeState({ latestPreviews: [makePreview({ pageCount: 2 })] }), setup)
    const dialog = await openRemove("Français")
    await flush()

    expect(within(dialog).getByRole("button", { name: "Remove" })).toBeDisabled()
  })

  test("the server's incomplete-review refusal is shown in plain words", async () => {
    const setup = makeProps()
    setup.actions.removeLastExtraLanguage.mockRejectedValue(
      new ConvexError("LANGUAGE_PREVIEW_REVIEW_INCOMPLETE")
    )
    renderScreen(makeState({ latestPreviews: [makePreview()] }), setup)
    const dialog = await openRemove("Français")
    await flush()
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }))
    await flush()
    await flush()

    expect(within(dialog).getByRole("alert")).toHaveTextContent("Check every item before you confirm.")
  })

  // Module on, not adopted, several languages: an older site whose owner then
  // switched Multilingual on in Modules (S2 with the module off shows no
  // Remove at all, so it is not a fixture here).
  test.each([
    ["S3", ["en", "fr"]],
    ["S3", ["en", "fr", "es"]],
  ] as const)(
    "Remove on an unadopted %s site with %j writes nothing until the owner continues in the dialog",
    async (lifecycleState, enabledLocales) => {
      const setup = makeProps()
      const view = renderScreen(
        makeState({
          lifecycleState,
          enabledLocales: [...enabledLocales],
          latestPreviews: [makePreview()],
        }),
        setup
      )
      const dialog = await openRemove("Français")
      await flush()

      // Choosing Remove only opens the dialog: no mutation of any kind.
      expect(view.actions.prepareLanguageChange).not.toHaveBeenCalled()
      expect(view.actions.startLanguageImpactPreview).not.toHaveBeenCalled()
      expect(within(dialog).getByRole("heading", { name: "Remove Français?" })).toBeInTheDocument()
      expect(within(dialog).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument()

      fireEvent.click(within(dialog).getByRole("button", { name: "Count what is affected" }))
      await flush()
      await flush()

      expect(view.actions.prepareLanguageChange).toHaveBeenCalledTimes(1)
      expect(view.actions.prepareLanguageChange).toHaveBeenCalledWith({
        expectedSettingsUpdatedAt: 42,
        expectedModuleConfigurationVersion: 9,
        expectedAuthorityVersion: 4,
      })
      expect(view.actions.startLanguageImpactPreview).toHaveBeenCalledTimes(1)
    }
  )

  test("Remove on an adopted site does not prepare", async () => {
    const view = renderScreen(makeState({ latestPreviews: [makePreview()] }))
    await openRemove("Français")
    await flush()

    expect(view.actions.prepareLanguageChange).not.toHaveBeenCalled()
  })

  test("Remove on an adopted site only starts the expiring preview: nothing is removed or switched off before Remove is confirmed", async () => {
    const view = renderScreen(makeState({ latestPreviews: [makePreview()] }))
    const dialog = await openRemove("Français")
    await flush()

    // Opening the dialog starts the impact preview (it expires on its own).
    expect(view.actions.startLanguageImpactPreview).toHaveBeenCalledTimes(1)
    expect(view.actions.startLanguageImpactPreview).toHaveBeenCalledWith({
      kind: "remove",
      locale: "fr",
    })
    // No removal, module or authority change yet.
    for (const action of [
      "removeLanguage",
      "removeLastExtraLanguage",
      "prepareLanguageChange",
      "prepareLanguageReview",
      "addSiteLanguage",
    ] as const) {
      expect(view.actions[action]).not.toHaveBeenCalled()
    }

    // Cancelling leaves the same: still nothing removed or switched.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await flush()
    expect(view.actions.removeLanguage).not.toHaveBeenCalled()
    expect(view.actions.removeLastExtraLanguage).not.toHaveBeenCalled()
  })

  test("Remove waits for the prepare step before it starts the preview", async () => {
    const setup = makeProps()
    let finish: (value: unknown) => void = () => {}
    setup.actions.prepareLanguageChange.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    renderScreen(makeState({ lifecycleState: "S2", latestPreviews: [makePreview()] }), setup)
    const dialog = await openRemove("Français")
    fireEvent.click(within(dialog).getByRole("button", { name: "Count what is affected" }))

    expect(setup.actions.prepareLanguageChange).toHaveBeenCalledTimes(1)
    expect(setup.actions.startLanguageImpactPreview).not.toHaveBeenCalled()
    await act(async () => finish({ authorityVersion: 5, moduleConfigurationVersion: 10 }))
    await flush()
    expect(setup.actions.startLanguageImpactPreview).toHaveBeenCalledTimes(1)
  })

  test("a refused prepare step shows the plain error in the dialog and starts nothing", async () => {
    const setup = makeProps()
    setup.actions.prepareLanguageChange.mockRejectedValue(
      new ConvexError("CMS_MODULE_CONFIGURATION_STALE")
    )
    renderScreen(makeState({ lifecycleState: "S2" }), setup)
    const dialog = await openRemove("Français")
    fireEvent.click(within(dialog).getByRole("button", { name: "Count what is affected" }))
    await flush()

    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "The languages changed in another window. The list is up to date now; try again."
    )
    expect(setup.actions.startLanguageImpactPreview).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  test("Cancel in the Remove dialog writes nothing on an unadopted site", async () => {
    const view = renderScreen(makeState({ lifecycleState: "S3", enabledLocales: ["en", "fr", "es"] }))
    const dialog = await openRemove("Français")
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await flush()

    expect(view.actions.prepareLanguageChange).not.toHaveBeenCalled()
    expect(view.actions.startLanguageImpactPreview).not.toHaveBeenCalled()
    expect(view.actions.removeLanguage).not.toHaveBeenCalled()
  })

  test("two languages remove through removeLastExtraLanguage", async () => {
    const view = renderScreen(
      makeState({ latestPreviews: [makePreview({ reviewedThroughOrdinal: 0 })] })
    )
    const dialog = await openRemove("Français")
    await flush()

    const remove = within(dialog).getByRole("button", { name: "Remove" })
    expect(remove).toBeEnabled()
    fireEvent.click(remove)
    await flush()

    expect(view.actions.removeLastExtraLanguage).toHaveBeenCalledWith({
      previewId,
      expectedDigest: "preview-digest",
      expectedCount: { publicPages: 3, routes: 4, manualRules: 1, menus: 2 },
    })
    expect(view.actions.removeLanguage).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith("Français was removed.")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  test("more than two languages remove through removeLanguage", async () => {
    const view = renderScreen(
      makeState({
        enabledLocales: ["en", "fr", "es"],
        latestPreviews: [makePreview({ reviewedThroughOrdinal: 0 })],
      })
    )
    const dialog = await openRemove("Français")
    await flush()
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }))
    await flush()

    expect(view.actions.removeLanguage).toHaveBeenCalledTimes(1)
    expect(view.actions.removeLastExtraLanguage).not.toHaveBeenCalled()
  })

  test("an incomplete preview shows progress and cannot be confirmed", async () => {
    renderScreen(
      makeState({
        latestPreviews: [makePreview({ phase: "scanning", pageCount: 0 })],
      })
    )
    const dialog = await openRemove("Français")
    await flush()

    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Counting what changes. A large site can take a moment."
    )
    expect(within(dialog).getByRole("button", { name: "Remove" })).toBeDisabled()
  })

  test("a refusal from the server is shown and the dialog stays open", async () => {
    const setup = makeProps()
    setup.actions.removeLastExtraLanguage.mockRejectedValue(
      new ConvexError("LANGUAGE_NOT_LAST_EXTRA")
    )
    renderScreen(
      makeState({ latestPreviews: [makePreview({ reviewedThroughOrdinal: 0 })] }),
      setup
    )
    const dialog = await openRemove("Français")
    await flush()
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }))
    await flush()

    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "The languages changed in the meantime. Reload the page and try again."
    )
  })

  test("a failure to start the preview is shown in plain words", async () => {
    const setup = makeProps()
    setup.actions.startLanguageImpactPreview.mockRejectedValue(
      new ConvexError("LANGUAGE_OPERATION_OPEN")
    )
    renderScreen(makeState(), setup)
    const dialog = await openRemove("Français")
    await flush()

    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Finish or stop the language change in progress first."
    )
  })
})

describe("make default", () => {
  test("Make default is one click: setDefaultLanguage once with the tokens, no dialog, a toast", async () => {
    const view = renderScreen(makeState())

    const menu = await openMenu("Actions for Français")
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Make default/ }))
    await flush()

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(view.actions.setDefaultLanguage).toHaveBeenCalledTimes(1)
    expect(view.actions.setDefaultLanguage).toHaveBeenCalledWith({
      toLocale: "fr",
      expectedAuthorityVersion: 4,
      expectedModuleConfigurationVersion: 9,
    })
    expect(view.actions.startDefaultLanguageMigration).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith("Français is now the default language.")
  })

  test("the success toast is in French too", async () => {
    renderScreen(makeState(), makeProps(), "fr")

    const menu = await openMenu("Actions pour Français")
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Définir par défaut/ }))
    await flush()

    expect(toast.success).toHaveBeenCalledWith(
      "Français est maintenant la langue par défaut."
    )
  })

  test("Make default on an unadopted site prepares first and uses the returned versions", async () => {
    const view = renderScreen(
      makeState({ lifecycleState: "S2", version: null, commandTokens: {
        settingsUpdatedAt: 42,
        moduleConfigurationVersion: 9,
        authorityVersion: null,
      } })
    )

    const menu = await openMenu("Actions for Français")
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Make default/ }))
    await flush()

    expect(view.actions.prepareLanguageChange).toHaveBeenCalledTimes(1)
    expect(view.actions.setDefaultLanguage).toHaveBeenCalledWith({
      toLocale: "fr",
      expectedAuthorityVersion: 5,
      expectedModuleConfigurationVersion: 10,
    })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  test("a stale result is the stale toast and nothing else", async () => {
    const setup = makeProps()
    setup.actions.setDefaultLanguage.mockResolvedValue({
      ok: false,
      code: "SITE_LANGUAGE_VERSION_CHANGED",
    })
    renderScreen(makeState(), setup)

    const menu = await openMenu("Actions for Français")
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Make default/ }))
    await flush()

    expect(toast.error).toHaveBeenCalledWith(
      "The languages changed in another window. The list is up to date now; try again."
    )
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  test("there is no home-page refusal any more: no inline alert, no link to the pages", async () => {
    const setup = makeProps()
    renderScreen(makeState(), setup)

    const menu = await openMenu("Actions for Français")
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Make default/ }))
    await flush()

    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Open pages" })).not.toBeInTheDocument()
  })

  test("other refusals show a plain toast", async () => {
    const setup = makeProps()
    setup.actions.setDefaultLanguage.mockRejectedValue(
      new ConvexError("DEFAULT_MIGRATION_SUPERSEDED")
    )
    renderScreen(makeState(), setup)

    const menu = await openMenu("Actions for Français")
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Make default/ }))
    await flush()

    expect(toast.error).toHaveBeenCalledWith(
      "The languages changed in another window. The list is up to date now; try again."
    )
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  test("the Add picker, the Add button and the row menus are disabled while it runs", async () => {
    const setup = makeProps()
    const pending = deferred<unknown>()
    setup.actions.setDefaultLanguage.mockReturnValue(pending.promise)
    renderScreen(makeState(), setup)

    const menu = await openMenu("Actions for Français")
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Make default/ }))
    await flush()

    expect(screen.getByRole("button", { name: "Language to add" })).toBeDisabled()
    const add = screen.getByRole("button", { name: "Add" })
    expect(add).toBeDisabled()
    expect(add.querySelector(".lucide-plus")).toBeInTheDocument()
    expect(add.querySelector(".animate-spin")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Actions for English" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Actions for Français" })).toBeDisabled()

    await act(async () => {
      pending.resolve({ authorityVersion: 5 })
      await pending.promise
    })
    expect(screen.getByRole("button", { name: "Actions for Français" })).toBeEnabled()
  })

  test("the default language's Remove item is disabled, muted and not destructive-styled", async () => {
    renderScreen(makeState())

    const menu = await openMenu("Actions for English")
    const remove = within(menu).getByRole("menuitem", { name: /Remove/ })
    expect(remove).toHaveAttribute("aria-disabled", "true")
    expect(remove).not.toHaveAttribute("data-variant", "destructive")
    expect(remove.className).toContain("text-muted-foreground")
    expect(within(remove).getByText("Make another language the default first")).toBeInTheDocument()
    fireEvent.keyDown(menu, { key: "Escape" })

    const other = await openMenu("Actions for Français")
    expect(within(other).getByRole("menuitem", { name: /Remove/ })).toHaveAttribute("data-variant", "destructive")
  })

  test("a menu text status line shows with a count above zero and stays hidden at zero", () => {
    const view = renderScreen(
      makeState({ enabledLocales: ["en", "fr", "es"] }),
      makeProps({ menuTextMissing: { fr: 3, es: 0 } })
    )

    const lines = screen.getAllByTestId("menu-status")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveTextContent("Menu text missing (3 items)")
    expect(lines[0].closest("li")).toHaveTextContent("Français")
    expect(view.queries.useMenuTextMissing).toHaveBeenCalledWith(["fr", "es"])
  })

  test("the status line uses the singular for one item and French text", () => {
    renderScreen(makeState(), makeProps({ menuTextMissing: { fr: 1 } }), "fr")

    expect(screen.getByTestId("menu-status")).toHaveTextContent("Texte de menu manquant (1 élément)")
  })

  test("no status line while the count is loading", () => {
    renderScreen(makeState(), makeProps({ menuTextMissing: undefined }))

    expect(screen.queryByTestId("menu-status")).not.toBeInTheDocument()
  })

  test("an open change reopens on load with its address and page review", async () => {
    const view = renderScreen(
      makeState({
        openOperation: { kind: "default_migration", phase: "ready" },
        defaultMigration: makeMigration(),
      })
    )

    const dialog = await screen.findByRole("dialog", { name: "Make Français the default?" })
    expect(within(dialog).getByText("Changing the default language from English to Français")).toBeInTheDocument()
    expect(within(dialog).getByText("1 address · 0 kept behind redirects · 0 problems to fix")).toBeInTheDocument()
    expect(within(dialog).getByText("/about keeps leading to the page in en.")).toBeInTheDocument()
    expect(within(dialog).getByText("/about stays reserved for Français.")).toBeInTheDocument()
    expect(view.actions.recordDefaultMigrationReview).not.toHaveBeenCalled()
    expect(within(dialog).queryByRole("button", { name: /I have checked/ })).not.toBeInTheDocument()

    // One button records the receipts, then makes the change.
    const activate = within(dialog).getByRole("button", { name: "Make Français the default" })
    expect(activate).toBeEnabled()
    fireEvent.click(activate)
    await flush()
    await flush()
    expect(view.actions.recordDefaultMigrationReview).toHaveBeenCalledWith({
      migrationId,
      expectedGeneration: 2,
      ordinal: 0,
      pageDigest: "disclosure-digest",
    })
    expect(view.actions.activateDefaultLanguageMigration).toHaveBeenCalledWith({
      migrationId,
      expectedGeneration: 2,
      expectedReadinessVersion: 7,
      expectedAuthorityVersion: 4,
    })
    expect(toast.success).toHaveBeenCalledWith("Français is now the default.")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  test("closing the review leaves a way back and locks other changes", async () => {
    renderScreen(
      makeState({
        openOperation: { kind: "default_migration", phase: "ready" },
        defaultMigration: makeMigration(),
      })
    )
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" })
    await flush()

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByText("Making Français the default is not finished.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(await screen.findByRole("dialog", { name: "Make Français the default?" })).toBeInTheDocument()
  })

  test("stopping the change calls the existing cancel command", async () => {
    const view = renderScreen(
      makeState({
        openOperation: { kind: "default_migration", phase: "ready" },
        defaultMigration: makeMigration(),
      })
    )
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop this change" }))
    await flush()

    expect(view.actions.cancelDefaultLanguageMigration).toHaveBeenCalledWith({
      migrationId,
      expectedGeneration: 2,
    })
  })

  test("Continue stays hidden until a background step stalls", async () => {
    vi.useFakeTimers()
    const view = renderScreen(
      makeState({
        openOperation: { kind: "default_migration", phase: "enumerating" },
        defaultMigration: makeMigration({ phase: "enumerating", readinessVersion: null }),
      })
    )

    const dialog = screen.getByRole("dialog")
    expect(within(dialog).queryByRole("button", { name: "Continue" })).not.toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(STALL_AFTER_MS - 1000)
    })
    expect(within(dialog).queryByRole("button", { name: "Continue" })).not.toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }))
    await flush()
    expect(view.actions.continueDefaultLanguageMigration).toHaveBeenCalledWith({
      migrationId,
      expectedGeneration: 2,
    })
  })

  test("progress hides Continue again", async () => {
    vi.useFakeTimers()
    const view = renderScreen(
      makeState({
        openOperation: { kind: "default_migration", phase: "enumerating" },
        defaultMigration: makeMigration({ phase: "enumerating", readinessVersion: null }),
      })
    )
    await act(async () => {
      vi.advanceTimersByTime(STALL_AFTER_MS + 1000)
    })
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument()

    view.update(
      makeState({
        openOperation: { kind: "default_migration", phase: "enumerating" },
        defaultMigration: makeMigration({
          phase: "enumerating",
          readinessVersion: null,
          counts: { ...makeMigration().counts, rows: 25 },
        }),
      })
    )
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument()
  })
})

test.each(["loading", "off", "on", "error"] as const)("Languages gate %s owns Add, Modules link and row menu", (gate) => {
  moduleTestGate.forced = gate
  renderScreen(makeState())
  expect(screen.queryByRole("button", { name: "Add" }) !== null).toBe(gate === "on")
  expect(screen.queryByTestId("add-needs-module") !== null).toBe(gate === "off")
  expect(screen.queryByRole("button", { name: "Actions for Français" }) !== null).toBe(gate === "on")
  expect(screen.getByRole("heading", { name: "Languages" })).toBeInTheDocument()
})
test("an open M05 dialog unmounts on off and does not reopen when enabled", async () => {
  const view = renderScreen(makeState())
  const menu = await openMenu("Actions for Français")
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Remove/ }))
  expect(screen.getByRole("dialog")).toBeInTheDocument()
  moduleTestGate.forced = "off"
  view.update(makeState())
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  moduleTestGate.forced = "on"
  view.update(makeState())
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
})
test("late Add results after off produce no success toast or host changes", async () => {
  const setup = makeProps()
  const pending = deferred<unknown>()
  setup.actions.addSiteLanguage.mockReturnValue(pending.promise)
  const view = renderScreen(oneLanguageOn(), setup)
  await pickLanguage("Français")
  fireEvent.click(screen.getByRole("button", { name: "Add" }))
  moduleTestGate.forced = "off"
  view.update(oneLanguageOn())
  pending.resolve({ ok: true, operationKind: "add" })
  await flush()
  expect(toast.success).not.toHaveBeenCalled()
  expect(screen.getByTestId("add-needs-module")).toBeInTheDocument()
})

test("unexpected Add failure stays inside its contribution and preserves core Languages", async () => {
  const setup = makeProps()
  setup.actions.addSiteLanguage.mockRejectedValue(new Error("connection lost"))
  renderScreen(oneLanguageOn(), setup)
  await pickLanguage("Français")
  fireEvent.click(screen.getByRole("button", { name: "Add" }))
  await flush()
  expect(screen.getByRole("alert")).toHaveTextContent(en.shell.modulesUnavailable)
  expect(screen.getByRole("heading", { name: "Languages" })).toBeInTheDocument()
  expect(toast.error).not.toHaveBeenCalled()
})
test("disabled Add race withholds its controls and preserves core Languages", async () => {
  const setup = makeProps()
  setup.actions.addSiteLanguage.mockRejectedValue(new ConvexError("CMS_MODULE_DISABLED"))
  renderScreen(oneLanguageOn(), setup)
  await pickLanguage("Français")
  fireEvent.click(screen.getByRole("button", { name: "Add" }))
  await flush()
  expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "Languages" })).toBeInTheDocument()
  expect(toast.error).not.toHaveBeenCalled()
})


test("pending Add owns the Add spinner", async () => {
  const setup = makeProps()
  const pending = deferred<unknown>()
  setup.actions.addSiteLanguage.mockReturnValueOnce(pending.promise)
  renderScreen(oneLanguageOn(), setup)
  await pickLanguage("Français")
  fireEvent.click(screen.getByRole("button", { name: "Add" }))
  await flush()
  const add = screen.getByRole("button", { name: "Add" })
  expect(add).toBeDisabled()
  expect(add.querySelector(".animate-spin")).toBeInTheDocument()
  expect(add.querySelector(".lucide-plus")).not.toBeInTheDocument()
  await act(async () => { pending.resolve({ authorityVersion: 5 }); await pending.promise })
})
