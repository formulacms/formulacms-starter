import { sliceProfile } from "@/test-utils/slice-profile"
import { StrictMode } from "react"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import type { Slice } from "@/convex/lib/slices"
import type { Page } from "./page-editor/lib/types"
import { readPageDraftHandoff } from "./page-editor/lib/page-draft-handoff"

const owner = {
  ownerId: "owner-1",
  authId: "owner-auth-1",
  email: "owner@example.com",
  role: "admin" as const,
}

const mocks = vi.hoisted(() => ({
  createPage: vi.fn(),
  defaultMutation: vi.fn(async () => ({ status: "acquired" })),
  error: vi.fn(),
  push: vi.fn(),
  query: vi.fn(async () => []),
  refresh: vi.fn(),
  success: vi.fn(),
  updateDraft: vi.fn(),
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: mocks.query }),
  useMutation: mocks.useMutation,
  usePaginatedQuery: () => ({
    loadMore: vi.fn(),
    results: [],
    status: "Exhausted",
  }),
  useQuery: mocks.useQuery,
  useQueries: (queries: Record<string, unknown>) =>
    Object.keys(queries).length
      ? { checklist: { canPublish: true, blockers: [], warnings: [] } }
      : {},
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
    refresh: mocks.refresh,
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("sonner", () => ({
  toast: {
    dismiss: vi.fn(),
    error: mocks.error,
    loading: vi.fn(),
    success: mocks.success,
  },
}))

vi.mock("@/app/(core)/admin/(authenticated)/pages/actions", () => ({
  revalidatePagePaths: vi.fn(async () => undefined),
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => true),
}))

vi.mock("./command-palette", () => ({
  useRegisterAdminCommands: vi.fn(),
}))

vi.mock("./duplicate-page-dialog", () => ({
  DuplicatePageDialog: () => null,
}))

vi.mock("./locale-tabs", () => ({
  LocaleTabs: () => null,
}))

vi.mock("./content-type-fields-panel", () => ({
  ContentTypeFieldsPanel: () => null,
}))

vi.mock("./page-editor/components/pre-publish-checklist", () => ({
  PrePublishChecklistContent: () => null,
}))

vi.mock("./page-editor/components/page-readiness", () => ({
  PageReadinessTrigger: () => null,
}))

vi.mock("./page-editor/components/transfer-popover-content", () => ({
  TransferPopoverContent: () => null,
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

import { NewPageForm } from "./new-page-form"
import { PageEditor } from "./page-editor"

const pageId = "page-1" as Id<"pages">

function emptyImportedPage(): Page {
  return {
    _id: pageId,
    _creationTime: 1,
    slug: "imported-page",
    pageType: "page",
    status: "draft",
    createdAt: 100,
    updatedAt: 100,
    content: {
      en: {
        title: "Imported page",
        slices: [],
      },
    },
    tags: [],
    createdBy: "owner-1",
  } as Page
}

describe("Markdown import draft handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.sessionStorage.clear()
    mocks.createPage.mockResolvedValue(pageId)
    mocks.updateDraft.mockResolvedValue({ updatedAt: 101 })
    mocks.useMutation.mockImplementation((reference) => {
      const name = getFunctionName(reference)
      if (name === "cms/pages:create") return mocks.createPage
      if (name === "cms/pages:updateDraft") return mocks.updateDraft
      return mocks.defaultMutation
    })
    mocks.useQuery.mockImplementation((reference) => {
      const name = getFunctionName(reference)
      if (name === "cms/owner:getOwnerSession") return owner
      if (name === "cms/settings:getSiteConfig") {
        return {
          defaultLocale: "en",
          enabledLocales: ["en"],
          timezone: "UTC",
        }
      }
      if (name.endsWith("getArchivedContentTypes")) return []
      return undefined
    })
  })

  test("opens the editor with imported Markdown as an unsaved one-shot draft", sliceProfile(["rich-text-body"]), async () => {
    const newPage = render(<NewPageForm />)

    expect(screen.getByRole("button", { name: "Import .md" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "Import .md" }))

    expect(
      screen.getByRole("dialog", { name: "Import Markdown" })
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Or paste Markdown"), {
      target: {
        value: "# Imported page\n\nImported body survives the route change.",
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Import as draft" }))

    await waitFor(() => expect(mocks.createPage).toHaveBeenCalledOnce())
    expect(mocks.createPage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Imported page",
        content: {
          en: {
            title: "Imported page",
            slices: [],
          },
        },
      })
    )
    expect(mocks.push).toHaveBeenCalledWith(`/admin/pages/${pageId}`)

    const stashed = readPageDraftHandoff(pageId)
    expect(stashed?.slices).toEqual([
      expect.objectContaining({
        type: "rich-text-body",
        primary: {
          body: expect.stringContaining("Imported body survives"),
        },
      }),
    ])

    newPage.unmount()
    render(
      <StrictMode>
        <PageEditor
          page={emptyImportedPage()}
          hasStaging={false}
          stagingUpdatedAt={undefined}
        />
      </StrictMode>
    )

    expect(screen.getByTestId("page-editor-slices")).toHaveTextContent(
      "Imported body survives the route change."
    )
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    await waitFor(() => expect(readPageDraftHandoff(pageId)).toBeNull())

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mocks.updateDraft).toHaveBeenCalledOnce())
    expect(mocks.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          en: expect.objectContaining({
            slices: [
              expect.objectContaining({
                type: "rich-text-body",
                primary: {
                  body: expect.stringContaining("Imported body survives"),
                },
              }),
            ],
          }),
        },
      })
    )
  })
})
