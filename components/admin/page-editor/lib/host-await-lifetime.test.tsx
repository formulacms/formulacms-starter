import type { ReactNode } from "react"
import type { AdminAiTranslationHostProps } from "@/components/admin/contributions/ai-translation"
import type { AdminPageHistoryHostProps } from "@/components/admin/contributions/history"
import type { SlicesPanel } from "../components/slices-panel"
import type { Page } from "../lib/types"
import type { Id } from "@/convex/_generated/dataModel"
import {
  act,
  fireEvent,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { beforeEach, afterEach, expect, test, vi } from "vitest"
import { toast } from "sonner"
import { readRecoveryDraft, writeRecoveryDraft } from "../lib/recovery"

const mocks = vi.hoisted(() => ({
  localeTabs: null as
    | Parameters<typeof import("@/components/admin/locale-tabs").LocaleTabs>[0]
    | null,
  transfer: null as
    | Parameters<
        typeof import("@/components/admin/page-editor/components/transfer-popover-content").TransferPopoverContent
      >[0]
    | null,
  translation: null as AdminAiTranslationHostProps | null,
  commandIds: [] as string[],
  mutation: vi.fn(),
  confirm: vi.fn(async () => true),
  push: vi.fn(),
  settings: null as
    | Parameters<typeof import("../components/settings-panel").SettingsPanel>[0]
    | null,
  fields: null as
    | Parameters<
        typeof import("@/components/admin/content-type-fields-panel").ContentTypeFieldsPanel
      >[0]
    | null,
  hookArgs: null as
    Parameters<typeof import("../hooks/use-page-save").usePageSave>[0] | null,
  lock: { status: "available" } as unknown,
  remedy: null as unknown,
  historyInstalled: true,
  queryNames: [] as string[],
  checklistRequests: [] as Array<{ name: string; args: unknown }>,
  snapshotRestore: vi.fn(),
  saveDraft: vi.fn(),
  checklistResult: { canPublish: true, blockers: [], warnings: [] } as unknown,
  convex: {
    query: vi.fn<(reference: unknown, args: unknown) => Promise<unknown>>(
      async () => []
    ),
  },
  refresh: vi.fn(),
  slotProps: [] as AdminPageHistoryHostProps[],
  enabledLocales: ["en"] as string[],
  sliceProps: [] as Parameters<typeof SlicesPanel>[0][],
}))

vi.mock("@/components/admin/locale-tabs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/admin/locale-tabs")>()
  return {
    LocaleTabs: (props: Parameters<typeof actual.LocaleTabs>[0]) => {
      mocks.localeTabs = props
      return <actual.LocaleTabs {...props} />
    },
  }
})
vi.mock(
  "@/components/admin/page-editor/components/transfer-popover-content",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/admin/page-editor/components/transfer-popover-content")
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

vi.mock("@/components/admin/contributions/ai-translation", () => ({
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

vi.mock("@/components/admin/contributions/history", () => ({
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
  "@/components/admin/page-editor/components/snapshot-history-panel",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/admin/page-editor/components/snapshot-history-panel")
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
  useAction: () => vi.fn(),
  useConvex: () => mocks.convex,
  useMutation:
    (reference: unknown) =>
    (...args: unknown[]) =>
      mocks.mutation(getFunctionName(reference as never), ...args),
  useQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    mocks.queryNames.push(name)
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
    if (name === "cms/pages:listActiveEditors") return []
    if (name === "cms/pages:getPageEditorLock") return mocks.lock
    if (name === "cms/language:getRetainedTargetDraftRemedy")
      return mocks.remedy
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
    push: mocks.push,
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
}))

vi.mock("@/components/admin/command-palette", () => ({
  useRegisterAdminCommands: (commands: Array<{ id: string }>) => {
    if (commands.length > 0) {
      mocks.commandIds = commands.map((command) => command.id)
    }
  },
}))

vi.mock("@/components/admin/duplicate-page-dialog", () => ({
  DuplicatePageDialog: () => null,
}))
vi.mock("@/components/admin/content-type-fields-panel", () => ({
  ContentTypeFieldsPanel: (props: NonNullable<typeof mocks.fields>) => {
    mocks.fields = props
    return null
  },
}))
vi.mock("@/components/admin/page-editor/components/seo-panel", () => ({
  SeoPanel: () => null,
}))
vi.mock("@/components/admin/page-editor/components/settings-panel", () => ({
  SettingsPanel: (
    props: Parameters<
      typeof import("../components/settings-panel").SettingsPanel
    >[0]
  ) => {
    mocks.settings = props
    return (
      <input
        aria-label="test title"
        value={props.title}
        onChange={(event) => props.onTitleChange(event.target.value)}
      />
    )
  },
}))
vi.mock("@/components/admin/page-editor/components/slices-panel", () => ({
  SlicesPanel: (props: Parameters<typeof SlicesPanel>[0]) => {
    mocks.sliceProps.push(props)
    // Test proxy for the mounted PageEditor preview-panel host, not a native iframe.
    return <div data-testid="slice-panel" />
  },
}))

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("../hooks/use-page-save", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/use-page-save")>()
  return {
    ...actual,
    usePageSave: (args: Parameters<typeof actual.usePageSave>[0]) => {
      mocks.hookArgs = args
      return actual.usePageSave(args)
    },
  }
})
import { PageEditor } from "@/components/admin/page-editor"

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

function copyTarget() {
  return {
    page: { _id: "new-page" },
    publication: {
      authority: "snapshot_active" as const,
      lifecycleGeneration: 11,
      sharedDraftGeneration: 12,
      locales: [
        {
          locale: "en",
          draftGeneration: 13,
          publicGeneration: 0,
          releaseGeneration: 0,
        },
      ],
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings = null
  mocks.fields = null
  mocks.convex.query.mockReset().mockResolvedValue([])
  mocks.enabledLocales = ["en", "fr"]
  mocks.remedy = null
  mocks.lock = { status: "available" }
  mocks.confirm.mockReset().mockResolvedValue(true)
  mocks.mutation
    .mockReset()
    .mockImplementation(async (name: string) =>
      name === "cms/pages:create"
        ? "new-page"
        : { status: "acquired", updatedAt: 101, lifecycleGeneration: 4 }
    )
  window.localStorage.clear()
  window.sessionStorage.clear()
})
afterEach(cleanup)

function mount(snapshot = false, copyFields = false) {
  const publicationState = snapshot ? publication() : undefined
  const source = {
    ...page(),
    ...(copyFields ? { pageType: "post", category: "News" } : {}),
    content: {
      en: { title: "About", slices: [] },
      fr: { title: "À propos", slices: [] },
    },
  } as Page
  const view = render(
    <PageEditor
      page={source}
      hasStaging={false}
      stagingUpdatedAt={undefined}
      publication={publicationState}
      aiTranslationRouteData={
        {
          mechanicalTranslation: {},
          brandTranslation: {},
        } as AdminAiTranslationHostProps["routeData"]
      }
    />,
    { reactStrictMode: true }
  )
  return { ...view, source, publicationState }
}
function switchLocale(locale: "en" | "fr") {
  act(() => {
    mocks.localeTabs!.onLocaleChange(locale)
  })
}
function settings() {
  fireEvent.click(screen.getByRole("button", { name: "Settings" }))
  return mocks.settings!
}
function expectSilent() {
  expect(toast.success).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
  expect(toast.message).not.toHaveBeenCalled()
  expect(mocks.push).not.toHaveBeenCalled()
  expect(mocks.refresh).not.toHaveBeenCalled()
}

test.each(
  (
    [
      "claim",
      "force",
      "release",
      "retained",
      "delete",
      "snapshot delete",
      "conflict",
    ] as const
  ).flatMap((site) =>
    (["locale", "page", "unmount"] as const).map((end) => ({ site, end }))
  )
)(
  "host await $site ignores $end completion and keeps submitted mutation",
  async ({ site, end }) => {
    if (site === "retained") mocks.remedy = { pageId, locale: "fr" }
    if (site === "force" || site === "release")
      mocks.lock = {
        status: "locked",
        isMine: site === "release",
        lock: { name: "Other", lastActiveAt: 100 },
      }
    const view = mount(
      site === "snapshot delete" || site === "retained",
      site === "conflict"
    )
    const mutation = deferred<unknown>()
    const names = {
      claim: "cms/pages:acquirePageEditorLock",
      force: "cms/pages:acquirePageEditorLock",
      release: "cms/pages:releasePageEditorLock",
      retained: "cms/language:deleteRetainedTargetDraft",
      delete: "cms/pages:softDelete",
      "snapshot delete": "cms/publication:softDeletePage",
      conflict: "cms/pages:create",
    }
    mocks.mutation.mockImplementation((name: string) =>
      name === names[site]
        ? mutation.promise
        : Promise.resolve({ updatedAt: 102 })
    )
    let pending: Promise<void> | undefined
    if (site === "conflict")
      act(() => {
        pending = mocks.hookArgs!.onSaveConflict()
      })
    else if (site === "delete" || site === "snapshot delete") {
      const panel = settings()
      act(() => panel.onDelete?.())
    } else
      fireEvent.click(
        screen.getByRole("button", {
          name:
            site === "claim"
              ? "Claim focus"
              : site === "force"
                ? "Take over"
                : site === "release"
                  ? "Release focus"
                  : /Delete.*draft/i,
        })
      )
    await waitFor(() =>
      expect(
        mocks.mutation.mock.calls.some(([name]) => name === names[site])
      ).toBe(true)
    )
    if (end === "locale") switchLocale("fr")
    else if (end === "unmount") view.unmount()
    else
      view.rerender(
        <PageEditor
          page={{ ...view.source, _id: "page-2" as Id<"pages"> }}
          hasStaging={false}
          stagingUpdatedAt={undefined}
        />
      )
    writeRecoveryDraft(pageId, {
      base: null,
      ...{
        ...mocks.hookArgs!.draft,
        locale: "fr",
        savedAt: Date.now() + 1000,
      },
    })
    await act(async () => {
      mutation.resolve(
        site === "conflict"
          ? "new-page"
          : { status: "acquired", lifecycleGeneration: 4 }
      )
      await pending
    })
    expectSilent()
    expect(readRecoveryDraft(pageId, "fr")).not.toBeNull()
    if (site === "conflict") {
      const copied = mocks.mutation.mock.calls.find(
        ([name]) => name === "cms/pages:updateDraft"
      )?.[1]
      expect(copied).toMatchObject({ pageId: "new-page" })
      expect(JSON.parse(copied.sharedFieldsJson)).toMatchObject({
        category: "News",
      })
      expect(
        mocks.mutation.mock.calls.filter(
          ([name]) => name === "cms/pages:create"
        )
      ).toHaveLength(1)
    }
    view.unmount()
  }
)

test.each([
  "claim",
  "force",
  "release",
  "retained",
  "delete",
  "snapshot delete",
  "conflict",
] as const)("host await %s preserves active success", async (site) => {
  if (site === "retained") mocks.remedy = { pageId, locale: "fr" }
  if (site === "force" || site === "release")
    mocks.lock = {
      status: "locked",
      isMine: site === "release",
      lock: { name: "Other", lastActiveAt: 100 },
    }
  const view = mount(
    site === "snapshot delete" || site === "retained",
    site === "conflict"
  )
  if (site === "conflict")
    await act(async () => {
      await mocks.hookArgs!.onSaveConflict()
    })
  else if (site === "delete" || site === "snapshot delete") {
    const panel = settings()
    act(() => panel.onDelete?.())
  } else
    fireEvent.click(
      screen.getByRole("button", {
        name:
          site === "claim"
            ? "Claim focus"
            : site === "force"
              ? "Take over"
              : site === "release"
                ? "Release focus"
                : /Delete.*draft/i,
      })
    )
  await waitFor(() => expect(toast.success).toHaveBeenCalledOnce())
  expect(toast.error).not.toHaveBeenCalled()
  if (site === "conflict")
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/admin/pages/new-page")
  if (site === "delete" || site === "snapshot delete")
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/admin/pages")
  view.unmount()
})

test.each(["pull", "push", "participant"] as const)(
  "transfer %s refuses expired confirmation",
  async (site) => {
    const view = mount()
    const confirm = deferred<boolean>()
    mocks.confirm.mockImplementation(() => confirm.promise)
    let pending: Promise<boolean> | undefined
    act(() => {
      if (site === "participant")
        pending = mocks.translation!.prepareTransfer("en", "fr")
      else if (site === "pull") mocks.transfer!.onPullCopy("fr")
      else mocks.transfer!.onPush("fr", "copy")
    })
    expect(mocks.confirm).toHaveBeenCalledOnce()
    switchLocale("fr")
    switchLocale("en")
    const before = mocks.hookArgs!.draft
    mocks.mutation.mockClear()
    await act(async () => {
      confirm.resolve(true)
      await pending
    })
    expect(mocks.localeTabs!.currentLocale).toBe("en")
    expect(mocks.hookArgs!.draft).toEqual(before)
    expect(
      mocks.mutation.mock.calls.filter(([name]) =>
        ["cms/pages:updateDraft", "cms/publication:saveEditorDraft"].includes(
          name
        )
      )
    ).toEqual([])
    if (site === "participant") await expect(pending).resolves.toBe(false)
    expectSilent()
    view.unmount()
  }
)

test.each(["force", "retained", "delete", "conflict"] as const)(
  "host %s rejects expired confirmation before mutation",
  async (site) => {
    if (site === "retained") mocks.remedy = { pageId, locale: "fr" }
    if (site === "force")
      mocks.lock = {
        status: "locked",
        isMine: false,
        lock: { name: "Other", lastActiveAt: 100 },
      }
    const view = mount(site === "retained")
    const confirmation = deferred<boolean>()
    mocks.confirm.mockImplementation(() => confirmation.promise)
    let pending: Promise<void> | undefined
    if (site === "conflict")
      act(() => {
        pending = mocks.hookArgs!.onSaveConflict()
      })
    else if (site === "delete") {
      const panel = settings()
      act(() => panel.onDelete?.())
    } else
      fireEvent.click(
        screen.getByRole("button", {
          name: site === "force" ? "Take over" : /Delete.*draft/i,
        })
      )
    expect(mocks.confirm).toHaveBeenCalledOnce()
    switchLocale("fr")
    switchLocale("en")
    await act(async () => {
      confirmation.resolve(true)
      await pending
    })
    expect(
      mocks.mutation.mock.calls.filter(([name]) =>
        [
          "cms/pages:acquirePageEditorLock",
          "cms/language:deleteRetainedTargetDraft",
          "cms/pages:softDelete",
          "cms/pages:create",
        ].includes(name)
      )
    ).toEqual([])
    expectSilent()
    view.unmount()
  }
)

test.each([
  "claim",
  "force",
  "release",
  "retained",
  "delete",
  "snapshot delete",
] as const)("host %s suppresses stale mutation refusal", async (site) => {
  if (site === "retained") mocks.remedy = { pageId, locale: "fr" }
  if (site === "force" || site === "release")
    mocks.lock = {
      status: "locked",
      isMine: site === "release",
      lock: { name: "Other", lastActiveAt: 100 },
    }
  const view = mount(site === "snapshot delete" || site === "retained")
  const mutation = deferred<unknown>()
  const names = {
    claim: "cms/pages:acquirePageEditorLock",
    force: "cms/pages:acquirePageEditorLock",
    release: "cms/pages:releasePageEditorLock",
    retained: "cms/language:deleteRetainedTargetDraft",
    delete: "cms/pages:softDelete",
    "snapshot delete": "cms/publication:softDeletePage",
  }
  mocks.mutation.mockImplementation((name: string) =>
    name === names[site]
      ? mutation.promise
      : Promise.resolve({ updatedAt: 102 })
  )
  if (site === "delete" || site === "snapshot delete") {
    const panel = settings()
    act(() => panel.onDelete?.())
  } else
    fireEvent.click(
      screen.getByRole("button", {
        name:
          site === "claim"
            ? "Claim focus"
            : site === "force"
              ? "Take over"
              : site === "release"
                ? "Release focus"
                : /Delete.*draft/i,
      })
    )
  await waitFor(() =>
    expect(
      mocks.mutation.mock.calls.some(([name]) => name === names[site])
    ).toBe(true)
  )
  switchLocale("fr")
  await act(async () => {
    mutation.reject(new Error("Refused"))
    await mutation.promise.catch(() => {})
  })
  expectSilent()
  if (site === "retained")
    expect(screen.getByRole("button", { name: /Delete.*draft/i })).toBeEnabled()
  view.unmount()
})

test.each(["pull", "push", "participant"] as const)(
  "transfer %s preserves active completion",
  async (site) => {
    const view = mount()
    if (site === "participant")
      await act(async () => {
        await expect(
          mocks.translation!.prepareTransfer("en", "fr")
        ).resolves.toBe(true)
      })
    else {
      await act(async () => {
        if (site === "pull") mocks.transfer!.onPullCopy("fr")
        else mocks.transfer!.onPush("fr", "copy")
      })
      await waitFor(() =>
        expect(mocks.hookArgs!.draft.title).toBe(
          site === "pull" ? "À propos" : "About"
        )
      )
      expect(mocks.localeTabs!.currentLocale).toBe(
        site === "pull" ? "en" : "fr"
      )
    }
    view.unmount()
  }
)

test.each(
  [true, false].flatMap((snapshot) =>
    (["en", "fr"] as const).map((locale) => ({ snapshot, locale }))
  )
)(
  "conflict copy writes only target descriptor fields and tokens (snapshot=$snapshot, locale=$locale)",
  async ({ snapshot, locale }) => {
    const view = mount(snapshot, true)
    if (locale === "fr") switchLocale(locale)
    // Exercise the generic localized-bag seam with a declared post field.
    // Author-only extras cannot be copied: the host explicitly refuses authors.
    act(() => {
      mocks.fields!.onLocalizedChange({ metaDescription: `Copy ${locale}` })
    })
    const originalPublication = structuredClone(view.publicationState)
    const originalDraft = structuredClone(view.source)
    const targetPublication = {
      authority: "snapshot_active" as const,
      lifecycleGeneration: 11,
      sharedDraftGeneration: 12,
      locales: [
        {
          locale,
          draftGeneration: 13,
          publicGeneration: 0,
          releaseGeneration: 0,
        },
      ],
    }
    mocks.convex.query.mockResolvedValue({
      page: {
        ...view.source,
        _id: "new-page",
        slug: "copy-allocated-2",
        localizedSlugs: { [locale]: "copy-allocated-2" },
      },
      hasStaging: true,
      ...(snapshot ? { publication: targetPublication } : {}),
    })
    mocks.mutation.mockImplementation(async (name: string) =>
      name === "cms/pages:create"
        ? "new-page"
        : { updatedAt: 102, draftGeneration: 14, sharedDraftGeneration: 13 }
    )
    await act(async () => {
      await mocks.hookArgs!.onSaveConflict()
    })
    const writes = mocks.mutation.mock.calls.filter(([name]) =>
      [
        "cms/pages:updateDraft",
        "cms/publication:saveEditorDraft",
        "cms/publication:saveLocaleDraft",
        "cms/publication:saveSharedDraft",
      ].includes(name)
    )
    expect(writes.filter(([, args]) => args.pageId === pageId)).toEqual([])
    expect(view.publicationState).toEqual(originalPublication)
    expect(view.source).toEqual(originalDraft)
    expect(writes).toHaveLength(1)
    const [name, args] = writes[0]!
    const created = mocks.mutation.mock.calls.find(
      ([call]) => call === "cms/pages:create"
    )![1]
    expect(args.pageId).toBe("new-page")
    if (snapshot) {
      expect(name).toBe("cms/publication:saveEditorDraft")
      expect(
        mocks.convex.query.mock.calls
          .map(([reference, queryArgs]) => [
            getFunctionName(reference as never),
            queryArgs,
          ])
          .filter(([name]) => name === "cms/pages:getForEdit")
      ).toEqual([["cms/pages:getForEdit", { id: "new-page" }]])
      expect(args).toMatchObject({
        expectedLifecycleGeneration: 11,
        shared: { expectedGeneration: 12 },
        localized: {
          locale,
          slug: "copy-allocated-2",
          expectedGeneration: 13,
          draft: {
            pageType: "post",
            localized: { metaDescription: `Copy ${locale}` },
            slices: [],
          },
        },
      })
      expect(JSON.parse(args.shared.sharedFieldsJson)).toMatchObject({
        category: "News",
      })
    } else {
      expect(name).toBe("cms/pages:updateDraft")
      expect(args.expectedUpdatedAt).toBeUndefined()
      expect(args.content[locale].localized.metaDescription).toBe(
        `Copy ${locale}`
      )
      expect(JSON.parse(args.sharedFieldsJson)).toMatchObject({
        category: "News",
      })
    }
    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      "Recovered draft saved as a new page"
    )
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/admin/pages/new-page")
    view.unmount()
  }
)

test.each(["query", "missing", "write"] as const)(
  "snapshot conflict-copy carry-over stays best-effort on %s failure",
  async (failure) => {
    const view = mount(true, true)
    const original = structuredClone(view.publicationState)
    if (failure === "query")
      mocks.convex.query.mockRejectedValue(new Error("Target read refused"))
    else
      mocks.convex.query.mockResolvedValue(
        failure === "missing" ? null : copyTarget()
      )
    mocks.mutation.mockImplementation(async (name: string) => {
      if (name === "cms/publication:saveEditorDraft")
        throw new Error("Target write refused")
      return name === "cms/pages:create" ? "new-page" : { updatedAt: 101 }
    })
    await act(async () => {
      await mocks.hookArgs!.onSaveConflict()
    })
    expect(
      mocks.mutation.mock.calls.filter(([name]) => name === "cms/pages:create")
    ).toHaveLength(1)
    const writes = mocks.mutation.mock.calls.filter(
      ([name]) => name === "cms/publication:saveEditorDraft"
    )
    expect(writes).toHaveLength(failure === "write" ? 1 : 0)
    for (const [, args] of writes) expect(args.pageId).toBe("new-page")
    expect(view.publicationState).toEqual(original)
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      "Recovered draft saved as a new page"
    )
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/admin/pages/new-page")
    view.unmount()
  }
)

test.each(["query", "write"] as const)(
  "snapshot conflict copy keeps submitted target and ignores stale %s completion",
  async (boundary) => {
    const view = mount(true, true)
    const original = structuredClone(view.publicationState)
    const pendingTarget = deferred<unknown>()
    const pendingWrite = deferred<unknown>()
    mocks.convex.query.mockImplementation(() =>
      boundary === "query"
        ? pendingTarget.promise
        : Promise.resolve(copyTarget())
    )
    mocks.mutation.mockImplementation((name: string) => {
      if (name === "cms/publication:saveEditorDraft") {
        return boundary === "write"
          ? pendingWrite.promise
          : Promise.resolve({ updatedAt: 102, sharedDraftGeneration: 13 })
      }
      return Promise.resolve(name === "cms/pages:create" ? "new-page" : {})
    })
    let pending!: Promise<void>
    act(() => {
      pending = mocks.hookArgs!.onSaveConflict()
    })
    await waitFor(() => {
      if (boundary === "query")
        expect(
          mocks.convex.query.mock.calls.filter(
            ([reference]) =>
              getFunctionName(reference as never) === "cms/pages:getForEdit"
          )
        ).toHaveLength(1)
      else
        expect(
          mocks.mutation.mock.calls.some(
            ([name]) => name === "cms/publication:saveEditorDraft"
          )
        ).toBe(true)
    })
    switchLocale("fr")
    await act(async () => {
      pendingTarget.resolve(copyTarget())
      pendingWrite.resolve({ updatedAt: 102, sharedDraftGeneration: 13 })
      await pending
    })
    const writes = mocks.mutation.mock.calls.filter(
      ([name]) => name === "cms/publication:saveEditorDraft"
    )
    expect(writes).toHaveLength(1)
    expect(writes[0]![1]).toMatchObject({
      pageId: "new-page",
      expectedLifecycleGeneration: 11,
      shared: { expectedGeneration: 12 },
    })
    expect(writes[0]![1].localized).toBeUndefined()
    expect(view.publicationState).toEqual(original)
    expectSilent()
    view.unmount()
  }
)

test("host conflict ignores stale descriptor-write completion", async () => {
  const view = mount(false, true)
  const update = deferred<unknown>()
  mocks.mutation.mockImplementation((name: string) =>
    name === "cms/pages:updateDraft"
      ? update.promise
      : Promise.resolve(
          name === "cms/pages:create" ? "new-page" : { updatedAt: 101 }
        )
  )
  let pending!: Promise<void>
  act(() => {
    pending = mocks.hookArgs!.onSaveConflict()
  })
  await waitFor(() =>
    expect(
      mocks.mutation.mock.calls.some(
        ([name]) => name === "cms/pages:updateDraft"
      )
    ).toBe(true)
  )
  switchLocale("fr")
  await act(async () => {
    update.resolve({ updatedAt: 102 })
    await pending
  })
  expectSilent()
  const copied = mocks.mutation.mock.calls.find(
    ([name]) => name === "cms/pages:updateDraft"
  )?.[1]
  expect(copied).toMatchObject({ pageId: "new-page" })
  expect(JSON.parse(copied.sharedFieldsJson)).toMatchObject({
    category: "News",
  })
  view.unmount()
})

// fad4bec8: the delete reads the lifecycle at submission, after the
// confirmation. E1: the value it reads is this tab's own base, which a
// transition made by this tab while the dialog was open has advanced.
test("review snapshot delete uses the lifecycle this tab's own transition set during confirmation", async () => {
  const view = mount(true)
  const confirmation = deferred<boolean>()
  mocks.confirm.mockImplementation(() => confirmation.promise)
  mocks.mutation.mockImplementation(async (name: string, args: unknown) => {
    if (name === "cms/publication:archivePage")
      return { lifecycleGeneration: 4, updatedAt: 102 }
    if (name === "cms/publication:softDeletePage") {
      if (
        (args as { expectedLifecycleGeneration: number })
          .expectedLifecycleGeneration !== 4
      )
        throw new Error("PAGE_PUBLICATION_LIFECYCLE_STALE")
      return { lifecycleGeneration: 5 }
    }
    return { updatedAt: 102 }
  })
  const panel = settings()
  act(() => panel.onDelete?.())
  expect(mocks.confirm).toHaveBeenCalledOnce()
  await act(async () => {
    panel.onArchive?.()
  })
  await waitFor(() =>
    expect(
      mocks.mutation.mock.calls.some(
        ([name]) => name === "cms/publication:archivePage"
      )
    ).toBe(true)
  )
  await act(async () => {
    confirmation.resolve(true)
    await confirmation.promise
  })
  const request = mocks.mutation.mock.calls.find(
    ([name]) => name === "cms/publication:softDeletePage"
  )?.[1]
  expect(request).toMatchObject({ pageId, expectedLifecycleGeneration: 4 })
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/admin/pages")
  view.unmount()
})

// E1: a refresh that carries another tab's newer lifecycle does not replace the
// lifecycle this tab loaded, so the server (which holds 4) refuses a delete
// that was reviewed against 3. The old test pinned the opposite: that the
// base followed every new `publication` prop.
test("review snapshot delete keeps the lifecycle this tab loaded when a refresh carries a newer one", async () => {
  const view = mount(true)
  const confirmation = deferred<boolean>()
  mocks.confirm.mockImplementation(() => confirmation.promise)
  mocks.mutation.mockImplementation(async (name: string, args: unknown) => {
    if (name === "cms/publication:softDeletePage") {
      if (
        (args as { expectedLifecycleGeneration: number })
          .expectedLifecycleGeneration !== 4
      )
        throw new Error("PAGE_PUBLICATION_LIFECYCLE_STALE")
      return { lifecycleGeneration: 5 }
    }
    return { updatedAt: 102 }
  })
  const panel = settings()
  act(() => panel.onDelete?.())
  expect(mocks.confirm).toHaveBeenCalledOnce()
  view.rerender(
    <PageEditor
      page={view.source}
      hasStaging={false}
      stagingUpdatedAt={undefined}
      publication={{ ...publication(), lifecycleGeneration: 4 }}
    />
  )
  await act(async () => {
    confirmation.resolve(true)
    await confirmation.promise
  })
  const request = mocks.mutation.mock.calls.find(
    ([name]) => name === "cms/publication:softDeletePage"
  )?.[1]
  expect(request).toMatchObject({ pageId, expectedLifecycleGeneration: 3 })
  expect(toast.error).toHaveBeenCalledOnce()
  expect(toast.success).not.toHaveBeenCalled()
  expect(mocks.push).not.toHaveBeenCalled()
  view.unmount()
})
