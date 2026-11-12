import { createSampleSlice } from "@/convex/lib/slices/sample"
/**
 * Test-only diagnosis. Input: mounted editor updates (jsdom), NOT native keys.
 * Reuses page-editor-own-echo-boundary's infrastructure with normal delivery.
 * No React patches, hold/reentrant transport, shaping override or product fix.
 */
import { sliceProfile } from "@/test-utils/slice-profile"
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import type { Editor } from "@tiptap/core"
import { getFunctionName } from "convex/server"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import type { Id } from "@/convex/_generated/dataModel"
import type { Slice } from "@/convex/lib/slices"

import type { Page } from "./page-editor/lib/types"
import type { SlicesPanel } from "./page-editor/components/slices-panel"
import type { PreviewActiveEditHandle, PreviewInlineEditCommit } from "./visual-editing-types"
import type { LiveFrameWindow } from "./live-preview-frame-bridge"
import type { AdminAiTranslationHostProps } from "./contributions/ai-translation"

const boundary = vi.hoisted(() => ({
  catalog: undefined as unknown,
  sliceProps: [] as Parameters<typeof SlicesPanel>[0][],
  trace: [] as Array<Record<string, unknown>>,
  samples: [] as Array<Record<string, unknown>>,
  phase: "setup",
  sequence: 0,
  conflicts: 0,
  canvasConflicts: 0,
  handle: null as PreviewActiveEditHandle | null,
  parentBuffer: null as PreviewInlineEditCommit | null,
  canvasBuffer: null as PreviewInlineEditCommit | null,
  commits: [] as Array<{ commit: PreviewInlineEditCommit; accepted: boolean | void }>,
  refresh: vi.fn(),
  saveDraft: vi.fn(),
  convex: { query: vi.fn(async () => []) },
}))

vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useConvex: () => boundary.convex,
  useMutation: (reference: unknown) =>
    getFunctionName(reference as never) === "cms/publication:saveEditorDraft"
      ? boundary.saveDraft
      : vi.fn(async () => ({ status: "acquired", updatedAt: 101, generation: 1 })),
  useQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/slices:getPresentationCatalog") return boundary.catalog
    if (name === "cms/pages:getForEdit") return { page: { pageType: "landing-page" } }
    if (name === "cms/owner:getOwnerSession") return { ownerId: "owner-1", role: "admin" }
    if (name === "cms/settings:getSiteConfig") return {
      defaultLocale: "en", enabledLocales: ["en"], timezone: "UTC", languageVersion: 3,
    }
    if (name === "cms/pages:getPrePublishChecklist") return { canPublish: true, blockers: [], warnings: [] }
    if (name === "cms/pages:listActiveEditors") return []
    if (name === "cms/pages:getPageEditorLock") return { status: "available" }
    return undefined
  },
  useQueries: (queries: Record<string, unknown>) => Object.fromEntries(
    Object.keys(queries).map(key => [key, { canPublish: true, blockers: [], warnings: [] }])
  ),
}))
vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: boundary.refresh, replace: vi.fn() }),
}))
vi.mock("sonner", () => ({ toast: {
  dismiss: vi.fn(), error: vi.fn(), loading: vi.fn(), message: vi.fn(), success: vi.fn(),
} }))
vi.mock("@/app/(core)/admin/(authenticated)/pages/actions", () => ({ revalidatePagePaths: vi.fn(async () => undefined) }))
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => true) }))
vi.mock("@/components/admin/command-palette", () => ({ useRegisterAdminCommands() {} }))
vi.mock("./contributions/ai-translation", () => ({
  ADMIN_AI_TRANSLATION_BROWSER_BINDING: (props: AdminAiTranslationHostProps) => props.children({
    fieldTranslate: undefined, busy: false, command: null, control: null,
    setTranslateOpen() {}, runPushedTranslate() {},
  }),
}))
vi.mock("./contributions/history", () => ({ ADMIN_HISTORY_BROWSER_BINDING: null }))
vi.mock("./page-editor/components/snapshot-history-panel", () => ({ SnapshotHistoryPanelSlot: () => null }))
vi.mock("./duplicate-page-dialog", () => ({ DuplicatePageDialog: () => null }))
vi.mock("./content-type-fields-panel", () => ({ ContentTypeFieldsPanel: () => null }))
vi.mock("./page-editor/components/seo-panel", () => ({ SeoPanel: () => null }))
vi.mock("./page-editor/components/settings-panel", () => ({ SettingsPanel: () => null }))
vi.mock("@/lib/preview-build-id", () => ({ PREVIEW_BUILD_ID: "test-build" }))
vi.mock("@/components/providers", () => ({ Providers: ({ children }: { children: ReactNode }) => children }))
vi.mock("@/components/theme-provider", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock("@/components/public/public-site-shell", () => ({
  PublicSiteShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("./slice-builder", () => ({ SliceBuilder: () => null }))

// importOriginal wrappers call the original once, return its exact result, and
// observe only afterwards. Internal lexical calls stay original/unwrapped.
vi.mock("./page-editor/lib/page-inline-draft", async importOriginal => {
  const actual = await importOriginal<typeof import("./page-editor/lib/page-inline-draft")>()
  const observe = (kind: string, args: Parameters<typeof actual.applyPageField>, result: unknown) => {
    try {
      const [slices, locale, commit, epoch, catalog = ""] = args
      const current = actual.capturePageField(slices, locale, commit.sliceId, commit.fieldPath, epoch, catalog)
      record(kind, {
        locale, epoch, catalog, commit: commitState(commit), current: commitState(current),
        returnedNull: result === null,
        returnedSameCommit: result === commit,
        guardPreconditions: {
          bindingPresent: Boolean(commit.fieldBinding),
          localeMatches: commit.locale === locale,
          epochMatches: commit.fieldBinding?.contentEpoch === epoch,
          catalogMatches: commit.fieldBinding?.catalogRevision === catalog,
          captureFound: Boolean(current),
          sliceTypeMatches: current?.sliceType === commit.sliceType,
          kindMatches: current?.kind === commit.kind,
          presentationMatches: current?.fieldBinding?.presentation === commit.fieldBinding?.presentation,
          descriptorMatches: current?.fieldBinding?.descriptor === commit.fieldBinding?.descriptor,
          currentValueMatchesLastApplied: current?.value === commit.fieldBinding?.lastApplied,
          currentFingerprintMatchesBinding: current?.fieldBinding?.itemFingerprint === commit.fieldBinding?.itemFingerprint,
        },
        result: Array.isArray(result) ? fieldState(result as Slice[], commit.fieldPath) :
          result && typeof result === "object" ? commitState(result as PreviewInlineEditCommit) : result,
        limit: "Precondition observations only; source guard order determines cause, no alternate acceptance",
      })
    } catch (error) { record("observer-error", { kind, message: String(error) }) }
  }
  return {
    ...actual,
    applyPageField: (...args: Parameters<typeof actual.applyPageField>) => {
      const result = actual.applyPageField(...args)
      observe("applyPageField", args, result)
      return result
    },
    rebasePageField: (...args: Parameters<typeof actual.rebasePageField>) => {
      const result = actual.rebasePageField(...args)
      observe("rebasePageField", args, result)
      return result
    },
    reconcilePageFieldEcho: (...args: Parameters<typeof actual.reconcilePageFieldEcho>) => {
      const result = actual.reconcilePageFieldEcho(...args)
      try {
        const [slices, locale, commit, echo, epoch, catalog = ""] = args
        const current = actual.capturePageField(slices, locale, commit.sliceId, commit.fieldPath, epoch, catalog)
        record("reconcilePageFieldEcho", {
          locale, epoch, catalog, commit: commitState(commit), echo: commitState(echo), current: commitState(current),
          returnedNull: result === null,
          receiptPresent: Boolean(echo?.frameBinding),
          // A receiptless call is observed, never declared causal/benign merely because null.
          echoPreconditions: {
            frameBindingPresent: Boolean(echo?.frameBinding),
            inlineSessionPresent: Boolean(commit.inlineSessionId),
            inlineSessionMatches: echo?.inlineSessionId === commit.inlineSessionId,
            echoLocaleMatches: echo?.locale === locale,
            commitLocaleMatches: commit.locale === locale,
            sliceIDMatches: echo?.sliceId === commit.sliceId,
            sliceTypeMatches: echo?.sliceType === commit.sliceType,
            fieldPathMatches: echo?.fieldPath === commit.fieldPath,
            kindMatches: echo?.kind === commit.kind,
            commitBindingPresent: Boolean(commit.fieldBinding),
            echoBindingPresent: Boolean(echo?.fieldBinding),
            commitEpochMatches: commit.fieldBinding?.contentEpoch === epoch,
            echoEpochMatches: echo?.fieldBinding?.contentEpoch === epoch,
            commitCatalogMatches: commit.fieldBinding?.catalogRevision === catalog,
            echoCatalogMatches: echo?.fieldBinding?.catalogRevision === catalog,
            presentationMatches: commit.fieldBinding?.presentation === echo?.fieldBinding?.presentation,
            descriptorMatches: commit.fieldBinding?.descriptor === echo?.fieldBinding?.descriptor,
            captureFound: Boolean(current),
            currentValueMatchesEchoValue: current?.value === echo?.value,
          },
          result: result ? fieldState(result, commit.fieldPath) : null,
          limit: "Initial receiptless nulls remain distinct from later sequence immediately preceding actual conflict callback",
        })
      } catch (error) { record("observer-error", { kind: "reconcile", message: String(error) }) }
      return result
    },
  }
})

vi.mock("./page-editor/components/slices-panel", async importOriginal => {
  const actual = await importOriginal<typeof import("./page-editor/components/slices-panel")>()
  return { SlicesPanel: (props: Parameters<typeof actual.SlicesPanel>[0]) => {
    boundary.sliceProps.push(props)
    return <actual.SlicesPanel {...props}
      onPreviewInlineEditCommit={commit => {
        const accepted = props.onPreviewInlineEditCommit(commit)
        boundary.commits.push({ commit, accepted })
        record("parent-commit", { commit: commitState(commit), accepted })
        return accepted
      }}
      onPreviewActiveEditHandleChange={handle => {
        boundary.handle = handle
        props.onPreviewActiveEditHandleChange?.(handle)
      }}
      onPreviewActiveEditChange={commit => {
        boundary.parentBuffer = commit
        record("parent-buffer", { commit: commitState(commit) })
        props.onPreviewActiveEditChange?.(commit)
      }}
      onPreviewActiveEditConflict={() => {
        boundary.conflicts += 1
        record("parent-conflict", { buffer: commitState(boundary.parentBuffer) })
        props.onPreviewActiveEditConflict?.()
      }}
    />
  } }
})
vi.mock("./page-live-preview-canvas", async importOriginal => {
  const actual = await importOriginal<typeof import("./page-live-preview-canvas")>()
  return { ...actual, PageLivePreviewCanvas: (props: Parameters<typeof actual.PageLivePreviewCanvas>[0]) => (
    <actual.PageLivePreviewCanvas {...props}
      onActiveEditChange={commit => {
        boundary.canvasBuffer = commit
        record("canvas-buffer", { commit: commitState(commit) })
        props.onActiveEditChange?.(commit)
      }}
      onActiveEditConflict={() => {
        boundary.canvasConflicts += 1
        record("canvas-conflict", { buffer: commitState(boundary.canvasBuffer) })
        props.onActiveEditConflict?.()
      }}
    />
  ) }
})

import { PageEditor } from "./page-editor"
import { LivePreviewFrameRuntime } from "./live-preview-frame-runtime"
import { readSlicePresentationCatalog } from "@/convex/lib/slices/presentations"

function record(kind: string, value: Record<string, unknown>) {
  boundary.trace.push(JSON.parse(JSON.stringify({ sequence: ++boundary.sequence, phase: boundary.phase, kind, ...value })))
}
function documentState(value: unknown) {
  if (typeof value !== "string") return { value, text: null, levels: [] }
  try {
    const parsed = JSON.parse(value)
    const levels: unknown[] = []
    const text = (node: { type?: string; text?: string; attrs?: { level?: unknown }; content?: unknown[] }): string => {
      if (node.type === "heading") levels.push(node.attrs?.level ?? null)
      if (node.type === "text") return node.text ?? ""
      if (node.type === "hardBreak") return "\n"
      return (node.content ?? []).map(child => text(child as typeof node)).join("")
    }
    return { value, text: text(parsed), levels }
  } catch { return { value, text: value, levels: [] } }
}
function commitState(commit: PreviewInlineEditCommit | null | undefined) {
  return commit ? {
    sliceId: commit.sliceId, sliceType: commit.sliceType, locale: commit.locale,
    fieldPath: commit.fieldPath, inlineSessionId: commit.inlineSessionId,
    value: documentState(commit.value), lastApplied: documentState(commit.fieldBinding?.lastApplied),
    fieldBinding: commit.fieldBinding, frameBinding: commit.frameBinding, repeatedTarget: commit.repeatedTarget,
  } : null
}
function fieldValue(slices: Slice[], fieldPath: string) {
  return fieldPath.split(".").reduce<unknown>((value, key) =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
    slices[0])
}
function fieldState(slices: Slice[], fieldPath: string) { return documentState(fieldValue(slices, fieldPath)) }
const titleDoc = (text: string, level: number) => JSON.stringify({
  type: "doc", content: [{ type: "heading", attrs: { level }, content: [{ type: "text", text }] }],
})
const pageId = "page-1" as Id<"pages">

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() })
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [new DOMRect()] })
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() })
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
})
beforeEach(async () => {
  boundary.catalog = await readSlicePresentationCatalog()
  boundary.sliceProps = []; boundary.trace = []; boundary.samples = []; boundary.sequence = 0
  boundary.conflicts = 0; boundary.canvasConflicts = 0; boundary.commits = []
  boundary.handle = null; boundary.parentBuffer = null; boundary.canvasBuffer = null; boundary.phase = "setup"
  window.localStorage.clear(); window.sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  delete (window as LiveFrameWindow).__formulacmsLiveFrame
  vi.restoreAllMocks()
})

async function setupBoundary(fieldPath: "items.0.title" | "primary.heading") {
  const sample = createSampleSlice("features-icon-grid")
  if (sample.type !== "features-icon-grid") throw new Error("Factory did not return Features fixture")
  sample.primary.heading = titleDoc("First section", 2)
  sample.items = [{ ...sample.items[0]!, title: titleDoc("First item", 3) }]
  const slices = [sample] as Slice[]
  const fixture = {
    _id: pageId, _creationTime: 1, slug: "about", localizedSlugs: {}, pageType: "landing-page",
    status: "draft", createdAt: 100, updatedAt: 100, createdBy: "owner-1", tags: [],
    content: { en: { title: "About", slices } },
  } as Page
  const parent = render(<PageEditor page={fixture} hasStaging={false} stagingUpdatedAt={undefined} publication={{
    authority: "snapshot_active", lifecycleGeneration: 3, sharedDraftGeneration: 4,
    locales: [{ locale: "en", draftGeneration: 2, publicGeneration: 1, releaseGeneration: 1 }],
  }} />)
  const iframe = parent.getByTitle("About") as HTMLIFrameElement
  const child = iframe.contentWindow as LiveFrameWindow
  const sessionId = new URL(iframe.src).searchParams.get("session")!
  const identity = { sessionId, pageId: pageId as string, locale: "en" }
  const shell = {
    header: { logoUrl: null, locale: "en", defaultLocale: "en", enabledLocales: ["en"], languageVersion: 3, mainMenuItems: [] },
    footer: { logoUrl: null, locale: "en", defaultLocale: "en", cardsBySource: {}, footerMenu: null, chrome: null },
  }
  const posted: unknown[] = []
  vi.spyOn(window.parent, "postMessage").mockImplementation(value => { posted.push(value) })
  const runtime = render(<LivePreviewFrameRuntime identity={identity} page={{ pageType: "landing-page" } as never}
    config={{ defaultLocale: "en", enabledLocales: ["en"], languageVersion: 3 }} shell={shell}
    publicPath="/published" presentationCatalog={boundary.catalog as never} />)
  const actual = (window as LiveFrameWindow).__formulacmsLiveFrame!
  expect(actual).toBeDefined()
  // Real bridge, normal immediate parent input delivery. No replaceInput proxy.
  child.__formulacmsLiveFrame = actual
  const ready = posted.find(value => (value as { type?: string })?.type === "ready")
  expect(ready).toBeDefined()
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: child, data: ready }))
  })
  fireEvent.click(parent.getByRole("button", { name: /^Edit text in preview: off$/ }))
  const selector = `[data-preview-field="${fieldPath}"]`
  await waitFor(() => expect(runtime.container.querySelector(selector)).toBeTruthy())
  fireEvent.click(runtime.container.querySelector(selector)!)
  await waitFor(() => expect(runtime.container.querySelector("[contenteditable=true]")).toBeTruthy())
  const host = runtime.container.querySelector("[contenteditable=true]") as HTMLElement & { editor: Editor }
  const editor = host.editor
  expect(editor).toBeDefined()
  record("activated", { fieldPath, parent: fieldState(boundary.sliceProps.at(-1)!.slices, fieldPath), active: commitState(boundary.handle?.capture()) })
  return { parent, runtime, editor, fieldPath }
}
type Mounted = Awaited<ReturnType<typeof setupBoundary>>
function mountedEditor(frame: Mounted) {
  // Observe the editor that currently owns the DOM after the echo settles.
  // Do not reactivate a field or write through a destroyed/replaced instance.
  const host = frame.runtime.container.querySelector("[contenteditable=true]") as
    (HTMLElement & { editor?: Editor }) | null
  return host?.editor && !host.editor.isDestroyed ? host.editor : null
}
function observeCharacter(frame: Mounted, expected: string) {
  const pending = frame.parent.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Pending text"]')
  const editor = mountedEditor(frame)
  const sample = {
    expected, phase: boundary.phase,
    editorText: editor?.getText() ?? null,
    editorDocument: editor ? documentState(JSON.stringify(editor.getJSON())) : null,
    originalEditorDestroyed: frame.editor.isDestroyed,
    liveEditorPresent: editor !== null,
    liveEditorIsOriginal: editor === frame.editor,
    parent: fieldState(boundary.sliceProps.at(-1)!.slices, frame.fieldPath),
    active: commitState(boundary.handle?.capture()), parentBuffer: commitState(boundary.parentBuffer),
    canvasBuffer: commitState(boundary.canvasBuffer), pendingUI: pending ? documentState(pending.value) : null,
    alert: frame.parent.container.querySelector('[role="alert"]')?.textContent ?? null,
    conflicts: boundary.conflicts, canvasConflicts: boundary.canvasConflicts,
  }
  boundary.samples.push(sample)
  return sample
}
function assertCharacter(frame: Mounted, expected: string, level: number) {
  const sample = observeCharacter(frame, expected)
  expect.soft(sample.editorText).toBe(expected)
  expect.soft(sample.parent.text).toBe(expected)
  expect.soft(sample.parent.levels).toEqual([level])
  expect.soft(sample.active?.value.text).toBe(expected)
  expect.soft(sample.parentBuffer?.value.text).toBe(expected)
  expect.soft(sample.canvasBuffer?.value.text).toBe(expected)
  expect.soft(sample.pendingUI).toBeNull()
  expect.soft(sample.alert).toBeNull()
  expect.soft(boundary.conflicts).toBe(0)
  expect.soft(boundary.canvasConflicts).toBe(0)
}
async function twoCharacters(frame: Mounted, level: number) {
  boundary.phase = "character-O"
  await act(async () => { frame.editor.commands.selectAll(); frame.editor.commands.insertContent("O") })
  assertCharacter(frame, "O", level)
  boundary.phase = "character-r"
  const editor = mountedEditor(frame)
  expect(editor, "The actual mounted editor must remain available for the next character").not.toBeNull()
  await act(async () => { editor!.commands.insertContent("r") })
  assertCharacter(frame, "Or", level)
}
function emit(label: string) {
  console.log("ITEM_TITLE_BOUNDARY_TRACE", JSON.stringify({
    label, input: "mounted editor updates (jsdom)", sourceBoundary: "PageEditor→Frame/controller→Runtime→Canvas→TipTap→PageEditor",
    conflicts: boundary.conflicts, canvasConflicts: boundary.canvasConflicts,
    commits: boundary.commits.map(row => ({ accepted: row.accepted, commit: commitState(row.commit) })),
    samples: boundary.samples, sequence: boundary.trace,
    instrumentationLimit: "Exported wrappers only; original lexical nested calls are not intercepted. All originals returned unchanged; no source/React patch, transport delay, native input or Save/backend proof.",
  }))
}

test("itemTitle3: per-character mounted editor updates (jsdom) retain parent and buffers without conflict", sliceProfile(["features-icon-grid"]), async () => {
  try { const frame = await setupBoundary("items.0.title"); await twoCharacters(frame, 3) }
  finally { emit("itemTitle3-positive-contract-expected-RED-on-current-source") }
})
test("sliceTitle2: per-character mounted editor updates (jsdom) positive control", sliceProfile(["features-icon-grid"]), async () => {
  try { const frame = await setupBoundary("primary.heading"); await twoCharacters(frame, 2) }
  finally { emit("sliceTitle2-positive-control") }
})
test("mounted competing producer: genuine same-field parent write still refuses stale inline binding", sliceProfile(["features-icon-grid"]), async () => {
  try {
    const frame = await setupBoundary("primary.heading")
    boundary.phase = "first-mounted-character"
    await act(async () => { frame.editor.commands.selectAll(); frame.editor.commands.insertContent("O") })
    assertCharacter(frame, "O", 2)
    boundary.phase = "competing-parent-producer"
    const latest = boundary.sliceProps.at(-1)!
    const competing = structuredClone(latest.slices)
    const target = competing[0]
    if (target.type !== "features-icon-grid") throw new Error("Competing fixture changed Type")
    target.primary.heading = titleDoc("Competing parent", 2)
    // Actual PageEditor onSlicesChange producer; not a mocked parent projection.
    await act(async () => { latest.onSlicesChange(competing) })
    observeCharacter(frame, "O")
    expect.soft(boundary.conflicts).toBeGreaterThan(0)
    expect.soft(boundary.canvasConflicts).toBeGreaterThan(0)
    expect.soft(fieldState(boundary.sliceProps.at(-1)!.slices, frame.fieldPath).text).toBe("Competing parent")
    boundary.phase = "stale-character-r"
    await act(async () => { frame.editor.commands.insertContent("r") })
    const sample = observeCharacter(frame, "Or")
    expect.soft(sample.editorText).toBe("Or")
    expect.soft(sample.parent.text).toBe("Competing parent")
    expect.soft(sample.parent.levels).toEqual([2])
    expect.soft(sample.pendingUI?.text).toBe("Or")
    expect.soft(sample.alert).toContain("The list changed")
  } finally { emit("mounted-competing-producer-negative-not-second-browser-tab") }
})
