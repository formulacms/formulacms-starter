import { sliceProfile } from "@/test-utils/slice-profile"
import { createHash } from "node:crypto"
import type { AdminAiTranslationHostProps } from "./contributions/ai-translation"
import { act, fireEvent, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { beforeAll, beforeEach, expect, test, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import type { AdminPageHistoryHostProps } from "./contributions/history"
import type { Page } from "./page-editor/lib/types"
import type { Slice } from "@/convex/lib/slices"
import type { SlicesPanel } from "./page-editor/components/slices-panel"

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
  checklistResult: { canPublish: true, blockers: [], warnings: [] } as unknown,
  convex: { query: vi.fn(async () => []) },
  refresh: vi.fn(),
  slotProps: [] as AdminPageHistoryHostProps[],
  enabledLocales: ["en"] as string[],
  sliceProps: [] as Parameters<typeof SlicesPanel>[0][],
}))

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
  useAction: () => vi.fn(),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useConvex: () => mocks.convex,
  useMutation: (reference: unknown) =>
    getFunctionName(reference as never) ===
    "cms/publication:restoreSnapshotAsDraft"
      ? mocks.snapshotRestore
      : getFunctionName(reference as never) ===
          "cms/publication:saveEditorDraft"
        ? mocks.saveDraft
        : vi.fn(async () => ({
            status: "acquired",
            updatedAt: 101,
            generation: 1,
          })),
  useQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    mocks.queryNames.push(name)
    if (name === "cms/slices:getPresentationCatalog") return boundary.catalog
    if (name === "cms/pages:getForEdit")
      return { page: { pageType: "landing-page" } }
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
        languageVersion: 3,
      }
    }
    if (name === "cms/pages:getPrePublishChecklist") {
      if (mocks.checklistResult instanceof Error) throw mocks.checklistResult
      return mocks.checklistResult
    }
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

// Only infrastructure/unrelated chrome is mocked. All parent preparation, commit,
// Frame/controller, Runtime, Canvas and TipTap implementations execute unchanged.
import { useLayoutEffect } from "react"
import type { Editor } from "@tiptap/core"
import { LivePreviewFrameRuntime } from "./live-preview-frame-runtime"
import type {
  LiveFrameInput,
  LiveFrameWindow,
  LiveFrameBridge,
} from "./live-preview-frame-bridge"
import { readSlicePresentationCatalog } from "@/convex/lib/slices/presentations"

const boundary = vi.hoisted(() => ({
  control: process.env.OWN_ECHO_CONTROL ?? "original",
  catalog: undefined as unknown,
  mirrorRegistrations: 0,
  observerRegistrations: 0,
  observerRuns: 0,
  mirrorSuppressed: 0,
  afterOwnerPassive: null as null | (() => void),
  layout: null as null | ((props: Parameters<typeof SlicesPanel>[0]) => void),
  trace: [] as unknown[],
  conflicts: 0,
  commits: [] as { value: string; accepted: boolean | void }[],
}))
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>()
  return {
    ...actual,
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const source = effect.toString()
      const isMirror = /^\(\) => \{\s*slicesRef\.current = slices;?\s*\}$/.test(
        source
      )
      if (isMirror) {
        boundary.mirrorRegistrations++
        // React invokes the original mirror directly. The isolation control
        // suppresses only this effect; its counter is diagnostic, not a driver.
        return actual.useEffect(
          boundary.control === "effect-only"
            ? () => {
                boundary.mirrorSuppressed++
              }
            : effect,
          deps
        )
      }
      actual.useEffect(effect, deps)
      // This later PageEditor effect survives mirror removal. React registers
      // and invokes it with its original dependencies; a separate test observer
      // runs after it on EVERY owner commit, independently of mirror presence.
      const isOwnerAnchor =
        source.includes("initialPageDraftHandoff") &&
        source.includes("clearPageDraftHandoff") &&
        source.includes("page._id")
      if (isOwnerAnchor) {
        boundary.observerRegistrations++
        actual.useEffect(() => {
          boundary.observerRuns++
          boundary.trace.push(["owner-passive-observer"])
          boundary.afterOwnerPassive?.()
        })
      }
    },
  }
})
vi.mock("@/lib/rich-text/adopt-hero-titles", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rich-text/adopt-hero-titles")>()
  const share = (before: Slice[], after: Slice[]) =>
    boundary.control === "q38-only" &&
    after.every((slice, index) => slice === before[index])
      ? before
      : after
  return {
    ...actual,
    adoptHeroTitles: (...args: Parameters<typeof actual.adoptHeroTitles>) => {
      const result = actual.adoptHeroTitles(...args)
      return { ...result, value: share(args[0], result.value) }
    },
    prepareHeroTitleDraft: (
      ...args: Parameters<typeof actual.prepareHeroTitleDraft>
    ) => {
      const result = actual.prepareHeroTitleDraft(...args)
      const slices = share(args[0].slices, result.slices)
      boundary.trace.push([
        "actual-prepare",
        titleOf(slices),
        slices === args[0].slices,
      ])
      return { ...result, slices }
    },
  }
})
// Read-only observations of actual function results and their guard inputs.
// No alternate acceptance/reconciliation implementation exists in this fixture.
vi.mock("./page-editor/lib/page-inline-draft", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./page-editor/lib/page-inline-draft")>()
  return {
    ...actual,
    applyPageField: (...args: Parameters<typeof actual.applyPageField>) => {
      const result = actual.applyPageField(...args)
      if (!result) {
        const current = actual.capturePageField(
          args[0],
          args[1],
          args[2].sliceId,
          args[2].fieldPath,
          args[3],
          args[4]
        )
        boundary.trace.push([
          "actual-apply-null",
          titleOf(args[0]),
          args[2].fieldBinding?.lastApplied,
          current?.value,
        ])
      }
      return result
    },
    reconcilePageFieldEcho: (
      ...args: Parameters<typeof actual.reconcilePageFieldEcho>
    ) => {
      const result = actual.reconcilePageFieldEcho(...args)
      boundary.trace.push([
        "actual-reconcile",
        titleOf(args[0]),
        Boolean(args[3]?.frameBinding),
        Boolean(result),
      ])
      return result
    },
  }
})
vi.mock("@/lib/preview-build-id", () => ({ PREVIEW_BUILD_ID: "test-build" }))
vi.mock("@/components/providers", () => ({
  Providers: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/components/public/public-site-shell", () => ({
  PublicSiteShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("./slice-builder", () => ({ SliceBuilder: () => null }))
vi.mock("./page-editor/components/slices-panel", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./page-editor/components/slices-panel")
    >()
  return {
    SlicesPanel: (props: Parameters<typeof actual.SlicesPanel>[0]) => {
      mocks.sliceProps.push(props)
      useLayoutEffect(() => {
        boundary.layout?.(props)
      })
      return (
        <actual.SlicesPanel
          {...props}
          onPreviewActiveEditConflict={() => {
            boundary.conflicts++
            props.onPreviewActiveEditConflict?.()
          }}
          onPreviewInlineEditCommit={(commit) => {
            const accepted = props.onPreviewInlineEditCommit(commit)
            boundary.commits.push({ value: commit.value, accepted })
            boundary.trace.push([
              "actual-parent-commit",
              JSON.parse(commit.value).content[0].content?.[0]?.text,
              accepted,
            ])
            return accepted
          }}
        />
      )
    },
  }
})
vi.mock("./page-live-preview-canvas", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./page-live-preview-canvas")>()
  return {
    ...actual,
    PageLivePreviewCanvas: (
      props: Parameters<typeof actual.PageLivePreviewCanvas>[0]
    ) => {
      boundary.trace.push(["actual-canvas-render", titleOf(props.slices)])
      return <actual.PageLivePreviewCanvas {...props} />
    },
  }
})
function titleOf(slices: Slice[]) {
  const value = (slices as Array<{ primary?: Record<string, unknown> }>)?.[0]?.primary?.title
  return typeof value === "string"
    ? (JSON.parse(value).content?.[0]?.content?.[0]?.text ?? "")
    : ""
}
const titleDoc = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text }],
      },
    ],
  })

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect()],
  })
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
beforeEach(async () => {
  boundary.catalog = await readSlicePresentationCatalog()
  boundary.mirrorRegistrations = boundary.mirrorSuppressed = 0
  boundary.observerRegistrations = boundary.observerRuns = 0
  boundary.afterOwnerPassive = boundary.layout = null
  boundary.trace = []
  boundary.commits = []
  boundary.conflicts = 0
  mocks.sliceProps.length = 0
  mocks.historyInstalled = false
  mocks.enabledLocales = ["en", "fr"]
  window.localStorage.clear()
  window.sessionStorage.clear()
})
async function setupBoundary(locale: "en" | "fr") {
  const initial = "First"
  boundary.trace.push(["fixture-locale", locale])
  const slices = [
    {
      id: "hero",
      type: "hero-agency",
      enabled: true,
      primary: {
        eyebrow: "Agency",
        title: titleDoc(initial),
        description: JSON.stringify({
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Copy" }] },
          ],
        }),
      },
      items: [],
    },
  ] as Slice[]
  const fixture = page()
  fixture.pageType = "landing-page"
  fixture.content = {
    en: { title: "About", slices },
    fr: { title: "About", slices },
  }
  const parent = render(
    <PageEditor
      page={fixture}
      hasStaging={false}
      stagingUpdatedAt={undefined}
      publication={publication()}
    />,
    { locale }
  )
  if (locale === "fr")
    fireEvent.click(
      parent.getByRole("tab", { name: /Edit in Français|Modifier en Français/ })
    )
  const iframe = parent.getByTitle("About") as HTMLIFrameElement
  const child = iframe.contentWindow as LiveFrameWindow
  const sessionId = new URL(iframe.src).searchParams.get("session")!
  const contentLocale = mocks.sliceProps.at(-1)!.currentLocale
  expect(contentLocale).toBe(locale)
  const identity = {
    sessionId,
    pageId: pageId as string,
    locale: contentLocale,
  }
  const shell = {
    header: {
      logoUrl: null,
      locale: contentLocale,
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      languageVersion: 3,
      mainMenuItems: [],
    },
    footer: {
      logoUrl: null,
      locale: contentLocale,
      defaultLocale: "en",
      cardsBySource: {},
      footerMenu: null,
      chrome: null,
    },
  }
  const posted: unknown[] = []
  vi.spyOn(window.parent, "postMessage").mockImplementation((value) => {
    posted.push(value)
  })
  const runtime = render(
    <LivePreviewFrameRuntime
      identity={identity}
      page={{ pageType: "landing-page" } as never}
      config={{
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        languageVersion: 3,
      }}
      shell={shell}
      publicPath="/published"
      presentationCatalog={boundary.catalog as never}
    />
  )
  const actual = (window as LiveFrameWindow).__formulacmsLiveFrame!
  const queued: LiveFrameInput[] = []
  let transportHook:
    ((input: LiveFrameInput, accepted: boolean) => void) | null = null
  let hold = false
  const transport: LiveFrameBridge = {
    ...actual,
    replaceInput(input) {
      queued.push(input)
      if (hold) {
        boundary.trace.push(["transport-held", titleOf(input.slices)])
        return true
      }
      const accepted = actual.replaceInput(input)
      boundary.trace.push(["runtime-accept", titleOf(input.slices), accepted])
      transportHook?.(input, accepted)
      return accepted
    },
  }
  child.__formulacmsLiveFrame = transport
  const ready = posted.find(
    (value) => (value as { type?: string })?.type === "ready"
  )
  expect(ready).toBeDefined()
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: child,
        data: ready,
      })
    )
  )
  fireEvent.click(
    parent.getByRole("button", {
      name: /Edit text in preview: off|Modifier le texte dans l’aperçu : désactivé/,
    })
  )
  await waitFor(() =>
    expect(
      runtime.container.querySelector('[data-preview-field="primary.title"]')
    ).toBeTruthy()
  )
  fireEvent.click(
    runtime.container.querySelector('[data-preview-field="primary.title"]')!
  )
  await waitFor(() =>
    expect(
      runtime.container.querySelector("[contenteditable=true]")
    ).toBeTruthy()
  )
  const host = runtime.container.querySelector("[contenteditable=true]")!
  const editor = (host as HTMLElement & { editor: Editor }).editor
  const type = (char: string) => {
    boundary.trace.push(["tiptap-command", char])
    editor.commands.insertContent(char)
  }
  return {
    parent,
    runtime,
    actual,
    queued,
    editor,
    host,
    type,
    hold: () => {
      hold = true
    },
    hook: (fn: typeof transportHook) => {
      transportHook = fn
    },
    latest: () => mocks.sliceProps.at(-1)!,
    title: () =>
      runtime.container.querySelector('[data-preview-field="primary.title"]')
        ?.textContent,
  }
}
function digest(value: string) {
  return {
    sha256: createHash("sha256").update(value).digest("hex").slice(0, 16),
    length: value.length,
  }
}
function assertComplete(
  frame: Awaited<ReturnType<typeof setupBoundary>>,
  expected: string,
  count: number
) {
  console.log(
    "BOUNDARY_TRACE",
    JSON.stringify({
      control: boundary.control,
      conflicts: boundary.conflicts,
      commits: boundary.commits.map(({ value, accepted }) => ({
        value: digest(value),
        accepted,
      })),
      mirrorRegistrations: boundary.mirrorRegistrations,
      observerRegistrations: boundary.observerRegistrations,
      observerRuns: boundary.observerRuns,
      mirrorSuppressed: boundary.mirrorSuppressed,
      trace: boundary.trace.map((event) => {
        const [kind, ...values] = event as unknown[]
        return [
          kind,
          ...values.map((value) =>
            typeof value === "string" ? digest(value) : value
          ),
        ]
      }),
    })
  )
  expect(boundary.observerRegistrations).toBeGreaterThan(0)
  expect(boundary.observerRuns).toBeGreaterThan(0)
  if (boundary.control === "effect-only" && boundary.mirrorRegistrations > 0)
    expect(boundary.mirrorSuppressed).toBeGreaterThan(0)
  if (boundary.control !== "effect-only")
    expect(boundary.mirrorSuppressed).toBe(0)
  expect(boundary.commits).toHaveLength(count)
  expect(boundary.commits.map((row) => row.accepted)).toEqual(
    Array(count).fill(true)
  )
  expect(titleOf(frame.latest().slices)).toBe(expected)
  expect(frame.editor.getText()).toBe(expected)
  expect(frame.title()).toBe(expected)
  expect(frame.latest().previewInlineRefusal).toBeNull()
  expect(boundary.conflicts).toBe(0)
  expect(frame.parent.container.querySelector('[role="alert"]')).toBeNull()
}
test.each(["en", "fr"] as const)(
  "R accepted B before TipTap C retains every character (%s)", sliceProfile(["hero-agency"]),
  async (locale) => {
    const frame = await setupBoundary(locale)
    let triggered = false
    frame.hook((input, accepted) => {
      if (!triggered && titleOf(input.slices) === "Firstb") {
        expect(accepted).toBe(true)
        triggered = true
        frame.hold()
        frame.type("c")
      }
    })
    act(() => frame.type("b"))
    expect(triggered).toBe(true)
    assertComplete(frame, "Firstbc", 2)
  }
)
test.each(["en", "fr"] as const)(
  "W child layout C then real passive B preserves next TipTap D (%s)", sliceProfile(["hero-agency"]),
  async (locale) => {
    const frame = await setupBoundary(locale)
    let layoutTriggered = false
    let passiveTriggered = false
    // Holding B at transport isolates the ref hazard from stale Canvas receipt.
    frame.hold()
    boundary.layout = (props) => {
      if (!layoutTriggered && titleOf(props.slices) === "Firstb") {
        layoutTriggered = true
        frame.type("c")
      }
    }
    boundary.afterOwnerPassive = () => {
      if (layoutTriggered && !passiveTriggered) {
        passiveTriggered = true
        frame.type("d")
      }
    }
    act(() => frame.type("b"))
    expect(layoutTriggered).toBe(true)
    expect(passiveTriggered).toBe(true)
    assertComplete(frame, "Firstbcd", 3)
  }
)
