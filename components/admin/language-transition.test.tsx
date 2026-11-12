import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { getFunctionName } from "convex/server"
import { ConvexError } from "convex/values"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import LanguagesSettingsPage from "@/app/(core)/admin/(authenticated)/settings/languages/page"
import { LanguageTransition } from "./language-transition"

// F09 contract proof rows 30 (workflow UI), 10 and 11 (UI parts).

const mocks = vi.hoisted(() => ({
  queries: new Map<string, unknown>(),
  paginated: [] as unknown[],
  paginatedByName: new Map<
    string,
    {
      results: unknown[]
      status: "LoadingFirstPage" | "CanLoadMore" | "Exhausted"
      loadMore: ReturnType<typeof vi.fn>
    }
  >(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  apiReferences: new Set<string>(),
  queryReferences: new Set<string>(),
  toastError: vi.fn(),
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
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref)
    mocks.apiReferences.add(name)
    mocks.queryReferences.add(name)
    return mocks.queries.get(name)
  },
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref)
    mocks.apiReferences.add(name)
    return mutation(name)
  },
  usePaginatedQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref)
    mocks.apiReferences.add(name)
    mocks.queryReferences.add(name)
    return (
      mocks.paginatedByName.get(name) ?? {
        results: mocks.paginated,
        status: "Exhausted" as const,
        loadMore: vi.fn(),
      }
    )
  },
}))

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}))

const SETTINGS = { updatedAt: 42, defaultLocale: "en", enabledLocales: ["en"] }

function languageState(overrides: Record<string, unknown> = {}) {
  return {
    kind: "current",
    version: 1,
    currentLocale: "en",
    enabledLocales: ["en"],
    transition: null,
    blockers: [],
    ...overrides,
  }
}

function transition(overrides: Record<string, unknown> = {}) {
  return {
    _id: "transition1",
    mode: "replace_content",
    sourceLocale: "en",
    targetLocale: "fr",
    phase: "preparing",
    generation: 7,
    shortPath: false,
    sourcePublicSetVersion: 0,
    preparedSetVersion: 3,
    previewConfirmedPreparedSetVersion: null,
    carryDecisionDigest: null,
    previewConfirmedCarryDecisionDigest: null,
    readinessVersion: null,
    pageCount: 2,
    targetCount: 1,
    withdrawCount: 0,
    redirectCount: 0,
    unresolvedCount: 1,
    blockedCount: 0,
    targetDrafts: "retained",
    ...overrides,
  }
}

function pageRow(overrides: Record<string, unknown> = {}) {
  return {
    pageId: "page1",
    kind: "public_route",
    disposition: "target",
    status: "unready",
    blockerCode: null,
    generation: 4,
    redirectToPageId: null,
    sourceSlug: "about",
    sourcePath: "/about",
    targetPath: null,
    contentKeys: ["slices", "title"],
    seoJson: '{"metaTitle":"About"}',
    targetRouteConflict: false,
    confirmed: false,
    lifecycleGeneration: 1,
    sourceDraftGeneration: 2,
    targetDraftGeneration: 5,
    hasTargetDraft: true,
    sharedDraftGeneration: 9,
    retainedTarget: null,
    ...overrides,
  }
}

function renderWorkflow(messages: typeof en = en, locale = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <LanguageTransition />
    </NextIntlClientProvider>
  )
}

function renderLanguagesRoute() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <LanguagesSettingsPage />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mocks.queries.clear()
  mocks.mutations.clear()
  mocks.paginated = []
  mocks.paginatedByName.clear()
  mocks.toastError.mockReset()
  mocks.apiReferences.clear()
  mocks.queryReferences.clear()
  mocks.queries.set("cms/settings:getSettings", SETTINGS)
  // The Languages route renders the state-aware Multilingual composition; with
  // the module off it reports a single-language lifecycle state (S0).
  mocks.queries.set("cms/multilingual:getMultilingualState", {
    lifecycleState: "S0",
    origin: null,
    moduleEnabled: false,
    moduleConfigurationVersion: 1,
    version: 1,
    defaultLocale: "en",
    enabledLocales: ["en"],
    openOperation: null,
    defaultMigration: null,
    latestPreviews: [],
  })
  mocks.queries.set("cms/languageLifecycle:getLanguageLifecycleStatus", {
    updating: false,
    notDelivered: false,
    oldestUndelivered: null,
    operation: null,
  })
})

describe("language change workflow", () => {
  test("with Multilingual off, the Languages route opens the F09 workflow from the banner and reads only the Multilingual state", async () => {
    mocks.queries.set("cms/language:getLanguageState", languageState())
    mocks.queries.set("cms/languageLifecycle:getLanguageLifecycleStatus", {
      updating: false,
      notDelivered: true,
      oldestUndelivered: null,
      operation: null,
    })

    const current = renderLanguagesRoute()
    expect(
      screen.getByRole("heading", { name: "Languages" })
    ).toBeInTheDocument()
    // The delivery notice lives in Settings › General only (A2).
    expect(
      screen.queryByText("Some public-site updates were not delivered")
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Public site updates")).not.toBeInTheDocument()
    // One language, Multilingual off: no row menu and no Change language entry
    // (owner, 2026-11-05).
    expect(
      screen.queryByText("Your site is written in English.")
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Actions for English" })
    ).not.toBeInTheDocument()
    current.unmount()

    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ transition: transition() })
    )
    mocks.queries.set("cms/multilingual:getMultilingualState", {
      lifecycleState: "S1",
      origin: null,
      moduleEnabled: false,
      moduleConfigurationVersion: 1,
      version: 1,
      defaultLocale: "en",
      enabledLocales: ["en"],
      openOperation: { kind: "language_transition", phase: "preparing" },
      defaultMigration: null,
      latestPreviews: [],
    })
    mocks.paginated = [pageRow()]
    mocks.paginatedByName.set("cms/language:listLanguageCarryDecisions", {
      results: [],
      status: "Exhausted",
      loadMore: vi.fn(),
    })
    renderLanguagesRoute()

    // An unfinished change does not open by itself; the banner reopens it.
    expect(
      screen.queryByText("Changing from English to Français")
    ).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }))
    expect(
      await screen.findByText("Changing from English to Français")
    ).toBeInTheDocument()
    expect(
      [...mocks.apiReferences].filter(
        (reference) =>
          !reference.startsWith("cms/multilingual:") ||
          reference === "cms/multilingual:getMultilingualState"
      ).sort()
    ).toEqual(
      [
        "cms/language:activateLanguageTransition",
        "cms/language:cancelLanguageTransition",
        "cms/language:confirmTargetContent",
        "cms/language:confirmTransitionPreview",
        "cms/language:continueLanguageTransition",
        "cms/language:copySourceToTargetDraft",
        "cms/language:getLanguageState",
        "cms/language:initializeSiteLanguageAuthority",
        "cms/language:listLanguageCarryDecisions",
        "cms/language:listLanguageTransitionPages",
        "cms/language:prepareTargetPage",
        "cms/language:setPageDisposition",
        "cms/language:validateLanguageTransition",
        // Core Menus, not M05: mounted with "skip" while only one language exists.
        "cms/menus:countMenuTextMissing",
        "cms/multilingual:getMultilingualState",
        "cms/settings:getSettings",
        "cms/settings:updateSettings",
      ].sort()
    )
    // Single-language mode reads no other M05 data: no previews, adoption,
    // disclosure or migration queries while the module is off. (The screen
    // holds the M05 commands for the dialogs, but never queries them here.)
    expect(
      [...mocks.queryReferences].filter((reference) =>
        reference.includes("multilingual")
      )
    ).toEqual(["cms/multilingual:getMultilingualState"])
  })

  test("row 30: offers two plain-language modes with no locale tabs or multi-language controls", async () => {
    mocks.queries.set("cms/language:getLanguageState", languageState())
    renderWorkflow()

    expect(
      screen.getByText("Your site is written in English.")
    ).toBeInTheDocument()
    const modes = screen.getAllByRole("radio")
    expect(modes).toHaveLength(2)
    expect(screen.getByLabelText(/Fix the language label/)).toBeInTheDocument()
    expect(
      screen.getByLabelText(/Switch to content in another language/)
    ).toBeInTheDocument()
    // No retired multi-language controls, locale tabs or switcher.
    expect(screen.queryByText("Add a language…")).not.toBeInTheDocument()
    expect(screen.queryByText("Set default")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "EN" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
    expect(screen.getAllByRole("combobox")).toHaveLength(1)

    const select = screen.getByRole("combobox", { name: "New language" })
    expect(
      within(select).queryByRole("option", { name: "English" })
    ).not.toBeInTheDocument()
    const start = screen.getByRole("button", { name: "Start" })
    expect(start).toBeDisabled()

    fireEvent.change(select, { target: { value: "fr" } })
    fireEvent.click(
      screen.getByLabelText(/Switch to content in another language/)
    )
    fireEvent.click(start)
    expect(
      mutation("cms/language:startLanguageTransition")
    ).toHaveBeenCalledWith({
      mode: "replace_content",
      sourceLocale: "en",
      targetLocale: "fr",
      expectedSettingsUpdatedAt: 42,
      expectedAuthorityVersion: 1,
    })
  })

  test("row 11 UI: a replacement keeps the source live, warns about shared fields and binds confirmation to exact generations", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ transition: transition() })
    )
    mocks.paginated = [pageRow()]
    renderWorkflow()

    expect(
      screen.getByText("Changing from English to Français")
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Your site stays live in English. Visitors cannot see the Français version yet."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(/shared fields are the same in every language/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Copied text does not count as Français until you confirm it."
      )
    ).toBeInTheDocument()
    // Unconfirmed text cannot be prepared.
    expect(
      screen.queryByRole("button", { name: "Get this page ready" })
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole("button", { name: "This text is in Français" })
    )
    expect(mutation("cms/language:confirmTargetContent")).toHaveBeenCalledWith({
      transitionId: "transition1",
      pageId: "page1",
      expectedTargetDraftGeneration: 5,
      expectedSharedDraftGeneration: 9,
      expectedPageGeneration: 4,
    })
  })

  test("F09b: a replacement row opens the page editor for the new-language version; a label fix does not", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ transition: transition() })
    )
    mocks.paginated = [
      pageRow(),
      pageRow({
        pageId: "page2",
        sourcePath: "/contact",
        hasTargetDraft: false,
        targetDraftGeneration: null,
      }),
      pageRow({
        pageId: "page3",
        sourcePath: "/gone",
        lifecycleGeneration: null,
      }),
    ]
    const { unmount } = renderWorkflow()

    // The address carries no language: the editor reads it from the open change.
    expect(
      screen.getByRole("link", { name: "Edit the Français version" })
    ).toHaveAttribute("href", "/admin/pages/page1?language=new")
    expect(
      screen.getByRole("link", { name: "Write the Français version" })
    ).toHaveAttribute("href", "/admin/pages/page2?language=new")
    // A page that can no longer be edited gets no link.
    expect(screen.getAllByRole("link")).toHaveLength(2)
    unmount()

    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ transition: transition({ mode: "correct_label" }) })
    )
    renderWorkflow()
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })

  test("R2 names the blocked Page path and links to the post-cancellation remedy", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({
        transition: transition({ blockedCount: 1, unresolvedCount: 0 }),
      })
    )
    mocks.paginated = [
      pageRow({
        sourcePath: "/",
        sourceSlug: "home",
        status: "blocked",
        blockerCode: "TARGET_LOCALE_HAS_RETAINED_CONTENT",
      }),
    ]

    renderWorkflow()

    expect(
      screen.getByText(
        "Page / has a retained Français Working Draft. Cancel this language change, then open Page / and choose Delete Français Working Draft."
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open Page /" })).toHaveAttribute(
      "href",
      "/admin/pages/page1"
    )
  })

  test.each([
    [
      en,
      "en",
      "Use the previously published version",
      "Search title: Accueil — Site",
      "Search description: La page d’accueil publiée",
    ],
    [
      fr,
      "fr",
      "Utiliser la version publiée auparavant",
      "Titre pour la recherche : Accueil — Site",
      "Description pour la recherche : La page d’accueil publiée",
    ],
  ] as const)(
    "retained snapshot review is deliberate and truthful in %s",
    (messages, locale, action, seoTitle, seoDescription) => {
      mocks.queries.set(
        "cms/language:getLanguageState",
        languageState({
          transition: transition({ blockedCount: 1, unresolvedCount: 0 }),
        })
      )
      mocks.paginated = [
        pageRow({
          sourcePath: "/",
          status: "blocked",
          blockerCode: "TARGET_LOCALE_HAS_RETAINED_CONTENT",
          disposition: "undecided",
          retainedTarget: {
            reviewDigest: "sha256:review",
            targetLocale: "fr",
            selection: {
              snapshotId: "snapshot1",
              publishedAt: Date.UTC(2026, 8, 20),
              title: "Accueil publié",
              path: "/",
              seoTitle: "Accueil — Site",
              seoDescription: "La page d’accueil publiée",
              contentKeys: ["slices", "title"],
            },
            draftBaseSnapshotId: "snapshot1",
            workingDraft: {
              generation: 6,
              slug: "accueil-prive",
              title: "Accueil privé",
              contentKeys: ["slices", "title"],
              differsFromSelection: true,
            },
            sharedDraft: { generation: 9, differsFromSelection: false },
          },
        }),
      ]
      renderWorkflow(messages, locale)

      expect(
        screen.getAllByText("Accueil publié", { exact: false }).length
      ).toBeGreaterThan(0)
      expect(screen.getByText("Accueil privé", { exact: false })).toBeInTheDocument()
      expect(screen.getByText(seoTitle)).toBeInTheDocument()
      expect(screen.getByText(seoDescription)).toBeInTheDocument()
      expect(
        screen.queryByText(/Published content:|Contenu publié :/)
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole("link", { name: /Open Page|Ouvrir la page/ })
      ).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: action }))
      expect(mutation("cms/language:setPageDisposition")).toHaveBeenCalledWith({
        transitionId: "transition1",
        pageId: "page1",
        disposition: "target",
        expectedPageGeneration: 4,
        retainedTargetReview: {
          digest: "sha256:review",
          basis: "retained_snapshot",
        },
      })
    }
  )

  test("after an explicit retained withdrawal, the Working Draft gets a fresh separate decision", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ transition: transition() })
    )
    mocks.paginated = [
      pageRow({
        disposition: "withdraw",
        status: "ready",
        blockerCode: null,
        retainedTarget: {
          reviewDigest: "sha256:fresh-draft-review",
          targetLocale: "fr",
          selection: null,
          draftBaseSnapshotId: "snapshot1",
          workingDraft: {
            generation: 6,
            slug: "accueil-prive",
            title: "Accueil privé",
            contentKeys: ["slices", "title"],
            differsFromSelection: null,
          },
          sharedDraft: { generation: 9, differsFromSelection: null },
        },
      }),
      pageRow({
        pageId: "page2",
        sourceSlug: "contact",
        sourcePath: "/contact",
        targetPath: "/contact",
        status: "ready",
      }),
    ]
    renderWorkflow()

    const retainedPage = screen.getAllByTestId("language-transition-page")[0]!
    expect(
      within(retainedPage).queryByRole("option", {
        name: "The Français version",
      })
    ).not.toBeInTheDocument()
    fireEvent.change(
      within(retainedPage).getByRole("combobox", {
        name: "What visitors get after the switch",
      }),
      { target: { value: "redirect" } }
    )
    expect(mutation("cms/language:setPageDisposition")).toHaveBeenCalledWith({
      transitionId: "transition1",
      pageId: "page1",
      disposition: "redirect",
      redirectToPageId: "page2",
      expectedPageGeneration: 4,
    })

    fireEvent.click(
      screen.getByRole("button", { name: "Prepare the Working Draft" })
    )
    expect(mutation("cms/language:setPageDisposition")).toHaveBeenCalledWith({
      transitionId: "transition1",
      pageId: "page1",
      disposition: "target",
      expectedPageGeneration: 4,
      retainedTargetReview: {
        digest: "sha256:fresh-draft-review",
        basis: "draft",
      },
    })
  })

  test.each([
    [
      "English snapshot",
      en,
      "en",
      "This content changed after you chose. Review it and choose again.",
      "Use the previously published version",
      "retained_snapshot",
    ],
    [
      "French snapshot",
      fr,
      "fr",
      "Ce contenu a changé après votre choix. Vérifiez-le et choisissez de nouveau.",
      "Utiliser la version publiée auparavant",
      "retained_snapshot",
    ],
    [
      "English draft",
      en,
      "en",
      "This content changed after you chose. Review it and choose again.",
      "Prepare the Working Draft",
      "draft",
    ],
    [
      "French draft",
      fr,
      "fr",
      "Ce contenu a changé après votre choix. Vérifiez-le et choisissez de nouveau.",
      "Préparer le brouillon de travail",
      "draft",
    ],
  ] as const)(
    "a stale retained target restores the %s decision and hides preparation",
    (_label, messages, locale, changedMessage, action, basis) => {
      mocks.queries.set(
        "cms/language:getLanguageState",
        languageState({ transition: transition() })
      )
      mocks.paginated = [
        pageRow({
          disposition: "target",
          status: "stale",
          retainedTarget: {
            decisionCurrent: false,
            decisionBasis: basis,
            reviewDigest: "sha256:fresh-review",
            targetLocale: "fr",
            selection: {
              snapshotId: "snapshot1",
              publishedAt: Date.UTC(2026, 8, 20),
              title: "Accueil publié",
              path: "/",
              seoTitle: null,
              seoDescription: null,
              contentKeys: ["slices", "title"],
            },
            draftBaseSnapshotId: "snapshot1",
            workingDraft:
              basis === "draft"
                ? {
                    generation: 6,
                    slug: "accueil-prive",
                    title: "Accueil privé",
                    contentKeys: ["slices", "title"],
                    differsFromSelection: true,
                  }
                : null,
            sharedDraft: { generation: 9, differsFromSelection: false },
          },
        }),
      ]
      renderWorkflow(messages, locale)

      expect(screen.getByText(changedMessage)).toBeInTheDocument()
      expect(
        screen.queryByRole("button", {
          name: /Get this page ready|Préparer cette page/,
        })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole("button", {
          name: /This text is in|Ce texte est en/,
        })
      ).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: action }))
      expect(mutation("cms/language:setPageDisposition")).toHaveBeenCalledWith({
        transitionId: "transition1",
        pageId: "page1",
        disposition: "target",
        expectedPageGeneration: 4,
        retainedTargetReview: {
          digest: "sha256:fresh-review",
          basis,
        },
      })
    }
  )

  test("cancellation distinguishes transition-created drafts from retained content", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ transition: transition() })
    )
    mocks.paginated = [pageRow()]
    renderWorkflow()

    fireEvent.click(
      screen.getByRole("button", { name: "Stop the language change" })
    )
    expect(
      screen.getByText(
        /Adopted published versions you did not withdraw, and drafts that existed before this change, are kept unless the change must pause to protect newer content/
      )
    ).toBeInTheDocument()
  })

  test("row 11 UI: a page without a target draft offers a copy that starts unconfirmed", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ transition: transition() })
    )
    mocks.paginated = [
      pageRow({ hasTargetDraft: false, targetDraftGeneration: null }),
    ]
    renderWorkflow()

    fireEvent.click(
      screen.getByRole("button", {
        name: "Copy current text as a starting point",
      })
    )
    expect(
      mutation("cms/language:copySourceToTargetDraft")
    ).toHaveBeenCalledWith({
      transitionId: "transition1",
      pageId: "page1",
      expectedSourceDraftGeneration: 2,
      expectedLifecycleGeneration: 1,
    })
  })

  test("Finding B: a private draft is explained and cannot offer an impossible target decision", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ transition: transition() })
    )
    mocks.paginated = [
      pageRow({
        kind: "private_draft",
        disposition: "withdraw",
        status: "blocked",
        blockerCode: "TARGET_SELECTION_MISMATCH",
        hasTargetDraft: false,
        targetDraftGeneration: null,
      }),
    ]
    renderWorkflow()

    expect(
      screen.getByText(/This is a private draft in the current language/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/The Français page is missing or no longer matches/)
    ).toBeInTheDocument()
    const decision = screen.getByRole("combobox", {
      name: /What visitors get after the switch/,
    })
    expect(decision).toBeDisabled()
    expect(
      within(decision).queryByRole("option", { name: /version/ })
    ).not.toBeInTheDocument()
  })

  test("C4 requires every carry decision to be shown before review confirmation", () => {
    const loadMore = vi.fn()
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({
        transition: transition({ carryDecisionDigest: "carry-digest" }),
      })
    )
    mocks.paginated = [pageRow()]
    mocks.paginatedByName.set("cms/language:listLanguageCarryDecisions", {
      results: [{ fromPath: "/old-about", outcome: "drop_retired" }],
      status: "CanLoadMore",
      loadMore,
    })
    const { unmount } = renderWorkflow()

    expect(screen.getByText("/old-about")).toBeInTheDocument()
    expect(screen.getByText("Retired address left behind")).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: "I have reviewed the pages, site name and menus",
      })
    ).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Show more" }))
    expect(loadMore).toHaveBeenCalledWith(25)
    unmount()

    mocks.paginatedByName.set("cms/language:listLanguageCarryDecisions", {
      results: [{ fromPath: "/old-about", outcome: "drop_retired" }],
      status: "Exhausted",
      loadMore,
    })
    renderWorkflow()
    fireEvent.click(
      screen.getByRole("button", {
        name: "I have reviewed the pages, site name and menus",
      })
    )
    expect(
      mutation("cms/language:confirmTransitionPreview")
    ).toHaveBeenCalledWith({
      transitionId: "transition1",
      expectedPreparedSetVersion: 3,
      expectedCarryDecisionDigest: "carry-digest",
    })
  })

  test("row 10 UI: a label correction reports each page's content, search settings, address and conflicts", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ transition: transition({ mode: "correct_label" }) })
    )
    mocks.paginated = [
      pageRow({
        hasTargetDraft: false,
        targetPath: "/a-propos",
        targetRouteConflict: true,
      }),
    ]
    renderWorkflow()

    expect(screen.getByText("/about")).toBeInTheDocument()
    expect(screen.getByText("Content: slices, title")).toBeInTheDocument()
    expect(
      screen.getByText('Search settings: {"metaTitle":"About"}')
    ).toBeInTheDocument()
    expect(screen.getByText("New address: /a-propos")).toBeInTheDocument()
    expect(
      screen.getByText("Another page already uses this address in Français.")
    ).toBeInTheDocument()
    expect(screen.queryByText(/shared fields/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Copy current text/ })
    ).not.toBeInTheDocument()
  })

  const READY = {
    phase: "ready",
    unresolvedCount: 0,
    targetCount: 2,
    previewConfirmedPreparedSetVersion: 3,
    readinessVersion: 2,
  }

  test("F09c F3: a ready, reviewed change switches once, bound to the exact values it showed", async () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ transition: transition(READY) })
    )
    let finish: (value: unknown) => void = () => {}
    mutation("cms/language:activateLanguageTransition").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    renderWorkflow()

    expect(
      screen.getByText(
        "Everything is ready. Your site stays in English until you switch."
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reviewed" })).toBeDisabled()
    // Nothing is sent until the owner confirms.
    fireEvent.click(
      screen.getByRole("button", { name: "Switch my site to Français" })
    )
    expect(
      mutation("cms/language:activateLanguageTransition")
    ).not.toHaveBeenCalled()
    expect(
      screen.getByRole("heading", {
        name: "Switch your live site to Français?",
      })
    ).toBeInTheDocument()

    const confirm = screen.getByRole("button", { name: "Switch now" })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(
      await screen.findByRole("button", { name: "Switching…" })
    ).toBeDisabled()
    expect(screen.getByRole("button", { name: "Not yet" })).toBeDisabled()
    expect(
      mutation("cms/language:activateLanguageTransition")
    ).toHaveBeenCalledTimes(1)
    expect(
      mutation("cms/language:activateLanguageTransition")
    ).toHaveBeenCalledWith({
      transitionId: "transition1",
      expectedGeneration: 7,
      expectedAuthorityVersion: 1,
      expectedSettingsUpdatedAt: 42,
      expectedReadinessVersion: 2,
    })
    finish(null)
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Switch now" })
      ).not.toBeInTheDocument()
    )
  })

  test.each([
    ["not checked yet", { ...READY, readinessVersion: null }],
    ["not reviewed", { ...READY, previewConfirmedPreparedSetVersion: null }],
    [
      "reviewed an older set",
      { ...READY, previewConfirmedPreparedSetVersion: 2 },
    ],
    ["back to preparing", { ...READY, phase: "preparing" }],
    ["a page needs attention", { ...READY, blockedCount: 1 }],
  ])(
    "F09c F3: no switch is offered when the change is %s",
    (_label, overrides) => {
      mocks.queries.set(
        "cms/language:getLanguageState",
        languageState({ transition: transition(overrides) })
      )
      renderWorkflow()

      expect(
        screen.queryByRole("button", { name: /Switch/ })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText(/stays in English until you switch/)
      ).not.toBeInTheDocument()
    }
  )

  test.each([
    [
      "LANGUAGE_TRANSITION_STALE",
      "Something changed in the meantime. The latest state is shown, try again.",
    ],
    [
      "LANGUAGE_TRANSITION_PENDING_PUBLICATION_OBLIGATIONS",
      "A scheduled publication is waiting. Finish or cancel it first.",
    ],
    [
      "RETAINED_TARGET_REVIEW_STALE",
      "The retained content changed after it was shown. Review the latest version and choose again.",
    ],
    [
      "RETAINED_TARGET_DECISION_INVALID",
      "That retained-content choice is no longer available. Review the latest page state.",
    ],
    [
      "RETAINED_TARGET_SELECTION_MUST_BE_WITHDRAWN",
      "Withdraw the retained published version before choosing its newer Working Draft.",
    ],
    [
      "SITE_LANGUAGE_AUTHORITY_INVALID",
      "Your language setup has a problem that must be fixed first. Nothing on your live site was changed.",
    ],
  ])(
    "F09c F3: a refused switch (%s) says why and can be tried again",
    async (code, message) => {
      mocks.queries.set(
        "cms/language:getLanguageState",
        languageState({ transition: transition(READY) })
      )
      mutation("cms/language:activateLanguageTransition").mockRejectedValue(
        new ConvexError(code)
      )
      renderWorkflow()

      fireEvent.click(
        screen.getByRole("button", { name: "Switch my site to Français" })
      )
      fireEvent.click(screen.getByRole("button", { name: "Switch now" }))
      await vi.waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith(message)
      )
      await vi.waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Switch my site to Français" })
        ).toBeEnabled()
      )
    }
  )

  test("multi-language installs are refused without offering a change", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({
        kind: "multi_locale",
        version: null,
        currentLocale: null,
        enabledLocales: ["en", "fr"],
      })
    )
    renderWorkflow()

    expect(screen.getByText(/more than one language/)).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Start" })
    ).not.toBeInTheDocument()
  })

  test("a retained multilingual setup is refused without offering a change", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ kind: "multilingual", enabledLocales: ["en", "fr"] })
    )
    renderWorkflow()

    expect(
      screen.getByText(
        "Your site shows content in more than one language (English, Français). Changing the language here is not available for this site yet. Nothing was changed."
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Start" })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  })

  test("an uninitialized site can still begin the F09 language workflow", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({
        kind: "uninitialized",
        version: 0,
        currentLocale: "en",
      })
    )
    renderWorkflow()

    expect(
      screen.getByText(/Turn on language changes to fix the label/)
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on language changes" })
    )
    expect(
      mutation("cms/language:initializeSiteLanguageAuthority")
    ).toHaveBeenCalledWith({})
  })

  test("an invalid site setup is refused without offering a language change", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ kind: "invalid", version: null, currentLocale: null })
    )
    renderWorkflow()

    expect(
      screen.getByText(
        "Your language setup has a problem that must be fixed before the language can change. Nothing on your live site was changed."
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Start" })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  })

  test("refusal codes become plain-language messages", async () => {
    mocks.queries.set("cms/language:getLanguageState", languageState())
    mutation("cms/language:startLanguageTransition").mockRejectedValue(
      new ConvexError("LANGUAGE_TRANSITION_PENDING_PUBLICATION_OBLIGATIONS")
    )
    renderWorkflow()

    fireEvent.change(screen.getByRole("combobox", { name: "New language" }), {
      target: { value: "fr" },
    })
    fireEvent.click(screen.getByLabelText(/Fix the language label/))
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "A scheduled publication is waiting. Finish or cancel it first."
      )
    )
  })

  test("French admin messages render every workflow key", () => {
    mocks.queries.set(
      "cms/language:getLanguageState",
      languageState({ transition: transition() })
    )
    mocks.paginated = [pageRow()]
    const { container } = renderWorkflow(fr as typeof en, "fr")
    // A missing key renders as its dotted path.
    expect(container.textContent).not.toMatch(/settings\.languages\./)
    expect(
      screen.getByText("Passage de English à Français")
    ).toBeInTheDocument()
  })

  test("French and English workflow messages have the same keys", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([key, child]) =>
            keys(child, `${prefix}${key}.`)
          )
        : [prefix]
    expect(keys(fr.settings.languages).sort()).toEqual(
      keys(en.settings.languages).sort()
    )
  })
})
