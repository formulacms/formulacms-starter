import { fireEvent, screen, within } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"

import type { Id } from "@/convex/_generated/dataModel"
import type { Page, PrePublishChecklist } from "./page-editor/lib/types"

// FR2c row C (audit B9): the page editor offers no Scheduling. A page that
// still carries the `scheduledAt` / `expiresAt` compatibility fields opens
// without a Schedule command, menu item, dialog, or schedule badge.

const mocks = vi.hoisted(() => ({
  commandIds: [] as string[],
  convex: { query: vi.fn(async () => []) },
  enabledLocales: ["en"] as string[],
  checklist: {
    canPublish: true,
    blockers: [],
    warnings: [],
  } as PrePublishChecklist,
}))

vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useConvex: () => mocks.convex,
  useMutation: () =>
    vi.fn(async () => ({ status: "acquired", updatedAt: 101, generation: 1 })),
  useQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/owner:getOwnerSession") {
      return { ownerId: "owner-1", role: "admin" }
    }
    if (name === "cms/settings:getSiteConfig") {
      return {
        defaultLocale: "en",
        enabledLocales: mocks.enabledLocales,
        timezone: "UTC",
      }
    }
    if (name === "cms/pages:getPrePublishChecklist") {
      return mocks.checklist
    }
    if (name === "cms/pages:listActiveEditors") return []
    if (name === "cms/pages:getPageEditorLock") return { status: "available" }
    return undefined
  },
  useQueries: (queries: Record<string, unknown>) =>
    Object.keys(queries).length ? { checklist: mocks.checklist } : {},
}))

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}))

vi.mock("sonner", () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock("@/app/(core)/admin/(authenticated)/pages/actions", () => ({
  revalidatePagePaths: vi.fn(async () => undefined),
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => true),
}))

vi.mock("@/components/admin/command-palette", () => ({
  useRegisterAdminCommands: (commands: Array<{ id: string }>) => {
    if (commands.length > 0) {
      mocks.commandIds = commands.map((command) => command.id)
    }
  },
}))

vi.mock("./duplicate-page-dialog", () => ({ DuplicatePageDialog: () => null }))
vi.mock("./content-type-fields-panel", () => ({
  ContentTypeFieldsPanel: () => null,
}))
vi.mock("./page-editor/components/seo-panel", () => ({ SeoPanel: () => null }))
vi.mock("./page-editor/components/settings-panel", () => ({
  SettingsPanel: () => null,
}))
vi.mock("./page-editor/components/slices-panel", () => ({
  SlicesPanel: () => null,
}))

vi.mock("./contributions/history", () => ({
  ADMIN_HISTORY_BROWSER_BINDING: { PanelSlot: () => null },
}))

import { PageEditor } from "./page-editor"

const pageId = "page-1" as Id<"pages">
const FUTURE = Date.UTC(2099, 0, 1, 12, 0)

function page(status: Page["status"], extra: Partial<Page>): Page {
  return {
    _id: pageId,
    _creationTime: 1,
    slug: "about",
    localizedSlugs: {},
    pageType: "page",
    status,
    createdAt: 100,
    updatedAt: 100,
    content: { en: { title: "About", slices: [] } },
    tags: [],
    createdBy: "owner-1",
    ...extra,
  } as Page
}

function publication() {
  return {
    authority: "snapshot_active" as const,
    lifecycleGeneration: 3,
    sharedDraftGeneration: 4,
    locales: [
      {
        locale: "en",
        draftGeneration: 2,
        publicGeneration: 1,
        releaseGeneration: 1,
      },
    ],
  }
}

function expectNoScheduling() {
  expect(mocks.commandIds).toContain("page-editor:save")
  expect(mocks.commandIds).not.toContain("page-editor:schedule-publish")
  expect(document.getElementById("page-scheduled-at")).toBeNull()
  expect(screen.queryByText(/^Publishes /)).not.toBeInTheDocument()
  expect(screen.queryByText(/^Expires /)).not.toBeInTheDocument()

  const more = screen.getByRole("button", { name: "More page actions" })
  fireEvent.keyDown(more, { key: "Enter" })
  expect(screen.getByRole("menu")).toBeInTheDocument()
  expect(
    screen.queryByRole("menuitem", { name: /Schedule/ })
  ).not.toBeInTheDocument()
  expect(screen.queryByText("Publishing schedule")).not.toBeInTheDocument()
}

describe("PageEditor offers no Scheduling (FR2c row C)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.commandIds = []
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  test("a draft with a stored publish time shows no schedule controls", () => {
    const view = render(
      <PageEditor
        page={page("draft", { scheduledAt: FUTURE })}
        hasStaging={false}
        stagingUpdatedAt={undefined}
      />
    )
    expect(view.container.querySelector("div.overflow-y-auto.p-6")).toHaveClass(
      "motion-safe:scroll-smooth"
    )
    expectNoScheduling()
  })

  test("a published page with a stored expiry shows no schedule controls under snapshot authority", () => {
    render(
      <PageEditor
        page={page("published", { expiresAt: FUTURE })}
        hasStaging={false}
        stagingUpdatedAt={undefined}
        publication={publication()}
      />
    )
    expectNoScheduling()
  })
})

test("page editor navigation titles use the effective French dictionary", () => {
  render(
    <PageEditor
      page={page("draft", {})}
      hasStaging={false}
      stagingUpdatedAt={undefined}
    />,
    { locale: "fr" }
  )
  expect(screen.getByTitle("Contenu")).toBeInTheDocument()
  expect(screen.getByTitle("Référencement")).toBeInTheDocument()
  expect(screen.getByTitle("Paramètres")).toBeInTheDocument()
  expect(screen.getByTitle("Historique")).toBeInTheDocument()
  expect(screen.queryByTitle("History")).not.toBeInTheDocument()
  expect(screen.queryByTitle("Content")).not.toBeInTheDocument()
  expect(screen.queryByTitle("Settings")).not.toBeInTheDocument()
})

// The phone and desktop layouts share these controls. Exercise their semantic
// boundary here; actual viewport geometry belongs to browser verification.
describe("PageEditor shared header action semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.sessionStorage.clear()
    mocks.checklist = { canPublish: true, blockers: [], warnings: [] }
  })

  const cases = [
    {
      state: "clean draft",
      status: "draft",
      multilingual: false,
      staged: false,
      publishEnabled: false,
    },
    {
      state: "saved draft",
      status: "draft",
      multilingual: true,
      staged: true,
      publishEnabled: true,
    },
    {
      state: "published without changes",
      status: "published",
      multilingual: false,
      staged: false,
      publishEnabled: false,
    },
    {
      state: "published with changes",
      status: "published",
      multilingual: true,
      staged: true,
      publishEnabled: true,
    },
    {
      state: "archived",
      status: "archived",
      multilingual: true,
      staged: false,
      publishEnabled: false,
    },
    {
      state: "private replacement locale",
      status: "published",
      multilingual: false,
      staged: false,
      publishEnabled: false,
      privateDraft: true,
    },
    {
      state: "blocked saved draft",
      status: "draft",
      multilingual: true,
      staged: true,
      publishEnabled: false,
      blocked: true,
    },
  ] as const

  test.each(
    (["en", "fr"] as const).flatMap((locale) =>
      cases.map((scenario) => ({ ...scenario, locale }))
    )
  )(
    "retains named actions and lifecycle gates for $state in $locale",
    (scenario) => {
      const messages = scenario.locale === "fr" ? fr : en
      const copy = messages.editor.page
      const readiness = messages.editor.readiness
      const privateDraft = "privateDraft" in scenario
      const blocked = "blocked" in scenario
      mocks.enabledLocales = scenario.multilingual ? ["en", "fr"] : ["en"]
      if (blocked) {
        mocks.checklist = {
          canPublish: false,
          blockers: [
            {
              code: "broken_internal_link",
              severity: "blocker",
              message: "A linked page no longer exists.",
            },
          ],
          warnings: [],
        }
      }

      const view = render(
        <PageEditor
          page={page(scenario.status, {
            content: {
              en: { title: "About", slices: [] },
              fr: { title: "À propos", slices: [] },
            },
          })}
          hasStaging={scenario.staged}
          stagingUpdatedAt={scenario.staged ? 100 : undefined}
          publication={publication()}
          targetDraftLocale={privateDraft ? "fr" : undefined}
        />,
        { locale: scenario.locale }
      )
      const header = within(view.container.querySelector("header")!)
      function singleAction(name: string) {
        const actions = header.getAllByRole("button", { name })
        expect(actions).toHaveLength(1)
        return actions[0]!
      }

      singleAction(privateDraft ? copy.backToLanguageChange : copy.backToPages)
      const save = singleAction(copy.save)
      expect(save).toBeDisabled()
      if (privateDraft) {
        expect(
          header.queryByRole("button", { name: copy.preview })
        ).not.toBeInTheDocument()
        expect(
          header.queryByRole("button", { name: copy.moreActions })
        ).not.toBeInTheDocument()
      } else {
        expect(singleAction(copy.preview)).toBeEnabled()
      }

      const publishName =
        scenario.status === "published" ? copy.publishChanges : copy.publish
      if (privateDraft || scenario.status === "archived") {
        expect(
          header.queryByRole("button", { name: copy.publish })
        ).not.toBeInTheDocument()
        expect(
          header.queryByRole("button", {
            name: copy.publishChanges,
          })
        ).not.toBeInTheDocument()
      } else {
        const publish = singleAction(publishName)
        if (scenario.publishEnabled) expect(publish).toBeEnabled()
        else expect(publish).toBeDisabled()
      }
      if (scenario.status === "archived") {
        expect(singleAction(copy.unarchive)).toBeEnabled()
        expect(
          header.queryByRole("button", { name: copy.moreActions })
        ).not.toBeInTheDocument()
      } else {
        expect(
          header.queryByRole("button", { name: copy.unarchive })
        ).not.toBeInTheDocument()
      }

      if (scenario.multilingual) {
        const tabs = within(
          header.getByRole("tablist", {
            name: messages.common.localeTabs.label,
          })
        )
        expect(tabs.getAllByRole("tab")).toHaveLength(2)
        expect(
          tabs.getByRole("tab", {
            name:
              scenario.locale === "fr"
                ? "EN — Modifier en English"
                : "EN — Edit English",
          })
        ).toHaveAttribute("aria-selected", String(scenario.locale === "en"))
        // The editor opens on the interface language when it is a site language.
        expect(
          tabs.getByRole("tab", {
            name:
              scenario.locale === "fr"
                ? "FR — Modifier en Français"
                : "FR — Edit Français",
          })
        ).toHaveAttribute("aria-selected", String(scenario.locale === "fr"))
      } else {
        expect(header.queryByRole("tablist")).not.toBeInTheDocument()
      }

      const readinessState = privateDraft
        ? readiness.checkingShort
        : blocked
          ? scenario.locale === "fr"
            ? "1 blocage"
            : "1 blocker"
          : readiness.readyShort
      const report = singleAction(`${readiness.title}: ${readinessState}`)
      fireEvent.click(report)
      expect(screen.getByText(readiness.description)).toBeInTheDocument()
      expect(
        screen.getByText(
          privateDraft ? readiness.checking : readiness.reportHint
        )
      ).toBeInTheDocument()
      fireEvent.click(report)

      // Editing still enables Save; blockers and private-locale isolation survive
      // the same transition that makes an ordinary draft publishable.
      fireEvent.change(header.getByRole("textbox", { name: copy.pageTitle }), {
        target: { value: "Edited title" },
      })
      expect(save).toBeEnabled()
      if (!privateDraft && scenario.status !== "archived") {
        if (blocked) expect(singleAction(publishName)).toBeDisabled()
        else expect(singleAction(publishName)).toBeEnabled()

        fireEvent.keyDown(singleAction(copy.moreActions), { key: "Enter" })
        expect(
          screen.getByRole("menuitem", { name: copy.archive })
        ).toBeEnabled()
        if (scenario.status === "published") {
          expect(
            screen.getByRole("menuitem", { name: copy.unpublish })
          ).toBeEnabled()
        } else {
          expect(
            screen.queryByRole("menuitem", {
              name: copy.unpublish,
            })
          ).not.toBeInTheDocument()
        }
      }
    }
  )
})
