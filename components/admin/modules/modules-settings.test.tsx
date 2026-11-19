import { ConvexError } from "convex/values"
const moduleTestState = vi.hoisted(() => ({ redirects: "on", multilingual: "on", failed: false }))
vi.mock("../admin-module-state-provider", () => ({ useModuleGate: (id: string) => ({ state: moduleTestState[id as "redirects" | "multilingual"] }), useModuleStateFailure: () => moduleTestState.failed }))
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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
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

  test("groups the catalog: optional modules first, then Always on, collapsed", () => {
    renderSettings()

    expect(screen.getByRole("heading", { name: "Modules" })).toBeInTheDocument()
    const optional = MODULE_CATALOG.filter((entry) => !entry.required)
    const alwaysOn = MODULE_CATALOG.filter((entry) => entry.required)
    const optionalCard = screen.getByTestId("optional-modules")
    expect(optionalCard).toHaveTextContent("Optional modules")
    expect(within(optionalCard).getAllByRole("checkbox")).toHaveLength(optional.length)
    for (const entry of optional)
      expect(within(optionalCard).getByTestId(`module-${entry.id}`)).toBeInTheDocument()
    expect(screen.getAllByRole("checkbox")).toHaveLength(optional.length)
    expect(screen.queryByText(/Needs/)).not.toBeInTheDocument()
    expect(screen.queryByText("Required")).not.toBeInTheDocument()
    expect(screen.getByText("No changes to review.")).toBeInTheDocument()

    const group = screen.getByTestId("always-on")
    expect(group).toHaveTextContent(`Always on (${alwaysOn.length})`)
    expect(group).toHaveTextContent("Needed by every site, so they cannot be turned off.")
    expect(screen.queryByTestId("always-on-list")).not.toBeInTheDocument()

    fireEvent.click(within(group).getByRole("button", { name: "Show" }))
    const list = screen.getByTestId("always-on-list")
    expect(within(list).getAllByRole("listitem")).toHaveLength(alwaysOn.length)
    expect(screen.getByTestId("module-language")).toHaveTextContent(
      "Language: Every page and address has a language, so language support stays on."
    )
    fireEvent.click(within(group).getByRole("button", { name: "Hide" }))
    expect(screen.queryByTestId("always-on-list")).not.toBeInTheDocument()
  })

  test("required modules have no switch; optional modules keep theirs", () => {
    renderSettings()

    expect(
      screen.queryByRole("checkbox", { name: "Turn System on or off" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("checkbox", { name: "Turn Email on or off" })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    ).not.toBeDisabled()
  })

  test("previews an optional toggle and commits only the exact reviewed changes", async () => {
    renderSettings()

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    )

    expect(await screen.findByTestId("module-changes")).toHaveTextContent(
      /Redirects.*Disabled.*Enabled/
    )
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
    expect(screen.getByTestId("apply-title")).toHaveTextContent("Turning on Redirects")
    expect(mocks.success).not.toHaveBeenCalled()
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

      // The internal configuration version is never shown to the owner.
      expect(screen.queryByText(/Configuration version/)).not.toBeInTheDocument()
      expect(screen.queryByText(/\b7\b/)).not.toBeInTheDocument()
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
      expect(screen.getByTestId("apply-title")).toHaveTextContent("Applying 2 changes")
      expect(mocks.success).not.toHaveBeenCalled()
    })
    test.each(["en", "fr"] as const)("refused mixed Apply resets every draft to saved (%s)", async (locale) => {
      previewWithBlocker(["en"])
      mocks.commit.mockRejectedValue(new ConvexError("CMS_MODULE_TRANSITION_BLOCKED"))
      renderSettings(locale)
      const message = locale === "en" ? en : fr
      const multiName = locale === "en" ? toggleName : "Activer ou désactiver Multilingue"
      fireEvent.click(screen.getByRole("checkbox", { name: multiName }))
      fireEvent.click(screen.getByRole("button", { name: message.settings.modules.save }))
      const panel = screen.getByTestId("apply-progress")
      await waitFor(() => expect(panel).toHaveAttribute("data-status", "failed"), { timeout: 2000 })
      expect(within(panel).getByTestId("apply-step")).toHaveTextContent(message.settings.modules.commitFailed)
      expect(within(panel).getByRole("button", { name: message.settings.modules.progress.close })).toBeInTheDocument()
      expect(mocks.error).not.toHaveBeenCalled()
      expect(screen.getByRole("checkbox", { name: multiName })).toBeChecked()
      expect(screen.queryByTestId("module-changes")).not.toBeInTheDocument()
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
    expect(mocks.error).not.toHaveBeenCalled()
    expect(screen.queryByTestId("apply-progress")).not.toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(
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
    expect(screen.getByTestId("always-on")).toHaveTextContent("Toujours actifs (8)")
    fireEvent.click(screen.getByRole("button", { name: "Afficher" }))
    expect(screen.getByTestId("module-content-model")).toHaveTextContent(
      "Types de contenu"
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
      toggle: "Turn Multilingual on or off",
    },
    {
      locale: "fr" as const,
      text: "Publiez votre site dans plusieurs langues.",
      toggle: "Activer ou désactiver Multilingue",
    },
  ])(
    "Multilingual has the same switch as other optional modules and no Languages link ($locale)",
    ({ locale, text, toggle }) => {
      mocks.useQuery.mockImplementation((_reference, args) => {
        if (args === "skip") return undefined
        return preview({ multilingualEnabled: true })
      })
      const view = renderSettings(locale)

      const row = screen.getByTestId("module-multilingual")
      expect(row).toHaveTextContent(text)
      expect(within(row).getByRole("checkbox", { name: toggle })).toBeChecked()
      expect(within(row).queryByRole("link")).not.toBeInTheDocument()
      view.unmount()

      mocks.useQuery.mockImplementation((_reference, args) => {
        if (args === "skip") return undefined
        return preview({ multilingualEnabled: false })
      })
      renderSettings(locale)
      const off = screen.getByTestId("module-multilingual")
      expect(within(off).getByRole("checkbox", { name: toggle })).not.toBeChecked()
      expect(within(off).queryByRole("link")).not.toBeInTheDocument()
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
      expect(screen.getByTestId("apply-progress")).toHaveAttribute("data-status", "noop")
      expect(screen.getByTestId("apply-step")).toHaveTextContent(
        "No changes to review."
      )
      expect(
        screen.getByRole("button", { name: "Apply reviewed changes" })
      ).toBeDisabled()
    }, { timeout: 3000 })
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100")
    expect(mocks.success).not.toHaveBeenCalled()
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
      expect(screen.getByTestId("apply-progress")).toHaveAttribute("data-status", "failed"),
      { timeout: 2000 }
    )
    expect(screen.getByTestId("apply-step")).toHaveTextContent(en.settings.modules.commitFailed)
    // The bar stops where the save failed: 1 of 3 steps.
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "33")
    expect(mocks.error).not.toHaveBeenCalled()
    // A refused (non-stale) Apply resets the draft, as before.
    expect(
      screen.getByRole("checkbox", { name: "Turn Redirects on or off" })
    ).not.toBeChecked()
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
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(en.settings.modules.stale))
  expect(screen.queryByTestId("apply-progress")).not.toBeInTheDocument()
  expect(mocks.error).not.toHaveBeenCalled()
  // The draft stays.
  expect(screen.getByRole("checkbox", { name: "Turn Redirects on or off" })).toBeChecked()
  expect(screen.getByTestId("module-changes")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: en.settings.modules.reviewAgain })).toBeInTheDocument()
})


describe("Rows show only on/off", () => {
  test("a row shows name, summary and the switch; offNote still renders in the review row", () => {
    // Multilingual on and AI on but not set up: the states that used to add a link or a setup line.
    mocks.useQuery.mockImplementation((_reference, args) => {
      if (args === "skip") return undefined
      const value = preview({
        multilingualEnabled: true,
        redirectsEnabled: args.changes.length === 0,
        changes: args.changes.length
          ? [{ moduleId: "redirects", fromEnabled: true, toEnabled: false }]
          : [],
      })
      return {
        ...value,
        readiness: value.readiness.map((entry) =>
          entry.moduleId === "ai" ? state("ai", true, true, "needs_setup", "required") : entry
        ),
      }
    })
    function OffNote() {
      return <p data-testid="redirects-off-note">Rules stay saved.</p>
    }
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ModulesSettings slots={{ redirects: { offNote: OffNote } }} />
      </NextIntlClientProvider>
    )

    for (const id of ["ai", "multilingual", "redirects"]) {
      const row = screen.getByTestId(`module-${id}`)
      expect(within(row).getAllByRole("checkbox")).toHaveLength(1)
      expect(within(row).queryByRole("link")).not.toBeInTheDocument()
      expect(within(row).queryByRole("button")).not.toBeInTheDocument()
    }
    expect(screen.getByTestId("module-ai")).toHaveTextContent(
      `${en.settings.modules.items.ai.name}${en.settings.modules.items.ai.summary}${en.settings.modules.enabled}`
    )
    expect(screen.queryByTestId("redirects-off-note")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("checkbox", { name: "Turn Redirects on or off" }))
    expect(
      within(screen.getByTestId("module-changes")).getByTestId("redirects-off-note")
    ).toBeInTheDocument()
  })
})

describe("Apply progress panel", () => {
  // Live module state: the commit flips it, as the reactive query would.
  let savedAi = false
  function aiLive(flipOnCommit: boolean) {
    savedAi = false
    mocks.useQuery.mockImplementation((_reference, args) => {
      if (args === "skip") return undefined
      const value = preview({})
      const aiOn = args.changes.length ? args.changes[0].enabled : savedAi
      return {
        ...value,
        changes: args.changes.length
          ? [{ moduleId: "ai", fromEnabled: savedAi, toEnabled: aiOn }]
          : [],
        readiness: value.readiness.map((entry) =>
          entry.moduleId === "ai" ? state("ai", aiOn) : entry
        ),
      }
    })
    mocks.commit.mockImplementation(async () => {
      if (flipOnCommit) savedAi = true
      return { ...preview({}), committed: true }
    })
  }
  async function wait(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("walks the real steps in order, each shown at least 400 ms, then ends with Close", async () => {
    aiLive(true)
    renderSettings()
    fireEvent.click(screen.getByRole("checkbox", { name: "Turn AI on or off" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }))

    const panel = screen.getByTestId("apply-progress")
    expect(panel).toHaveAttribute("role", "status")
    expect(screen.getByTestId("apply-title")).toHaveTextContent("Turning on AI")
    expect(screen.getByTestId("apply-step")).toHaveTextContent("Checking your changes…")
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0")
    for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeDisabled()

    await wait(399)
    expect(screen.getByTestId("apply-step")).toHaveTextContent("Checking your changes…")
    await wait(1)
    expect(screen.getByTestId("apply-step")).toHaveTextContent("Saving…")
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "33")
    await wait(400)
    expect(screen.getByTestId("apply-step")).toHaveTextContent("Turning on AI…")
    expect(screen.getByRole("checkbox", { name: "Turn AI on or off" })).toBeDisabled()
    await wait(400)
    expect(panel).toHaveAttribute("data-status", "done")
    expect(screen.getByTestId("apply-step")).toHaveTextContent("AI is on.")
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100")
    expect(screen.getByRole("checkbox", { name: "Turn AI on or off" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Turn AI on or off" })).toBeEnabled()
    expect(mocks.success).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(screen.queryByTestId("apply-progress")).not.toBeInTheDocument()
  })

  test("finishes after 5 s when the live state never shows the change", async () => {
    aiLive(false)
    renderSettings()
    fireEvent.click(screen.getByRole("checkbox", { name: "Turn AI on or off" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }))

    // Each act() turn flushes one state update; the next timer starts after it.
    await wait(400)
    await wait(400)
    expect(screen.getByTestId("apply-step")).toHaveTextContent("Turning on AI…")
    await wait(4000)
    expect(screen.getByTestId("apply-progress")).toHaveAttribute("data-status", "running")
    // The 5 s wait counts from the save (the commit settled at 400 ms here).
    await wait(1000)
    await wait(0)
    expect(screen.getByTestId("apply-progress")).toHaveAttribute("data-status", "done")
    expect(screen.getByTestId("apply-step")).toHaveTextContent("AI is on.")
  })
})
