import { ConvexError } from "convex/values"
const moduleTestState = vi.hoisted(() => ({ redirects: "on", multilingual: "on", ai: "on", failed: false }))
vi.mock("../admin-module-state-provider", () => ({ useModuleGate: (id: string) => ({ state: moduleTestState[id as "redirects" | "multilingual" | "ai"] }), useModuleStateFailure: () => moduleTestState.failed }))
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { getFunctionName, type FunctionReturnType } from "convex/server"
import type { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { MODULE_CATALOG } from "@/lib/modules/catalog"
import { ModulesSettings } from "./modules-settings"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useStatusQueries: vi.fn(),
  commit: vi.fn(),
  requeue: vi.fn(),
  lifecycleStatus: {
    updating: false,
    notDelivered: false,
    failing: false,
    localUnreachable: false,
    oldestUndelivered: null,
    operation: null,
  },
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useQueries: (queries: unknown) => mocks.useStatusQueries(queries),
  useQuery: (
    reference: Parameters<typeof getFunctionName>[0],
    args: unknown
  ) =>
    getFunctionName(reference) ===
    "cms/languageLifecycle:getLanguageLifecycleStatus"
      ? mocks.lifecycleStatus
      : mocks.useQuery(reference, args),
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference)
    return name === "cms/languageLifecycle:requeueUndeliveredLifecycleIntents"
      ? mocks.requeue
      : mocks.commit
  },
}))

vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}))

type ModulePreview = FunctionReturnType<typeof api.cms.modules.preview>
type ModuleCommit = FunctionReturnType<typeof api.cms.modules.commit>

function state(
  moduleId: string,
  enabled: boolean,
  effective = enabled,
  readiness: "ready" | "needs_setup" = "ready",
  setup: "not_required" | "required" = "not_required"
): ModulePreview["readiness"][number] {
  return {
    moduleId,
    available: true,
    enabled,
    effective,
    readiness,
    setup,
  }
}

function preview({
  changes = [],
  blockers = [],
  configurationVersion = 0,
  redirectsEnabled = false,
  emailReadiness = "ready" as const,
  emailSetup = "not_required" as const,
  multilingualEnabled = false,
}: {
  changes?: ModulePreview["changes"]
  blockers?: ModulePreview["blockers"]
  configurationVersion?: number
  redirectsEnabled?: boolean
  emailReadiness?: "ready" | "needs_setup"
  emailSetup?: "not_required" | "required"
  multilingualEnabled?: boolean
}): ModulePreview {
  return {
    multilingualCommandTokens: null,
    configurationVersion,
    changes,
    blockers,
    requiredDependencies: redirectsEnabled
      ? ["owner-access", "publication", "system"]
      : [],
    readiness: MODULE_CATALOG.map((module) =>
      state(
        module.id,
        module.required ||
          (module.id === "redirects" && redirectsEnabled) ||
          (module.id === "multilingual" && multilingualEnabled),
        undefined,
        module.id === "email" ? emailReadiness : "ready",
        module.id === "email" ? emailSetup : "not_required"
      )
    ),
  }
}

function renderSettings(locale: "en" | "fr" = "en") {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? en : fr}
    >
      <ModulesSettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  moduleTestState.redirects = "on"
  moduleTestState.multilingual = "on"
  moduleTestState.failed = false
  moduleTestState.ai = "on"
  mocks.useStatusQueries.mockReturnValue({})
  mocks.lifecycleStatus.updating = false
  mocks.lifecycleStatus.notDelivered = false
  mocks.useQuery.mockImplementation((_reference, args) => {
    if (args === "skip") return undefined
    if (args.changes.length > 0) {
      return preview({
        redirectsEnabled: args.changes[0].enabled,
        changes: [
          {
            moduleId: "redirects",
            fromEnabled: false,
            toEnabled: args.changes[0].enabled,
          },
        ],
      })
    }
    return preview({})
  })
  mocks.commit.mockResolvedValue({ ...preview({}), committed: true })
  mocks.requeue.mockResolvedValue({ requeued: 0, moreRemain: false })
})

describe("ModulesSettings", () => {
  test("shows no delivery notice; that status lives in Settings > General", () => {
    mocks.lifecycleStatus.notDelivered = true
    mocks.lifecycleStatus.updating = true
    renderSettings()

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(
      screen.queryByText("Some public-site updates were not delivered")
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Push updates now" })
    ).not.toBeInTheDocument()
    expect(mocks.requeue).not.toHaveBeenCalled()
  })

  test("shows backend effective state, readiness, setup, and dependencies", () => {
    renderSettings()

    expect(screen.getByRole("heading", { name: "Modules" })).toBeInTheDocument()
    expect(screen.getByTestId("module-system")).toHaveTextContent("Active")
    expect(screen.getByTestId("module-redirects")).toHaveTextContent("Inactive")
    expect(screen.getByTestId("module-redirects")).toHaveTextContent(
      "Not required"
    )
    expect(screen.getByTestId("module-redirects")).toHaveTextContent(
      /Needs:.*System, Owner access, Publication/
    )
    expect(screen.getByText("No changes to review.")).toBeInTheDocument()
    expect(screen.getByTestId("module-language")).toHaveTextContent(
      "Every page and address has a language"
    )
  })

  test("keeps required modules non-toggleable while the installed pilot remains owner-configurable", () => {
    renderSettings()

    expect(
      screen.getByRole("checkbox", { name: "Turn System on or off" })
    ).toBeDisabled()
    expect(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    ).not.toBeDisabled()
  })

  test("shows required Email as active but needing setup, distinct from disabled Redirects", () => {
    mocks.useQuery.mockImplementation((_reference, args) => {
      if (args === "skip") return undefined
      return preview({
        emailReadiness: "needs_setup",
        emailSetup: "required",
      })
    })
    renderSettings()

    expect(screen.getByTestId("module-email")).toHaveTextContent("Active")
    expect(screen.getByTestId("module-email")).toHaveTextContent("Needs setup")
    expect(screen.getByTestId("module-redirects")).toHaveTextContent("Inactive")
    expect(screen.getByTestId("module-redirects")).toHaveTextContent("Ready")
  })

  test("previews an optional toggle and commits only the exact reviewed changes", async () => {
    renderSettings()

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    )

    expect(await screen.findByTestId("module-changes")).toHaveTextContent(
      /Redirects.*Disabled.*Enabled/
    )
    expect(
      screen.getAllByText("Owner access, Publication, System").length
    ).toBeGreaterThan(0)

    fireEvent.click(
      screen.getByRole("button", { name: "Apply reviewed changes" })
    )

    await waitFor(() => {
      expect(mocks.commit).toHaveBeenCalledWith({
        expectedConfigurationVersion: 0,
        multilingualCommandTokens: null,
        changes: [{ moduleId: "redirects", enabled: true }],
      })
    })
    expect(mocks.success).toHaveBeenCalledWith("Module configuration updated.")
  })

  describe("turning Multilingual off", () => {
    const toggleName = "Turn Multilingual on or off"

    function previewWithBlocker(locales: string[]) {
      mocks.useQuery.mockImplementation((_reference, args) => {
        if (args === "skip") return undefined
        if (args.changes.length === 0) {
          return preview({ multilingualEnabled: true, configurationVersion: 7 })
        }
        return { ...preview({
          configurationVersion: 7,
          multilingualEnabled: !args.changes.some(
            (change: { moduleId: string; enabled: boolean }) =>
              change.moduleId === "multilingual" && !change.enabled
          ),
          redirectsEnabled: args.changes.some(
            (change: { moduleId: string; enabled: boolean }) =>
              change.moduleId === "redirects" && change.enabled
          ),
          changes: args.changes.map(
            (change: { moduleId: string; enabled: boolean }) => ({
              moduleId: change.moduleId,
              fromEnabled: !change.enabled,
              toEnabled: change.enabled,
            })
          ),
          blockers: locales.length === 1 ? [] : [{ code: "MULTILINGUAL_AUTHORITY_ACTIVE", moduleId: "multilingual", locales }],
        }), multilingualCommandTokens: { settingsUpdatedAt: 1, authorityVersion: 4, moduleConfigurationVersion: 7 } }
      })
    }

    test("the review shows no internal version number", async () => {
      previewWithBlocker(["en"])
      renderSettings()

      fireEvent.click(screen.getByRole("checkbox", { name: toggleName }))
      await screen.findByTestId("module-changes")

      // "Current state" belongs to each card's Active/Inactive badge; the
      // internal configuration version is never shown to the owner.
      expect(screen.queryByText(/Configuration version/)).not.toBeInTheDocument()
      expect(screen.queryByText("Current state: 7")).not.toBeInTheDocument()
      expect(
        within(screen.getByTestId("module-multilingual")).getByText(
          "Current state: Inactive"
        )
      ).toBeInTheDocument()
    })

    test("one language and mixed changes use ONE atomic commit with the preview token", async () => {
      previewWithBlocker(["en"])
      renderSettings()
      fireEvent.click(screen.getByRole("checkbox", { name: toggleName }))
      fireEvent.click(screen.getByRole("checkbox", { name: "Turn Redirects on or off" }))
      fireEvent.click(screen.getByRole("button", { name: en.settings.modules.save }))
      await waitFor(() => expect(mocks.commit).toHaveBeenCalledExactlyOnceWith({
        expectedConfigurationVersion: 7,
        changes: [{ moduleId: "redirects", enabled: true }, { moduleId: "multilingual", enabled: false }],
        multilingualCommandTokens: { settingsUpdatedAt: 1, authorityVersion: 4, moduleConfigurationVersion: 7 },
      }))
      expect(mocks.success).toHaveBeenCalledWith(en.settings.modules.saved)
    })
    test.each(["en", "fr"] as const)("refused mixed Apply resets every draft to saved (%s)", async (locale) => {
      previewWithBlocker(["en"])
      mocks.commit.mockRejectedValue(new ConvexError("CMS_MODULE_TRANSITION_BLOCKED"))
      renderSettings(locale)
      const message = locale === "en" ? en : fr
      const multiName = locale === "en" ? toggleName : "Activer ou désactiver Multilingue"
      fireEvent.click(screen.getByRole("checkbox", { name: multiName }))
      fireEvent.click(screen.getByRole("button", { name: message.settings.modules.save }))
      await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(message.settings.modules.commitFailed))
      expect(screen.getByRole("checkbox", { name: multiName })).toBeChecked()
      expect(screen.queryByTestId("module-changes")).not.toBeInTheDocument()
      const error = screen.getByRole("alert")
      expect(error).toHaveTextContent(message.settings.modules.commitFailed)
      expect(error.parentElement).toContainElement(screen.getByRole("button", { name: message.settings.modules.save }))
    })

    test("two or more languages keep the blocker, disable Apply and call nothing", async () => {
      previewWithBlocker(["en", "fr"])
      renderSettings()

      fireEvent.click(screen.getByRole("checkbox", { name: toggleName }))

      expect(await screen.findByRole("alert")).toHaveTextContent(
        en.settings.modules.multilingualActiveBlocker
      )
      expect(
        screen.getByRole("button", { name: "Apply reviewed changes" })
      ).toBeDisabled()
      expect(mocks.commit).not.toHaveBeenCalled()
    })
  })

  test("keeps a module commit pending and recovers when a newer configuration wins", async () => {
    let configurationVersion = 0
    mocks.useQuery.mockImplementation((_reference, args) => {
      if (args === "skip") return undefined
      if (args.changes.length > 0) {
        return preview({
          configurationVersion,
          redirectsEnabled: args.changes[0].enabled,
          changes: [
            {
              moduleId: "redirects",
              fromEnabled: false,
              toEnabled: args.changes[0].enabled,
            },
          ],
        })
      }
      return preview({ configurationVersion })
    })
    const commit = deferred<ModuleCommit>()
    mocks.commit.mockReturnValue(commit.promise)
    const view = renderSettings()

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Apply reviewed changes" })
    )
    expect(mocks.commit).toHaveBeenCalledWith({
      expectedConfigurationVersion: 0,
      multilingualCommandTokens: null,
      changes: [{ moduleId: "redirects", enabled: true }],
    })
    expect(
      screen.getByRole("button", { name: "Applying changes…" })
    ).toBeDisabled()
    expect(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    ).toBeDisabled()
    expect(mocks.success).not.toHaveBeenCalled()

    configurationVersion = 1
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ModulesSettings />
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This configuration changed while you were reviewing it. Review the changes again before applying them."
    )
    expect(
      screen.getByRole("button", { name: "Applying changes…" })
    ).toBeDisabled()

    await act(async () => {
      commit.reject(new ConvexError("CMS_MODULE_CONFIGURATION_STALE"))
      await commit.promise.catch(() => undefined)
    })

    expect(mocks.commit).toHaveBeenCalledOnce()
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith(
      "This configuration changed while you were reviewing it. Review the changes again before applying them."
    )
    expect(screen.getByTestId("module-changes")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Review current configuration" })
    ).toBeEnabled()
    fireEvent.click(
      screen.getByRole("button", { name: "Review current configuration" })
    )
    expect(screen.queryByTestId("module-changes")).not.toBeInTheDocument()
    expect(mocks.commit).toHaveBeenCalledOnce()
  })

  test("shows plain French names and summaries for the modules", () => {
    renderSettings("fr")

    expect(screen.getByTestId("module-redirects")).toHaveTextContent(
      "Dirigez les visiteurs des anciennes adresses vers les nouvelles."
    )
    expect(
      screen.getByRole("checkbox", {
        name: "Activer ou désactiver Redirections",
      })
    ).toBeInTheDocument()
    expect(screen.getByTestId("module-content-model")).toHaveTextContent(
      "Choisissez les types de contenu que votre site peut enregistrer."
    )
  })

  test("renders explicit backend blockers and does not offer a blocked commit", () => {
    mocks.useQuery.mockImplementation((_reference, args) => {
      if (args === "skip") return undefined
      if (args.changes.length > 0) {
        return preview({
          changes: [
            { moduleId: "redirects", fromEnabled: true, toEnabled: false },
          ],
          blockers: [
            {
              code: "DEPENDANT_ENABLED",
              moduleId: "publication",
              relatedModuleId: "redirects",
            },
          ],
        })
      }
      return preview({ redirectsEnabled: true })
    })
    renderSettings()

    // The mock reports the current state as enabled, so this is an explicit
    // pending disable reviewed by the backend-shaped preview.
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    )

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Turn off Redirects before turning off Publication."
    )
    expect(
      screen.getByRole("button", { name: "Apply reviewed changes" })
    ).toBeDisabled()
  })

  test.each([
    {
      locale: "en" as const,
      text: "Publish your site in more than one language.",
      link: "Open Languages",
      toggle: "Turn Multilingual on or off",
    },
    {
      locale: "fr" as const,
      text: "Publiez votre site dans plusieurs langues.",
      link: "Ouvrir les langues",
      toggle: "Activer ou désactiver Multilingue",
    },
  ])(
    "Multilingual has the same switch as other optional modules, and Open Languages only while on ($locale)",
    ({ locale, text, link, toggle }) => {
      mocks.useQuery.mockImplementation((_reference, args) => {
        if (args === "skip") return undefined
        return preview({ multilingualEnabled: true })
      })
      const view = renderSettings(locale)

      const row = screen.getByTestId("module-multilingual")
      expect(row).toHaveTextContent(text)
      expect(within(row).getByRole("checkbox", { name: toggle })).toBeChecked()
      expect(within(row).getByRole("link", { name: link })).toHaveAttribute(
        "href",
        "/admin/settings/languages"
      )
      // Multilingual has no setup step: it shows the same generic badges as
      // every other module, Ready and Not required (approved prototype).
      const modules = (locale === "en" ? en : fr).settings.modules
      expect(row).toHaveTextContent(`${modules.readiness}: ${modules.ready}`)
      expect(row).toHaveTextContent(
        `${modules.setup}: ${modules.notRequired}`
      )
      expect(row).not.toHaveTextContent(modules.needsSetup)
      view.unmount()

      mocks.useQuery.mockImplementation((_reference, args) => {
        if (args === "skip") return undefined
        return preview({ multilingualEnabled: false })
      })
      renderSettings(locale)
      const off = screen.getByTestId("module-multilingual")
      expect(off).toHaveTextContent(`${modules.readiness}: ${modules.ready}`)
      expect(off).toHaveTextContent(`${modules.setup}: ${modules.notRequired}`)
      expect(off).not.toHaveTextContent(modules.needsSetup)
      expect(within(off).getByRole("checkbox", { name: toggle })).not.toBeChecked()
      expect(within(off).queryByRole("link", { name: link })).not.toBeInTheDocument()
    }
  )

  test("gives direct actions when a Multilingual blocker comes back with a reviewed change", () => {
    mocks.useQuery.mockImplementation((_reference, args) => {
      if (args === "skip") return undefined
      if (args.changes.length > 0) {
        return preview({
          blockers: [
            {
              code: "MULTILINGUAL_AUTHORITY_ACTIVE",
              moduleId: "multilingual",
              locales: ["en", "fr"],
            },
          ],
        })
      }
      return preview({ multilingualEnabled: true })
    })
    renderSettings()
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    )

    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(
      "Multilingual cannot be turned off while more than one language is active"
    )
    expect(
      within(alert).getByRole("link", { name: "Manage English" })
    ).toHaveAttribute("href", "/admin/settings/languages")
    expect(
      within(alert).getByRole("link", { name: "Manage Français" })
    ).toHaveAttribute("href", "/admin/settings/languages")
    expect(
      within(alert).getByRole("link", { name: "Use one language" })
    ).toHaveAttribute("href", "/admin/settings/languages")
    expect(
      screen.getByRole("button", { name: "Apply reviewed changes" })
    ).toBeDisabled()
  })

  test.each([
    {
      moreRules: false,
      ruleCount: 2,
      message:
        "Redirects can’t be turned off while 2 redirects are saved. Delete them on the Redirects page first. Nothing is deleted for you.",
    },
    {
      moreRules: true,
      ruleCount: 3,
      message:
        "Redirects can’t be turned off while more than 2 redirects are saved. Delete them on the Redirects page first. Nothing is deleted for you.",
    },
  ])(
    "renders the saved-redirects blocker in plain language with each source path (moreRules: $moreRules)",
    ({ moreRules, ruleCount, message }) => {
      mocks.useQuery.mockImplementation((_reference, args) => {
        if (args === "skip") return undefined
        if (args.changes.length > 0) {
          return preview({
            changes: [
              { moduleId: "redirects", fromEnabled: true, toEnabled: false },
            ],
            blockers: [
              {
                code: "REDIRECT_RULES_PRESENT",
                moduleId: "redirects",
                ruleCount,
                moreRules,
                rules: [
                  {
                    ruleId: "rule-1" as Id<"redirects">,
                    fromPath: "/old-page",
                  },
                  {
                    ruleId: "rule-2" as Id<"redirects">,
                    fromPath: "/ancienne-page",
                    locale: "fr",
                  },
                ],
              },
            ],
          })
        }
        return preview({ redirectsEnabled: true })
      })
      renderSettings()

      fireEvent.click(
        screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
      )

      expect(screen.getByRole("alert")).toHaveTextContent(message)
      expect(
        within(screen.getByTestId("redirect-rules-blocker"))
          .getAllByRole("listitem")
          .map((item) => item.textContent)
      ).toEqual(["/old-page", "/ancienne-page (language: fr)"])
      expect(
        screen.getByRole("button", { name: "Apply reviewed changes" })
      ).toBeDisabled()
    }
  )

  test("does not commit a review made stale by a newer backend configuration", () => {
    let configurationVersion = 0
    mocks.useQuery.mockImplementation((_reference, args) => {
      if (args === "skip") return undefined
      if (args.changes.length > 0) {
        return preview({
          configurationVersion,
          redirectsEnabled: args.changes[0].enabled,
          changes: [
            {
              moduleId: "redirects",
              fromEnabled: false,
              toEnabled: args.changes[0].enabled,
            },
          ],
        })
      }
      return preview({ configurationVersion })
    })
    renderSettings()

    configurationVersion = 1
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    )

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This configuration changed while you were reviewing it. Review the changes again before applying them."
    )
    expect(
      screen.getByRole("button", { name: "Apply reviewed changes" })
    ).toBeDisabled()
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  test("blocks a newer candidate preview even before the baseline subscription catches up", () => {
    mocks.useQuery.mockImplementation((_reference, args) => {
      if (args === "skip") return undefined
      if (args.changes.length > 0) {
        return preview({
          configurationVersion: 1,
          redirectsEnabled: args.changes[0].enabled,
          changes: [
            {
              moduleId: "redirects",
              fromEnabled: false,
              toEnabled: args.changes[0].enabled,
            },
          ],
        })
      }
      return preview({ configurationVersion: 0 })
    })
    renderSettings()

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    )

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This configuration changed while you were reviewing it. Review the changes again before applying them."
    )
    expect(
      screen.getByRole("button", { name: "Apply reviewed changes" })
    ).toBeDisabled()
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  test("keeps a loading state while the owner preview is unavailable", () => {
    mocks.useQuery.mockReturnValue(undefined)
    renderSettings()

    expect(
      screen.getByText("Loading module configuration…")
    ).toBeInTheDocument()
  })

  test("shows a recoverable error when the owner preview query fails", () => {
    mocks.useQuery.mockImplementation(() => {
      throw new Error("preview unavailable")
    })
    renderSettings()

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Module configuration could not be loaded. Refresh and try again."
    )
  })

  test.each(["en", "fr"] as const)(
    "explains all seven lifecycle codes explicitly in %s",
    (locale) => {
      const blockers: ModulePreview["blockers"] = [
        {
          code: "DEPENDENCY_NOT_LISTED",
          moduleId: "redirects",
          relatedModuleId: "publication",
        },
        {
          code: "DEPENDANT_ENABLED",
          moduleId: "publication",
          relatedModuleId: "redirects",
        },
        {
          code: "REQUIRED_MODULE",
          moduleId: "publication",
          relatedModuleId: "publication",
        },
        {
          code: "REDIRECT_RULES_PRESENT",
          moduleId: "redirects",
          ruleCount: 1,
          moreRules: false,
          rules: [
            { ruleId: "rule-1" as Id<"redirects">, fromPath: "/old-page" },
          ],
        },
        {
          code: "MULTILINGUAL_AUTHORITY_ACTIVE",
          moduleId: "multilingual",
          locales: ["en", "fr"],
        },
        {
          code: "LANGUAGE_OPERATION_OPEN",
          moduleId: "multilingual",
          kind: "default_migration",
        },
        { code: "LANGUAGE_STATE_INVALID", moduleId: "multilingual" },
      ]
      mocks.useQuery.mockImplementation((_reference, args) => {
        if (args === "skip") return undefined
        return preview({ blockers: args.changes.length ? blockers : [] })
      })
      renderSettings(locale)
      const messages = (locale === "en" ? en : fr).settings.modules
      fireEvent.click(
        screen.getByRole("checkbox", {
          name:
            locale === "en"
              ? "Turn Redirects on or off"
              : "Activer ou désactiver Redirections",
        })
      )

      const items = within(screen.getByRole("alert")).getAllByRole("list")[0]!
      expect(
        within(items)
          .getAllByRole("listitem")
          .filter((item) => item.parentElement === items)
      ).toHaveLength(7)
      expect(items).toHaveTextContent(
        locale === "en"
          ? "Turn on Publication before turning on Redirects."
          : "Activez Publication avant d’activer Redirections."
      )
      expect(items).toHaveTextContent(
        locale === "en"
          ? "Turn off Redirects before turning off Publication."
          : "Désactivez Redirections avant de désactiver Publication."
      )
      expect(items).toHaveTextContent(
        locale === "en"
          ? "Publication is needed for the site and cannot be turned off."
          : "Publication est nécessaire au site et ne peut pas être désactivé."
      )
      expect(items).toHaveTextContent(messages.multilingualActiveBlocker)
      expect(items).toHaveTextContent(messages.languageOperationBlocker)
      expect(items).toHaveTextContent(messages.languageStateInvalid)
      expect(
        within(items).getByTestId("redirect-rules-blocker")
      ).toHaveTextContent("/old-page")
      for (const link of within(items).getAllByRole("link")) {
        expect(link.getAttribute("href")).toMatch(
          /^\/admin\/settings\/languages$/
        )
      }
      expect(screen.getByRole("button", { name: messages.save })).toBeDisabled()
      expect(mocks.commit).not.toHaveBeenCalled()
    }
  )

  const invalidBlockers = [
    {
      code: "FUTURE_BLOCKER",
      moduleId: "publication",
      relatedModuleId: "redirects",
    },
    { code: "DEPENDENCY_NOT_LISTED", moduleId: "redirects" },
    { code: "DEPENDANT_ENABLED", moduleId: "publication", relatedModuleId: 42 },
    { code: "REQUIRED_MODULE", moduleId: "publication" },
    {
      code: "REDIRECT_RULES_PRESENT",
      moduleId: "redirects",
      ruleCount: 1,
      rules: [],
    },
    {
      code: "REDIRECT_RULES_PRESENT",
      moduleId: "redirects",
      ruleCount: 1,
      moreRules: false,
      rules: [{ ruleId: "rule-1", fromPath: null }],
    },
    {
      code: "MULTILINGUAL_AUTHORITY_ACTIVE",
      moduleId: "multilingual",
      locales: null,
    },
    {
      code: "MULTILINGUAL_AUTHORITY_ACTIVE",
      moduleId: "multilingual",
      locales: [42],
    },
    {
      code: "LANGUAGE_OPERATION_OPEN",
      moduleId: "multilingual",
      kind: "future_operation",
    },
    { code: "LANGUAGE_STATE_INVALID", moduleId: "redirects" },
  ]
  test.each(
    invalidBlockers.flatMap((blocker, index) =>
      (["en", "fr"] as const).flatMap((locale) =>
        (["current", "pending"] as const).map((surface) => ({
          blocker,
          index,
          locale,
          surface,
        }))
      )
    )
  )(
    "contains invalid blocker $index on the $surface preview in $locale",
    ({ blocker, locale, surface }) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {})
      try {
        mocks.useQuery.mockImplementation((_reference, args) => {
          if (args === "skip") return undefined
          // Invalid wire fixtures deliberately bypass the typed happy-path builder.
          const invalid = surface === "current" || args.changes.length > 0
          return { ...preview({}), blockers: invalid ? [blocker] : [] }
        })
        renderSettings(locale)
        if (surface === "pending") {
          fireEvent.click(
            screen.getByRole("checkbox", {
              name:
                locale === "en"
                  ? "Turn Redirects on or off"
                  : "Activer ou désactiver Redirections",
            })
          )
        }
        const messages = (locale === "en" ? en : fr).settings.modules
        expect(screen.getByRole("alert")).toHaveTextContent(messages.error)
        expect(
          screen.queryByRole("button", { name: messages.save })
        ).not.toBeInTheDocument()
        expect(screen.queryByTestId("module-changes")).not.toBeInTheDocument()
        expect(mocks.commit).not.toHaveBeenCalled()
        expect(mocks.success).not.toHaveBeenCalled()
      } finally {
        consoleError.mockRestore()
      }
    }
  )

  test("sends a normalized no-op review and reports no change instead of a saved transition", async () => {
    mocks.useQuery.mockImplementation((_reference, args) =>
      args === "skip" ? undefined : preview({ configurationVersion: 7 })
    )
    mocks.commit.mockResolvedValue({
      ...preview({ configurationVersion: 7 }),
      committed: false,
    } satisfies ModuleCommit)
    renderSettings()
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Apply reviewed changes" })
    )

    await waitFor(() =>
      expect(mocks.commit).toHaveBeenCalledWith({
        expectedConfigurationVersion: 7,
        multilingualCommandTokens: null,
        changes: [],
      })
    )
    await waitFor(() => {
      expect(mocks.success).toHaveBeenCalledExactlyOnceWith(
        "No changes to review."
      )
      expect(
        screen.getByRole("button", { name: "Apply reviewed changes" })
      ).toBeDisabled()
    })
  })

  test("resets reviewed choices when transactional blockers refuse the commit", async () => {
    mocks.commit.mockRejectedValue(new Error("CMS_MODULE_TRANSITION_BLOCKED"))
    renderSettings()
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Apply reviewed changes" })
    )

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(en.settings.modules.commitFailed)
    )
    expect(screen.queryByTestId("module-changes")).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Apply reviewed changes" })
    ).toBeDisabled()
    expect(mocks.commit).toHaveBeenCalledOnce()
    expect(mocks.success).not.toHaveBeenCalled()
  })
})

test.each(["loading", "error"])("row gate %s disables the toggle and displays the approved line", (gate) => {
  moduleTestState.redirects = gate
  renderSettings()
  expect(screen.getByRole("checkbox", { name: "Turn Redirects on or off" })).toBeDisabled()
  if (gate === "error") expect(screen.getByRole("alert")).toHaveTextContent(en.settings.modules.moduleError.replace("{name}", "Redirects"))
  else expect(screen.getAllByText(en.settings.modules.loading)).toHaveLength(1)
})
test("global failure suppresses per-row error copy", () => {
  moduleTestState.redirects = "error"
  moduleTestState.multilingual = "error"
  moduleTestState.failed = true
  renderSettings()
  expect(screen.queryByText(en.settings.modules.moduleError.replace("{name}", "Redirects"))).not.toBeInTheDocument()
})
test.each(["CMS_MODULE_CONFIGURATION_STALE", "LANGUAGE_OPERATION_STALE"])("exact typed %s keeps the draft and top review action", async (code) => {
  mocks.commit.mockRejectedValue(new ConvexError(code))
  renderSettings()
  fireEvent.click(screen.getByRole("checkbox", { name: "Turn Redirects on or off" }))
  fireEvent.click(screen.getByRole("button", { name: en.settings.modules.save }))
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(en.settings.modules.stale))
  expect(screen.getByTestId("module-changes")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: en.settings.modules.reviewAgain })).toBeInTheDocument()
})


describe("S3 AI card", () => {
  function aiPreview(enabled: boolean): ModulePreview {
    const value = preview({})
    return { ...value, readiness: value.readiness.map((entry) => entry.moduleId === "ai" ? state("ai", enabled, enabled, "needs_setup", "required") : entry) }
  }
  function configure(enabled = true, card: { state: "missing" } | { state: "refused"; provider: "openrouter" } | { state: "active" } = { state: "missing" }) {
    mocks.useQuery.mockImplementation((_reference, args) => args === "skip" ? undefined : aiPreview(args.changes.length ? args.changes[0].enabled : enabled))
    mocks.useStatusQueries.mockImplementation((queries) => Object.keys(queries).length ? { status: { card } } : {})
  }
  test.each(["en", "fr"] as const)("saved-on missing shows Q's single box before the unchanged four badges (%s)", (locale) => {
    configure()
    renderSettings(locale)
    const row = screen.getByTestId("module-ai")
    const box = within(row).getByTestId("ai-finish-setup")
    expect(box).toHaveTextContent(locale === "en" ? "Not configured: API key is missing" : "Non configuré : la clé API est absente")
    expect(box).toHaveTextContent(locale === "en" ? "AI is on but cannot run yet." : "L'IA est activée mais ne peut pas encore fonctionner.")
    expect(within(box).getByRole("link")).toHaveAttribute("href", "/admin/settings/ai")
    expect(box.nextElementSibling).toHaveAttribute("aria-label", locale === "en" ? "AI status" : "État de IA")
    expect(box.nextElementSibling?.children).toHaveLength(4)
  })
  test("refused wins over missing", () => {
    configure(true, { state: "refused", provider: "openrouter" })
    renderSettings()
    expect(screen.getByTestId("ai-finish-setup")).toHaveTextContent("Not configured: OpenRouter refused the key")
    expect(screen.getByTestId("ai-finish-setup")).not.toHaveTextContent("API key is missing")
  })
  test.each(["any-ready", "unreachable", "refused-other-ready"])("%s suppresses the box", () => {
    configure()
    const mounted = renderSettings()
    expect(screen.getByTestId("ai-finish-setup")).toBeInTheDocument()
    configure(true, { state: "active" })
    mounted.rerender(<NextIntlClientProvider locale="en" messages={en}><ModulesSettings /></NextIntlClientProvider>)
    expect(screen.queryByTestId("ai-finish-setup")).not.toBeInTheDocument()
  })
  test.each(["loading", "error"])("AI gate %s suppresses the box", (gate) => {
    configure()
    const mounted = renderSettings()
    expect(screen.getByTestId("ai-finish-setup")).toBeInTheDocument()
    moduleTestState.ai = gate
    mounted.rerender(<NextIntlClientProvider locale="en" messages={en}><ModulesSettings /></NextIntlClientProvider>)
    expect(screen.queryByTestId("ai-finish-setup")).not.toBeInTheDocument()
  })
  test("off and pending-on never query status or show the box before Apply", () => {
    configure()
    const mounted = renderSettings()
    expect(screen.getByTestId("ai-finish-setup")).toBeInTheDocument()
    configure(false)
    mocks.useStatusQueries.mockClear()
    mounted.rerender(<NextIntlClientProvider locale="en" messages={en}><ModulesSettings /></NextIntlClientProvider>)
    expect(screen.queryByTestId("ai-finish-setup")).not.toBeInTheDocument()
    fireEvent.click(within(screen.getByTestId("module-ai")).getByRole("checkbox"))
    expect(screen.queryByTestId("ai-finish-setup")).not.toBeInTheDocument()
    expect(mocks.useStatusQueries.mock.calls.every(([queries]) => Object.keys(queries).length === 0)).toBe(true)
  })
  test("pending-off still follows saved-on while badges preview", () => {
    configure()
    renderSettings()
    expect(screen.getByTestId("ai-finish-setup")).toBeInTheDocument()
    fireEvent.click(within(screen.getByTestId("module-ai")).getByRole("checkbox"))
    expect(screen.getByTestId("ai-finish-setup")).toBeInTheDocument()
  })
  test("status error is contained, reported and leaves the rest of Modules usable", () => {
    configure()
    const mounted = renderSettings()
    expect(screen.getByTestId("ai-finish-setup")).toBeInTheDocument()
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.useStatusQueries.mockReturnValue({ status: new Error("AI unavailable") })
    mocks.useStatusQueries.mockImplementation(() => ({ status: new Error("AI unavailable") }))
    mounted.rerender(<NextIntlClientProvider locale="en" messages={en}><ModulesSettings /></NextIntlClientProvider>)
    expect(screen.queryByTestId("ai-finish-setup")).not.toBeInTheDocument()
    expect(screen.getByTestId("module-language")).toBeInTheDocument()
    expect(report).toHaveBeenCalledWith(expect.stringContaining("module=ai boundary=admin.contribution"), expect.objectContaining({ cause: "AI unavailable" }))
    report.mockRestore()
  })
})
