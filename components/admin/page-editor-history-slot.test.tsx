import { convexTest } from "@/convexTestWithExplicitAdmin"
import schema from "@/convex/schema"
import { api } from "@/convex/_generated/api"
import { sliceProfile } from "@/test-utils/slice-profile"
import {
  stashPageDraftHandoff,
  readPageDraftHandoff,
} from "./page-editor/lib/page-draft-handoff"
import * as pageSaveHook from "./page-editor/hooks/use-page-save"
import type { PageSaveDraft } from "./page-editor/hooks/use-page-save"
import * as titleAdoption from "@/lib/rich-text/adopt-hero-titles"
import * as legacyParser from "@/lib/rich-text/legacy-html"
import type { AdminAiTranslationHostProps } from "./contributions/ai-translation"
import { mergeSliceText } from "./slice-editor-text"
import { sliceDefs } from "@/convex/lib/slices"
import { PreviewInlineEditor } from "./preview-inline-editor"
import type { Editor } from "@tiptap/core"
import { PageLivePreviewCanvas } from "./page-live-preview-canvas"
import {
  createLiveFrameController,
  type LiveFrameBridge,
  type LiveFrameCallbacks,
  type LiveFrameInput,
} from "./live-preview-frame-bridge"
import type {
  PreviewActiveEditHandle,
  PreviewInlineEditCommit,
} from "./visual-editing-types"
import { validateStrict } from "@/convex/lib/richtext/strict"
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { Component, Profiler, type ReactNode } from "react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { ConvexError } from "convex/values"
import { toast } from "sonner"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"

import type { Id } from "@/convex/_generated/dataModel"
import type { AdminPageHistoryHostProps } from "./contributions/history"
import type { Page } from "./page-editor/lib/types"
import type { Slice } from "@/convex/lib/slices"
import { capturePageField } from "./page-editor/lib/page-inline-draft"
import {
  readRecoveryDraft,
  writeRecoveryDraft,
  recoveryKey,
} from "./page-editor/lib/recovery"
import { createSampleSlice } from "@/lib/slices/sample"
import type { SlicesPanel } from "./page-editor/components/slices-panel"

// FR2c row H: the core editor reaches History only through the
// `admin.page-history` binding. With a participant bound, the editor offers
// the History tab and command and mounts the participant's panel.

const mocks = vi.hoisted(() => ({
  localeTabs: null as
    Parameters<typeof import("./locale-tabs").LocaleTabs>[0] | null,
  transfer: null as
    | Parameters<
        typeof import("./page-editor/components/transfer-popover-content").TransferPopoverContent
      >[0]
    | null,
  translation: null as AdminAiTranslationHostProps | null,
  commandIds: [] as string[],
  historyInstalled: true,
  queryNames: [] as string[],
  checklistRequests: [] as Array<{ name: string; args: unknown }>,
  snapshotRestore: vi.fn(),
  saveDraft: vi.fn(),
  createPage: vi.fn(async () => "copy-page" as Id<"pages">),
  legacyDraft: vi.fn(async () => ({ updatedAt: 101 })),
  targetSave: vi.fn(),
  sharedSave: vi.fn(),
  archivePage: vi.fn(async () => ({ lifecycleGeneration: 4 })),
  softDeletePage: vi.fn(async () => ({ lifecycleGeneration: 4 })),
  restorePage: vi.fn(async () => ({ lifecycleGeneration: 4 })),
  withdrawLocale: vi.fn(async () => null),
  discardLocale: vi.fn(async () => ({ generation: 6 })),
  updateAdapter: vi.fn(async () => ({ updatedAt: 101 })),
  strictWrites: false,
  unlistedWrite: vi.fn((name: string) => {
    throw new Error(`Unlisted mutation: ${name}`)
  }),
  confirm: vi.fn<(options?: unknown) => Promise<boolean>>(async () => true),
  publish: vi.fn<(args?: unknown) => Promise<unknown>>(async () => ({
    updatedAt: 101,
    generation: 1,
    status: "acquired",
  })),
  deleteTarget: vi.fn<(args?: unknown) => Promise<unknown>>(async () => ({
    generation: 8,
  })),
  retainedTargetRemedy: null as unknown,
  seoProps: null as
    | Parameters<
        typeof import("./page-editor/components/seo-panel").SeoPanel
      >[0]
    | null,
  checklistResult: { canPublish: true, blockers: [], warnings: [] } as unknown,
  convex: {
    query: vi.fn<(reference?: unknown) => Promise<unknown>>(async () => []),
  },
  refresh: vi.fn(),
  slotProps: [] as AdminPageHistoryHostProps[],
  enabledLocales: ["en"] as string[],
  sliceProps: [] as Parameters<typeof SlicesPanel>[0][],
  realSidebar: false,
  addressHarness: false,
  addressQuery: null as ((args: unknown) => unknown) | null,
  settingsProps: null as
    | Parameters<
        typeof import("./page-editor/components/settings-panel").SettingsPanel
      >[0]
    | null,
  addressRequests: [] as { locale: string; slug: string; intent: string }[],
}))

class TestErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

vi.mock("./locale-tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./locale-tabs")>()
  return {
    LocaleTabs: (props: Parameters<typeof actual.LocaleTabs>[0]) => {
      mocks.localeTabs = props
      return <actual.LocaleTabs {...props} />
    },
  }
})
vi.mock(
  "./page-editor/components/transfer-popover-content",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("./page-editor/components/transfer-popover-content")
      >()
    return {
      TransferPopoverContent: (
        props: Parameters<typeof actual.TransferPopoverContent>[0]
      ) => {
        mocks.transfer = props
        return <actual.TransferPopoverContent {...props} />
      },
    }
  }
)

vi.mock("./contributions/ai-translation", () => ({
  ADMIN_AI_TRANSLATION_BROWSER_BINDING: (
    props: AdminAiTranslationHostProps
  ) => {
    mocks.translation = props
    return props.children({
      fieldTranslate: undefined,
      busy: false,
      command: null,
      control: null,
      setTranslateOpen() {},
      runPushedTranslate() {},
    })
  },
}))

vi.mock("./contributions/history", () => ({
  get ADMIN_HISTORY_BROWSER_BINDING() {
    return mocks.historyInstalled
      ? {
          PanelSlot: (props: AdminPageHistoryHostProps) => {
            mocks.slotProps.push(props)
            return <p>History participant</p>
          },
        }
      : null
  },
}))

vi.mock(
  "./page-editor/components/snapshot-history-panel",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("./page-editor/components/snapshot-history-panel")
      >()
    return {
      SnapshotHistoryPanelSlot: (props: AdminPageHistoryHostProps) => {
        mocks.slotProps.push(props)
        return <actual.SnapshotHistoryPanelSlot {...props} />
      },
    }
  }
)

vi.mock("convex/react", () => ({
  useQuery_experimental: () => ({ status: "success", data: [] }),
  useAction: () => vi.fn(),
  useConvex: () => mocks.convex,
  useMutation: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/publication:restoreSnapshotAsDraft")
      return mocks.snapshotRestore
    if (name === "cms/publication:saveEditorDraft") return mocks.saveDraft
    if (name === "cms/pages:updateDraft") return mocks.legacyDraft
    if (name === "cms/pages:create") return mocks.createPage
    if (name === "cms/publication:saveLocaleDraft") return mocks.targetSave
    if (name === "cms/publication:saveSharedDraft") return mocks.sharedSave
    if (name === "cms/publication:publishLocale") return mocks.publish
    if (name === "cms/publication:archivePage") return mocks.archivePage
    if (name === "cms/publication:softDeletePage") return mocks.softDeletePage
    if (name === "cms/publication:restorePage") return mocks.restorePage
    if (name === "cms/publication:withdrawLocale") return mocks.withdrawLocale
    if (name === "cms/publication:discardLocaleDraft")
      return mocks.discardLocale
    if (name === "cms/pages:update") return mocks.updateAdapter
    if (name === "cms/language:deleteRetainedTargetDraft")
      return mocks.deleteTarget
    // Presence and lease maintenance are the only non-content writes allowed
    // by the clean cutover test. An unlisted write must also remain observable
    // if the editor catches the mock's error.
    if (
      ![
        "cms/pages:heartbeatPageEditor",
        "cms/pages:leavePagePresence",
        "cms/pages:acquirePageEditorLock",
        "cms/pages:releasePageEditorLock",
      ].includes(name)
    )
      return vi.fn(async () => {
        if (mocks.strictWrites) return mocks.unlistedWrite(name)
        return { status: "acquired", updatedAt: 101, generation: 1 }
      })
    return vi.fn(async () => ({
      status: "acquired",
      updatedAt: 101,
      generation: 1,
    }))
  },
  useQuery: (reference: unknown, args?: unknown) => {
    const name = getFunctionName(reference as never)
    mocks.queryNames.push(name)
    if (name === "cms/publication:addressAvailability" && mocks.addressQuery)
      return mocks.addressQuery(args)
    if (
      name === "cms/publication:addressAvailability" &&
      mocks.addressHarness &&
      args !== "skip"
    ) {
      const input = args as { locale: string; slug: string; intent: string }
      mocks.addressRequests.push({ ...input })
      return {
        parentChanged: false,
        entries: [
          {
            locale: input.locale,
            changed: false,
            check: {
              kind: "free",
              locale: input.locale,
              path: `/${input.slug}`,
            },
            ...(input.slug === "contact-2"
              ? {
                  allocation: {
                    wantedSlug: "contact",
                    allocatedSlug: "contact-2",
                    newPath: "/contact-2",
                    check: {
                      kind: "taken",
                      locale: input.locale,
                      path: "/contact",
                      holder: {
                        pageId: "other-contact",
                        pageType: "page",
                        title: "Occupied Contact",
                      },
                    },
                  },
                }
              : {}),
          },
        ],
      }
    }
    if (name === "cms/publication:listSnapshotHistory")
      return [
        {
          snapshotId: "snapshot-1",
          generation: 1,
          publishedAt: 100,
          unavailablePaths: [],
        },
      ]
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
      if (mocks.checklistResult instanceof Error) throw mocks.checklistResult
      return mocks.checklistResult
    }
    if (name === "cms/language:getRetainedTargetDraftRemedy")
      return mocks.retainedTargetRemedy
    if (name === "cms/pages:listActiveEditors") return []
    if (name === "cms/pages:getPageEditorLock") return { status: "available" }
    return undefined
  },
  useQueries: (queries: Record<string, { query: unknown; args: unknown }>) => {
    const [key] = Object.keys(queries)
    if (!key) return {}
    const request = queries[key]!
    const name = getFunctionName(request.query as never)
    mocks.queryNames.push(name)
    mocks.checklistRequests.push({ name, args: request.args })
    return { [key]: mocks.checklistResult }
  },
}))

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  useRouter: () => ({
    push: vi.fn(),
    refresh: mocks.refresh,
    replace: vi.fn(),
  }),
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
  useConfirm: () => mocks.confirm,
  usePrompt: () => vi.fn(async () => null),
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
vi.mock("./page-editor/components/seo-panel", () => ({
  SeoPanel: (
    props: Parameters<
      typeof import("./page-editor/components/seo-panel").SeoPanel
    >[0]
  ) => {
    mocks.seoProps = props
    return null
  },
}))
vi.mock("./page-editor/components/settings-panel", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./page-editor/components/settings-panel")
    >()
  return {
    SettingsPanel: (props: Parameters<typeof actual.SettingsPanel>[0]) => {
      mocks.settingsProps = props
      return mocks.strictWrites || mocks.addressHarness ? (
        <actual.SettingsPanel {...props} />
      ) : null
    },
  }
})
vi.mock("./page-live-preview", () => ({ PageLivePreview: () => null }))
vi.mock("./page-editor/components/slices-panel", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./page-editor/components/slices-panel")
    >()
  return {
    SlicesPanel: (props: Parameters<typeof SlicesPanel>[0]) => {
      mocks.sliceProps.push(props)
      // R1 mounts the real sidebar under the real PageEditor publication wiring.
      return mocks.realSidebar ? (
        <actual.SlicesPanel {...props} />
      ) : (
        <div data-testid="slice-panel" />
      )
    },
  }
})

import { PageEditor } from "./page-editor"

const pageId = "page-1" as Id<"pages">

function page(): Page {
  return {
    _id: pageId,
    _creationTime: 1,
    slug: "about",
    localizedSlugs: {},
    pageType: "page",
    status: "draft",
    createdAt: 100,
    updatedAt: 100,
    content: { en: { title: "About", slices: [] } },
    tags: [],
    createdBy: "owner-1",
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

describe("PageEditor with a bound History participant (FR2c row H)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.commandIds = []
    mocks.historyInstalled = true
    mocks.queryNames.length = 0
    mocks.checklistRequests.length = 0
    mocks.saveDraft.mockReset().mockResolvedValue({
      updatedAt: 101,
      draftGeneration: 3,
      sharedDraftGeneration: 4,
    })
    mocks.snapshotRestore.mockResolvedValue({
      locale: "en",
      draftGeneration: 3,
      sharedDraftGeneration: 5,
      updatedAt: 500,
    })
    mocks.slotProps.length = 0
    mocks.sliceProps.length = 0
    mocks.checklistResult = { canPublish: true, blockers: [], warnings: [] }
    mocks.enabledLocales = ["en"]
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  test(
    "a newer preview action cancels a pending form-field focus",
    sliceProfile([]),
    () => {
      const slice = {
        ...createSampleSlice("hero-with-image"),
        id: "slice_focus",
      }
      const withSlice = page()
      withSlice.content = { en: { title: "About", slices: [slice] } }
      render(
        <PageEditor
          page={withSlice}
          hasStaging={false}
          stagingUpdatedAt={undefined}
          publication={publication()}
        />
      )
      const current = () => mocks.sliceProps.at(-1)!
      const target = { sliceId: slice.id, fieldPath: "primary.eyebrow" }
      const pending = () => {
        act(() => current().onPreviewSelectField(target))
        expect(current().focusedFieldTarget).toMatchObject(target)
      }

      pending()
      act(() => current().onPreviewSelectField(target, { status: "activated" }))
      expect(current().focusedFieldTarget).toBeNull()

      pending()
      act(() => current().onPreviewSelectSlice(slice.id))
      expect(current().focusedFieldTarget).toBeNull()

      pending()
      act(() => current().onPreviewSelectSliceFallback(slice.id))
      expect(current().focusedFieldTarget).toBeNull()
    }
  )

  test(
    "NEW Unit A wires preview Save to the actual Page save handler and keeps keyboard Save",
    sliceProfile([]),
    async () => {
      render(
        <PageEditor
          page={page()}
          hasStaging={false}
          stagingUpdatedAt={undefined}
          publication={publication()}
        />
      )
      act(() => mocks.sliceProps.at(-1)!.onSave())
      expect(mocks.saveDraft).not.toHaveBeenCalled()
      fireEvent.change(screen.getByDisplayValue("About"), {
        target: { value: "Preview Save title" },
      })
      await act(async () => mocks.sliceProps.at(-1)!.onSave())
      await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledOnce())
      expect(mocks.saveDraft.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          pageId,
          localized: expect.objectContaining({
            locale: "en",
            draft: expect.objectContaining({
              localized: expect.objectContaining({
                title: "Preview Save title",
              }),
            }),
          }),
        })
      )
      fireEvent.change(screen.getByDisplayValue("Preview Save title"), {
        target: { value: "Keyboard Save title" },
      })
      fireEvent.keyDown(window, { key: "s", ctrlKey: true })
      await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledTimes(2))
      expect(mocks.saveDraft.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          localized: expect.objectContaining({
            locale: "en",
            draft: expect.objectContaining({
              localized: expect.objectContaining({
                title: "Keyboard Save title",
              }),
            }),
          }),
        })
      )
    }
  )

  test(
    "offers History and mounts the participant panel with the host inputs",
    sliceProfile([]),
    () => {
      render(
        <PageEditor
          page={page()}
          hasStaging={false}
          stagingUpdatedAt={undefined}
        />
      )

      expect(mocks.commandIds).toContain("page-editor:history")
      expect(screen.queryByText("History participant")).not.toBeInTheDocument()

      fireEvent.click(screen.getByTitle("History"))

      expect(screen.getByText("History participant")).toBeInTheDocument()
      const props = mocks.slotProps.at(-1)!
      expect(props.pageId).toBe(pageId)
      expect(props.restoreBlocked).toBe(false)

      props.onRestored(500)
      expect(mocks.refresh).toHaveBeenCalledOnce()
    }
  )

  test(
    "NEW checklist read errors stay local while the draft and preview panel host remain mounted",
    sliceProfile([]),
    async () => {
      const view = render(
        <TestErrorBoundary fallback={<p>Admin page failed.</p>}>
          <PageEditor
            page={page()}
            hasStaging={false}
            stagingUpdatedAt={undefined}
          />
        </TestErrorBoundary>
      )

      const title = screen.getByLabelText("Page title")
      fireEvent.change(title, { target: { value: "Unsaved page title" } })
      expect(title).toHaveValue("Unsaved page title")
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
      const previewPanel = screen.getByTestId("slice-panel")

      mocks.checklistResult = new Error("private checklist diagnostic")
      view.rerender(
        <TestErrorBoundary fallback={<p>Admin page failed.</p>}>
          <PageEditor
            page={page()}
            hasStaging={false}
            stagingUpdatedAt={undefined}
          />
        </TestErrorBoundary>
      )

      expect(screen.getByLabelText("Page title")).toHaveValue(
        "Unsaved page title"
      )
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
      expect(screen.getByTestId("slice-panel")).toBe(previewPanel)
      fireEvent.click(
        screen.getByRole("button", { name: "Page readiness: Unavailable" })
      )
      expect(screen.getByRole("alert")).toHaveTextContent(
        "We couldn’t check this page. You can keep editing."
      )
      expect(
        screen.queryByText("private checklist diagnostic")
      ).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled()
      expect(screen.queryByText("Ready to publish")).not.toBeInTheDocument()

      const originalRequest = mocks.checklistRequests[0]!
      mocks.checklistResult = { canPublish: true, blockers: [], warnings: [] }
      fireEvent.click(screen.getByRole("button", { name: "Try again" }))
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Page readiness: Ready" })
        ).toBeInTheDocument()
      )
      expect(mocks.checklistRequests.at(-1)).toEqual(originalRequest)
      expect(screen.getByLabelText("Page title")).toHaveValue(
        "Unsaved page title"
      )
      expect(screen.getByTestId("slice-panel")).toBe(previewPanel)
    }
  )

  test(
    "core snapshot restore is reachable with M06 absent and never opens legacy history",
    sliceProfile([]),
    async () => {
      mocks.historyInstalled = false
      render(
        <PageEditor
          page={page()}
          hasStaging={false}
          publication={publication()}
          stagingUpdatedAt={undefined}
        />
      )
      expect(mocks.commandIds).toContain("page-editor:history")
      fireEvent.click(screen.getByTitle("History"))
      expect(screen.getByText("Published version 1")).toBeInTheDocument()
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Restore draft" }))
      )
      expect(mocks.snapshotRestore).toHaveBeenCalledWith({
        pageId,
        snapshotId: "snapshot-1",
        locale: "en",
        expectedDraftGeneration: 2,
        expectedSharedDraftGeneration: 4,
        expectedLifecycleGeneration: 3,
        expectedPublicGeneration: 1,
        expectedReleaseGeneration: 1,
      })
      expect(mocks.refresh).toHaveBeenCalledOnce()
      expect(mocks.queryNames).toContain("cms/publication:listSnapshotHistory")
      expect(
        mocks.queryNames.some((name) => name.startsWith("cms/pageHistory:"))
      ).toBe(false)
      expect(screen.queryByText("History participant")).not.toBeInTheDocument()
    }
  )

  test(
    "supplies the language to the History participant and the generations only through the base getter",
    sliceProfile([]),
    () => {
      render(
        <PageEditor
          page={page()}
          hasStaging={false}
          stagingUpdatedAt={undefined}
          publication={publication()}
        />
      )

      fireEvent.click(screen.getByTitle("History"))

      expect(mocks.slotProps.at(-1)!.snapshotRestore).toEqual({ locale: "en" })
      expect(mocks.slotProps.at(-1)!.readSnapshotRestore!()).toEqual({
        expectedDraftGeneration: 2,
        expectedSharedDraftGeneration: 4,
        expectedLifecycleGeneration: 3,
        expectedPublicGeneration: 1,
        expectedReleaseGeneration: 1,
      })
    }
  )
  test(
    "loads restored draft values only after the refreshed generations arrive",
    sliceProfile([]),
    () => {
      const original = page(),
        current = publication()
      const view = render(
        <PageEditor
          page={original}
          hasStaging={false}
          stagingUpdatedAt={undefined}
          publication={current}
        />
      )
      fireEvent.click(screen.getByTitle("History"))
      act(() => {
        mocks.slotProps.at(-1)!.onSnapshotRestored!({
          locale: "en",
          draftGeneration: 3,
          sharedDraftGeneration: 5,
        })
      })
      expect(screen.getByDisplayValue("About")).toBeInTheDocument()
      view.rerender(
        <PageEditor
          page={
            {
              ...original,
              content: { en: { title: "Restored English", slices: [] } },
            } as Page
          }
          hasStaging
          publication={{
            ...current,
            sharedDraftGeneration: 5,
            locales: [{ ...current.locales[0]!, draftGeneration: 3 }],
          }}
          stagingUpdatedAt={undefined}
        />
      )
      expect(screen.getByDisplayValue("Restored English")).toBeInTheDocument()
      expect(screen.queryByDisplayValue("About")).not.toBeInTheDocument()
    }
  )
})

const pmB1 = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text,
            marks: [
              { type: "bold" },
              { type: "link", attrs: { href: "https://example.invalid/" } },
            ],
          },
          { type: "hardBreak" },
          { type: "text", text: "tail" },
        ],
      },
    ],
  })
function b1Page(repeated = false) {
  const slice = {
    ...createSampleSlice(repeated ? "features-icon-grid" : "hero-agency"),
    id: "b1-slice",
  }
  const source = {
    ...page(),
    content: {
      en: { title: "About", slices: [slice] },
      fr: { title: "Français", slices: [] },
    },
  } as Page
  const view = render(
    <PageEditor
      page={source}
      hasStaging={false}
      stagingUpdatedAt={undefined}
      publication={publication()}
    />
  )
  const current = () => mocks.sliceProps.at(-1)!
  const binding = () =>
    capturePageField(
      current().slices,
      current().currentLocale,
      slice.id,
      repeated ? "items.0.body" : "primary.description",
      current().contentEpoch ?? 0,
      current().presentationCatalog?.revision ?? ""
    )!
  return { view, slice, source, current, binding }
}
describe("ED10 R1 parent publication", () => {
  const doc = (text: string) =>
    JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    })
  const current = () => mocks.sliceProps.at(-1)!
  const description = () => {
    const slice = current().slices.find((item) => item.id === "ed10-first")!
    if (!("description" in slice.primary))
      throw new Error("Description fixture missing")
    return slice.primary.description
  }
  const rangeRects = {
    getClientRects: Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getClientRects"
    ),
    getBoundingClientRect: Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getBoundingClientRect"
    ),
  }
  beforeAll(() => {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [new DOMRect()],
    })
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    })
  })
  afterAll(() => {
    for (const [key, descriptor] of Object.entries(rangeRects)) {
      if (descriptor) Object.defineProperty(Range.prototype, key, descriptor)
      else Reflect.deleteProperty(Range.prototype, key)
    }
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sliceProps.length = 0
    mocks.enabledLocales = ["en"]
    window.sessionStorage.clear()
    window.localStorage.clear()
  })
  async function setup() {
    mocks.realSidebar = true
    const sample = createSampleSlice("hero-agency")
    const slices = ["ed10-first", "ed10-second", "ed10-third"].map((id) => ({
      ...sample,
      id,
      primary: { ...sample.primary, description: doc("Copy") },
    })) as Slice[]
    const commits = vi.fn()
    const view = render(
      <Profiler id="ed10-parent" onRender={commits}>
        <PageEditor
          page={
            { ...page(), content: { en: { title: "About", slices } } } as Page
          }
          hasStaging={false}
          stagingUpdatedAt={undefined}
          publication={publication()}
        />
      </Profiler>
    )
    fireEvent.click(
      screen.getAllByRole("button", { name: /Hero Agency.*1/ })[0]!
    )
    const sidebar = (await screen.findByRole("textbox", {
      name: "Description",
    })) as HTMLElement & { editor: Editor }
    return { view, sidebar, editor: sidebar.editor, commits }
  }
  async function island() {
    const snapshot = current()
    const input: LiveFrameInput = {
      sessionId: "ed10-session",
      pageId: "ed10-page",
      buildId: "ed10-build",
      pageType: "page",
      locale: "en",
      defaultLocale: "en",
      languageVersion: 0,
      title: "Preview",
      slices: snapshot.slices,
      contentEpoch: snapshot.contentEpoch,
      catalogRevision: snapshot.presentationCatalog?.revision,
      selectedSliceId: null,
      inlineEditingEnabled: true,
      mode: "light",
      ordering: {
        draftRevision: snapshot.draftRevision!,
        inputRevision: 0,
        generation: "ed10-frame",
      },
    }
    const conflict = vi.fn(snapshot.onPreviewActiveEditConflict)
    const controller = createLiveFrameController(input, {
      selectSlice() {},
      selectField() {},
      save() {},
      unavailable() {},
      context() {},
      commit: snapshot.onPreviewInlineEditCommit,
      change: (commit) => snapshot.onPreviewActiveEditChange?.(commit),
      conflict,
      draftRevision: snapshot.getDraftRevision,
    })
    let callbacks!: LiveFrameCallbacks
    let handle: PreviewActiveEditHandle | null = null
    const deliveries: LiveFrameInput[] = []
    const bridge: LiveFrameBridge = {
      ...input,
      generation: "ed10-frame",
      connect: (_input, next) => {
        callbacks = next
        return true
      },
      // Hold publication before the iframe processes it, as in production.
      replaceInput: (next) => {
        deliveries.push(next)
        return true
      },
      disconnect() {},
      acceptCapture() {},
      capture: () => handle?.capture() ?? null,
      acknowledgeDraftRevision() {},
      flush: () => handle?.flush?.(),
      isComposing: () => handle?.isComposing() ?? false,
      hasActiveSession: () => handle?.hasActiveSession() ?? false,
    }
    expect(controller.connect(bridge)).toBe(true)
    const bind = (commit: PreviewInlineEditCommit) => ({
      ...commit,
      frameBinding: {
        sessionId: input.sessionId,
        pageId: input.pageId,
        generation: bridge.generation,
        buildId: input.buildId,
        languageVersion: input.languageVersion,
      },
    })
    const frame = render(
      <PageLivePreviewCanvas
        title="Preview"
        slices={input.slices}
        locale="en"
        defaultLocale="en"
        contentEpoch={input.contentEpoch}
        selectedSliceId={null}
        controlledInlineEnabled
        renderContext={{
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          presentationCatalog: snapshot.presentationCatalog,
        }}
        onSelectSlice={() => {}}
        onSelectField={() => {}}
        onInlineEditCommit={(commit) => callbacks.commit(bind(commit))}
        onActiveEditChange={(commit) =>
          callbacks.change(commit ? bind(commit) : null)
        }
        onActiveEditConflict={() => callbacks.conflict()}
        onActiveEditHandleChange={(next) => {
          handle = next
        }}
      />
    )
    fireEvent.click(
      frame.container.querySelector(
        '[data-preview-field="primary.description"]'
      )!
    )
    const host = (await within(frame.container).findByRole(
      "textbox"
    )) as HTMLElement & { editor: Editor }
    return {
      frame,
      host,
      editor: host.editor,
      conflict,
      handle: () => handle,
      deliveries,
      publish: () =>
        controller.replaceInput({
          ...input,
          slices: current().slices,
          ordering: {
            draftRevision: current().draftRevision!,
            inputRevision: 1,
            generation: bridge.generation,
          },
        }),
    }
  }
  test(
    "ED10 R1 single-document model of iframe order publishes DefaultLane draft before the first sidebar input task",
    sliceProfile([]),
    async () => {
      const { view, editor, commits } = await setup()
      const child = await island()
      act(() =>
        child.editor.commands.setTextSelection(
          child.editor.state.doc.content.size - 1
        )
      )
      const runtime = globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean
      }
      const previous = runtime.IS_REACT_ACT_ENVIRONMENT
      const order: string[] = []
      // The mounted canvas listener is document capture; this observer records
      // that phase before the body listener. Separate roots model the iframe
      // order in a single document.
      const canvasFocus = () => {
        order.push("canvas document capture")
      }
      document.addEventListener("focusin", canvasFocus, true)
      try {
        runtime.IS_REACT_ACT_ENVIRONMENT = false
        const revision = current().draftRevision!
        const epoch = current().contentEpoch
        child.editor.commands.insertContent(" island")
        expect(current().getDraftRevision!()).toBe(revision + 1)
        // Deliberately outside act and outside any event: DefaultLane, not transition.
        expect(editor.getJSON()).toEqual(JSON.parse(doc("Copy")))
        expect(current().draftRevision).toBe(revision)
        // Native focusin only: TipTap's separate focus transaction must not
        // incidentally promote the queued parent update in this renderer model.
        screen
          .getByRole("button", { name: "Move Hero Agency 1 down" })
          .dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
        expect(order).toEqual(["canvas document capture"])
        expect(child.handle()?.hasActiveSession()).toBe(false)
        expect(editor.getJSON()).toEqual(JSON.parse(doc("Copy")))
        await new Promise<void>((resolve) => queueMicrotask(resolve))
        // No Scheduler task or act drain has run before this assertion.
        expect(editor.getJSON()).toEqual(JSON.parse(doc("Copy island")))
        expect(current().draftRevision).toBe(revision + 1)
        expect(current().getDraftRevision!()).toBe(revision + 1)
        expect(current().contentEpoch).toBe(epoch)
        editor.commands.setTextSelection(editor.state.doc.content.size - 1)
        editor.commands.insertContent(" /")
        await act(async () => {})
        expect(description()).toBe(doc("Copy island /"))
        expect(current().inlineEditingBlocked).toBe(false)
        expect(toast.error).not.toHaveBeenCalled()
        commits.mockClear()
        screen
          .getByRole("button", { name: "Move Hero Agency 1 down" })
          .dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
        await new Promise<void>((resolve) => queueMicrotask(resolve))
        // Eager bailout may call components; quiescent focus needs no commit.
        expect(commits).not.toHaveBeenCalled()
      } finally {
        runtime.IS_REACT_ACT_ENVIRONMENT = previous
        document.removeEventListener("focusin", canvasFocus, true)
        child.frame.unmount()
        view.unmount()
        mocks.realSidebar = false
      }
    }
  )
  test(
    "ED10 R1 keyboard-focused sidebar reorder restores focus without a lifecycle flushSync warning",
    sliceProfile([]),
    async () => {
      const { view } = await setup()
      const errors = vi.spyOn(console, "error")
      try {
        const down = screen.getByRole("button", {
          name: "Move Hero Agency 1 down",
        })
        act(() => down.focus())
        await act(async () => {})
        const restoreFocus = vi.spyOn(down, "focus")
        fireEvent.click(down, { detail: 0 })
        await act(async () => {})
        expect(current().slices.map((slice) => slice.id)).toEqual([
          "ed10-second",
          "ed10-first",
          "ed10-third",
        ])
        expect(document.activeElement).toBe(down)
        expect(restoreFocus).toHaveBeenCalled()
        restoreFocus.mockRestore()
        expect(errors).not.toHaveBeenCalled()
      } finally {
        errors.mockRestore()
        view.unmount()
        mocks.realSidebar = false
      }
    }
  )
  test(
    "ED10 R1 deferred composition B survives sidebar input before held iframe publication",
    sliceProfile([]),
    async () => {
      const parent = await setup()
      const child = await island()
      // Tiptap focuses a mounted island one animation frame later. Let that
      // focus land before the sidebar takes focus, as it does for a person.
      await waitFor(() => expect(document.activeElement).toBe(child.host))
      const runtime = globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean
      }
      const previous = runtime.IS_REACT_ACT_ENVIRONMENT
      const deferred: Array<() => void> = []
      const originalTimeout = globalThis.setTimeout
      const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: TimerHandler,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (delay === 0 && typeof callback === "function") {
          deferred.push(() => callback(...args))
          return 0 as unknown as ReturnType<typeof setTimeout>
        }
        return originalTimeout(callback, delay, ...args)
      }) as typeof setTimeout)
      try {
        act(() => {
          child.editor.commands.setTextSelection(
            child.editor.state.doc.content.size - 1
          )
          child.editor.commands.insertContent(" A")
        })
        fireEvent.compositionStart(child.host)
        act(() => parent.sidebar.focus())
        await act(async () => {})
        expect(parent.editor.getText()).toBe("Copy A")
        expect(child.handle()?.hasActiveSession()).toBe(true)
        expect(document.activeElement).toBe(parent.sidebar)
        fireEvent.compositionEnd(child.host)
        expect(deferred.length).toBeGreaterThan(0)
        runtime.IS_REACT_ACT_ENVIRONMENT = false
        // Native composition settlement accepts B after focus published A.
        // Plain code, no event/transition priority, and child input still held.
        child.editor.commands.insertContent(" B")
        expect(parent.editor.getText()).toBe("Copy A")
        await new Promise<void>((resolve) => queueMicrotask(resolve))
        parent.editor.commands.setTextSelection(
          parent.editor.state.doc.content.size - 1
        )
        parent.editor.commands.insertContent(" /")
        await act(async () => {})
        expect(child.publish()).toBe(true)
        expect(child.deliveries).toHaveLength(1)
        // Finish before the iframe consumes that publication. Unchanged B must
        // not erase the only surviving recovery buffer after an A+input write.
        act(() => {
          for (const finish of deferred.splice(0)) finish()
        })
        expect(child.handle()?.hasActiveSession()).toBe(false)
        expect(description()).toBe(doc("Copy A B /"))
        expect(child.conflict).not.toHaveBeenCalled()
        expect(current().inlineEditingBlocked).toBe(false)
      } finally {
        runtime.IS_REACT_ACT_ENVIRONMENT = previous
        timers.mockRestore()
        child.frame.unmount()
        parent.view.unmount()
        mocks.realSidebar = false
      }
    }
  )
})

describe("B1 real Page consumer replacement safety", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sliceProps.length = 0
    mocks.enabledLocales = ["en", "fr"]
    mocks.saveDraft.mockReset().mockResolvedValue({
      updatedAt: 101,
      draftGeneration: 3,
      sharedDraftGeneration: 4,
    })
    window.sessionStorage.clear()
    window.localStorage.clear()
  })
  test(
    "NEW R1 PageEditor pairs each draft snapshot with its revision and acknowledges accepted writes synchronously across locales",
    sliceProfile([]),
    () => {
      const view = b1Page()
      const snapshot = view.current()
      const revision = snapshot.draftRevision!
      const originalSlices = snapshot.slices
      act(() => {
        expect(
          snapshot.onPreviewInlineEditCommit({
            ...view.binding(),
            value: pmB1("Accepted revision"),
          })
        ).toBe(true)
        expect(snapshot.getDraftRevision!()).toBe(revision + 1)
        // A captured render keeps the revision of its exact content, even before React renders the accepted write.
        expect(snapshot.draftRevision).toBe(revision)
        expect(snapshot.slices).toBe(originalSlices)
      })
      expect(view.current().draftRevision).toBe(revision + 1)
      expect(view.current().slices).not.toBe(originalSlices)
      fireEvent.change(screen.getByDisplayValue("About"), {
        target: { value: "Sidebar revision" },
      })
      expect(view.current().draftRevision).toBe(revision + 2)
      act(() =>
        view.current().onSlicesChange(
          view.current().slices.map((slice) => ({
            ...slice,
            primary: { ...slice.primary, eyebrow: "Other field" },
          })) as Slice[]
        )
      )
      expect(view.current().draftRevision).toBe(revision + 3)
      fireEvent.click(screen.getByRole("tab", { name: /français/i }))
      const frenchRevision = view.current().draftRevision!
      expect(frenchRevision).toBeGreaterThan(revision + 3)
      fireEvent.click(screen.getByRole("tab", { name: /english/i }))
      expect(view.current().draftRevision).toBeGreaterThan(frenchRevision)
      const beforeRefusal = view.current().draftRevision!
      act(() =>
        expect(
          view.current().onPreviewInlineEditCommit({
            ...view.binding(),
            locale: "fr",
            value: pmB1("Rejected"),
          })
        ).toBe(false)
      )
      expect(view.current().draftRevision).toBe(beforeRefusal)
      expect(view.current().getDraftRevision!()).toBe(beforeRefusal)
    }
  )
  test(
    "NEW Order1.4 saves active inline parent values without any frame capture and keyboard repeats run once",
    sliceProfile([]),
    async () => {
      const view = b1Page()
      expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled()
      const capture = vi.fn(() => null)
      const value = pmB1("inline latest")
      act(() => {
        view.current().onPreviewActiveEditHandleChange!({
          capture,
          acceptCapture() {},
          isComposing: () => false,
          hasActiveSession: () => true,
        })
        expect(
          view.current().onPreviewInlineEditCommit({ ...view.binding(), value })
        ).toBe(true)
      })
      expect(mocks.saveDraft).not.toHaveBeenCalled()
      fireEvent.keyDown(window, { key: "s", ctrlKey: true })
      fireEvent.keyDown(window, { key: "s", ctrlKey: true, repeat: true })
      await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledOnce())
      expect(capture).not.toHaveBeenCalled()
      expect(
        mocks.saveDraft.mock.calls[0][0].localized.draft.slices[0].primary
          .description
      ).toBe(value)
      expect(
        (view.current().slices[0].primary as Record<string, unknown>)
          .description
      ).toBe(value)
    }
  )
  test(
    "NEW Save and locale switch refuse composing input but leave exact parent work intact",
    sliceProfile([]),
    async () => {
      const view = b1Page()
      const value = pmB1("composing parent")
      act(() => {
        view.current().onPreviewInlineEditCommit({ ...view.binding(), value })
        view.current().onPreviewActiveEditHandleChange!({
          capture: () => null,
          acceptCapture() {},
          isComposing: () => true,
          hasActiveSession: () => true,
        })
      })
      await act(async () => view.current().onSave())
      fireEvent.click(screen.getByRole("tab", { name: /français/i }))
      expect(view.current().currentLocale).toBe("en")
      expect(mocks.saveDraft).not.toHaveBeenCalled()
      expect(
        (view.current().slices[0].primary as Record<string, unknown>)
          .description
      ).toBe(value)
    }
  )
  test(
    "NEW B-C0 preserves manual sidebar work and exact inline JSON through frame loss and locale return",
    sliceProfile([]),
    () => {
      const view = b1Page()
      const value = pmB1("retained parent")
      act(() =>
        view.current().onPreviewInlineEditCommit({ ...view.binding(), value })
      )
      fireEvent.change(screen.getByDisplayValue("About"), {
        target: { value: "Manual parent title" },
      })
      act(() => view.current().onPreviewActiveEditHandleChange!(null))
      expect(screen.queryByRole("button", { name: /^Restore$/ })).toBeNull()
      fireEvent.click(screen.getByRole("tab", { name: /français/i }))
      fireEvent.click(screen.getByRole("tab", { name: /english/i }))
      expect(
        (view.current().slices[0].primary as Record<string, unknown>)
          .description
      ).toBe(value)
      expect(
        screen.getByDisplayValue("Manual parent title")
      ).toBeInTheDocument()
    }
  )
  test(
    "NEW R2/Order1.5 retains formatted incompatible data through full Page reload, refusing Restore and Save",
    sliceProfile([]),
    async () => {
      const view = b1Page()
      const pending = {
        ...view.binding(),
        value: pmB1("formatted incompatible"),
      }
      act(() => {
        view.current().onPreviewActiveEditChange!(pending)
        view.current().onPreviewActiveEditConflict!()
      })
      expect(screen.getByRole("textbox", { name: "Pending text" })).toHaveValue(
        pending.value
      )
      act(() => window.dispatchEvent(new Event("pagehide")))
      const recovered = readRecoveryDraft(view.source._id, "en")!
      expect(recovered.inlineConflicts?.[0].value).toBe(pending.value)
      view.view.unmount()
      const reloaded = readRecoveryDraft(view.source._id, "en")!
      const fresh = b1Page()
      const restore = screen.getByRole("button", { name: /^Restore$/ })
      fireEvent.click(restore)
      expect(screen.getByRole("textbox", { name: "Pending text" })).toHaveValue(
        JSON.stringify(reloaded)
      )
      await act(async () => fresh.current().onSave())
      expect(mocks.saveDraft).not.toHaveBeenCalled()
      expect(fresh.current().slices).toEqual([fresh.slice])
    }
  )
  test(
    "NEW unrelated sidebar fields keep the structural epoch and allow the next inline intent",
    sliceProfile([]),
    () => {
      const view = b1Page()
      const binding = view.binding()
      const epoch = view.current().contentEpoch
      const next = view.current().slices.map(
        (slice) =>
          ({
            ...slice,
            primary: { ...slice.primary, eyebrow: "sidebar" },
          }) as Slice
      )
      act(() => view.current().onSlicesChange(next))
      expect(view.current().contentEpoch).toBe(epoch)
      act(() =>
        expect(
          view.current().onPreviewInlineEditCommit({
            ...binding,
            value: pmB1("inline after sidebar"),
          })
        ).toBe(true)
      )
      expect(
        (view.current().slices[0].primary as Record<string, unknown>).eyebrow
      ).toBe("sidebar")
    }
  )
  test(
    "NEW repeated equal-valued reorder increments the epoch and refuses stale targets with exact copyable data",
    sliceProfile([]),
    () => {
      const view = b1Page(true)
      const slice = view.slice as Extract<Slice, { type: "features-icon-grid" }>
      const equal = {
        ...slice,
        items: [0, 1, 2].map(() => ({ ...slice.items[0] })),
      }
      act(() => view.current().onSlicesChange([equal]))
      const binding = view.binding(),
        epoch = view.current().contentEpoch!
      const next = [{ ...equal, items: [...equal.items].reverse() }]
      act(() => view.current().onSlicesChange(next))
      expect(view.current().contentEpoch).toBe(epoch + 1)
      const pending = { ...binding, value: pmB1("stale repeated") }
      act(() => {
        expect(view.current().onPreviewInlineEditCommit(pending)).toBe(false)
        view.current().onPreviewActiveEditChange!(pending)
        view.current().onPreviewActiveEditConflict!()
      })
      expect(view.current().slices).toEqual(next)
      expect(screen.getByRole("textbox", { name: "Pending text" })).toHaveValue(
        pending.value
      )
      const discardActiveEdit = vi.fn()
      act(() =>
        view.current().onPreviewActiveEditHandleChange!({
          capture: () => pending,
          acceptCapture() {},
          isComposing: () => false,
          hasActiveSession: () => true,
          discardActiveEdit,
        })
      )
      fireEvent.click(screen.getByRole("button", { name: /^Discard$/ }))
      expect(discardActiveEdit).toHaveBeenCalledTimes(1)
      expect(view.current().slices).toEqual(next)
      expect(view.current().inlineEditingBlocked).toBe(false)
    }
  )
})

describe("D2 R1 actual-consumer diagnostics", () => {
  // Match the existing real-preview DOM harness; jsdom has no Range geometry.
  const rangeRects = {
    getClientRects: Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getClientRects"
    ),
    getBoundingClientRect: Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getBoundingClientRect"
    ),
  }
  beforeAll(() => {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [new DOMRect()],
    })
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    })
  })
  afterAll(() => {
    for (const [key, descriptor] of Object.entries(rangeRects)) {
      if (descriptor) Object.defineProperty(Range.prototype, key, descriptor)
      else Reflect.deleteProperty(Range.prototype, key)
    }
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sliceProps.length = 0
    mocks.enabledLocales = ["en", "fr"]
    mocks.translation = null
    mocks.saveDraft.mockResolvedValue({
      updatedAt: 101,
      draftGeneration: 3,
      sharedDraftGeneration: 4,
    })
    window.sessionStorage.clear()
    window.localStorage.clear()
  })
  test.each([
    "source copy",
    "AI merge",
    "inline PM",
    "HTML href",
    "HTML page-id",
    "locale cache",
  ] as const)(
    "retains both located reports through %s → parent → recovery/Save",
    sliceProfile([]),
    async (mode) => {
      const heroes = ["first", "second"].map((id) => ({
        ...createSampleSlice("hero-with-image"),
        id,
      }))
      const original = heroes.map((slice, i) => ({
        ...slice,
        primary: {
          ...slice.primary,
          title: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: i ? "Second" : "First",
                    marks: [{ type: "link", attrs: { href: `/${slice.id}` } }],
                  },
                ],
              },
            ],
          }),
        },
      }))
      const source = {
        ...page(),
        content: {
          en: { title: "About", slices: heroes },
          fr: { title: "Français", slices: heroes },
        },
      } as Page
      const view = render(
        <PageEditor
          page={source}
          hasStaging={false}
          stagingUpdatedAt={undefined}
          publication={publication()}
          aiTranslationRouteData={
            { mechanicalTranslation: {}, brandTranslation: {} } as never
          }
        />
      )
      const current = () => mocks.sliceProps.at(-1)!
      let reportLocale = "en"
      if (mode === "locale cache") {
        reportLocale = "fr"
        const draft = mocks.translation!.readSourceContent("fr")
        const canonical = original.map((slice, i) => ({
          ...slice,
          primary: {
            ...slice.primary,
            title: JSON.stringify({
              type: "doc",
              content: [
                {
                  type: "heading",
                  attrs: { level: 2 },
                  content: [{ type: "text", text: i ? "Second" : "First" }],
                },
              ],
            }),
          },
        }))
        act(() =>
          mocks.translation!.storeDraft("fr", {
            ...draft,
            slices: canonical,
            removedTitleLinks: heroes.map((slice) => ({
              locale: "fr",
              sliceId: slice.id,
              fieldPath: "primary.title",
              removedLinks: [{ href: `/${slice.id}` }],
            })),
          })
        )
        fireEvent.click(screen.getByRole("tab", { name: /français/i }))
      } else if (mode === "inline PM") {
        for (const slice of original) {
          const binding = capturePageField(
            current().slices,
            "en",
            slice.id,
            "primary.title",
            current().contentEpoch ?? 0,
            current().presentationCatalog?.revision ?? ""
          )!
          let flush: (() => void) | null = null
          const inline = render(
            <PreviewInlineEditor
              value={slice.primary.title}
              contract="title"
              fieldPath="primary.title"
              label="Title"
              onChange={(value, removedLinks) => {
                expect(
                  current().onPreviewInlineEditCommit({
                    ...binding,
                    value,
                    removedLinks,
                  })
                ).toBe(true)
              }}
              onCancel={() => {}}
              onCommit={() => {}}
              onCompositionChange={() => {}}
              onFlushHandleChange={(value) => {
                flush = value
              }}
            />
          )
          await waitFor(() => expect(flush).not.toBeNull())
          act(() => flush!())
          inline.unmount()
        }
      } else {
        const incoming = original.map((slice, i) =>
          mode === "source copy" || mode === "AI merge"
            ? mergeSliceText(
                heroes[i],
                slice,
                sliceDefs["hero-with-image"].primary,
                mode === "source copy" ? "copy" : "write"
              )
            : {
                ...slice,
                primary: {
                  ...slice.primary,
                  title:
                    mode === "HTML page-id"
                      ? `<p><a data-page-id="${slice.id}-page">${i ? "Second" : "First"}</a></p>`
                      : `<p><a href="/${slice.id}">${i ? "Second" : "First"}</a></p>`,
                },
              }
        )
        act(() => current().onSlicesChange(incoming as Slice[]))
      }
      for (const slice of current().slices) {
        expect(slice.type).toBe("hero-with-image")
        if (slice.type === "hero-with-image")
          expect(validateStrict("title", slice.primary.title)).toEqual({
            ok: true,
          })
      }
      act(() => window.dispatchEvent(new Event("pagehide")))
      const recovery = readRecoveryDraft(source._id, reportLocale)!
      const reports = heroes.map((slice) => ({
        locale: reportLocale,
        sliceId: slice.id,
        fieldPath: "primary.title",
        removedLinks: [
          mode === "HTML page-id"
            ? { pageId: `${slice.id}-page` }
            : { href: `/${slice.id}` },
        ],
      }))
      expect(recovery.removedTitleLinks).toEqual(
        expect.arrayContaining(reports)
      )
      expect(
        recovery.slices.map((slice) =>
          slice.type === "hero-with-image"
            ? JSON.parse(slice.primary.title).content[0].content[0].text
            : ""
        )
      ).toEqual(["First", "Second"])
      await act(async () => current().onSave())
      expect(mocks.saveDraft).toHaveBeenCalled()
      const saved = mocks.saveDraft.mock.calls.at(-1)![0]
      expect(
        saved.localized.draft.slices.map((slice: Slice) =>
          slice.type === "hero-with-image" ? slice.primary.title : ""
        )
      ).toEqual(
        recovery.slices.map((slice) =>
          slice.type === "hero-with-image" ? slice.primary.title : ""
        )
      )
      // Locale-cache restore must not discard reports already attached to canonical values.
      fireEvent.click(
        screen.getByRole("tab", {
          name: reportLocale === "en" ? /français/i : /english/i,
        })
      )
      fireEvent.click(
        screen.getByRole("tab", {
          name: reportLocale === "en" ? /english/i : /français/i,
        })
      )
      fireEvent.change(
        screen.getByDisplayValue(reportLocale === "en" ? "About" : "Français"),
        { target: { value: "After cache restore" } }
      )
      act(() => window.dispatchEvent(new Event("pagehide")))
      expect(
        readRecoveryDraft(source._id, reportLocale)!.removedTitleLinks
      ).toEqual(expect.arrayContaining(reports))
      expect(JSON.stringify(original)).toContain('"link"')
      view.unmount()
    }
  )
})

describe("D2 R3 recovery adoption failure", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.historyInstalled = false
    mocks.enabledLocales = ["en", "fr"]
    mocks.sliceProps.length = 0
    mocks.saveDraft.mockReset().mockResolvedValue({
      updatedAt: 501,
      draftGeneration: 3,
      sharedDraftGeneration: 4,
    })
    mocks.checklistResult = { canPublish: true, blockers: [], warnings: [] }
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
  test.each(
    ["en", "fr"].flatMap((locale) =>
      ["HTML-first", "PM-first"].flatMap((order) =>
        ["transient", "persistent"].map((failure) => ({
          locale,
          order,
          failure,
        }))
      )
    )
  )(
    "independent recovery conversion-failure retry retains both located reports: $locale / $order / $failure",
    sliceProfile([]),
    async ({ locale, order, failure }) => {
      const html = {
        ...createSampleSlice("hero-with-image"),
        id: "html",
        items: [],
        primary: {
          ...createSampleSlice("hero-with-image").primary,
          title: '<p><a href="/first">First</a></p>',
        },
      }
      const pm = {
        ...createSampleSlice("hero-with-image"),
        id: "pm",
        items: [],
        primary: {
          ...createSampleSlice("hero-with-image").primary,
          title: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Second",
                    marks: [{ type: "link", attrs: { href: "/second" } }],
                  },
                ],
              },
            ],
          }),
        },
      }
      const rawSlices = order === "HTML-first" ? [html, pm] : [pm, html]
      const sourceBytes = JSON.stringify(rawSlices)
      writeRecoveryDraft(pageId, {
        base: null,
        ...{
          locale,
          savedAt: 500,
          title: "Recovered draft",
          slug: "recovered",
          pageType: "page",
          parentId: "",
          authorIds: [],
          tags: [],
          metaTitle: "",
          metaDescription: "",
          slices: rawSlices,
          seoNoIndex: false,
          seoNoFollow: false,
          seoOgTitle: "",
          seoOgDescription: "",
          seoOgImage: "",
          sharedFieldValues: {},
          localizedFieldValues: {},
        },
      })
      const parse = legacyParser.generateRichTextDocument
      let failuresLeft = failure === "persistent" ? Infinity : 1
      const parser = vi
        .spyOn(legacyParser, "generateRichTextDocument")
        .mockImplementation((...args) => {
          if (failuresLeft > 0) {
            failuresLeft -= 1
            throw new Error("transient title parser failure")
          }
          return parse(...args)
        })
      let view: ReturnType<typeof render> | undefined
      try {
        view = render(
          <PageEditor
            page={page()}
            hasStaging={false}
            stagingUpdatedAt={undefined}
            publication={{
              ...publication(),
              locales: [
                publication().locales[0]!,
                { ...publication().locales[0]!, locale: "fr" },
              ],
            }}
          />
        )
        if (locale === "fr")
          fireEvent.click(screen.getByRole("tab", { name: /français/i }))
        const current = () => mocks.sliceProps.at(-1)!
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: "Restore" })
          ).toBeInTheDocument()
        )
        await act(async () => current().onSave())
        expect(mocks.saveDraft).not.toHaveBeenCalled()
        if (failure === "persistent") {
          await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: "Restore" }))
          )
          expect(
            screen.getByRole("button", { name: "Restore" })
          ).toBeInTheDocument()
          await act(async () => current().onSave())
          expect(mocks.saveDraft).not.toHaveBeenCalled()
          expect(
            JSON.stringify(
              JSON.parse(
                window.sessionStorage.getItem(recoveryKey(pageId, locale))!
              ).slices
            )
          ).toBe(sourceBytes)
          failuresLeft = 0
        }
        await act(async () =>
          fireEvent.click(screen.getByRole("button", { name: "Restore" }))
        )
        const expectedTitles = rawSlices.map((slice) =>
          JSON.stringify({
            type: "doc",
            content: [
              {
                type: "heading",
                attrs: { level: 2 },
                content: [
                  {
                    type: "text",
                    text: slice.id === "html" ? "First" : "Second",
                  },
                ],
              },
            ],
          })
        )
        expect(
          current().slices.map(
            (slice) => (slice.primary as { title: string }).title
          )
        ).toEqual(expectedTitles)
        await act(async () => current().onSave())
        expect(mocks.saveDraft).toHaveBeenCalledOnce()
        const saved = mocks.saveDraft.mock.calls[0][0]
        expect(saved.localized.locale).toBe(locale)
        expect(
          saved.localized.draft.slices.map(
            (slice: Slice) => (slice.primary as { title: string }).title
          )
        ).toEqual(expectedTitles)
        fireEvent.change(screen.getByDisplayValue("Recovered draft"), {
          target: { value: "After recovery Save" },
        })
        act(() => window.dispatchEvent(new Event("pagehide")))
        const recovered = readRecoveryDraft(pageId, locale)!
        expect(recovered.removedTitleLinks).toEqual(
          expect.arrayContaining([
            {
              locale,
              sliceId: "html",
              fieldPath: "primary.title",
              removedLinks: [{ href: "/first" }],
            },
            {
              locale,
              sliceId: "pm",
              fieldPath: "primary.title",
              removedLinks: [{ href: "/second" }],
            },
          ])
        )
        expect(recovered.removedTitleLinks).toHaveLength(2)
        expect(JSON.stringify(rawSlices)).toBe(sourceBytes)
      } finally {
        parser.mockRestore()
        view?.unmount()
      }
    }
  )
})

describe("D2 R4 atomic actual-consumer ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.historyInstalled = false
    mocks.enabledLocales = ["en", "fr"]
    mocks.sliceProps.length = 0
    mocks.saveDraft.mockReset().mockResolvedValue({
      updatedAt: 501,
      draftGeneration: 3,
      sharedDraftGeneration: 4,
    })
    mocks.checklistResult = { canPublish: true, blockers: [], warnings: [] }
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
  const linked = (text: string, href: string) =>
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text, marks: [{ type: "link", attrs: { href } }] },
          ],
        },
      ],
    })
  const hero = (id: string, title: string) =>
    ({
      ...createSampleSlice("hero-with-image"),
      id,
      items: [],
      primary: { ...createSampleSlice("hero-with-image").primary, title },
    }) as Slice
  test.each(
    ["en", "fr"].flatMap((locale) =>
      ["HTML-first", "PM-first"].flatMap((order) =>
        ["corrupt-PM", "transient-HTML", "persistent-HTML"].flatMap((failure) =>
          [
            "locale",
            "locale-cached",
            "copy",
            "translation-source",
            "translation-store",
            "translation-apply",
          ].map((ingress) => ({ locale, order, failure, ingress }))
        )
      )
    )
  )(
    "atomic incoming draft: $ingress / $locale / $order / $failure",
    sliceProfile([]),
    async ({ locale, order, failure, ingress }) => {
      const other = locale === "en" ? "fr" : "en"
      const source = {
        ...page(),
        content: {
          en: {
            title: "English baseline",
            metaTitle: "English meta",
            metaDescription: "English description",
            slices: [hero("en-prior", linked("Prior EN", "/prior-en"))],
          },
          fr: {
            title: "French baseline",
            metaTitle: "French meta",
            metaDescription: "French description",
            slices: [hero("fr-prior", linked("Prior FR", "/prior-fr"))],
          },
        },
      } as Page
      source.content = Object.fromEntries(
        [locale, other].map((l) => [l, source.content![l]])
      ) as Page["content"]
      const observedPreparation = vi.spyOn(
        titleAdoption,
        "prepareHeroTitleDraft"
      )
      const view = render(
        <PageEditor
          page={source}
          hasStaging={false}
          stagingUpdatedAt={undefined}
          requestedLocale={locale}
          publication={{
            ...publication(),
            locales: [
              publication().locales[0]!,
              { ...publication().locales[0]!, locale: "fr" },
            ],
          }}
          aiTranslationRouteData={
            { mechanicalTranslation: {}, brandTranslation: {} } as never
          }
        />
      )
      const current = () => mocks.sliceProps.at(-1)!
      const cached =
        ingress === "locale-cached"
          ? mocks.translation!.readSourceContent(other)
          : undefined
      fireEvent.change(
        screen.getByDisplayValue(
          locale === "en" ? "English baseline" : "French baseline"
        ),
        { target: { value: "Post-flush baseline" } }
      )
      act(() => current().onSelectedSliceIdChange(current().slices[0].id))
      const flush = vi.fn()
      act(() =>
        current().onPreviewActiveEditHandleChange!({
          flush,
          capture: () => null,
          acceptCapture() {},
          isComposing: () => false,
          hasActiveSession: () => true,
        })
      )
      const buffer = () => {
        act(() => window.dispatchEvent(new Event("pagehide")))
        // Observe the complete real recovery/Save capture even after a copy's
        // ensureSaved has legitimately cleared browser recovery storage.
        const [draft, capturedLocale, previousReports] = [
          ...observedPreparation.mock.calls,
        ]
          .reverse()
          .find(([draft]) => "pageType" in draft)!
        return structuredClone({
          ...(draft as PageSaveDraft),
          locale: capturedLocale,
          removedTitleLinks: previousReports,
        })
      }
      const baseline = buffer()
      const selection = current().selectedSliceId
      const summaries = [
        mocks.translation!.getLocaleSummary("en"),
        mocks.translation!.getLocaleSummary("fr"),
      ]
      const html = hero("html", '<p><a href="/first">First</a></p>')
      const pm = hero("pm", linked("Second", "/second"))
      const raw = order === "HTML-first" ? [html, pm] : [pm, html]
      if (failure === "corrupt-PM")
        (pm.primary as { title: string }).title =
          '{"type":"doc","content":false}'
      const incoming = {
        title: "Incoming title",
        slug: "incoming-slug",
        slugLinked: false,
        metaTitle: "Incoming meta",
        metaDescription: "Incoming description",
        slices: raw,
        localizedFieldValues: { roleTitle: "Incoming localized value" },
        removedTitleLinks: [
          {
            locale: other,
            sliceId: "html",
            fieldPath: "primary.title",
            removedLinks: [{ href: "/retained" }],
          },
        ],
      }
      const targetBag = source.content![other] as unknown as {
        title: string
        metaTitle: string
        metaDescription: string
        slices: Slice[]
      }
      Object.assign(targetBag, {
        title: incoming.title,
        metaTitle: incoming.metaTitle,
        metaDescription: incoming.metaDescription,
        slices: raw,
      })
      if (cached) Object.assign(cached, incoming)
      const cacheBytes = JSON.stringify(cached)
      const parse = legacyParser.generateRichTextDocument
      let failuresLeft =
        failure === "corrupt-PM"
          ? 0
          : failure === "persistent-HTML"
            ? Infinity
            : 1
      const parser = vi
        .spyOn(legacyParser, "generateRichTextDocument")
        .mockImplementation((...args) => {
          if (failuresLeft > 0) {
            failuresLeft--
            throw new Error("incoming HTML adoption failed")
          }
          return parse(...args)
        })
      const attempt = async () => {
        await act(async () => {
          try {
            if (ingress === "locale" || ingress === "locale-cached")
              mocks.localeTabs!.onLocaleChange(other)
            else if (ingress === "copy") await mocks.transfer!.onPullCopy(other)
            else if (ingress === "translation-source")
              mocks.translation!.readSourceContent(other)
            else if (ingress === "translation-store")
              mocks.translation!.storeDraft(other, incoming)
            else mocks.translation!.applyActiveDraft(incoming)
          } catch {
            /* Flush queued React state even when the ingress refuses. */
          }
        })
      }
      try {
        await attempt()
        expect(current().currentLocale).toBe(locale)
        expect(current().selectedSliceId).toBe(selection)
        expect(JSON.stringify(cached)).toBe(cacheBytes)
        expect(buffer()).toEqual(baseline)
        // Destination failure must not publish a new cache summary.
        expect([
          mocks.translation!.getLocaleSummary("en"),
          mocks.translation!.getLocaleSummary("fr"),
        ]).toEqual(summaries)
        await act(async () => current().onSave())
        if (mocks.saveDraft.mock.calls.length) {
          const saved = mocks.saveDraft.mock.calls.at(-1)![0]
          expect(saved.localized.locale).toBe(locale)
          expect(saved.localized.draft.localized.title).toBe(baseline.title)
          expect(saved.localized.draft.slices).toEqual(baseline.slices)
          expect(saved.localized.draft.localized.metaTitle).toBe(
            baseline.metaTitle
          )
          expect(saved.localized.draft.localized.metaDescription).toBe(
            baseline.metaDescription
          )
          expect(saved.localized.draft.localized).toMatchObject(
            baseline.localizedFieldValues
          )
        }
        if (failure === "persistent-HTML") {
          await attempt()
          expect(current().currentLocale).toBe(locale)
          expect(current().slices).toEqual(baseline.slices)
          expect(current().selectedSliceId).toBe(selection)
        }
        failuresLeft = 0
        ;(pm.primary as { title: string }).title = linked("Second", "/second")
        await attempt()
        const result = ["translation-source", "translation-store"].includes(
          ingress
        )
          ? mocks.translation!.readSourceContent(other)
          : { slices: current().slices }
        expect(
          result.slices.map(
            (s) => JSON.parse((s.primary as { title: string }).title).content[0]
          )
        ).toEqual(
          raw.map((s) => ({
            type: "heading",
            attrs: { level: 2 },
            content: [
              { type: "text", text: s.id === "html" ? "First" : "Second" },
            ],
          }))
        )
        if (["translation-source", "translation-store"].includes(ingress))
          act(() => mocks.localeTabs!.onLocaleChange(other))
        const acceptedLocale = current().currentLocale
        fireEvent.change(screen.getByDisplayValue("Incoming title"), {
          target: { value: "Accepted incoming title" },
        })
        act(() => window.dispatchEvent(new Event("pagehide")))
        const accepted = JSON.parse(
          window.sessionStorage.getItem(recoveryKey(pageId, acceptedLocale))!
        )
        for (const [text, href] of [
          ["First", "/first"],
          ["Second", "/second"],
        ]) {
          const s = current().slices.find(
            (s) =>
              JSON.parse((s.primary as { title: string }).title).content[0]
                .content[0].text === text
          )!
          expect(accepted.removedTitleLinks).toEqual(
            expect.arrayContaining([
              {
                locale: acceptedLocale,
                sliceId: s.id,
                fieldPath: "primary.title",
                removedLinks: expect.arrayContaining([{ href }]),
              },
            ])
          )
        }
        await act(async () => current().onSave())
        expect(
          mocks.saveDraft.mock.calls.at(-1)![0].localized.draft.slices
        ).toEqual(current().slices)
      } finally {
        parser.mockRestore()
        observedPreparation.mockRestore()
        view.unmount()
      }
    }
  )
  test.each(["en", "fr"])(
    "inline acceptance publishes reports only after whole-draft preparation: %s",
    sliceProfile([]),
    async (locale) => {
      const source = {
        ...page(),
        content: {
          [locale]: {
            title: "Inline baseline",
            slices: [
              hero("html", linked("First", "/first")),
              hero("pm", linked("Second", "/second")),
            ],
          },
        },
      } as Page
      const prepare = titleAdoption.prepareHeroTitleDraft
      const observer = vi.spyOn(titleAdoption, "prepareHeroTitleDraft")
      const view = render(
        <PageEditor
          page={source}
          hasStaging={false}
          stagingUpdatedAt={undefined}
          requestedLocale={locale}
          publication={{
            ...publication(),
            locales: [
              publication().locales[0]!,
              { ...publication().locales[0]!, locale: "fr" },
            ],
          }}
        />
      )
      const current = () => mocks.sliceProps.at(-1)!
      const original = structuredClone(current().slices)
      const before = structuredClone(observer.mock.calls.at(-1)![2])
      const binding = capturePageField(
        current().slices,
        locale,
        "html",
        "primary.title",
        current().contentEpoch ?? 0,
        current().presentationCatalog?.revision ?? ""
      )!
      let reject = true
      observer.mockImplementation((...args) => {
        if (
          reject &&
          JSON.stringify(args[0].slices).includes("Inline incoming")
        )
          throw new Error("whole-draft validation failure")
        return prepare(...args)
      })
      try {
        act(() =>
          expect(
            current().onPreviewInlineEditCommit({
              ...binding,
              value: linked("Inline incoming", "/inline"),
            })
          ).toBe(false)
        )
        expect(current().slices).toEqual(original)
        await act(async () => current().onSave())
        expect(observer.mock.calls.at(-1)![2]).toEqual(before)
        for (const [saved] of mocks.saveDraft.mock.calls)
          expect(saved.localized.draft.slices).toEqual(original)
        mocks.saveDraft.mockClear()
        reject = false
        act(() =>
          expect(
            current().onPreviewInlineEditCommit({
              ...binding,
              value: linked("Inline incoming", "/inline"),
            })
          ).toBe(true)
        )
        await act(async () => current().onSave())
        expect(
          mocks.saveDraft.mock.calls.at(-1)![0].localized.draft.slices
        ).toEqual(current().slices)
        expect(observer.mock.calls.at(-1)![2]).toEqual(
          expect.arrayContaining([
            {
              locale,
              sliceId: "html",
              fieldPath: "primary.title",
              removedLinks: expect.arrayContaining([{ href: "/inline" }]),
            },
          ])
        )
      } finally {
        observer.mockRestore()
        view.unmount()
      }
    }
  )
  test.each(["en", "fr"])(
    "translation storage and active apply share the exact once-prepared draft: %s",
    sliceProfile([]),
    async (locale) => {
      const source = {
        ...page(),
        content: { [locale]: { title: "Translation baseline", slices: [] } },
      } as Page
      const observer = vi.spyOn(titleAdoption, "prepareHeroTitleDraft")
      const view = render(
        <PageEditor
          page={source}
          hasStaging={false}
          stagingUpdatedAt={undefined}
          requestedLocale={locale}
          publication={{
            ...publication(),
            locales: [
              publication().locales[0]!,
              { ...publication().locales[0]!, locale: "fr" },
            ],
          }}
          aiTranslationRouteData={
            { mechanicalTranslation: {}, brandTranslation: {} } as never
          }
        />
      )
      const draft = {
        title: "Translated",
        slug: "translated",
        slugLinked: true,
        metaTitle: "Translated meta",
        metaDescription: "Translated description",
        slices: [
          hero("html", '<p><a href="/first">First</a></p>'),
          hero("pm", linked("Second", "/second")),
        ],
        localizedFieldValues: {},
      }
      const host = mocks.translation!
      let stored: ReturnType<typeof host.storeDraft> | undefined
      const apply = vi.fn(host.applyActiveDraft)
      try {
        await act(async () => {
          stored = host.storeDraft(locale, draft)
          apply(stored)
        })
        expect(apply).toHaveBeenCalledExactlyOnceWith(stored)
        // Count incoming adoption calls, excluding the pure Save/recovery captures
        // triggered by rendering the committed parent.
        expect(
          observer.mock.calls.filter(([value]) => value === draft)
        ).toHaveLength(1)
        expect(
          observer.mock.calls.filter(([value]) => value === stored)
        ).toHaveLength(0)
        expect(stored!.removedTitleLinks).toEqual(
          expect.arrayContaining([
            {
              locale,
              sliceId: "html",
              fieldPath: "primary.title",
              removedLinks: [{ href: "/first" }],
            },
            {
              locale,
              sliceId: "pm",
              fieldPath: "primary.title",
              removedLinks: [{ href: "/second" }],
            },
          ])
        )
      } finally {
        observer.mockRestore()
        view.unmount()
      }
    }
  )
})

describe("D2 R5 canonical diagnostic recipients", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.historyInstalled = false
    mocks.enabledLocales = ["en", "fr"]
    mocks.sliceProps.length = 0
    mocks.saveDraft.mockReset().mockResolvedValue({
      updatedAt: 501,
      draftGeneration: 3,
      sharedDraftGeneration: 4,
    })
    mocks.checklistResult = { canPublish: true, blockers: [], warnings: [] }
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
  const canonical = () =>
    ["first", "second"].map((id) => ({
      ...createSampleSlice("hero-with-image"),
      id,
      items: [],
      primary: {
        ...createSampleSlice("hero-with-image").primary,
        title: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: id }],
            },
          ],
        }),
      },
    })) as Slice[]
  function heroTitle(slice: Slice) {
    expect(slice.type).toBe("hero-with-image")
    if (slice.type !== "hero-with-image")
      throw new Error("Expected Hero fixture")
    return slice.primary.title
  }
  const reportsFor = (locale: string) =>
    ["first", "second"].map((sliceId) => ({
      locale,
      sliceId,
      fieldPath: "primary.title",
      removedLinks: [{ href: `/${sliceId}-attached` }],
    }))
  const rawRecovery = (locale: string) =>
    JSON.parse(
      window.sessionStorage.getItem(recoveryKey(page()._id, locale))!
    ) as PageSaveDraft
  const props = () => ({
    page: {
      ...page(),
      content: {
        en: { title: "English", slices: canonical() },
        fr: { title: "French", slices: canonical() },
      },
    } as Page,
    hasStaging: false,
    stagingUpdatedAt: undefined,
    publication: {
      ...publication(),
      locales: [
        publication().locales[0]!,
        { ...publication().locales[0]!, locale: "fr" },
      ],
    },
    aiTranslationRouteData: {
      mechanicalTranslation: {},
      brandTranslation: {},
    } as never,
  })
  test.each([
    "shared slice",
    "saved locale",
    "cached locale",
    "source copy",
    "translation read",
    "translation store",
    "translation apply",
    "inline",
  ] as const)(
    "canonical report recipients: %s",
    sliceProfile([]),
    async (boundary) => {
      const view = render(<PageEditor {...props()} />)
      const current = () => mocks.sliceProps.at(-1)!
      const reports = reportsFor(boundary === "cached locale" ? "fr" : "en")
      let locale = "en"
      let expected = reports
      const host = mocks.translation!
      const incoming = {
        title: "Attached",
        slug: "attached",
        slugLinked: true,
        metaTitle: "",
        metaDescription: "",
        localizedFieldValues: {},
        slices: canonical().map((slice) => ({
          ...slice,
          primary: {
            ...slice.primary,
            title: (slice.primary as { title: string }).title
              .replace('"first"', '"Incoming first"')
              .replace('"second"', '"Incoming second"'),
          },
        })) as Slice[],
        removedTitleLinks: [reports[0], reports[0], reports[1]],
      }
      try {
        let prepared: ReturnType<typeof host.storeDraft>
        act(() => {
          prepared = host.storeDraft(
            boundary === "cached locale" ? "fr" : "en",
            incoming
          )
          if (boundary !== "cached locale") host.applyActiveDraft(prepared)
        })
        // Cache/store is itself a recipient, before active adoption or reconversion.
        expect(prepared!.removedTitleLinks).toEqual(reports)
        if (boundary === "translation read") {
          const read = mocks.translation!.readSourceContent("en")
          expect(read.slices).toEqual(incoming.slices)
          expect(read.removedTitleLinks).toEqual(reports)
        } else if (boundary === "shared slice") {
          act(() =>
            current().onSlicesChange(
              current().slices.map((slice) => ({
                ...slice,
                primary: { ...slice.primary, eyebrow: "Edited sibling" },
              })) as Slice[]
            )
          )
        } else if (boundary === "inline") {
          const binding = capturePageField(
            current().slices,
            "en",
            "first",
            "primary.title",
            current().contentEpoch ?? 0,
            current().presentationCatalog?.revision ?? ""
          )!
          act(() =>
            expect(
              current().onPreviewInlineEditCommit({
                ...binding,
                value: (incoming.slices[0].primary as { title: string }).title,
                removedLinks: [{ href: "/inline-attached" }],
              })
            ).toBe(true)
          )
          expected = [
            {
              ...reports[0],
              removedLinks: [
                ...reports[0].removedLinks,
                { href: "/inline-attached" },
              ],
            },
            reports[1],
          ]
        } else if (
          boundary === "cached locale" ||
          boundary === "saved locale" ||
          boundary === "source copy"
        ) {
          if (boundary === "source copy")
            await act(async () => current().onSave())
          await act(async () =>
            fireEvent.click(screen.getByRole("tab", { name: /français/i }))
          )
          locale = "fr"
          if (boundary === "source copy") {
            fireEvent.click(screen.getByTitle("Copy content between locales"))
            await act(async () =>
              fireEvent.click(
                screen.getByRole("button", { name: /^Copy from EN/ })
              )
            )
            const remapped = current().slices.map((slice, i) => ({
              ...reports[i],
              locale: "fr",
              sliceId: slice.id,
            }))
            expected = [...reports, ...remapped]
            expect(current().slices.map((slice) => slice.id)).not.toEqual([
              "first",
              "second",
            ])
          }
        }
        fireEvent.change(
          screen.getByDisplayValue(
            boundary === "saved locale" ? "French" : "Attached"
          ),
          {
            target: { value: "Recipient dirty" },
          }
        )
        act(() => window.dispatchEvent(new Event("pagehide")))
        const raw = rawRecovery(locale) // No adopting reader can repair missing diagnostics.
        expect(raw.removedTitleLinks).toEqual(expected)
        expect(raw.slices.map(heroTitle)).toEqual(
          (boundary === "saved locale" ? canonical() : incoming.slices).map(
            heroTitle
          )
        )
        await act(async () => current().onSave())
        fireEvent.change(screen.getByDisplayValue("Recipient dirty"), {
          target: { value: "After Save" },
        })
        act(() => window.dispatchEvent(new Event("pagehide")))
        expect(rawRecovery(locale).removedTitleLinks).toEqual(expected)
      } finally {
        view.unmount()
      }
    }
  )
  // Ingress (not forwarding): the AI route stash has slices but no report
  // field. Real legacy PM is therefore adopted at the initial mount boundary.
  test.each(["initial load", "AI handoff"] as const)(
    "initial ingress retains located reports: %s",
    sliceProfile([]),
    async (boundary) => {
      const source = canonical().map((slice) => ({
        ...slice,
        primary: {
          ...slice.primary,
          title: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: slice.id,
                    marks: [
                      {
                        type: "link",
                        attrs: { href: `/${slice.id}-attached` },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        },
      })) as Slice[]
      const input = props()
      if (boundary === "initial load")
        input.page = {
          ...input.page,
          content: {
            ...input.page.content,
            en: { title: "English", slices: source },
          },
        } as Page
      else
        expect(stashPageDraftHandoff(input.page._id, { slices: source })).toBe(
          true
        )
      const view = render(<PageEditor {...input} />)
      try {
        expect(mocks.sliceProps.at(-1)!.slices).toEqual(canonical())
        expect(readPageDraftHandoff(input.page._id)).toBeNull()
        fireEvent.change(screen.getByDisplayValue("English"), {
          target: { value: "Initial dirty" },
        })
        act(() => window.dispatchEvent(new Event("pagehide")))
        expect(rawRecovery("en").removedTitleLinks).toEqual(reportsFor("en"))
        await act(async () => mocks.sliceProps.at(-1)!.onSave())
        fireEvent.change(screen.getByDisplayValue("Initial dirty"), {
          target: { value: "After initial Save" },
        })
        act(() => window.dispatchEvent(new Event("pagehide")))
        expect(rawRecovery("en").removedTitleLinks).toEqual(reportsFor("en"))
        expect(heroTitle(source[0])).toContain('"link"')
      } finally {
        view.unmount()
      }
    }
  )
  test(
    "Save prepared callback retains canonical attached reports in the real parent",
    sliceProfile([]),
    async () => {
      const reports = reportsFor("en")
      const actual = pageSaveHook.usePageSave
      let payload: PageSaveDraft | undefined
      // The capture seam supplies a prepared canonical draft with diagnostics.
      // All parent/hook code is real; neither the parent nor its reader can
      // reconstruct these reports from the canonical title bytes.
      const seam = vi
        .spyOn(pageSaveHook, "usePageSave")
        .mockImplementation((options) =>
          actual({
            ...options,
            captureDraft: async (draft, isCurrent) => {
              const captured = await options.captureDraft!(draft, isCurrent)
              return captured && { ...captured, removedTitleLinks: reports }
            },
            onPreparedDraft: (draft) => {
              payload = draft
              options.onPreparedDraft?.(draft)
            },
          })
        )
      const view = render(<PageEditor {...props()} />)
      try {
        fireEvent.change(screen.getByDisplayValue("English"), {
          target: { value: "Save captured" },
        })
        await act(async () => mocks.sliceProps.at(-1)!.onSave())
        expect(payload).toEqual(
          expect.objectContaining({
            slices: canonical(),
            removedTitleLinks: reports,
          })
        )
        fireEvent.change(screen.getByDisplayValue("Save captured"), {
          target: { value: "Parent retained" },
        })
        act(() => window.dispatchEvent(new Event("pagehide")))
        expect(rawRecovery("en").removedTitleLinks).toEqual(reports)
      } finally {
        view.unmount()
        seam.mockRestore()
      }
    }
  )
})

// E1: two tabs of one owner on one page. Another tab's save reaches this tab
// only through a server-prop refresh, which never reloads this tab's buffers.
// Every buffer must therefore keep the generation base it was loaded from.
describe("E1 a tab never saves over content it has not loaded", () => {
  const states = (over: {
    lifecycle?: number
    shared?: number
    en?: number
    fr?: number
    enPublic?: number
  }) => ({
    authority: "snapshot_active" as const,
    lifecycleGeneration: over.lifecycle ?? 3,
    sharedDraftGeneration: over.shared ?? 4,
    locales: [
      {
        locale: "en",
        draftGeneration: over.en ?? 2,
        publicGeneration: over.enPublic ?? 1,
        releaseGeneration: 1,
      },
      ...(over.fr === undefined
        ? []
        : [
            {
              locale: "fr",
              draftGeneration: over.fr,
              publicGeneration: 0,
              releaseGeneration: 0,
            },
          ]),
    ],
  })
  const pageOf = (en: string, fr?: string) =>
    ({
      ...page(),
      content: {
        en: { title: en, slices: [] },
        ...(fr === undefined ? {} : { fr: { title: fr, slices: [] } }),
      },
    }) as Page
  const tab = (pageProp: Page, publicationProp: ReturnType<typeof states>) => (
    <PageEditor
      page={pageProp}
      hasStaging={false}
      stagingUpdatedAt={undefined}
      publication={publicationProp}
    />
  )
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  const save = () => act(async () => mocks.sliceProps.at(-1)!.onSave())
  const sent = (n = -1) => mocks.saveDraft.mock.calls.at(n)![0]
  // Coming back to a language with typing the tab kept offers the browser copy
  // of that typing. Keeping it is what the owner does; the base is unchanged.
  const keepBrowserCopy = async () => {
    const restore = screen.queryByRole("button", { name: "Restore" })
    if (restore) await act(async () => fireEvent.click(restore))
  }
  const localizedOf = (call: { localized: Record<string, unknown> }) =>
    call.localized as {
      locale: string
      expectedGeneration: number
      draft: { localized: { title: string } }
    }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.historyInstalled = false
    mocks.enabledLocales = ["en"]
    mocks.sliceProps.length = 0
    mocks.slotProps.length = 0
    mocks.seoProps = null
    mocks.retainedTargetRemedy = null
    mocks.convex.query.mockReset().mockImplementation(async () => [])
    mocks.confirm.mockReset().mockResolvedValue(true)
    mocks.saveDraft.mockReset().mockResolvedValue({
      updatedAt: 101,
      draftGeneration: 3,
      sharedDraftGeneration: 4,
    })
    mocks.snapshotRestore.mockReset().mockResolvedValue({
      locale: "en",
      draftGeneration: 3,
      sharedDraftGeneration: 5,
      updatedAt: 500,
    })
    mocks.checklistResult = { canPublish: true, blockers: [], warnings: [] }
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  test(
    "E1-1 a refresh that carries another tab's generation does not move this tab's base",
    sliceProfile([]),
    async () => {
      const mounted = states({})
      const view = render(tab(pageOf("About"), mounted))
      view.rerender(
        tab(
          pageOf("Their title"),
          states({ lifecycle: 5, shared: 9, en: 7, enPublic: 2 })
        )
      )
      // The refresh did not reload this tab: it still holds its own text.
      expect(screen.getByLabelText("Page title")).toHaveValue("About")
      type("Page title", "Mine")
      await save()
      expect(mocks.saveDraft).toHaveBeenCalledOnce()
      expect(sent()).toMatchObject({ expectedLifecycleGeneration: 3 })
      expect(localizedOf(sent())).toMatchObject({
        expectedGeneration: 2,
        draft: { localized: { title: "Mine" } },
      })
      // An unedited shared half is not sent at all (same payload as before).
      expect(sent().shared).toBeUndefined()
      expect(screen.getByLabelText("Page title")).toHaveValue("Mine")
      // The save result updated this tab's own base, never the server prop.
      expect(mounted.locales[0]!.draftGeneration).toBe(2)
    }
  )

  test(
    "E1-2 a shared-only save followed by a refresh cannot launder the base for a later locale save",
    sliceProfile([]),
    async () => {
      const view = render(tab(pageOf("About"), states({})))
      // B saved the English title (en 3). This tab, unaware, saves SEO only.
      fireEvent.click(screen.getByTitle("SEO"))
      mocks.saveDraft.mockResolvedValueOnce({
        updatedAt: 101,
        sharedDraftGeneration: 5,
      })
      act(() => mocks.seoProps!.onSeoOgTitleChange("Our social title"))
      await save()
      expect(sent()).toMatchObject({ shared: { expectedGeneration: 4 } })
      expect(sent().localized).toBeUndefined()
      // The refresh after that save carries B's en 3 and B's shared 8.
      view.rerender(tab(pageOf("Their title"), states({ en: 3, shared: 8 })))
      type("Page title", "Our body edit")
      act(() => mocks.seoProps!.onSeoOgTitleChange("Our second social title"))
      mocks.saveDraft.mockClear()
      await save()
      // Both halves keep the generations this tab loaded or saved to.
      expect(localizedOf(sent())).toMatchObject({
        expectedGeneration: 2,
        draft: { localized: { title: "Our body edit" } },
      })
      expect(sent().shared).toMatchObject({ expectedGeneration: 5 })
      expect(screen.getByLabelText("Page title")).toHaveValue("Our body edit")
    }
  )

  test(
    "E1-3 a cached language keeps the base it was loaded from; a first visit adopts that language from the payload",
    sliceProfile([]),
    async () => {
      mocks.enabledLocales = ["en", "fr"]
      const view = render(tab(pageOf("About", "Français"), states({ fr: 5 })))
      fireEvent.click(screen.getByRole("tab", { name: /français/i }))
      type("Page title", "Mon fr")
      fireEvent.click(screen.getByRole("tab", { name: /english/i }))
      // B saved French (fr 6) and this tab refreshed.
      view.rerender(tab(pageOf("About", "Leur fr"), states({ fr: 6, en: 2 })))
      fireEvent.click(screen.getByRole("tab", { name: /français/i }))
      // The revisit shows this tab's cached buffer, so it keeps fr 5.
      expect(screen.getByLabelText("Page title")).toHaveValue("Mon fr")
      await keepBrowserCopy()
      type("Page title", "Mon fr 2")
      await save()
      expect(localizedOf(sent())).toMatchObject({
        locale: "fr",
        expectedGeneration: 5,
        draft: { localized: { title: "Mon fr 2" } },
      })
    }
  )

  test(
    "E1-3b a first visit loads a language from the current payload and adopts only that language's base",
    sliceProfile([]),
    async () => {
      mocks.enabledLocales = ["en", "fr"]
      const view = render(tab(pageOf("About", "Français"), states({ fr: 5 })))
      // B saved French (fr 6) and en (en 9) before this tab ever opened French.
      view.rerender(
        tab(pageOf("Their en", "Leur fr"), states({ fr: 6, en: 9, shared: 8 }))
      )
      fireEvent.click(screen.getByRole("tab", { name: /français/i }))
      expect(screen.getByLabelText("Page title")).toHaveValue("Leur fr")
      type("Page title", "Après leur fr")
      await save()
      // French content and base come from the same payload.
      expect(localizedOf(sent())).toMatchObject({
        locale: "fr",
        expectedGeneration: 6,
      })
      // English was loaded at mount, so its base did not move.
      fireEvent.click(screen.getByRole("tab", { name: /english/i }))
      type("Page title", "Our en")
      mocks.saveDraft.mockClear()
      await save()
      expect(localizedOf(sent())).toMatchObject({
        locale: "en",
        expectedGeneration: 2,
      })
    }
  )

  test(
    "E1-4 History keeps each retained language's base through the remount",
    sliceProfile([]),
    async () => {
      mocks.enabledLocales = ["en", "fr"]
      const view = render(tab(pageOf("About", "Français"), states({ fr: 5 })))
      fireEvent.click(screen.getByRole("tab", { name: /français/i }))
      type("Page title", "Mon fr")
      fireEvent.click(screen.getByRole("tab", { name: /english/i }))
      fireEvent.click(screen.getByTitle("History"))
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Restore draft" }))
      )
      expect(mocks.snapshotRestore).toHaveBeenCalledOnce()
      // The restore wrote en 3 and shared 5; B had saved French (fr 6) earlier.
      view.rerender(
        tab(
          pageOf("Restored English", "Leur fr"),
          states({ en: 3, shared: 5, fr: 6 })
        )
      )
      await waitFor(() =>
        expect(screen.getByLabelText("Page title")).toHaveValue(
          "Restored English"
        )
      )
      fireEvent.click(screen.getByRole("tab", { name: /français/i }))
      expect(screen.getByLabelText("Page title")).toHaveValue("Mon fr")
      await keepBrowserCopy()
      type("Page title", "Mon fr 2")
      mocks.saveDraft.mockClear()
      await save()
      expect(localizedOf(sent())).toMatchObject({
        locale: "fr",
        expectedGeneration: 5,
        draft: { localized: { title: "Mon fr 2" } },
      })
      // The restored language was reloaded, so it adopts the refreshed base.
      fireEvent.click(screen.getByRole("tab", { name: /english/i }))
      type("Page title", "After restore")
      mocks.saveDraft.mockClear()
      await save()
      expect(localizedOf(sent())).toMatchObject({
        locale: "en",
        expectedGeneration: 3,
      })
      expect(sent()).toMatchObject({ expectedLifecycleGeneration: 3 })
    }
  )

  test(
    "E1-5 a delayed refresh after two own saves does not roll the base back",
    sliceProfile([]),
    async () => {
      const view = render(tab(pageOf("About"), states({})))
      mocks.saveDraft
        .mockResolvedValueOnce({
          updatedAt: 101,
          draftGeneration: 3,
          sharedDraftGeneration: 4,
        })
        .mockResolvedValueOnce({
          updatedAt: 102,
          draftGeneration: 4,
          sharedDraftGeneration: 4,
        })
      type("Page title", "One")
      await save()
      type("Page title", "Two")
      await save()
      expect(localizedOf(sent(0))).toMatchObject({ expectedGeneration: 2 })
      expect(localizedOf(sent(1))).toMatchObject({ expectedGeneration: 3 })
      // The refresh of save one arrives last.
      view.rerender(tab(pageOf("One"), states({ en: 3 })))
      type("Page title", "Three")
      await save()
      expect(localizedOf(sent(2))).toMatchObject({ expectedGeneration: 4 })
    }
  )

  test(
    "E1-6 History sends this tab's base, not a refreshed prop's, and sees a save made before its refresh",
    sliceProfile([]),
    async () => {
      const view = render(tab(pageOf("About"), states({})))
      // Our own save first; its refresh has not arrived.
      type("Page title", "Saved here")
      await save()
      fireEvent.click(screen.getByTitle("History"))
      expect(mocks.slotProps.at(-1)!.readSnapshotRestore!()).toEqual({
        expectedDraftGeneration: 3,
        expectedSharedDraftGeneration: 4,
        expectedLifecycleGeneration: 3,
        expectedPublicGeneration: 1,
        expectedReleaseGeneration: 1,
      })
      // Then B saved and the refresh carried B's generations.
      view.rerender(
        tab(pageOf("Their title"), states({ en: 7, shared: 9, lifecycle: 6 }))
      )
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Restore draft" }))
      )
      expect(mocks.snapshotRestore).toHaveBeenCalledWith({
        pageId,
        snapshotId: "snapshot-1",
        locale: "en",
        expectedDraftGeneration: 3,
        expectedSharedDraftGeneration: 4,
        expectedLifecycleGeneration: 3,
        expectedPublicGeneration: 1,
        expectedReleaseGeneration: 1,
      })
    }
  )

  describe("ED1REC snapshot recovery", () => {
    const recovered = (base: unknown) => ({
      locale: "en",
      savedAt: 500,
      title: "My recovered words",
      slug: "about",
      pageType: "page" as const,
      parentId: "",
      authorIds: [],
      tags: [],
      metaTitle: "",
      metaDescription: "",
      slices: [],
      seoNoIndex: false,
      seoNoFollow: false,
      seoOgTitle: "Recovered social",
      seoOgDescription: "",
      seoOgImage: "",
      sharedFieldValues: {},
      localizedFieldValues: {},
      base,
    })
    const restore = async () =>
      act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Restore" }))
      )
    const current = {
      draftGeneration: 5,
      sharedDraftGeneration: 6,
      lifecycleGeneration: 3,
    }

    test.each([
      {
        name: "R2 locale",
        base: { ...current, draftGeneration: 4 },
        locale: 4,
        shared: 6,
        life: -1,
        code: "PAGE_LOCALE_DRAFT_STALE",
      },
      {
        name: "R3 shared",
        base: { ...current, sharedDraftGeneration: 5 },
        locale: 5,
        shared: 5,
        life: -1,
        code: "PAGE_SHARED_DRAFT_STALE",
      },
      {
        name: "lifecycle",
        base: { ...current, lifecycleGeneration: 2 },
        locale: 5,
        shared: 6,
        life: -1,
        code: "PAGE_PUBLICATION_LIFECYCLE_STALE",
      },
      {
        name: "R4 missing",
        base: undefined,
        locale: -1,
        shared: -1,
        life: -1,
        code: "PAGE_PUBLICATION_LIFECYCLE_STALE",
      },
      {
        name: "R8 null",
        base: null,
        locale: -1,
        shared: -1,
        life: -1,
        code: "PAGE_PUBLICATION_LIFECYCLE_STALE",
      },
      {
        name: "R8 legacy",
        base: { updatedAt: 100 },
        locale: -1,
        shared: -1,
        life: -1,
        code: "PAGE_PUBLICATION_LIFECYCLE_STALE",
      },
      {
        name: "R8 malformed",
        base: { ...current, draftGeneration: "4" },
        locale: -1,
        shared: -1,
        life: -1,
        code: "PAGE_PUBLICATION_LIFECYCLE_STALE",
      },
    ])(
      "ED1REC $name round trip restores literal expectations and repeats the dialog",
      sliceProfile([]),
      async (c) => {
        // Use the real writer/reader; malformed base must not hide the strip.
        writeRecoveryDraft(pageId, recovered(c.base) as never)
        expect(readRecoveryDraft(pageId, "en")?.title).toBe(
          "My recovered words"
        )
        const view = render(
          tab(pageOf("Their title"), states({ en: 5, shared: 6 }))
        )
        expect(screen.getByRole("button", { name: "Restore" })).toBeVisible()
        await restore()
        mocks.saveDraft.mockRejectedValue(new ConvexError(c.code))
        mocks.confirm.mockResolvedValue(false)
        await save()
        expect(sent()).toMatchObject({
          expectedLifecycleGeneration: c.life,
          localized: {
            expectedGeneration: c.locale,
            draft: { localized: { title: "My recovered words" } },
          },
          shared: {
            expectedGeneration: c.shared,
            seo: { ogTitle: "Recovered social" },
          },
        })
        expect(mocks.confirm).toHaveBeenCalledOnce()
        expect(mocks.refresh).not.toHaveBeenCalled()
        expect(toast.success).not.toHaveBeenCalledWith("Saved")
        await save()
        expect(mocks.confirm).toHaveBeenCalledTimes(2)
        expect(sent().localized.expectedGeneration).toBe(c.locale)
        expect(readRecoveryDraft(pageId, "en")?.base).toEqual({
          draftGeneration: c.locale,
          sharedDraftGeneration: c.shared,
          lifecycleGeneration: c.life,
        })
        view.unmount()
        render(tab(pageOf("Their title"), states({ en: 5, shared: 6 })))
        await restore()
        await save()
        expect(mocks.confirm).toHaveBeenCalledTimes(3)
        expect(sent()).toMatchObject({
          expectedLifecycleGeneration: -1,
          localized: { expectedGeneration: c.locale },
          shared: { expectedGeneration: c.shared },
        })
      }
    )

    test(
      "ED1REC R1 same-base writer restore saves normally",
      sliceProfile([]),
      async () => {
        const first = render(tab(pageOf("About"), states({ en: 5, shared: 6 })))
        type("Page title", "My recovered words")
        act(() => window.dispatchEvent(new Event("pagehide")))
        expect(readRecoveryDraft(pageId, "en")?.base).toEqual({
          draftGeneration: 5,
          sharedDraftGeneration: 6,
          lifecycleGeneration: 3,
        })
        first.unmount()
        render(tab(pageOf("About"), states({ en: 5, shared: 6 })))
        await restore()
        await save()
        expect(sent()).toMatchObject({
          expectedLifecycleGeneration: 3,
          localized: { expectedGeneration: 5 },
        })
        expect(mocks.confirm).not.toHaveBeenCalled()
        expect(mocks.refresh).toHaveBeenCalledOnce()
      }
    )

    test(
      "ED1REC R5 writers record held base despite newer live publication",
      sliceProfile([]),
      async () => {
        mocks.enabledLocales = ["en", "fr"]
        const view = render(
          tab(pageOf("About", "Bonjour"), states({ en: 5, shared: 6, fr: 1 }))
        )
        type("Page title", "Unsaved English")
        view.rerender(
          tab(
            pageOf("Their title", "Bonjour"),
            states({ en: 9, shared: 10, fr: 1 })
          )
        )
        act(() => window.dispatchEvent(new Event("pagehide")))
        expect(readRecoveryDraft(pageId, "en")?.base).toEqual({
          draftGeneration: 5,
          sharedDraftGeneration: 6,
          lifecycleGeneration: 3,
        })
        fireEvent.click(screen.getByRole("tab", { name: /français/i }))
        expect(readRecoveryDraft(pageId, "en")?.base).toEqual({
          draftGeneration: 5,
          sharedDraftGeneration: 6,
          lifecycleGeneration: 3,
        })
      }
    )

    test(
      "ED1REC R6 Publish pre-save carries recorded expectations and stops publication",
      sliceProfile([]),
      async () => {
        writeRecoveryDraft(
          pageId,
          recovered({
            draftGeneration: 4,
            sharedDraftGeneration: 6,
            lifecycleGeneration: 3,
          }) as never
        )
        render(tab(pageOf("Their title"), states({ en: 5, shared: 6 })))
        await restore()
        mocks.saveDraft.mockRejectedValue(
          new ConvexError("PAGE_LOCALE_DRAFT_STALE")
        )
        mocks.confirm.mockResolvedValue(false)
        await act(async () =>
          fireEvent.click(screen.getByRole("button", { name: /^Publish/ }))
        )
        expect(sent().localized.expectedGeneration).toBe(4)
        expect(mocks.confirm).toHaveBeenCalledOnce()
        expect(mocks.publish).not.toHaveBeenCalled()
      }
    )

    test(
      "ED1REC R7b real server refuses pre-save recovery after another tab saves and publishes",
      sliceProfile([]),
      async () => {
        const identity = {
          subject: "ed1rec-owner",
          tokenIdentifier: "https://convex.test|ed1rec-owner",
        }
        const t = convexTest({
          schema,
          modules: import.meta.glob("../../convex/**/*.ts"),
          ownerIdentity: identity,
          publicationAuthority: "missing",
        })
        const owner = t.withIdentity(identity)
        await owner.mutation(
          api.cms.publication.initializeEmptySnapshotAuthority,
          {}
        )
        const home = await owner.mutation(api.cms.pages.create, {
          pageType: "page",
          status: "draft",
          slug: "home",
          title: "Home",
          content: { en: { title: "Home", slices: [] } },
        })
        const id = await owner.mutation(api.cms.pages.create, {
          pageType: "page",
          status: "draft",
          slug: "about",
          title: "About",
          content: { en: { title: "About", slices: [] } },
        })
        await t.run(async (ctx) => {
          await ctx.db.insert("siteSettings", {
            siteName: "Recovery",
            siteUrl: "",
            defaultLocale: "en",
            enabledLocales: ["en"],
            homePageId: home,
            updatedAt: 100,
          })
        })
        // Creation is generation 1. Tab 2's buffer belongs to that exact base.
        writeRecoveryDraft(
          id,
          recovered({
            draftGeneration: 1,
            sharedDraftGeneration: 1,
            lifecycleGeneration: 1,
          }) as never
        )
        await owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId: id,
          expectedLifecycleGeneration: 1,
          localized: {
            locale: "en",
            slug: "about",
            expectedGeneration: 1,
            draft: {
              pageType: "page",
              localized: { title: "Tab one saved" },
              slices: [],
            },
          },
        })
        await owner.mutation(api.cms.publication.publishLocale, {
          pageId: id,
          locale: "en",
          expectedDraftGeneration: 2,
          expectedSharedDraftGeneration: 1,
          expectedLifecycleGeneration: 1,
          expectedPublicGeneration: 0,
          expectedReleaseGeneration: 0,
        })
        const readRows = () =>
          t.run(async (ctx) => ({
            draft: await ctx.db
              .query("pageLocaleDrafts")
              .withIndex("by_pageId_and_locale", (q) =>
                q.eq("pageId", id).eq("locale", "en")
              )
              .unique(),
            state: await ctx.db
              .query("pageLocalePublicationStates")
              .withIndex("by_pageId_and_locale", (q) =>
                q.eq("pageId", id).eq("locale", "en")
              )
              .unique(),
            shared: await ctx.db
              .query("pageSharedDrafts")
              .withIndex("by_pageId", (q) => q.eq("pageId", id))
              .unique(),
          }))
        const before = await readRows()
        expect(before.draft).toBeNull()
        expect(before.state?.draftGeneration).toBe(2)
        render(
          tab(
            { ...pageOf("Tab one saved"), _id: id },
            {
              authority: "snapshot_active",
              lifecycleGeneration: 1,
              sharedDraftGeneration: 1,
              locales: [
                {
                  locale: "en",
                  draftGeneration: 2,
                  publicGeneration: 1,
                  releaseGeneration: 1,
                },
              ],
            }
          )
        )
        await restore()
        // Real mutation, not a mocked STALE throw: acceptance would persist data.
        mocks.saveDraft.mockImplementation((args) =>
          owner.mutation(api.cms.publication.saveEditorDraft, args)
        )
        mocks.confirm.mockResolvedValue(false)
        await save()
        expect(mocks.confirm).toHaveBeenCalledOnce()
        expect(sent().localized.expectedGeneration).toBe(1)
        expect(toast.error).toHaveBeenCalledWith("This page changed elsewhere")
        expect(await readRows()).toEqual(before)
      }
    )

    test(
      "ED1REC shared-only write refuses a locale-stale recovery",
      sliceProfile([]),
      async () => {
        writeRecoveryDraft(pageId, {
          ...recovered({
            draftGeneration: 4,
            sharedDraftGeneration: 6,
            lifecycleGeneration: 3,
          }),
          title: "Their title",
        } as never)
        render(tab(pageOf("Their title"), states({ en: 5, shared: 6 })))
        await restore()
        mocks.saveDraft.mockRejectedValue(
          new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
        )
        mocks.confirm.mockResolvedValue(false)
        await save()
        expect(sent().localized).toBeUndefined()
        expect(sent()).toMatchObject({
          expectedLifecycleGeneration: -1,
          shared: { expectedGeneration: 6 },
        })
        expect(mocks.confirm).toHaveBeenCalledOnce()
      }
    )

    test(
      "ED1REC target locale-only write refuses a shared-stale recovery",
      sliceProfile([]),
      async () => {
        writeRecoveryDraft(pageId, {
          ...recovered({
            draftGeneration: 5,
            sharedDraftGeneration: 5,
            lifecycleGeneration: 3,
          }),
          seoOgTitle: "",
        } as never)
        render(
          <PageEditor
            page={pageOf("Their title")}
            publication={states({ en: 5, shared: 6 })}
            hasStaging={false}
            stagingUpdatedAt={undefined}
            targetDraftLocale="en"
          />
        )
        await restore()
        mocks.targetSave.mockRejectedValue(
          new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
        )
        mocks.confirm.mockResolvedValue(false)
        await save()
        expect(mocks.targetSave).toHaveBeenCalledWith(
          expect.objectContaining({
            expectedDraftGeneration: 5,
            expectedLifecycleGeneration: -1,
          })
        )
        expect(mocks.sharedSave).not.toHaveBeenCalled()
        expect(mocks.confirm).toHaveBeenCalledOnce()
      }
    )

    test.each([1, 2, 3, 4, 5, 6, 7])(
      "refusal-provenance-outlives-restored-content (case %s)",
      sliceProfile([]),
      async (which) => {
        const identity = {
          subject: "lifetime-owner",
          tokenIdentifier: "https://convex.test|lifetime-owner",
        }
        const t = convexTest({
          schema,
          modules: import.meta.glob("../../convex/**/*.ts"),
          ownerIdentity: identity,
          publicationAuthority: "missing",
        })
        const owner = t.withIdentity(identity)
        await owner.mutation(
          api.cms.publication.initializeEmptySnapshotAuthority,
          {}
        )
        const id = await owner.mutation(api.cms.pages.create, {
          pageType: "page",
          status: "draft",
          slug: "about",
          content: {
            en: { title: "Their title", slices: [] },
            fr: { title: "Bonjour", slices: [] },
            de: { title: "Guten Tag", slices: [] },
          },
        })
        let content = {
          en: { title: "Their title", slices: [] },
          fr: { title: "Bonjour", slices: [] },
          de: { title: "Guten Tag", slices: [] },
        }
        let pub = {
          authority: "snapshot_active" as const,
          lifecycleGeneration: 3,
          sharedDraftGeneration: 6,
          locales: [
            {
              locale: "en",
              draftGeneration: 5,
              publicGeneration: 1,
              releaseGeneration: 1,
            },
            {
              locale: "fr",
              draftGeneration: 7,
              publicGeneration: 1,
              releaseGeneration: 1,
            },
            {
              locale: "de",
              draftGeneration: 9,
              publicGeneration: 1,
              releaseGeneration: 1,
            },
          ],
        }
        let updatedAt = 100
        await t.run(async (ctx) => {
          await ctx.db.insert("siteSettings", {
            siteName: "Lifetime",
            siteUrl: "",
            defaultLocale: "en",
            enabledLocales: ["en", "fr", "de"],
            updatedAt: 100,
          })
          const shared = await ctx.db
            .query("pageSharedDrafts")
            .withIndex("by_pageId", (q) => q.eq("pageId", id))
            .unique()
          const life = await ctx.db
            .query("pagePublicationPageStates")
            .withIndex("by_pageId", (q) => q.eq("pageId", id))
            .unique()
          await ctx.db.patch("pageSharedDrafts", shared!._id, { generation: 6 })
          await ctx.db.patch("pagePublicationPageStates", life!._id, {
            lifecycleGeneration: 3,
          })
          for (const [locale, generation] of [
            ["en", 5],
            ["fr", 7],
            ["de", 9],
          ] as const) {
            const state = await ctx.db
              .query("pageLocalePublicationStates")
              .withIndex("by_pageId_and_locale", (q) =>
                q.eq("pageId", id).eq("locale", locale)
              )
              .unique()
            const draft = await ctx.db
              .query("pageLocaleDrafts")
              .withIndex("by_pageId_and_locale", (q) =>
                q.eq("pageId", id).eq("locale", locale)
              )
              .unique()
            await ctx.db.patch("pageLocalePublicationStates", state!._id, {
              draftGeneration: generation,
              publicGeneration: 1,
              releaseGeneration: 1,
            })
            await ctx.db.patch("pageLocaleDrafts", draft!._id, { generation })
          }
        })
        const rows = () =>
          t.run(async (ctx) => ({
            drafts: await ctx.db
              .query("pageLocaleDrafts")
              .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", id))
              .collect(),
            shared: await ctx.db
              .query("pageSharedDrafts")
              .withIndex("by_pageId", (q) => q.eq("pageId", id))
              .unique(),
          }))
        const props = () => ({
          page: { ...page(), _id: id, content, updatedAt } as Page,
          publication: pub,
          hasStaging: false,
          stagingUpdatedAt: undefined,
        })
        const clock = vi.spyOn(Date, "now").mockReturnValue(2000)
        const seam = vi.spyOn(pageSaveHook, "usePageSave")
        mocks.enabledLocales = ["en", "fr", "de"]
        mocks.historyInstalled = true
        mocks.strictWrites = true
        mocks.saveDraft.mockImplementation((args) =>
          owner.mutation(api.cms.publication.saveEditorDraft, args)
        )
        mocks.confirm.mockResolvedValue(true)
        writeRecoveryDraft(id, {
          ...recovered({
            draftGeneration: 4,
            sharedDraftGeneration: 6,
            lifecycleGeneration: 3,
          }),
          savedAt: 1500,
          title: which === 6 ? "Their title" : "My recovered words",
          seoOgTitle: "",
        } as never)
        if (which === 5)
          writeRecoveryDraft(id, {
            ...recovered({
              draftGeneration: 6,
              sharedDraftGeneration: 5,
              lifecycleGeneration: 3,
            }),
            savedAt: 1500,
            locale: "fr",
            title: "French recovered",
            slug: "bonjour",
            seoOgTitle: "Recovered social",
          } as never)
        let view = render(<PageEditor {...props()} />)
        const language = (name: RegExp) =>
          fireEvent.click(screen.getByRole("tab", { name }))
        const doHistory = async (locale: "en" | "fr" | "de") => {
          clock.mockReturnValue(3000)
          await t.run(async (ctx) => {
            const state = await ctx.db
              .query("pageLocalePublicationStates")
              .withIndex("by_pageId_and_locale", (q) =>
                q.eq("pageId", id).eq("locale", locale)
              )
              .unique()
            const draft = await ctx.db
              .query("pageLocaleDrafts")
              .withIndex("by_pageId_and_locale", (q) =>
                q.eq("pageId", id).eq("locale", locale)
              )
              .unique()
            const shared = await ctx.db
              .query("pageSharedDrafts")
              .withIndex("by_pageId", (q) => q.eq("pageId", id))
              .unique()
            await ctx.db.patch("pageLocalePublicationStates", state!._id, {
              draftGeneration: state!.draftGeneration + 1,
            })
            await ctx.db.patch("pageLocaleDrafts", draft!._id, {
              generation: draft!.generation + 1,
              content: { title: "History " + locale, slices: [] },
            })
            await ctx.db.patch("pageSharedDrafts", shared!._id, {
              generation: 7,
            })
          })
          pub = {
            ...pub,
            sharedDraftGeneration: 7,
            locales: pub.locales.map((entry) =>
              entry.locale === locale
                ? { ...entry, draftGeneration: entry.draftGeneration + 1 }
                : entry
            ),
          }
          content = {
            ...content,
            [locale]: { title: "History " + locale, slices: [] },
          }
          updatedAt = 3000
          return {
            locale,
            draftGeneration: locale === "en" ? 6 : locale === "fr" ? 8 : 10,
            sharedDraftGeneration: 7,
            updatedAt: 3000,
          }
        }
        const startHistory = async () => {
          fireEvent.click(screen.getByTitle("History"))
          const button = screen.getByRole("button", { name: "Restore draft" })
          expect(button).toBeEnabled()
          await act(async () => fireEvent.click(button))
        }
        try {
          if (which === 5) {
            // Begin from a clean third language. During the real asynchronous
            // History command, two other language buffers acquire protection.
            language(/deutsch/i)
            let release!: () => void
            const pending = new Promise<void>((resolve) => {
              release = resolve
            })
            mocks.snapshotRestore.mockImplementation(async () => {
              await pending
              return doHistory("de")
            })
            await startHistory()
            await waitFor(() =>
              expect(mocks.snapshotRestore).toHaveBeenCalledOnce()
            )
            language(/english/i)
            await restore()
            language(/français/i)
            await restore()
            await act(async () => release())
            view.rerender(<PageEditor {...props()} />)
            await waitFor(() =>
              expect(screen.getByLabelText("Page title")).toHaveValue(
                "French recovered"
              )
            )
          } else {
            await restore()
            if (which === 1) {
              const storageWrites = vi.spyOn(Storage.prototype, "setItem")
              language(/français/i)
              const captures = storageWrites.mock.calls
                .filter(([key]) => key === recoveryKey(id, "en"))
                .map(([, value]) => JSON.parse(value))
              storageWrites.mockRestore()
              expect(captures.length).toBeGreaterThan(0)
              for (const capture of captures)
                expect(capture.base).toEqual({
                  draftGeneration: 4,
                  sharedDraftGeneration: 6,
                  lifecycleGeneration: -1,
                })
              expect(
                JSON.parse(
                  window.sessionStorage.getItem(recoveryKey(id, "en"))!
                )
              ).not.toHaveProperty("refusalBase")
              expect(readRecoveryDraft(id, "en")?.base).toEqual({
                draftGeneration: 4,
                sharedDraftGeneration: 6,
                lifecycleGeneration: -1,
              })
              language(/english/i)
              fireEvent.click(screen.getByRole("button", { name: "Discard" }))
            }
            if (which === 2 || which === 3 || which === 6) {
              if (which !== 6) language(/français/i)
              mocks.snapshotRestore.mockImplementation(() =>
                doHistory(which === 6 ? "en" : "fr")
              )
              await startHistory()
              expect(mocks.snapshotRestore).toHaveBeenCalledOnce()
              view.rerender(<PageEditor {...props()} />)
              await waitFor(() =>
                expect(screen.getByLabelText("Page title")).toHaveValue(
                  which === 6 ? "History en" : "History fr"
                )
              )
              if (which !== 6) {
                language(/english/i)
                expect(
                  screen.queryByRole("button", { name: "Restore" })
                ).toBeNull()
                expect(
                  seam.mock.calls.at(-1)![0].retainedSharedDraft
                ).toBeUndefined()
              } else type("Page title", "After History")
            }
            if (which === 3) {
              clock.mockReturnValue(4000)
              act(() => window.dispatchEvent(new Event("pagehide")))
              const payload = readRecoveryDraft(id, "en")!
              expect(payload.savedAt).toBeGreaterThan(updatedAt)
              expect(payload.base).toEqual({
                draftGeneration: 4,
                sharedDraftGeneration: 6,
                lifecycleGeneration: -1,
              })
              view.unmount()
              view = render(<PageEditor {...props()} />)
              await restore()
            }
            if (which === 4) {
              await save()
              expect(mocks.createPage).toHaveBeenCalledOnce()
              clock.mockReturnValue(4000)
              view.unmount()
              expect(readRecoveryDraft(id, "en")?.base).toEqual({
                draftGeneration: 4,
                sharedDraftGeneration: 6,
                lifecycleGeneration: -1,
              })
              view = render(<PageEditor {...props()} />)
              await restore()
              mocks.saveDraft.mockClear()
            }
            if (which === 7) {
              language(/français/i)
              type("Page title", "Fresh French")
            }
          }
          const before = await rows()
          mocks.confirm.mockClear().mockResolvedValue(false)
          mocks.saveDraft.mockClear()
          if (which === 5) language(/english/i)
          await save()
          expect(mocks.saveDraft).toHaveBeenCalledOnce()
          expect(sent()).toMatchObject(
            which === 6
              ? {
                  expectedLifecycleGeneration: 3,
                  localized: { expectedGeneration: 6 },
                }
              : which === 7
                ? {
                    expectedLifecycleGeneration: 3,
                    localized: { locale: "fr", expectedGeneration: 7 },
                  }
                : {
                    expectedLifecycleGeneration: -1,
                    localized: { locale: "en", expectedGeneration: 4 },
                  }
          )
          if (which <= 5) {
            if (which === 5) expect(sent().shared.expectedGeneration).toBe(5)
            expect(mocks.confirm).toHaveBeenCalledOnce()
            expect(await rows()).toEqual(before)
            if (which === 5) {
              language(/français/i)
              mocks.saveDraft.mockClear()
              await save()
              expect(mocks.saveDraft).toHaveBeenCalledOnce()
              expect(sent()).toMatchObject({
                expectedLifecycleGeneration: -1,
                localized: { locale: "fr", expectedGeneration: 6 },
                shared: { expectedGeneration: 5 },
              })
              expect(await rows()).toEqual(before)
            }
          } else {
            expect(mocks.confirm).not.toHaveBeenCalled()
            expect(
              (await rows()).drafts.find(
                (d) => d.locale === (which === 6 ? "en" : "fr")
              )?.content.title
            ).toBe(which === 6 ? "After History" : "Fresh French")
          }
          expect(mocks.unlistedWrite).not.toHaveBeenCalled()
        } finally {
          view.unmount()
          seam.mockRestore()
          clock.mockRestore()
          mocks.strictWrites = false
        }
      }
    )

    test.each([
      "Trash",
      "Archive",
      "Restore from archive",
      "Unpublish",
      "Discard",
    ] as const)(
      "non-save-commands-after-stale-restore-match-eb31c9dc (%s)",
      sliceProfile([]),
      async (command) => {
        mocks.strictWrites = true
        mocks.historyInstalled = true
        const hook = vi.spyOn(pageSaveHook, "usePageSave")
        try {
          writeRecoveryDraft(
            pageId,
            recovered({
              draftGeneration: 4,
              sharedDraftGeneration: 5,
              lifecycleGeneration: 2,
            }) as never
          )
          render(
            <PageEditor
              page={{
                ...pageOf("Their title"),
                status:
                  command === "Trash" || command === "Restore from archive"
                    ? "archived"
                    : "published",
                publishedAt: 50,
              }}
              hasStaging={true}
              stagingUpdatedAt={100}
              publication={{
                ...states({ en: 5, shared: 6 }),
                locales: [
                  {
                    locale: "en",
                    draftGeneration: 5,
                    publicGeneration: 2,
                    releaseGeneration: 1,
                    currentSnapshotId:
                      "snapshot-1" as Id<"pagePublishedSnapshots">,
                  },
                ],
              }}
            />
          )
          await restore()
          fireEvent.click(screen.getByTitle("History"))
          const historyBeforeCommand =
            mocks.slotProps.at(-1)!.readSnapshotRestore!()
          // This is the real hook's returned command, bound to the real editor
          // adapter; the hook and every command handler run without replacement.
          const handlers = hook.mock.results.at(-1)!.value as ReturnType<
            typeof pageSaveHook.usePageSave
          >
          if (command === "Trash") {
            fireEvent.click(screen.getByTitle("Settings"))
            await act(async () =>
              fireEvent.click(
                screen.getByRole("button", { name: "Move to trash" })
              )
            )
          } else {
            await act(async () => {
              if (command === "Archive") await handlers.archive()
              if (command === "Restore from archive") await handlers.unarchive()
              if (command === "Unpublish") await handlers.unpublish()
              if (command === "Discard") await handlers.discard()
            })
          }
          const called =
            command === "Trash"
              ? mocks.softDeletePage
              : command === "Archive"
                ? mocks.archivePage
                : command === "Restore from archive"
                  ? mocks.restorePage
                  : command === "Unpublish"
                    ? mocks.withdrawLocale
                    : mocks.discardLocale
          // Literals derived from eb31c9dc's held base, never the recovery base.
          expect(called).toHaveBeenCalledExactlyOnceWith(
            command === "Unpublish"
              ? {
                  pageId,
                  locale: "en",
                  expectedSnapshotId: "snapshot-1",
                  expectedPublicGeneration: 2,
                  expectedLifecycleGeneration: 3,
                }
              : command === "Discard"
                ? {
                    pageId,
                    locale: "en",
                    expectedDraftGeneration: 5,
                    expectedLifecycleGeneration: 3,
                  }
                : { pageId, expectedLifecycleGeneration: 3 }
          )
          expect(historyBeforeCommand).toEqual({
            expectedDraftGeneration: 5,
            expectedSharedDraftGeneration: 6,
            expectedLifecycleGeneration: 3,
            expectedPublicGeneration: 2,
            expectedReleaseGeneration: 1,
          })
          expect(mocks.unlistedWrite).not.toHaveBeenCalled()
          expect(mocks.saveDraft).not.toHaveBeenCalled()
          expect(toast.error).not.toHaveBeenCalled()
        } finally {
          hook.mockRestore()
          mocks.strictWrites = false
        }
      }
    )

    test(
      "ED1REC legacy restore keeps the original staging expectation",
      sliceProfile([]),
      async () => {
        writeRecoveryDraft(
          pageId,
          recovered({
            draftGeneration: 4,
            sharedDraftGeneration: 6,
            lifecycleGeneration: 3,
          }) as never
        )
        render(
          <PageEditor
            page={pageOf("About")}
            hasStaging={true}
            stagingUpdatedAt={77}
          />
        )
        await restore()
        act(() => window.dispatchEvent(new Event("pagehide")))
        expect(readRecoveryDraft(pageId, "en")?.base).toBeNull()
        await save()
        expect(mocks.legacyDraft).toHaveBeenCalledWith(
          expect.objectContaining({ expectedUpdatedAt: 77 })
        )
        expect(mocks.saveDraft).not.toHaveBeenCalled()
        expect(mocks.confirm).not.toHaveBeenCalled()
      }
    )
  })

  describe("recovery after a conflict", () => {
    const copy = (title: string, seoOgTitle = "") => ({
      base: {
        draftGeneration: 2,
        sharedDraftGeneration: 4,
        lifecycleGeneration: 3,
      },
      locale: "en",
      savedAt: 500,
      title,
      slug: "about",
      pageType: "page" as const,
      parentId: "",
      authorIds: [],
      tags: [],
      metaTitle: "",
      metaDescription: "",
      slices: [],
      seoNoIndex: false,
      seoNoFollow: false,
      seoOgTitle,
      seoOgDescription: "",
      seoOgImage: "",
      sharedFieldValues: {},
      localizedFieldValues: {},
    })

    test(
      "E1-7a after a reload and a restore, a new write by the other tab is still refused",
      sliceProfile([]),
      async () => {
        writeRecoveryDraft(pageId, copy("My unsaved words"))
        // The reload mounts with B's generations (en 5, shared 6).
        const view = render(
          tab(pageOf("Their title"), states({ en: 5, shared: 6 }))
        )
        await act(async () =>
          fireEvent.click(screen.getByRole("button", { name: "Restore" }))
        )
        expect(screen.getByLabelText("Page title")).toHaveValue(
          "My unsaved words"
        )
        view.rerender(tab(pageOf("Newest"), states({ en: 9, shared: 6 })))
        await save()
        expect(localizedOf(sent())).toMatchObject({
          expectedGeneration: 2,
          draft: { localized: { title: "My unsaved words" } },
        })
      }
    )

    test(
      "E1-7b after a reload, the restored save is based on the recovery's recorded generations and addresses only the loaded language and shared fields",
      sliceProfile([]),
      async () => {
        // The copy also differs in a shared field (SEO), so the save has a
        // shared half whose base must be the recorded one, never the reload's.
        writeRecoveryDraft(
          pageId,
          copy("My unsaved words", "Copy social title")
        )
        render(tab(pageOf("Their title"), states({ en: 5, shared: 6 })))
        await act(async () =>
          fireEvent.click(screen.getByRole("button", { name: "Restore" }))
        )
        await save()
        expect(mocks.saveDraft).toHaveBeenCalledOnce()
        expect(sent()).toMatchObject({
          expectedLifecycleGeneration: -1,
          localized: {
            locale: "en",
            expectedGeneration: 2,
            draft: { localized: { title: "My unsaved words" } },
          },
          shared: {
            expectedGeneration: 4,
            seo: { ogTitle: "Copy social title" },
          },
        })
        expect(Object.keys(sent()).sort()).toEqual([
          "expectedLifecycleGeneration",
          "localized",
          "pageId",
          "shared",
        ])
      }
    )

    test(
      "E1-7c a restore without a reload keeps the old base, so the save is refused",
      sliceProfile([]),
      async () => {
        writeRecoveryDraft(
          pageId,
          copy("My unsaved words", "Copy social title")
        )
        const view = render(tab(pageOf("About"), states({})))
        // B saved; this tab refreshed but did not reload.
        view.rerender(tab(pageOf("Their title"), states({ en: 7, shared: 9 })))
        await act(async () =>
          fireEvent.click(screen.getByRole("button", { name: "Restore" }))
        )
        await save()
        // Both halves carry the generations this tab loaded; the server
        // refuses them (it holds en 7 and shared 9).
        expect(localizedOf(sent())).toMatchObject({ expectedGeneration: 2 })
        expect(sent().shared).toMatchObject({ expectedGeneration: 4 })
      }
    )

    describe("a refused Save while the recovered draft waits", () => {
      const refusal =
        "Restore or discard the recovered draft before saving or publishing."
      const bar = () =>
        screen.getByRole("button", { name: "Restore" }).closest(".bg-sky-50")
      const refusalAlert = () =>
        screen
          .queryAllByRole("alert")
          .find((node) => node.textContent === refusal)

      test(
        "shows no refusal and no outline before anything is refused",
        sliceProfile([]),
        async () => {
          writeRecoveryDraft(pageId, copy("My unsaved words"))
          render(tab(pageOf("About"), states({})))
          expect(bar()).not.toBeNull()
          expect(refusalAlert()).toBeUndefined()
          expect(bar()!.className).not.toContain("ring-2")
        }
      )

      test(
        "keeps the refusal inside the outlined bar instead of a toast",
        sliceProfile([]),
        async () => {
          writeRecoveryDraft(pageId, copy("My unsaved words"))
          render(tab(pageOf("About"), states({})))
          type("Page title", "Typing while the bar waits")
          await save()
          expect(toast.error).not.toHaveBeenCalled()
          const alert = refusalAlert()
          expect(alert).toBeDefined()
          expect(bar()!.contains(alert!)).toBe(true)
          expect(bar()!.className).toContain("ring-2")
          expect(mocks.saveDraft).not.toHaveBeenCalled()
        }
      )

      test.each(["Discard", "Restore"])(
        "removes the bar and its refusal after %s, and Save works again",
        sliceProfile([]),
        async (choice) => {
          writeRecoveryDraft(pageId, copy("My unsaved words"))
          render(tab(pageOf("About"), states({})))
          type("Page title", "Typing while the bar waits")
          await save()
          expect(refusalAlert()).toBeDefined()
          await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: choice }))
          )
          expect(
            screen.queryByRole("button", { name: "Restore" })
          ).not.toBeInTheDocument()
          expect(screen.queryByText(refusal)).not.toBeInTheDocument()
          type("Page title", "Saved after the choice")
          await save()
          expect(mocks.saveDraft).toHaveBeenCalledOnce()
          expect(screen.queryByText(refusal)).not.toBeInTheDocument()
        }
      )

      test(
        "hides the save shortcut hint only while the recovered draft waits",
        sliceProfile([]),
        async () => {
          writeRecoveryDraft(pageId, copy("My unsaved words"))
          render(tab(pageOf("About"), states({})))
          type("Page title", "Typing while the bar waits")
          expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
          expect(screen.queryByText(/to save\)$/)).not.toBeInTheDocument()
          await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: "Discard" }))
          )
          type("Page title", "Typing after the choice")
          expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
          expect(screen.getByText(/to save\)$/)).toBeInTheDocument()
        }
      )
    })
  })

  test(
    "E1-8 a single tab keeps saving, publishing and restoring after refreshes that carry its own results",
    sliceProfile([]),
    async () => {
      const view = render(tab(pageOf("About"), states({})))
      type("Page title", "One")
      await save()
      // Refresh with our own result.
      view.rerender(tab(pageOf("One"), states({ en: 3 })))
      mocks.saveDraft.mockResolvedValueOnce({
        updatedAt: 102,
        draftGeneration: 4,
        sharedDraftGeneration: 4,
      })
      type("Page title", "Two")
      await save()
      expect(localizedOf(sent())).toMatchObject({ expectedGeneration: 3 })
      view.rerender(tab(pageOf("Two"), states({ en: 4 })))
      // Publish uses the base this tab saved to.
      mocks.convex.query.mockImplementation(async (reference?: unknown) =>
        getFunctionName(reference as never) ===
        "cms/pages:getPrePublishChecklist"
          ? { canPublish: true, blockers: [], warnings: [] }
          : []
      )
      mocks.publish.mockResolvedValueOnce({
        publicGeneration: 2,
        snapshotId: "snapshot-2",
        publishedAt: 200,
      })
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: /^Publish/ }))
      )
      await waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce())
      expect(mocks.publish.mock.calls[0]![0]).toMatchObject({
        expectedDraftGeneration: 4,
        expectedSharedDraftGeneration: 4,
        expectedPublicGeneration: 1,
        expectedLifecycleGeneration: 3,
        expectedReleaseGeneration: 1,
      })
      // History restore uses the same base, including the publish result.
      fireEvent.click(screen.getByTitle("History"))
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Restore draft" }))
      )
      expect(mocks.snapshotRestore).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedDraftGeneration: 4,
          expectedPublicGeneration: 2,
          expectedReleaseGeneration: 2,
        })
      )
    }
  )

  test(
    "E1-9 deleting the retained target draft drops that language's cached buffer and base",
    sliceProfile([]),
    async () => {
      mocks.enabledLocales = ["en", "fr"]
      mocks.retainedTargetRemedy = {
        transitionId: "transition1",
        pageId,
        locale: "fr",
        draftGeneration: 5,
        lifecycleGeneration: 3,
      }
      render(tab(pageOf("About", "Brouillon"), states({ fr: 5 })))
      fireEvent.click(screen.getByRole("tab", { name: /français/i }))
      type("Page title", "Mon fr")
      fireEvent.click(screen.getByRole("tab", { name: /english/i }))
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", { name: "Delete Français Working Draft" })
        )
      )
      await waitFor(() => expect(mocks.deleteTarget).toHaveBeenCalledOnce())
      // Production sequence: nothing refreshes the page after the deletion.
      expect(mocks.refresh).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole("tab", { name: /français/i }))
      // The revisit loads from the payload, not from the cached buffer.
      expect(screen.getByLabelText("Page title")).toHaveValue("Brouillon")
      // The browser copy of the old typing is a separate, explicit choice.
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Discard" }))
      )
      // The payload is stale (the server holds fr 8), so the save carries fr 5
      // and the server refuses it: the tab keeps its typing and the conflict
      // dialog is offered. The stored draft is untouched by a refused save.
      mocks.saveDraft.mockRejectedValueOnce(
        new ConvexError("PAGE_LOCALE_DRAFT_STALE")
      )
      mocks.confirm.mockResolvedValueOnce(false)
      type("Page title", "Nouveau")
      await save()
      expect(localizedOf(sent())).toMatchObject({
        locale: "fr",
        expectedGeneration: 5,
      })
      expect(toast.error).toHaveBeenCalledWith("This page changed elsewhere")
      expect(screen.getByLabelText("Page title")).toHaveValue("Nouveau")
      expect(mocks.refresh).not.toHaveBeenCalled()
    }
  )

  test(
    "E1-10 a tab opened before a legacy-to-snapshot cutover refuses Save and History through the stale path and keeps its typing",
    sliceProfile([]),
    async () => {
      const view = render(
        <PageEditor
          page={pageOf("About")}
          hasStaging={false}
          stagingUpdatedAt={undefined}
        />
      )
      // The cutover happens while the tab is open; the next refresh delivers a
      // publication payload this tab never loaded content from.
      view.rerender(tab(pageOf("Their title"), states({ en: 7, shared: 9 })))
      type("Page title", "Unsaved words")
      mocks.confirm.mockResolvedValueOnce(false)
      await save()
      expect(mocks.saveDraft).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith("This page changed elsewhere")
      expect(mocks.confirm).toHaveBeenCalledOnce()
      expect(screen.getByLabelText("Page title")).toHaveValue("Unsaved words")
      act(() => window.dispatchEvent(new Event("pagehide")))
      expect(readRecoveryDraft(pageId, "en")?.title).toBe("Unsaved words")
      // History: no base, so no restore request is made from the prop.
      fireEvent.click(screen.getByTitle("History"))
      expect(mocks.slotProps.at(-1)!.readSnapshotRestore!()).toBeUndefined()
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Restore draft" }))
      )
      expect(mocks.snapshotRestore).not.toHaveBeenCalled()
    }
  )

  test.each(["Restore draft", "Publish", "Archive", "Move to trash"])(
    "P3-1 a clean cutover tab refuses %s before any publication write",
    sliceProfile([]),
    async (action) => {
      mocks.strictWrites = true
      mocks.convex.query.mockImplementation(async (reference?: unknown) =>
        getFunctionName(reference as never) ===
        "cms/pages:getPrePublishChecklist"
          ? { canPublish: true, blockers: [], warnings: [] }
          : []
      )
      // Trash is offered only on archived pages. Persisted staging enables
      // Publish without introducing unsaved typing that would disable History.
      const source = {
        ...pageOf("About"),
        status: action === "Move to trash" ? "archived" : "draft",
      } as Page
      const props = {
        page: source,
        hasStaging: true,
        stagingUpdatedAt: 100,
      }
      const view = render(<PageEditor {...props} />)
      try {
        view.rerender(
          <PageEditor {...props} publication={states({ en: 7, shared: 9 })} />
        )
        expect(screen.getByLabelText("Page title")).toHaveValue("About")
        fireEvent.click(screen.getByTitle("History"))
        expect(mocks.slotProps.at(-1)!.restoreDisabled).toBe(false)
        expect(mocks.slotProps.at(-1)!.readSnapshotRestore!()).toBeUndefined()
        expect(
          screen.getByRole("button", { name: "Restore draft" })
        ).toBeEnabled()

        if (action === "Archive" || action === "Move to trash")
          fireEvent.click(screen.getByTitle("Settings"))
        const button = screen.getByRole("button", {
          name: action === "Archive" ? "Archive page" : action,
        })
        expect(button).toBeEnabled()
        await act(async () => fireEvent.click(button))
        expect(mocks.publish).not.toHaveBeenCalled()
        expect(mocks.archivePage).not.toHaveBeenCalled()
        expect(mocks.softDeletePage).not.toHaveBeenCalled()
        expect(mocks.snapshotRestore).not.toHaveBeenCalled()
        expect(mocks.updateAdapter).not.toHaveBeenCalled()
        expect(mocks.saveDraft).not.toHaveBeenCalled()
        expect(mocks.deleteTarget).not.toHaveBeenCalled()
        expect(mocks.unlistedWrite).not.toHaveBeenCalled()
        if (action === "Restore draft")
          expect(mocks.confirm).not.toHaveBeenCalled()
        if (action === "Move to trash")
          expect(mocks.confirm).toHaveBeenCalledOnce()
        // Observe the handler's refusal, so an enabled-looking control that
        // never reaches its handler cannot satisfy the no-write assertions.
        await waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
      } finally {
        mocks.strictWrites = false
      }
    }
  )

  describe("translation writers", () => {
    const mountWithTranslation = () => {
      mocks.enabledLocales = ["en", "fr"]
      const props = (
        pageProp: Page,
        publicationProp: ReturnType<typeof states>
      ) => (
        <PageEditor
          page={pageProp}
          hasStaging={false}
          stagingUpdatedAt={undefined}
          publication={publicationProp}
          aiTranslationRouteData={
            { mechanicalTranslation: {}, brandTranslation: {} } as never
          }
        />
      )
      return {
        props,
        view: render(props(pageOf("About", "Français"), states({ fr: 5 }))),
      }
    }

    test(
      "a source read from the page prop adopts that language's base from the same payload",
      sliceProfile([]),
      async () => {
        const { props, view } = mountWithTranslation()
        view.rerender(props(pageOf("About", "Leur fr"), states({ fr: 6 })))
        const read = mocks.translation!.readSourceContent("fr")
        expect(read.title).toBe("Leur fr")
        fireEvent.click(screen.getByRole("tab", { name: /français/i }))
        expect(screen.getByLabelText("Page title")).toHaveValue("Leur fr")
        type("Page title", "Après leur fr")
        await save()
        expect(localizedOf(sent())).toMatchObject({
          locale: "fr",
          expectedGeneration: 6,
        })
      }
    )

    test(
      "a cached language keeps its base when it is read again as a source",
      sliceProfile([]),
      async () => {
        const { props, view } = mountWithTranslation()
        fireEvent.click(screen.getByRole("tab", { name: /français/i }))
        type("Page title", "Mon fr")
        fireEvent.click(screen.getByRole("tab", { name: /english/i }))
        view.rerender(props(pageOf("About", "Leur fr"), states({ fr: 6 })))
        mocks.translation!.readSourceContent("fr")
        fireEvent.click(screen.getByRole("tab", { name: /français/i }))
        await keepBrowserCopy()
        expect(screen.getByLabelText("Page title")).toHaveValue("Mon fr")
        type("Page title", "Mon fr 2")
        await save()
        expect(localizedOf(sent())).toMatchObject({
          locale: "fr",
          expectedGeneration: 5,
        })
      }
    )

    test(
      "a stored translation keeps the older base, never the refresh's",
      sliceProfile([]),
      async () => {
        const { props, view } = mountWithTranslation()
        view.rerender(props(pageOf("About", "Leur fr"), states({ fr: 6 })))
        mocks.translation!.storeDraft("fr", {
          title: "Traduit",
          slug: "traduit",
          slugLinked: false,
          metaTitle: "",
          metaDescription: "",
          slices: [],
          localizedFieldValues: {},
        })
        fireEvent.click(screen.getByRole("tab", { name: /français/i }))
        expect(screen.getByLabelText("Page title")).toHaveValue("Traduit")
        type("Page title", "Traduit 2")
        await save()
        expect(localizedOf(sent())).toMatchObject({
          locale: "fr",
          expectedGeneration: 5,
        })
      }
    )
  })

  // S2 review round 1: a Translation Accept reloads its target tab through the
  // History remount. The reload starts at the press and completes after the
  // server save; typing during either wait and the open tab are preserved.
  describe("Translation Accept reloads the target tab", () => {
    const french = /français/i
    const english = /english/i
    const editor = (
      pageProp: Page,
      publicationProp: ReturnType<typeof states>
    ) => (
      <PageEditor
        page={pageProp}
        hasStaging={false}
        stagingUpdatedAt={undefined}
        publication={publicationProp}
        aiTranslationRouteData={
          { mechanicalTranslation: {}, brandTranslation: {} } as never
        }
      />
    )
    // French is empty and has no draft yet.
    const mount = () => {
      mocks.enabledLocales = ["en", "fr"]
      return render(editor(pageOf("About"), states({})))
    }
    // The server saved the translation as French draft 1; the refresh that
    // carries it arrives when the test re-renders.
    const translated = () =>
      editor(pageOf("About", "Traduit"), states({ fr: 1 }))
    const openTab = (name: RegExp) =>
      fireEvent.click(screen.getByRole("tab", { name }))
    // What the review does when Accept is pressed: start, then save the tab.
    const pressAccept = async () => {
      let reload!: { complete(draftGeneration: number): void }
      act(() => {
        reload = mocks.translation!.beginSavedLanguage!("fr")
      })
      await act(async () => {
        expect(await mocks.translation!.ensureSaved()).toBe(true)
      })
      return reload
    }
    const typeFrench = () => {
      type("Page title", "Mon titre")
      fireEvent.click(screen.getByTitle("SEO"))
      act(() => mocks.seoProps!.onMetaTitleChange("Mon méta"))
    }
    const openLocale = () => mocks.localeTabs!.currentLocale
    const urlLocale = () =>
      new URL(window.location.href).searchParams.get("locale")

    beforeEach(() => {
      mocks.refresh.mockReset()
      window.history.replaceState(null, "", "/admin/pages/page-1")
    })

    test(
      "a: with no later typing the target opens clean with the translation",
      sliceProfile([]),
      async () => {
        const view = mount()
        openTab(french)
        const reload = await pressAccept()
        act(() => reload.complete(1))
        expect(mocks.refresh).toHaveBeenCalledOnce()
        view.rerender(translated())
        expect(openLocale()).toBe("fr")
        expect(screen.getByLabelText("Page title")).toHaveValue("Traduit")
        expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()
        // The reloaded tab saves on the translation's generation.
        type("Page title", "Traduit 2")
        await save()
        expect(localizedOf(sent())).toMatchObject({
          locale: "fr",
          expectedGeneration: 1,
          draft: { localized: { title: "Traduit 2" } },
        })
      }
    )

    test.each(["the save", "the refresh"])(
      "b: target title and meta typed during %s are kept, dirty, on the old base",
      sliceProfile([]),
      async (wait) => {
        const view = mount()
        openTab(french)
        const reload = await pressAccept()
        if (wait === "the save") typeFrench()
        act(() => reload.complete(1))
        if (wait === "the refresh") typeFrench()
        view.rerender(translated())
        expectFrenchKept()
        await refusedAsStale()
      }
    )

    test(
      "b: target text typed before switching away is kept and opened",
      sliceProfile([]),
      async () => {
        const view = mount()
        openTab(french)
        const reload = await pressAccept()
        typeFrench()
        openTab(english)
        act(() => reload.complete(1))
        view.rerender(translated())
        expectFrenchKept()
        await refusedAsStale()
      }
    )

    // The live buffer, read before any browser copy could be restored.
    function expectFrenchKept() {
      expect(openLocale()).toBe("fr")
      expect(screen.getByLabelText("Page title")).toHaveValue("Mon titre")
      fireEvent.click(screen.getByTitle("SEO"))
      expect(mocks.seoProps!.metaTitle).toBe("Mon méta")
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
    }

    // The kept buffer's History base is the one it was typed on, so its Save
    // takes the History conflict flow (use-page-save persistSave) before any
    // write, instead of replacing the translation (draft 1).
    async function refusedAsStale() {
      await keepBrowserCopy()
      mocks.saveDraft.mockClear()
      vi.mocked(toast.error).mockClear()
      await save()
      expect(mocks.saveDraft).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith("This page changed elsewhere")
      expect(screen.getByLabelText("Page title")).toHaveValue("Mon titre")
    }

    test.each([
      [
        "the source tab",
        async () => {
          const reload = await pressAccept()
          // English typed while the Accept waits.
          type("Page title", "About 2")
          return reload
        },
      ],
      [
        "the target tab",
        async () => {
          // English typed before, kept unsaved in its tab.
          type("Page title", "About 2")
          openTab(french)
          return pressAccept()
        },
      ],
    ])(
      "c: Accept pressed from %s opens the target; the source buffer is kept",
      sliceProfile([]),
      async (_, press) => {
        const view = mount()
        const reload = await press()
        act(() => reload.complete(1))
        view.rerender(translated())
        expect(openLocale()).toBe("fr")
        expect(urlLocale()).toBe("fr")
        expect(screen.getByLabelText("Page title")).toHaveValue("Traduit")
        expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
        openTab(english)
        expect(screen.getByLabelText("Page title")).toHaveValue("About 2")
        expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
        await keepBrowserCopy()
        expect(screen.getByLabelText("Page title")).toHaveValue("About 2")
      }
    )

    test.each(["before the save returns", "before the refresh"])(
      "d: switching language %s still reconciles to the target",
      sliceProfile([]),
      async (when) => {
        const view = mount()
        openTab(french)
        const reload = await pressAccept()
        if (when === "before the save returns") openTab(english)
        act(() => reload.complete(1))
        if (when === "before the refresh") openTab(english)
        expect(mocks.refresh).toHaveBeenCalledOnce()
        view.rerender(translated())
        expect(openLocale()).toBe("fr")
        expect(urlLocale()).toBe("fr")
        expect(screen.getByLabelText("Page title")).toHaveValue("Traduit")
        expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
      }
    )

    test(
      "e: shared fields the open tab saves before Accept are not lost",
      sliceProfile([]),
      async () => {
        const view = mount()
        fireEvent.click(screen.getByTitle("SEO"))
        act(() => mocks.seoProps!.onSeoOgTitleChange("Our social title"))
        mocks.saveDraft.mockResolvedValueOnce({
          updatedAt: 101,
          sharedDraftGeneration: 5,
        })
        const reload = await pressAccept()
        expect(sent()).toMatchObject({ shared: { expectedGeneration: 4 } })
        act(() => reload.complete(1))
        view.rerender(
          editor(
            {
              ...pageOf("About", "Traduit"),
              seo: { ogTitle: "Our social title" },
            } as Page,
            states({ fr: 1, shared: 5 })
          )
        )
        expect(openLocale()).toBe("fr")
        fireEvent.click(screen.getByTitle("SEO"))
        expect(mocks.seoProps!.seoOgTitle).toBe("Our social title")
        expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
        // The shared half now saves on the generation its save returned.
        act(() => mocks.seoProps!.onSeoOgTitleChange("Our social title 2"))
        mocks.saveDraft.mockClear()
        await save()
        expect(sent().shared).toMatchObject({ expectedGeneration: 5 })
      }
    )

    test(
      "f: leaving the page before the save returns does nothing",
      sliceProfile([]),
      async () => {
        const view = mount()
        openTab(french)
        const reload = await pressAccept()
        const before = window.location.href
        view.unmount()
        act(() => reload.complete(1))
        expect(mocks.refresh).not.toHaveBeenCalled()
        expect(window.location.href).toBe(before)
      }
    )
  })

  test.each(["rendered", "unrendered"])(
    "F1 a capture that resolves after %s newer typing never overwrites it or its browser copy",
    sliceProfile([]),
    async (timing) => {
      const slice = {
        ...createSampleSlice("hero-with-image"),
        id: "f1-slice",
      }
      const source = {
        ...page(),
        content: { en: { title: "About", slices: [slice] } },
      } as Page
      const actual = pageSaveHook.usePageSave
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const seam = vi
        .spyOn(pageSaveHook, "usePageSave")
        .mockImplementation((options) =>
          actual({
            ...options,
            captureDraft: async (draft, isCurrent) => {
              const captured = await options.captureDraft!(draft, isCurrent)
              await gate
              return captured
            },
          })
        )
      const view = render(tab(source, states({})))
      try {
        type("Page title", "Older title")
        let saving!: Promise<unknown>
        act(() => {
          saving = Promise.resolve(mocks.sliceProps.at(-1)!.onSave())
        })
        const newer = () =>
          mocks.sliceProps.at(-1)!.onSlicesChange(
            mocks.sliceProps.at(-1)!.slices.map((current) => ({
              ...current,
              primary: { ...current.primary, eyebrow: "Newer eyebrow" },
            })) as Slice[]
          )
        if (timing === "rendered") {
          act(() => newer())
          type("Page title", "Newer title")
          await act(async () => {
            release()
            await saving
          })
        } else {
          // Typing lands in the same tick the capture resolves, before React
          // has run the hook's effects.
          await act(async () => {
            newer()
            release()
            await saving
          })
        }
        expect(mocks.saveDraft).not.toHaveBeenCalled()
        expect(
          (mocks.sliceProps.at(-1)!.slices[0]!.primary as { eyebrow?: string })
            .eyebrow
        ).toBe("Newer eyebrow")
        if (timing === "rendered")
          expect(screen.getByLabelText("Page title")).toHaveValue("Newer title")
        act(() => window.dispatchEvent(new Event("pagehide")))
        const copy = readRecoveryDraft(pageId, "en")!
        expect(
          (copy.slices[0] as unknown as { primary: { eyebrow?: string } })
            .primary.eyebrow
        ).toBe("Newer eyebrow")
      } finally {
        view.unmount()
        seam.mockRestore()
      }
    }
  )
})

describe("per-language identifier intent boundaries", () => {
  const boundaries = [
    "saved target",
    "cached target",
    "history remount",
    "recovery typed",
    "recovery generated",
    "recovery legacy",
    "copy",
    "translation active",
    "translation cached",
    "cleared identifier",
  ] as const
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.addressHarness = true
    mocks.strictWrites = false
    mocks.realSidebar = false
    mocks.historyInstalled = false
    mocks.enabledLocales = ["en", "fr"]
    mocks.addressRequests.length = 0
    mocks.settingsProps = null
    mocks.sliceProps.length = 0
    mocks.slotProps.length = 0
    mocks.checklistResult = { canPublish: true, blockers: [], warnings: [] }
    mocks.confirm.mockReset().mockResolvedValue(true)
    mocks.convex.query.mockReset().mockImplementation(async () => [])
    mocks.retainedTargetRemedy = null
    mocks.seoProps = null
    mocks.saveDraft.mockReset().mockImplementation(async (args) => ({
      updatedAt: 501,
      draftGeneration: (args.localized?.expectedGeneration ?? 2) + 1,
    }))
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
  afterEach(() => {
    mocks.addressHarness = false
    mocks.settingsProps = null
  })
  test.each(
    boundaries.flatMap((boundary) =>
      (["en", "fr"] as const).map((locale) => ({ boundary, locale }))
    )
  )(
    "$boundary keeps $locale intent through availability and Save",
    sliceProfile([]),
    async ({ boundary, locale }) => {
      const other = locale === "en" ? "fr" : "en"
      const source = {
        ...page(),
        slug: "contact-2",
        localizedSlugs: { fr: "contact-2" },
        content: {
          en: { title: "Contact", slices: [] },
          fr: { title: "Contact", slices: [] },
        },
      } as Page
      const typedLocale = boundary === "saved target" ? other : locale
      source.content![typedLocale] = { title: "Typed Match", slices: [] }
      if (typedLocale === "en") source.slug = "typed-match"
      else source.localizedSlugs = { fr: "typed-match" }
      if (boundary === "copy") {
        source.content![other] = { title: "Copy Source", slices: [] }
        if (other === "en") source.slug = "copy-source"
        else source.localizedSlugs = { fr: "copy-source" }
      }
      const state = {
        ...publication(),
        locales: [
          publication().locales[0]!,
          { ...publication().locales[0]!, locale: "fr" },
        ],
      }
      const initialLocale =
        boundary === "saved target" || boundary === "history remount"
          ? other
          : locale
      const props = {
        page: source,
        publication: state,
        requestedLocale: initialLocale,
        hasStaging: false,
        stagingUpdatedAt: undefined,
        aiTranslationRouteData: {
          mechanicalTranslation: {},
          brandTranslation: {},
        } as never,
      }
      if (boundary.startsWith("recovery")) {
        writeRecoveryDraft(pageId, {
          locale,
          savedAt: Date.now(),
          title: boundary === "recovery generated" ? "Contact" : "Typed Match",
          slug: boundary === "recovery generated" ? "contact-2" : "typed-match",
          ...(boundary === "recovery legacy"
            ? {}
            : {
                addressWasTyped: boundary === "recovery typed",
                slugLinked: true,
              }),
          pageType: "page",
          parentId: "",
          authorIds: [],
          tags: [],
          metaTitle: "Recovered metadata",
          metaDescription: "",
          slices: [],
          seoNoIndex: false,
          seoNoFollow: false,
          seoOgTitle: "",
          seoOgDescription: "",
          seoOgImage: "",
          sharedFieldValues: {},
          localizedFieldValues: {},
          base: {
            draftGeneration: 2,
            sharedDraftGeneration: 4,
            lifecycleGeneration: 3,
          },
        })
        // The optional metadata is additive to v3; exercise the real reader.
        expect(readRecoveryDraft(pageId, locale)?.version).toBe(3)
      }
      const view = render(<PageEditor {...props} />)
      const settings = () => mocks.settingsProps!
      const openSettings = () => fireEvent.click(screen.getByTitle("Settings"))
      const switchTo = async (target: "en" | "fr") => {
        await act(async () =>
          fireEvent.click(
            screen.getByRole("tab", {
              name: target === "fr" ? /français/i : /english/i,
            })
          )
        )
        openSettings()
      }
      const typeIdentifier = (value: string) =>
        act(() => settings().onSlugChange(value))
      const query = () => mocks.addressRequests.at(-1)!
      const dirtyMeta = () => {
        fireEvent.click(screen.getByTitle("SEO"))
        act(() => mocks.seoProps!.onMetaTitleChange(`Intent proof ${boundary}`))
        openSettings()
      }
      try {
        openSettings()
        if (boundary === "saved target") {
          typeIdentifier("typed-match")
          expect(query().intent).toBe("typed")
          await switchTo(locale)
        } else if (boundary === "history remount") {
          fireEvent.click(screen.getByTitle("History"))
          const restored = mocks.slotProps.at(-1)!.onSnapshotRestored!
          await switchTo(locale)
          typeIdentifier("typed-match")
          act(() =>
            restored({
              locale: other,
              draftGeneration: 3,
              sharedDraftGeneration: 5,
            })
          )
          view.rerender(
            <PageEditor
              {...props}
              publication={{
                ...state,
                sharedDraftGeneration: 5,
                locales: state.locales.map((row) =>
                  row.locale === other ? { ...row, draftGeneration: 3 } : row
                ),
              }}
            />
          )
          openSettings()
        } else if (boundary.startsWith("recovery")) {
          await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: "Restore" }))
          )
          openSettings()
        } else {
          typeIdentifier("typed-match")
          expect(query()).toMatchObject({
            locale,
            slug: "typed-match",
            intent: "typed",
          })
          if (boundary === "cached target") {
            // Equal-to-title input keeps slugLinked=true: only durable intent can distinguish it.
            await switchTo(other)
            typeIdentifier("")
            act(() => settings().onTitleChange("Other generated"))
            await switchTo(locale)
          } else if (boundary === "copy") {
            fireEvent.click(screen.getByTitle("Copy content between locales"))
            await act(async () =>
              fireEvent.click(
                screen.getByRole("button", {
                  name: new RegExp(`^Copy from ${other.toUpperCase()}`),
                })
              )
            )
            openSettings()
          } else if (boundary.startsWith("translation")) {
            expect(
              mocks.translation!.readSourceContent(locale).addressWasTyped
            ).toBe(true)
            if (boundary === "translation cached") {
              await switchTo(other)
              typeIdentifier("other-manual")
            }
            const host = mocks.translation!
            act(() => {
              // Exercise the existing neutral host seam; core retains this test
              // while the optional AI producer is absent from its projection.
              const prepared = host.storeDraft(locale, {
                title: "Translated Contact",
                slug: "translated-contact",
                slugLinked: true,
                metaTitle: "",
                metaDescription: "",
                slices: [],
                localizedFieldValues: {},
              })
              if (host.getActiveLocale() === locale)
                host.applyActiveDraft(prepared)
            })
            if (boundary === "translation cached") {
              expect(settings().addressWasTyped).toBe(true)
              await switchTo(locale)
            }
            openSettings()
          } else if (boundary === "cleared identifier") {
            typeIdentifier("")
            act(() => settings().onTitleChange("Generated Contact"))
          }
        }
        const typed = [
          "cached target",
          "history remount",
          "recovery typed",
        ].includes(boundary)
        const legacy = boundary === "recovery legacy"
        const numbered =
          boundary === "saved target" || boundary === "recovery generated"
        // Observe restored intent before any title edit can intentionally replace the identifier.
        expect(settings().currentLocale).toBe(locale)
        expect(settings().addressWasTyped).toBe(typed)
        expect(query()).toMatchObject({ locale, slug: settings().slug })
        if (typed || legacy) expect(query().intent).toBe("typed")
        else if (!numbered) expect(query().intent).toBe("generated")
        if (numbered) {
          expect(screen.getByText(/Occupied Contact/)).toBeVisible()
          expect(screen.getByText(/Occupied Contact/)).toHaveTextContent(
            locale === "fr" ? "/fr/contact-2" : "/contact-2"
          )
          expect(settings().slugLinked).toBe(true)
        } else
          expect(screen.queryByText(/Occupied Contact/)).not.toBeInTheDocument()
        // Identifier-preserving slice/SEO merges must not change the address intent.
        act(() => mocks.sliceProps.at(-1)!.onSlicesChange([]))
        dirtyMeta()
        act(() => window.dispatchEvent(new Event("pagehide")))
        const recovery = JSON.parse(
          window.sessionStorage.getItem(recoveryKey(pageId, locale))!
        )
        expect(recovery).toMatchObject({ version: 3, addressWasTyped: typed })
        if (boundary.startsWith("recovery"))
          expect(recovery.slugLinked).toBe(!legacy)
        mocks.saveDraft.mockClear()
        await act(async () => mocks.sliceProps.at(-1)!.onSave())
        expect(mocks.saveDraft).toHaveBeenCalledOnce()
        expect(mocks.saveDraft.mock.calls[0]![0].localized).toMatchObject({
          locale,
          slug: settings().slug,
          addressIntent: typed || legacy ? "typed" : "generated",
        })
        const kept = settings().slug
        act(() => settings().onTitleChange("Next Contact"))
        expect(settings().slug).toBe(legacy ? kept : "next-contact")
        expect(settings().addressWasTyped).toBe(false)
        if (!legacy) expect(query().intent).toBe("generated")
      } finally {
        view.unmount()
      }
    }
  )
})

describe("round4 loading availability provenance", () => {
  test(
    "a content-only Save while French availability is pending retains the real reloaded allocation and hint",
    sliceProfile(["rich-text-body"]),
    async () => {
      vi.clearAllMocks()
      mocks.enabledLocales = ["en", "fr"]
      mocks.addressHarness = true
      mocks.strictWrites = false
      mocks.realSidebar = false
      mocks.historyInstalled = false
      mocks.checklistResult = { canPublish: true, blockers: [], warnings: [] }
      mocks.sliceProps.length = 0
      window.localStorage.clear()
      window.sessionStorage.clear()
      const identity = {
        subject: "allocation-owner",
        tokenIdentifier: "https://convex.test|allocation-owner",
      }
      const t = convexTest({
        schema,
        modules: import.meta.glob("../../convex/**/*.ts"),
        ownerIdentity: identity,
        publicationAuthority: "missing",
      })
      const owner = t.withIdentity(identity)
      await owner.mutation(
        api.cms.publication.initializeEmptySnapshotAuthority,
        {}
      )
      const home = await owner.mutation(api.cms.pages.create, {
        pageType: "page",
        status: "draft",
        slug: "home",
        title: "Home",
        content: { en: { title: "Home", slices: [] } },
      })
      await t.run((ctx) =>
        ctx.db.insert("siteSettings", {
          siteName: "Allocation",
          siteUrl: "",
          defaultLocale: "en",
          enabledLocales: ["en", "fr"],
          homePageId: home,
          updatedAt: 1,
        })
      )
      await owner.mutation(api.cms.pages.create, {
        pageType: "page",
        status: "draft",
        slug: "contact",
        title: "Occupied Contact",
        content: {
          en: { title: "Occupied Contact", slices: [] },
          fr: { title: "Occupied Contact", slices: [] },
        },
      })
      const body = {
        ...createSampleSlice("rich-text-body"),
        id: "allocation-body",
      } as Slice
      const id = await owner.mutation(api.cms.pages.create, {
        pageType: "page",
        status: "draft",
        slug: "contact",
        title: "Contact",
        content: {
          en: { title: "Contact", slices: [body] },
          fr: { title: "Contact", slices: [body] },
        },
      })
      const initial = (await owner.query(api.cms.pages.getForEdit, { id }))!
      let resolved:
        | Awaited<
            ReturnType<
              typeof owner.query<typeof api.cms.publication.addressAvailability>
            >
          >
        | undefined
      // The query remains pending throughout the real Save; no slug-derived
      // allocation mock may provide the evidence after the reload.
      mocks.addressQuery = () => resolved
      mocks.convex.query
        .mockReset()
        .mockImplementation(async (reference) =>
          getFunctionName(reference as never) === "cms/pages:getForEdit"
            ? owner.query(api.cms.pages.getForEdit, { id })
            : []
        )
      mocks.saveDraft
        .mockReset()
        .mockImplementation((args) =>
          owner.mutation(api.cms.publication.saveEditorDraft, args)
        )
      mocks.confirm.mockResolvedValue(true)
      const view = render(
        <PageEditor
          page={initial.page as Page}
          publication={initial.publication}
          requestedLocale="en"
          hasStaging={false}
          stagingUpdatedAt={undefined}
        />
      )
      try {
        await act(async () =>
          fireEvent.click(screen.getByRole("tab", { name: /français/i }))
        )
        fireEvent.click(screen.getByTitle("Settings"))
        expect(mocks.settingsProps!.slug).toBe("contact-2")
        expect(screen.queryByText(/Occupied Contact/)).not.toBeInTheDocument()
        act(() =>
          mocks.sliceProps.at(-1)!.onSlicesChange([
            {
              ...body,
              primary: {
                ...body.primary,
                body: JSON.stringify({
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "French body edited before availability resolves",
                        },
                      ],
                    },
                  ],
                }),
              },
            } as Slice,
          ])
        )
        await act(async () => mocks.sliceProps.at(-1)!.onSave())
        expect(mocks.saveDraft).toHaveBeenCalledOnce()
        expect(resolved).toBeUndefined()
        const reloaded = (await owner.query(api.cms.pages.getForEdit, { id }))!
        resolved = await owner.query(api.cms.publication.addressAvailability, {
          pageId: id,
          locale: "fr",
        })
        expect(
          resolved.entries.find((e) => e.locale === "fr")?.allocation
        ).toMatchObject({ wantedSlug: "contact", allocatedSlug: "contact-2" })
        const frenchContent = reloaded.page.content?.fr
        expect(
          frenchContent && "slices" in frenchContent
            ? JSON.stringify(frenchContent.slices)
            : undefined
        ).toContain("French body edited before availability resolves")
        // A remount reads only actual server results and represents reopening
        // the saved page, including allocation provenance restored from storage.
        view.unmount()
        const reopened = render(
          <PageEditor
            page={reloaded.page as Page}
            publication={reloaded.publication}
            requestedLocale="fr"
            hasStaging={false}
            stagingUpdatedAt={undefined}
          />
        )
        try {
          fireEvent.click(screen.getByTitle("Settings"))
          expect(screen.getByText(/Occupied Contact/)).toBeVisible()
          expect(
            screen.getByText(/Occupied Contact/).parentElement
          ).toHaveTextContent("/fr/contact-2")
        } finally {
          reopened.unmount()
        }
      } finally {
        view.unmount()
        mocks.addressQuery = null
        mocks.addressHarness = false
        mocks.convex.query.mockReset().mockResolvedValue([])
        mocks.saveDraft.mockReset()
        mocks.settingsProps = null
      }
    }
  )
})
