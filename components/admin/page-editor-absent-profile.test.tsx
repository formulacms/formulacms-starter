import type { ReactNode } from "react"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

import type { Id } from "@/convex/_generated/dataModel"
import type { Slice } from "@/convex/lib/slices"
import type { Page, PrePublishChecklist } from "./page-editor/lib/types"

const owner = {
  ownerId: "owner-1",
  authId: "owner-auth-1",
  email: "owner@example.com",
  role: "admin" as const,
}

const mocks = vi.hoisted(() => ({
  actionNames: [] as string[],
  commandIds: [] as string[],
  confirm: vi.fn(async () => true),
  error: vi.fn(),
  latestChecklist: {
    canPublish: true,
    blockers: [],
    warnings: [
      {
        code: "missing_seo_title",
        severity: "warning",
        message: "Add an SEO title.",
        locales: ["en"],
      },
    ],
  } as PrePublishChecklist,
  convex: {
    query: vi.fn(async (reference: unknown) => {
      if (
        getFunctionName(reference as never) ===
        "cms/pages:getPrePublishChecklist"
      ) {
        return mocks.latestChecklist
      }
      return []
    }),
  },
  mutation: vi.fn(async () => ({ status: "acquired", updatedAt: 101 })),
  languageNotice: null as unknown,
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
  push: vi.fn(),
  queryNames: [] as string[],
  refresh: vi.fn(),
  replace: vi.fn(),
  success: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useAction: (reference: unknown) => {
    mocks.actionNames.push(getFunctionName(reference as never))
    return vi.fn()
  },
  useConvex: () => mocks.convex,
  useMutation: () => mocks.mutation,
  useQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    mocks.queryNames.push(name)
    if (name === "cms/owner:getOwnerSession") return owner
    if (name === "cms/settings:getSiteConfig") {
      return {
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        timezone: "UTC",
      }
    }
    if (name === "cms/pages:getPrePublishChecklist") {
      return {
        canPublish: true,
        blockers: [],
        warnings: [
          {
            code: "missing_seo_title",
            severity: "warning",
            message: "Add an SEO title.",
            locales: ["en"],
          },
        ],
      }
    }
    if (name === "cms/language:getSourcePublicationNotice") {
      return mocks.languageNotice
    }
    if (name === "cms/pages:listActiveEditors") return []
    if (name === "cms/pages:getPageEditorLock") {
      return { status: "available" }
    }
    return undefined
  },
  useQueries: (queries: Record<string, unknown>) =>
    Object.keys(queries).length
      ? {
          checklist: {
            canPublish: true,
            blockers: [],
            warnings: [
              {
                code: "missing_seo_title",
                severity: "warning",
                message: "Add an SEO title.",
                locales: ["en"],
              },
            ],
          },
        }
      : {},
}))

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  useRouter: () => ({
    push: mocks.push,
    refresh: mocks.refresh,
    replace: mocks.replace,
  }),
}))

vi.mock("sonner", () => ({
  toast: {
    dismiss: vi.fn(),
    error: mocks.error,
    loading: vi.fn(),
    message: vi.fn(),
    success: mocks.success,
  },
}))

vi.mock("@/app/(core)/admin/(authenticated)/pages/actions", () => ({
  revalidatePagePaths: vi.fn(async () => undefined),
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
}))

vi.mock("@/components/admin/command-palette", () => ({
  useRegisterAdminCommands: (commands: Array<{ id: string }>) => {
    if (commands.length > 0) {
      mocks.commandIds = commands.map((command) => command.id)
    }
  },
}))

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("./duplicate-page-dialog", () => ({
  DuplicatePageDialog: () => null,
}))

vi.mock("./content-type-fields-panel", () => ({
  ContentTypeFieldsPanel: () => null,
}))

vi.mock("./page-editor/components/seo-panel", () => ({
  SeoPanel: () => null,
}))

vi.mock("./page-editor/components/settings-panel", () => ({
  SettingsPanel: () => null,
}))

vi.mock("./page-editor/components/slices-panel", () => ({
  SlicesPanel: ({ slices }: { slices: Slice[] }) => (
    <output data-testid="page-editor-slices">{JSON.stringify(slices)}</output>
  ),
}))

import { PageEditor } from "./page-editor"

const pageId = "page-1" as Id<"pages">

function bodySlice(id: string, body: string): Slice {
  return {
    id,
    type: "rich-text-body",
    enabled: true,
    primary: { body },
  } as Slice
}

function localizedPage(): Page {
  return {
    _id: pageId,
    _creationTime: 1,
    slug: "english-title",
    localizedSlugs: { fr: "titre-francais" },
    pageType: "page",
    status: "draft",
    createdAt: 100,
    updatedAt: 100,
    content: {
      en: {
        title: "English title",
        slices: [bodySlice("slice-en", "English body")],
      },
      fr: {
        title: "Titre Français",
        slices: [bodySlice("slice-fr", "Corps Français")],
      },
    },
    tags: [],
    createdBy: "owner-1",
  } as Page
}

function renderEditor() {
  return render(
    <PageEditor
      page={localizedPage()}
      hasStaging={false}
      stagingUpdatedAt={undefined}
    />
  )
}

describe("PageEditor all-off admin profile", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.actionNames.length = 0
    mocks.commandIds.length = 0
    mocks.queryNames.length = 0
    mocks.languageNotice = null
    mocks.latestChecklist = {
      canPublish: true,
      blockers: [],
      warnings: [
        {
          code: "missing_seo_title",
          severity: "warning",
          message: "Add an SEO title.",
          locales: ["en"],
        },
      ],
    }
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  test("opens no AI work, offers Review SEO, and omits uninstalled History", () => {
    renderEditor()

    expect(screen.getByRole("button", { name: "Review SEO" })).toBeEnabled()
    expect(
      screen.queryByRole("button", { name: "Generate SEO suggestion" })
    ).not.toBeInTheDocument()
    expect(screen.queryByTitle("History")).not.toBeInTheDocument()
    expect(screen.queryByText("Revision history")).not.toBeInTheDocument()

    expect(mocks.commandIds).toEqual(
      expect.arrayContaining(["page-editor:save", "page-editor:insert-slice"])
    )
    expect(mocks.commandIds).not.toContain("page-editor:history")
    expect(mocks.queryNames).not.toContain("cms/ai:isConfigured")
    expect(mocks.queryNames).not.toContain("cms/agents:getContentPresets")
    expect(mocks.actionNames).not.toContain(
      "agents/localizer:translateRichText"
    )
  })

  test("pulls another locale through the page-level Copy host", async () => {
    renderEditor()

    expect(screen.getByTitle("Copy content between locales")).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: /Copy from FR/i }))

    await waitFor(() => {
      expect(screen.getByLabelText("Page title")).toHaveValue("Titre Français")
    })
    expect(screen.getByTestId("page-editor-slices")).toHaveTextContent(
      "Corps Français"
    )
    expect(mocks.success).toHaveBeenCalledWith(
      "Copied FR content — review and save"
    )
  })

  test("pushes the active locale through the page-level Copy host", async () => {
    renderEditor()

    fireEvent.click(
      screen.getByRole("button", {
        name: "Send EN to another locale",
      })
    )
    fireEvent.click(screen.getByRole("button", { name: /EN.*FR/i }))

    await waitFor(() => {
      expect(screen.getByTitle("Français")).toHaveAttribute(
        "aria-selected",
        "true"
      )
      expect(mocks.success).toHaveBeenCalledWith(
        "Copied EN content — review and save"
      )
    })
    expect(screen.getByLabelText("Page title")).toHaveValue("English title")
    expect(screen.getByTestId("page-editor-slices")).toHaveTextContent(
      "English body"
    )
  })

  // F09 contract proof row 39 through the real publish path.
  test("warns before a source publication during a language replacement and stops when the owner declines", async () => {
    mocks.languageNotice = {
      sourceLocale: "en",
      targetLocale: "fr",
      sharedChangedSinceSourcePublication: true,
    }
    mocks.confirm.mockResolvedValueOnce(false)
    render(
      <PageEditor
        page={localizedPage()}
        hasStaging
        stagingUpdatedAt={100}
        publication={{
          authority: "snapshot_active",
          lifecycleGeneration: 1,
          sharedDraftGeneration: 2,
          locales: [
            {
              locale: "en",
              draftGeneration: 1,
              publicGeneration: 0,
              releaseGeneration: 0,
            },
          ],
        }}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Publish" }))

    await waitFor(() => {
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Publish while your site changes language?",
          confirmText: "Publish anyway",
        })
      )
    })
    // Declining stops before the checklist warning and before publication.
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.mutation).not.toHaveBeenCalledWith(
      expect.objectContaining({ expectedReleaseGeneration: 0 })
    )
  })

  test("uses a fresh checklist and blocks a missing public locale", async () => {
    mocks.latestChecklist = {
      canPublish: false,
      blockers: [
        {
          code: "archived_relation_target",
          severity: "blocker",
          message: '"Dr. Ada" isn\'t published in FR.',
          field: "authorIds[0]",
          locales: ["fr"],
        },
      ],
      warnings: [],
    }
    render(
      <PageEditor page={localizedPage()} hasStaging stagingUpdatedAt={100} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Publish" }))

    await waitFor(() => {
      expect(mocks.error).toHaveBeenCalledWith(
        "Resolve 1 blocker before publishing"
      )
    })
    expect(mocks.convex.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locale: "en" })
    )
    expect(mocks.confirm).not.toHaveBeenCalled()
  })
})
