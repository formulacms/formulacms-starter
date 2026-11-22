import { cleanup, screen, within } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import type { Page, PrePublishChecklist } from "./page-editor/lib/types"

// ADR-0037 amendment (2026-11-17): on a language tab that the content type's
// translation switch hides, the editor shows the amber notice and Publish is
// disabled there; every other tab is unchanged.
const mocks = vi.hoisted(() => ({
  convex: { query: vi.fn(async () => []) },
  enabledLocales: ["en", "fr"] as string[],
  homePageId: null as string | null,
  untranslated: [] as { pageType: string; locale: string }[],
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
        homePageId: mocks.homePageId,
        timezone: "UTC",
      }
    }
    if (name === "cms/pages:getPrePublishChecklist") {
      return mocks.checklist
    }
    if (name === "cms/contentTypes:getUntranslatedContentTypes")
      return mocks.untranslated
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
    void commands
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
vi.mock("./page-editor/components/blocks-panel", () => ({
  BlocksPanel: () => null,
}))

vi.mock("./contributions/history", () => ({
  ADMIN_HISTORY_BROWSER_BINDING: { PanelSlot: () => null },
}))

import { PageEditor } from "./page-editor"

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

type Entry = {
  locale: string
  state: "published" | "draft" | "not_translated"
  path?: string | null
}
function mount(options: {
  locale: "en" | "fr"
  requestedLocale: "en" | "fr"
  pageType?: string
  entries: Entry[]
  home?: boolean
  status?: string
  untranslated?: { pageType: string; locale: string }[]
}) {
  mocks.homePageId = options.home ? "page-1" : null
  mocks.untranslated = options.untranslated ?? []
  const page = {
    _id: "page-1" as Id<"pages">,
    _creationTime: 1,
    slug: "about",
    localizedSlugs: {},
    pageType: options.pageType ?? "page",
    status: options.status ?? "draft",
    createdAt: 100,
    updatedAt: 100,
    content: {
      en: { title: "About", blocks: [] },
      fr: { title: "À propos", blocks: [] },
    },
    tags: [],
    createdBy: "owner-1",
  } as Page
  const view = render(
    <PageEditor
      page={page}
      hasStaging={false}
      stagingUpdatedAt={undefined}
      requestedLocale={options.requestedLocale}
      publication={{
        authority: "snapshot_active",
        lifecycleGeneration: 3,
        sharedDraftGeneration: 4,
        locales: options.entries.map((entry) => ({
          draftGeneration: 2,
          publicGeneration: 1,
          releaseGeneration: 1,
          ...entry,
        })),
      }}
    />,
    { locale: options.locale }
  )
  return { header: within(view.container.querySelector("header")!), view }
}

const ENTRIES: Entry[] = [
  { locale: "en", state: "draft", path: "/about" },
  { locale: "fr", state: "draft", path: "/a-propos" },
]
const POSTS_IN_ENGLISH = [{ pageType: "post", locale: "en" }]

function publishButton(header: ReturnType<typeof mount>["header"]) {
  return header.getByRole("button", { name: /^(Publish|Publier)$/ })
}

test("the hidden language's tab shows the notice and Publish is disabled", () => {
  const { header } = mount({
    locale: "en",
    requestedLocale: "fr",
    pageType: "post",
    entries: ENTRIES,
    untranslated: POSTS_IN_ENGLISH,
  })
  const message = "Not shown on the site: translation is off for Posts."
  expect(screen.getByTestId("translation-off-notice")).toHaveTextContent(
    message
  )
  expect(publishButton(header)).toBeDisabled()
  expect(publishButton(header)).toHaveAttribute("title", message)
})

test("the kept language's tab is unchanged", () => {
  const { header } = mount({
    locale: "en",
    requestedLocale: "en",
    pageType: "post",
    entries: ENTRIES,
    untranslated: POSTS_IN_ENGLISH,
  })
  expect(screen.queryByTestId("translation-off-notice")).toBeNull()
  expect(publishButton(header)).toBeEnabled()
})

test("the notice reads in French", () => {
  mount({
    locale: "fr",
    requestedLocale: "fr",
    pageType: "post",
    entries: ENTRIES,
    untranslated: POSTS_IN_ENGLISH,
  })
  expect(screen.getByTestId("translation-off-notice")).toHaveTextContent(
    "Non affiché sur le site : la traduction est désactivée pour les articles."
  )
})

test("the Home page stays in every language", () => {
  const { header } = mount({
    locale: "en",
    requestedLocale: "fr",
    pageType: "post",
    home: true,
    entries: ENTRIES,
    untranslated: POSTS_IN_ENGLISH,
  })
  expect(screen.queryByTestId("translation-off-notice")).toBeNull()
  expect(publishButton(header)).toBeEnabled()
})

test("another content type's switch has no effect here", () => {
  mount({
    locale: "en",
    requestedLocale: "fr",
    pageType: "page",
    entries: ENTRIES,
    untranslated: POSTS_IN_ENGLISH,
  })
  expect(screen.queryByTestId("translation-off-notice")).toBeNull()
})
