import { cleanup, within } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import type { Page, PrePublishChecklist } from "./page-editor/lib/types"

// Mounted production header on a snapshot site: the line under the title shows
// the ACTIVE language's address, content type, language and page status.
const mocks = vi.hoisted(() => ({
  convex: { query: vi.fn(async () => []) },
  enabledLocales: ["en", "fr"] as string[],
  homePageId: null as string | null,
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
vi.mock("./page-editor/components/slices-panel", () => ({
  SlicesPanel: () => null,
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
}) {
  mocks.homePageId = options.home ? "page-1" : null
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
      en: { title: "About", slices: [] },
      fr: { title: "À propos", slices: [] },
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

test("English: address, content type, language and page status of the active language", () => {
  const { header } = mount({
    locale: "en",
    requestedLocale: "fr",
    entries: [
      { locale: "en", state: "published", path: "/about" },
      { locale: "fr", state: "draft", path: "/a-propos" },
    ],
  })
  expect(header.getByText("Address:").nextElementSibling).toHaveTextContent(
    "/fr/a-propos"
  )
  expect(
    header.getByText("Content type:").nextElementSibling
  ).toHaveTextContent("Page")
  expect(header.getByText("Language:").nextElementSibling).toHaveTextContent(
    "French"
  )
  expect(header.getByText("Page status:").nextElementSibling).toHaveTextContent(
    "Draft"
  )
  // The bare slug and the page-wide badge are gone.
  expect(header.queryByText("/about")).toBeNull()
  // Draft appears once, in the line itself: there is no second page-wide badge.
  expect(header.getAllByText("Draft")).toHaveLength(1)
  expect(header.queryByText("Home page")).toBeNull()
})

test("French: the same line in French with a space before each colon", () => {
  const { header } = mount({
    locale: "fr",
    requestedLocale: "en",
    pageType: "landing-page",
    entries: [{ locale: "en", state: "published", path: "/about" }],
  })
  expect(header.getByText("Adresse :").nextElementSibling).toHaveTextContent(
    "/about"
  )
  expect(
    header.getByText("Type de contenu :").nextElementSibling
  ).toHaveTextContent("Page d'atterrissage")
  expect(header.getByText("Langue :").nextElementSibling).toHaveTextContent(
    "Anglais"
  )
  expect(
    header.getByText("État de la page :").nextElementSibling
  ).toHaveTextContent("Publiée")
})

test("the home page shows its root address and a Home page badge", () => {
  const { header } = mount({
    locale: "en",
    requestedLocale: "en",
    home: true,
    entries: [{ locale: "en", state: "published", path: "/" }],
  })
  expect(header.getByText("Address:").nextElementSibling).toHaveTextContent("/")
  expect(header.getByText("Home page")).toBeInTheDocument()
})

test("a Not translated language has no address yet and no home badge", () => {
  const { header } = mount({
    locale: "en",
    requestedLocale: "fr",
    home: true,
    entries: [{ locale: "en", state: "published", path: "/" }],
  })
  expect(header.getByText("No address yet")).toBeInTheDocument()
  expect(header.getByText("Page status:").nextElementSibling).toHaveTextContent(
    "Not translated"
  )
  expect(header.queryByText("Home page")).toBeNull()
})

test("a non-routable content type has no Address item at all", () => {
  const { header } = mount({
    locale: "en",
    requestedLocale: "en",
    entries: [{ locale: "en", state: "draft", path: null }],
  })
  expect(header.queryByText("Address:")).toBeNull()
  expect(header.getByText("Page status:")).toBeInTheDocument()
})

test("an archived page reads Archived whatever its language state", () => {
  const { header } = mount({
    locale: "en",
    requestedLocale: "en",
    status: "archived",
    entries: [{ locale: "en", state: "published", path: "/about" }],
  })
  expect(header.getByText("Page status:").nextElementSibling).toHaveTextContent(
    "Archived"
  )
})

test("the language tabs carry no green dot, only the selected pill colours", () => {
  const { header, view } = mount({
    locale: "en",
    requestedLocale: "en",
    entries: [
      { locale: "en", state: "draft", path: "/about" },
      { locale: "fr", state: "draft", path: "/a-propos" },
    ],
  })
  expect(view.container.querySelector(".bg-emerald-400")).toBeNull()
  const selected = header.getByRole("tab", { selected: true })
  expect(selected).toHaveClass("bg-primary", "text-primary-foreground")
})
