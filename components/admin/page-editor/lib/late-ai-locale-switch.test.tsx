import { isActiveContentType } from "@/convex/lib/contentTypes"
// DATA-LOSS-FIXES case 1, phase A (test 5): a late per-field AI answer after
// the owner switched language tabs. Harness copied from
// host-await-lifetime.test.tsx, but SeoPanel and ContentTypeFieldsPanel stay
// REAL, and a Writing participant is injected so the field Write buttons
// render. NOTE: today's shipped ADMIN_AI_WRITING_BROWSER_BINDING has no
// PageEditorSlot, so this path is reachable only with the injected participant.
import type { ReactNode } from "react"
import type { AdminAiTranslationHostProps } from "@/components/admin/contributions/ai-translation"
import type {
  AdminAiWritingPageEditorHostProps,
  AdminAiWritingRouteData,
} from "@/components/admin/contributions/ai-writing"
import type { FieldGenerate } from "@/components/admin/fields/field-editor"
import type { Page } from "../lib/types"
import type { Id } from "@/convex/_generated/dataModel"
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { toast } from "sonner"

const FIELD_CHANGED = "This field changed, so the AI answer was not applied."

const mocks = vi.hoisted(() => ({
  localeTabs: null as
    | Parameters<typeof import("@/components/admin/locale-tabs").LocaleTabs>[0]
    | null,
  mutation: vi.fn(),
  confirm: vi.fn(async () => true),
  prompt: vi.fn(async () => "a short brief" as string | null),
  push: vi.fn(),
  refresh: vi.fn(),
  enabledLocales: ["en", "fr"] as string[],
  convex: {
    query: vi.fn<(reference: unknown, args: unknown) => Promise<unknown>>(
      async () => []
    ),
  },
  generate: null as FieldGenerate | null,
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

vi.mock("@/components/admin/contributions/ai-translation", () => ({
  ADMIN_AI_TRANSLATION_BROWSER_BINDING: (
    props: AdminAiTranslationHostProps
  ) =>
    props.children({
      fieldTranslate: undefined,
      busy: false,
      command: null,
      control: null,
      setTranslateOpen() {},
      runPushedTranslate() {},
    }),
}))

// The injected Writing participant (absent from today's shipped binding).
vi.mock("@/components/admin/contributions/ai-writing", () => ({
  ADMIN_AI_WRITING_BROWSER_BINDING: {
    NewPageSlot: () => null,
    PageEditorSlot: (props: AdminAiWritingPageEditorHostProps) =>
      props.children({
        fieldGenerate: mocks.generate ?? undefined,
        metaGenerationAvailable: false,
        isGeneratingMeta: false,
        generateMeta: async () => {},
        commands: [],
      }),
  },
}))

vi.mock("@/components/admin/contributions/history", () => ({
  ADMIN_HISTORY_BROWSER_BINDING: null,
}))

vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useConvex: () => mocks.convex,
  useMutation:
    (reference: unknown) =>
    (...args: unknown[]) =>
      mocks.mutation(getFunctionName(reference as never), ...args),
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
    if (name === "cms/pages:getPrePublishChecklist")
      return { canPublish: true, blockers: [], warnings: [] }
    if (name === "cms/pages:listActiveEditors") return []
    if (name === "cms/pages:getPageEditorLock") return { status: "available" }
    return undefined
  },
  useQueries: (queries: Record<string, unknown>) => {
    const [key] = Object.keys(queries)
    if (!key) return {}
    return { [key]: { canPublish: true, blockers: [], warnings: [] } }
  },
  useQuery_experimental: () => ({ status: "success", data: [] }),
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
  usePrompt: () => mocks.prompt,
}))

vi.mock("@/components/admin/command-palette", () => ({
  useRegisterAdminCommands: () => {},
}))

vi.mock("@/components/admin/page-editor/components/settings-panel", () => ({
  SettingsPanel: () => null,
}))
vi.mock("@/components/admin/page-editor/components/blocks-panel", () => ({
  BlocksPanel: () => <div data-testid="block-panel" />,
}))
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
import { PageEditor } from "@/components/admin/page-editor"

const pageId = "page-1" as Id<"pages">

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function authorPage(frenchMetaTitle = "Titre FR"): Page {
  return {
    _id: pageId,
    _creationTime: 1,
    slug: "ada",
    localizedSlugs: {},
    pageType: "author",
    status: "draft",
    createdAt: 100,
    updatedAt: 100,
    name: "Ada",
    content: {
      en: { title: "Ada", blocks: [], metaTitle: "", roleTitle: "" },
      fr: {
        title: "Ada FR",
        blocks: [],
        metaTitle: frenchMetaTitle,
        roleTitle: "Rôle FR",
      },
    },
    tags: [],
    createdBy: "owner-1",
  } as unknown as Page
}

function mount(frenchMetaTitle?: string) {
  const answer = deferred<string>()
  mocks.generate = {
    run: vi.fn(() => answer.promise),
    runRefine: vi.fn(() => answer.promise),
    runBlock: vi.fn(),
  }
  const view = render(
    <PageEditor
      page={authorPage(frenchMetaTitle)}
      hasStaging={false}
      stagingUpdatedAt={undefined}
      publication={{
        authority: "snapshot_active",
        lifecycleGeneration: 3,
        sharedDraftGeneration: 4,
        locales: ["en", "fr"].map((locale) => ({
          locale,
          draftGeneration: 2,
          publicGeneration: 1,
          releaseGeneration: 1,
        })),
      }}
      aiTranslationRouteData={
        {
          mechanicalTranslation: {},
          brandTranslation: {},
        } as AdminAiTranslationHostProps["routeData"]
      }
      aiWritingRouteData={
        {
          editorialCopy: {},
          structuredOutlineMeta: {},
        } as AdminAiWritingRouteData
      }
    />,
    { reactStrictMode: true }
  )
  return { ...view, answer, generate: mocks.generate }
}

function switchLocale(locale: "en" | "fr") {
  act(() => {
    mocks.localeTabs!.onLocaleChange(locale)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.enabledLocales = ["en", "fr"]
  mocks.confirm.mockReset().mockResolvedValue(true)
  mocks.prompt.mockReset().mockResolvedValue("a short brief")
  mocks.mutation
    .mockReset()
    .mockImplementation(async () => ({
      status: "acquired",
      updatedAt: 101,
      lifecycleGeneration: 4,
    }))
  window.localStorage.clear()
  window.sessionStorage.clear()
})
afterEach(cleanup)

test("SEO meta title: an English answer after a switch to French does not land in French", async () => {
  const { generate, answer } = mount()
  fireEvent.click(screen.getByRole("button", { name: "SEO" }))
  const metaRow = () => document.getElementById("page-meta-title")!.parentElement!
  const write = within(metaRow()).getByRole("button", { name: "Write" })
  await act(async () => {
    fireEvent.click(write)
  })
  await waitFor(() => expect(generate.run).toHaveBeenCalledTimes(1))
  switchLocale("fr")
  expect(mocks.localeTabs!.currentLocale).toBe("fr")
  expect(document.getElementById("page-meta-title")).toHaveValue("Titre FR")
  // Finding: is the clicked button still mounted after the switch?
  const stillMounted = write.isConnected
  console.info(`[late-ai] SEO Write button mounted after switch: ${stillMounted}`)
  await act(async () => answer.resolve("English AI title"))
  expect(toast.error).toHaveBeenCalledWith(FIELD_CHANGED)
  // Correct behavior: French keeps its own value.
  expect(document.getElementById("page-meta-title")).toHaveValue("Titre FR")
  switchLocale("en")
  expect(document.getElementById("page-meta-title")).not.toHaveValue(
    "Titre FR"
  )
})

test.runIf(isActiveContentType("author"))("page-level localized field: an English answer after a switch to French does not land in French", async () => {
  const { generate, answer } = mount()
  const roleRow = () =>
    document.querySelector<HTMLElement>(
      '[data-block-field-path^="localized."][data-block-field-path$=".roleTitle"]'
    )!
  expect(roleRow().getAttribute("data-block-field-path")).toBe(
    "localized.en.roleTitle"
  )
  const write = within(roleRow()).getByRole("button", { name: "Write" })
  await act(async () => {
    fireEvent.click(write)
  })
  await waitFor(() => expect(generate.run).toHaveBeenCalledTimes(1))
  switchLocale("fr")
  expect(roleRow().getAttribute("data-block-field-path")).toBe(
    "localized.fr.roleTitle"
  )
  expect(within(roleRow()).getByRole("textbox")).toHaveValue("Rôle FR")
  const stillMounted = write.isConnected
  console.info(`[late-ai] roleTitle Write button mounted after switch: ${stillMounted}`)
  await act(async () => answer.resolve("English AI role"))
  expect(toast.error).toHaveBeenCalledWith(FIELD_CHANGED)
  // Correct behavior: French keeps its own value.
  expect(within(roleRow()).getByRole("textbox")).toHaveValue("Rôle FR")
})

test("SEO meta title: an English answer does not land in French when both are empty", async () => {
  const { generate, answer } = mount("")
  fireEvent.click(screen.getByRole("button", { name: "SEO" }))
  const metaRow = () => document.getElementById("page-meta-title")!.parentElement!
  await act(async () => {
    fireEvent.click(within(metaRow()).getByRole("button", { name: "Write" }))
  })
  await waitFor(() => expect(generate.run).toHaveBeenCalledTimes(1))
  switchLocale("fr")
  expect(document.getElementById("page-meta-title")).toHaveValue("")
  await act(async () => answer.resolve("English AI title"))
  expect(toast.error).toHaveBeenCalledWith(FIELD_CHANGED)
  expect(document.getElementById("page-meta-title")).toHaveValue("")
})
