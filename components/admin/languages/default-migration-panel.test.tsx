import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { ConvexError } from "convex/values"
import { NextIntlClientProvider } from "next-intl"
import { toast } from "sonner"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import en from "@/messages/admin/en.json"
import { OptionalContribution } from "../optional-contribution"
import {
  DefaultMigrationPanel,
  STALL_AFTER_MS,
} from "./default-migration-panel"
import type { DefaultMigration } from "./types"

vi.mock("../admin-module-state-provider", () => ({
  useModuleGate: () => ({ state: "on" }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const migration: DefaultMigration = {
  migrationId: "migration1" as Id<"siteDefaultLanguageMigrations">,
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
}

function renderPanel(overrides: Partial<DefaultMigration> = {}) {
  const actions = {
    continueDefaultLanguageMigration: vi.fn().mockResolvedValue(undefined),
    activateDefaultLanguageMigration: vi.fn().mockResolvedValue(undefined),
    cancelDefaultLanguageMigration: vi.fn().mockResolvedValue(undefined),
    recordDefaultMigrationReview: vi.fn().mockResolvedValue({ stale: false }),
  }
  const onFinished = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <input aria-label="Core draft" defaultValue="unsaved" />
      <div data-testid="contribution-host">
        <OptionalContribution
          moduleId="multilingual"
          slot="admin.language-add"
          fallbackText={en.shell.modulesUnavailable}
          finishSetup={{
            href: "/admin/settings/modules",
            label: en.settings.modules.title,
          }}
        >
          <DefaultMigrationPanel
            migration={{ ...migration, ...overrides }}
            authorityVersion={4}
            actions={actions}
            onFinished={onFinished}
            queries={{
              useDefaultRoutes: () => ({
                results: [],
                status: "Exhausted",
                loadMore: vi.fn(),
              }),
              useMigrationDisclosure: () => ({
                stale: false,
                ordinal: 0,
                pageCount: 1,
                section: "shadowed",
                items: [],
                digest: "reviewed-digest",
              }),
            }}
          />
        </OptionalContribution>
      </div>
    </NextIntlClientProvider>
  )
  return { actions, onFinished }
}

async function activate() {
  const button = screen.getByRole("button", {
    name: "Make Français the default",
  })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  await act(async () => {})
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test.each([
  "CMS_MODULE_DISABLED",
  "CMS_MODULE_NOT_READY",
  "injected command rejection",
])(
  "contained activation %s never reports success or finishes after completed receipts",
  async (code) => {
    const signal = vi.spyOn(console, "error").mockImplementation(() => {})
    const view = renderPanel()
    view.actions.activateDefaultLanguageMigration.mockRejectedValueOnce(
      code.startsWith("CMS_") ? new ConvexError(code) : new Error(code)
    )
    await activate()
    expect(view.actions.recordDefaultMigrationReview).toHaveBeenCalledWith({
      migrationId: migration.migrationId,
      expectedGeneration: 2,
      ordinal: 0,
      pageDigest: "reviewed-digest",
    })
    expect(view.actions.activateDefaultLanguageMigration).toHaveBeenCalledWith({
      migrationId: migration.migrationId,
      expectedGeneration: 2,
      expectedReadinessVersion: 7,
      expectedAuthorityVersion: 4,
    })
    expect(toast.success).not.toHaveBeenCalled()
    expect(view.onFinished).not.toHaveBeenCalled()
    expect(
      screen.queryByText(en.settings.multilingualLanguages.errors.stale)
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText("Core draft")).toHaveValue("unsaved")
    if (code === "CMS_MODULE_DISABLED") {
      expect(screen.getByTestId("contribution-host")).toBeEmptyDOMElement()
      expect(signal).not.toHaveBeenCalled()
    } else if (code === "CMS_MODULE_NOT_READY") {
      expect(
        screen.getByRole("link", { name: en.settings.modules.title })
      ).toHaveAttribute("href", "/admin/settings/modules")
      expect(signal).not.toHaveBeenCalled()
    } else {
      expect(screen.getByRole("alert")).toHaveTextContent(
        en.shell.modulesUnavailable
      )
      expect(signal).toHaveBeenCalledWith(
        expect.stringContaining("boundary=admin.contribution"),
        expect.anything()
      )
    }
  }
)

test("a stale receipt aborts before activation", async () => {
  const view = renderPanel()
  view.actions.recordDefaultMigrationReview.mockResolvedValueOnce({
    stale: true,
  })
  await activate()
  expect(view.actions.recordDefaultMigrationReview).toHaveBeenCalledOnce()
  expect(view.actions.activateDefaultLanguageMigration).not.toHaveBeenCalled()
  expect(toast.success).not.toHaveBeenCalled()
  expect(view.onFinished).not.toHaveBeenCalled()
  expect(screen.getByRole("alert")).toHaveTextContent(
    en.settings.multilingualLanguages.errors.stale
  )
})

test("successful void activation reports success and finishes after its receipt", async () => {
  const view = renderPanel()
  await activate()
  expect(view.actions.recordDefaultMigrationReview).toHaveBeenCalledOnce()
  expect(view.actions.activateDefaultLanguageMigration).toHaveBeenCalledOnce()
  expect(toast.success).toHaveBeenCalledWith("Français is now the default.")
  expect(view.onFinished).toHaveBeenCalledOnce()
})

test.each([undefined, null])(
  "successful Cancel result %s still reports success and finishes",
  async (result) => {
    const view = renderPanel()
    view.actions.cancelDefaultLanguageMigration.mockResolvedValueOnce(result)
    fireEvent.click(screen.getByRole("button", { name: "Stop this change" }))
    await act(async () => {})
    expect(toast.success).toHaveBeenCalledWith(
      en.settings.multilingualLanguages.migration.cancelled
    )
    expect(view.onFinished).toHaveBeenCalledOnce()
  }
)

test.each([undefined, null])(
  "successful Continue result %s still reports progress and unlocks",
  async (result) => {
    vi.useFakeTimers()
    const view = renderPanel({ phase: "enumerating", readinessVersion: null })
    view.actions.continueDefaultLanguageMigration.mockResolvedValueOnce(result)
    await act(async () => {
      vi.advanceTimersByTime(STALL_AFTER_MS)
    })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await act(async () => {})
    expect(toast.success).toHaveBeenCalledWith(
      en.settings.multilingualLanguages.migration.continued
    )
    // Continue keeps the review open; Cancel and activation finish it.
    expect(view.onFinished).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled()
  }
)
