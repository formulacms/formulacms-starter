import { act, fireEvent, screen } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import type { Page, PrePublishChecklist } from "./page-editor/lib/types"
const mocks = vi.hoisted(() => ({
  commandIds: [] as string[],
  siteConfig: undefined as { defaultLocale: string; enabledLocales: string[] } | undefined,
  history: null as import("./contributions/history").AdminPageHistoryHostProps | null,
  confirm: vi.fn<
    (options: {
      title: string
      description?: string
      confirmText?: string
      cancelText?: string
      destructive?: boolean
    }) => Promise<boolean>
  >(async () => true),
  convex: {
    query: vi.fn<(reference: unknown, args: unknown) => Promise<unknown>>(
      async () => []
    ),
  },
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  queries: [] as Array<{ name: string; args: unknown }>,
  push: vi.fn(),
  freshChecklist: {
    canPublish: true,
    blockers: [],
    warnings: [],
  } as PrePublishChecklist,
  subscriptionChecklistResult: {
    canPublish: true,
    blockers: [],
    warnings: [],
  } as PrePublishChecklist | Error | undefined,
  publishCommand: null as {
    disabled?: boolean
    disabledReason?: string
  } | null,
  languageNotice: null as unknown,
  retainedTargetRemedy: null as unknown,
}))

function mutation(name: string) {
  let fn = mocks.mutations.get(name)
  if (!fn) {
    fn = vi.fn(async () => ({
      status: "acquired",
      updatedAt: 101,
      generation: 1,
    }))
    mocks.mutations.set(name, fn)
  }
  return fn
}

vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useConvex: () => mocks.convex,
  useMutation: (reference: unknown) =>
    mutation(getFunctionName(reference as never)),
  useQuery: (reference: unknown, args: unknown) => {
    const name = getFunctionName(reference as never)
    mocks.queries.push({ name, args })
    if (name === "cms/owner:getOwnerSession") {
      return { ownerId: "owner-1", role: "admin" }
    }
    if (name === "cms/settings:getSiteConfig") {
      return mocks.siteConfig
    }
    if (name === "cms/pages:getPrePublishChecklist") {
      return { canPublish: true, blockers: [], warnings: [] }
    }
    if (name === "cms/language:getSourcePublicationNotice") {
      return mocks.languageNotice
    }
    if (name === "cms/language:getRetainedTargetDraftRemedy") {
      return mocks.retainedTargetRemedy
    }
    if (name === "cms/pages:listActiveEditors") return []
    if (name === "cms/pages:getPageEditorLock") return { status: "available" }
    return undefined
  },
  useQueries: (queries: Record<string, { query: unknown; args: unknown }>) => {
    const [key] = Object.keys(queries)
    if (!key) return {}
    const request = queries[key]!
    mocks.queries.push({
      name: getFunctionName(request.query as never),
      args: request.args,
    })
    return { [key]: mocks.subscriptionChecklistResult }
  },
}))

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  useRouter: () => ({ push: mocks.push, refresh: vi.fn(), replace: vi.fn() }),
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
  useRegisterAdminCommands: (
    commands: Array<{
      id: string
      disabled?: boolean
      disabledReason?: string
    }>
  ) => {
    if (commands.length > 0) {
      mocks.commandIds = commands.map((command) => command.id)
      const publish = commands.find(
        (command) => command.id === "page-editor:publish"
      )
      if (publish) mocks.publishCommand = publish
    }
  },
}))

vi.mock("./duplicate-page-dialog", () => ({ DuplicatePageDialog: () => null }))
vi.mock("./content-type-fields-panel", () => ({
  ContentTypeFieldsPanel: () => null,
}))
vi.mock("./page-editor/components/seo-panel", () => ({ SeoPanel: () => null }))
vi.mock("./page-editor/components/settings-panel", () => ({
  SettingsPanel: ({
    tags,
    onTagsChange,
  }: Parameters<
    typeof import("./page-editor/components/settings-panel").SettingsPanel
  >[0]) => (
    <input
      aria-label="Synthetic shared tags"
      value={tags.join(",")}
      onChange={(event) =>
        onTagsChange(event.target.value ? event.target.value.split(",") : [])
      }
    />
  ),
}))
vi.mock("./page-editor/components/slices-panel", () => ({
  SlicesPanel: () => null,
}))

vi.mock("./contributions/history", () => ({
  ADMIN_HISTORY_BROWSER_BINDING: {
    PanelSlot: (props: import("./contributions/history").AdminPageHistoryHostProps) => {
      mocks.history = props
      return null
    },
  },
}))
vi.mock("./page-editor/components/snapshot-history-panel", () => ({
  SnapshotHistoryPanelSlot: (props: import("./contributions/history").AdminPageHistoryHostProps) => {
    mocks.history = props
    return null
  },
}))
import { PageEditor } from "./page-editor"
import { resolveRequestedEditorLocale } from "./page-editor/lib/requested-locale"


const source = {
  _id: "locale-page" as Id<"pages">, _creationTime: 1, pageType: "page",
  slug: "about", status: "draft", updatedAt: 100, createdAt: 100,
  content: { en: { title: "About", slices: [] }, fr: { title: "À propos", slices: [] } },
  tags: [], localizedSlugs: {}, createdBy: "owner-1",
} as Page
const publication = {
  authority: "snapshot_active" as const, lifecycleGeneration: 3, sharedDraftGeneration: 4,
  locales: ["en", "fr"].map((locale) => ({ locale, draftGeneration: 2, publicGeneration: 1, releaseGeneration: 1 })),
}

describe("requested editor locale", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutations.clear()
    mocks.queries.length = 0
    mocks.history = null
    mocks.siteConfig = { defaultLocale: "en", enabledLocales: ["en", "fr"] }
    mocks.languageNotice = null
    mocks.retainedTargetRemedy = null
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  test.each([
    { name: "chosen translation", requestedLocale: "fr", expected: "À propos" },
    { name: "enabled missing translation", requestedLocale: "es", expected: "" },
    { name: "no valid request", requestedLocale: undefined, expected: "About" },
    { name: "replacement target excluded", requestedLocale: "fr", replacementTargetLocale: "fr", expected: "About" },
    { name: "language=new target wins", requestedLocale: "en", targetDraftLocale: "fr", expected: "À propos" },
  ])("$name", ({ expected, requestedLocale, ...scenario }) => {
    const { targetDraftLocale, replacementTargetLocale } = scenario
    mocks.siteConfig!.enabledLocales.push("es")
    render(<PageEditor page={source} hasStaging={false} stagingUpdatedAt={undefined} requestedLocale={requestedLocale} targetDraftLocale={targetDraftLocale} replacementTargetLocale={replacementTargetLocale} />)
    expect(screen.getByLabelText("Page title")).toHaveValue(expected)
  })

  test.each([
    { name: "first query value", raw: ["en", "fr"], expected: "About" },
    // No valid request: the interface language (English here) when it is a
    // site language, never the first key of the stored content.
    { name: "invalid query", raw: "bogus", expected: "About" },
    { name: "disabled query", raw: "es", expected: "About" },
    { name: "empty query array", raw: [], expected: "About" },
    { name: "absent query", raw: undefined, expected: "About" },
  ])("validated route prop: $name", ({ raw, expected }) => {
    const requestedLocale = resolveRequestedEditorLocale(raw, ["en", "fr"])
    render(<PageEditor page={{ ...source, content: { fr: source.content!.fr, en: source.content!.en } } as Page}
      hasStaging={false} stagingUpdatedAt={undefined} requestedLocale={requestedLocale} />)
    expect(screen.getByLabelText("Page title")).toHaveValue(expected)
  })

  test.each([
    { name: "French interface, French is a site language", admin: "fr" as const, config: { defaultLocale: "en", enabledLocales: ["en", "fr"] }, expected: "À propos" },
    { name: "French interface, French is not a site language", admin: "fr" as const, config: { defaultLocale: "en", enabledLocales: ["en", "es"] }, expected: "About" },
    { name: "English interface, default is French", admin: "en" as const, config: { defaultLocale: "fr", enabledLocales: ["fr", "es"] }, expected: "À propos" },
  ])("opens on the interface language or else the site default: $name", ({ admin, config, expected }) => {
    mocks.siteConfig = config
    render(<PageEditor page={source} hasStaging={false} stagingUpdatedAt={undefined} />, { locale: admin })
    expect(screen.getByLabelText(admin === "fr" ? "Titre de la page" : "Page title")).toHaveValue(expected)
  })

  test("the first render already knows the site languages from the route, before the query answers", () => {
    mocks.siteConfig = undefined
    render(<PageEditor page={source} hasStaging={false} stagingUpdatedAt={undefined} routeDefaultLocale="en" routeEnabledLocales={["en", "fr"]} />, { locale: "fr" })
    expect(screen.getByLabelText("Titre de la page")).toHaveValue("À propos")
  })

  test("a Not translated language shows the real Page title placeholder in the empty title input", () => {
    mocks.siteConfig!.enabledLocales.push("es")
    render(<PageEditor page={source} hasStaging={false} stagingUpdatedAt={undefined} requestedLocale="es" />)
    const header = screen.getByLabelText("Page title")
    expect(header).toHaveValue("")
    expect(header).toHaveAttribute("placeholder", "Page title")
  })

  test("a later history restore keeps the explicitly selected editor locale after remount", () => {
    const view = render(<PageEditor page={source} hasStaging={false} stagingUpdatedAt={undefined} requestedLocale="fr" publication={publication} />)
    expect(screen.getByLabelText("Page title")).toHaveValue("À propos")
    fireEvent.click(screen.getByRole("tab", { name: /^EN/ }))
    fireEvent.click(screen.getByTitle("History"))
    act(() => mocks.history!.onSnapshotRestored!({ locale: "en", draftGeneration: 3, sharedDraftGeneration: 5 }))
    view.rerender(<PageEditor page={{ ...source, content: { fr: source.content!.fr, en: { title: "Restored English", slices: [] } } } as Page}
      hasStaging stagingUpdatedAt={undefined} requestedLocale="fr" publication={{ ...publication, sharedDraftGeneration: 5, locales: publication.locales.map((entry) => ({ ...entry, draftGeneration: 3 })) }} />)
    expect(screen.getByLabelText("Page title")).toHaveValue("Restored English")
    expect(screen.getByRole("tab", { name: /^EN/ })).toHaveAttribute("aria-selected", "true")
  })

  test("a requested locale prop update preserves an unsaved mounted session", () => {
    const view = render(<PageEditor page={source} hasStaging={false} stagingUpdatedAt={undefined} requestedLocale="en" />)
    fireEvent.change(screen.getByLabelText("Page title"), { target: { value: "Unsaved title" } })
    view.rerender(<PageEditor page={source} hasStaging={false} stagingUpdatedAt={undefined} requestedLocale="fr" />)
    expect(screen.getByLabelText("Page title")).toHaveValue("Unsaved title")
  })

  test.each([
    { requestedLocale: "en", expectedTitle: "About", expectedSlug: "about", afterSlug: "revised" },
    { requestedLocale: "de", expectedTitle: "Über uns", expectedSlug: "deutscher-name", afterSlug: "deutscher-name" },
  ])("cold load default de, requested $requestedLocale seeds the right slug and linkage", ({ requestedLocale, expectedTitle, expectedSlug, afterSlug }) => {
    mocks.siteConfig = undefined
    render(<PageEditor page={{ ...source, slug: "deutscher-name", content: { en: source.content!.en, de: { title: "Über uns", slices: [] } } } as Page}
      hasStaging={false} stagingUpdatedAt={undefined} requestedLocale={requestedLocale} routeDefaultLocale="de" />)
    expect(screen.getByLabelText("Page title")).toHaveValue(expectedTitle)
    expect(screen.getByText(`/${expectedSlug}`)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Page title"), { target: { value: "Revised" } })
    expect(screen.getByText(`/${afterSlug}`)).toBeInTheDocument()
  })
})
