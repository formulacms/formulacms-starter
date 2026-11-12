import {
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
} from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import pageEditorSource from "./page-editor.tsx?raw"
import snapshotHistorySource from "./page-editor/components/snapshot-history-panel.tsx?raw"

/**
 * F08d all-off proof: with the installed admin contribution profile (zero
 * optional participants), the real shell, sidebar, palette, Pages list and
 * Media browser open no optional subscription. A subscription counts as open
 * when a Convex hook receives arguments other than "skip".
 */

const owner = {
  ownerId: "owner-1",
  authId: "owner-auth-1",
  email: "owner@example.com",
  role: "admin" as const,
}

const mocks = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
}))

function record(reference: unknown, args: unknown) {
  mocks.calls.push({ name: getFunctionName(reference as never), args })
}

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: (reference: unknown, args: unknown) => {
    record(reference, args)
    const name = getFunctionName(reference as never)
    if (args === "skip") return undefined
    if (name === "cms/owner:getOwnerSession") return owner
    if (name === "cms/settings:getSiteConfig") {
      return { defaultLocale: "en", enabledLocales: ["en"], timezone: "UTC" }
    }
    if (name === "cms/publication:getAdminAuthority") return "legacy"
    if (name.endsWith("getArchivedContentTypes")) return []
    if (name === "cms/media:listFolders") return []
    return undefined
  },
  useQueries: (queries: Record<string, { query: unknown; args: unknown }>) => {
    for (const { query, args } of Object.values(queries)) record(query, args)
    return { effective: { version: 0, modules: [] } }
  },
  usePaginatedQuery: (reference: unknown, args: unknown) => {
    record(reference, args)
    return { loadMore: vi.fn(), results: [], status: "Exhausted" }
  },
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: vi.fn() },
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => vi.fn(),
  usePrompt: () => vi.fn(),
}))

// The starter ships no slice library, so the shell wraps nothing (D-6).
vi.mock("@/components/admin/contributions/authoring-tools", () => ({
  ADMIN_AUTHORING_TOOLS_BROWSER_BINDING: null,
}))

// The list's row Publish calls this server action; it needs server-only env.
vi.mock("@/app/(core)/admin/(authenticated)/pages/actions", () => ({
  revalidatePagePaths: vi.fn(async () => undefined),
}))

vi.mock("@/components/admin/duplicate-page-dialog", () => ({
  DuplicatePageDialog: () => null,
}))

vi.mock("@/lib/media/use-media-upload", () => ({
  useMediaUpload: () => ({
    uploadMany: vi.fn(),
    importFromUrl: vi.fn(),
    isUploading: false,
  }),
}))

import { AdminShell } from "./admin-shell"
import { MediaBrowser } from "./media-browser"
import { PagesListClient } from "./pages-list-client"

/** Required Community subscriptions the shell may hold with zero optional modules. */
const REQUIRED_SHELL_SUBSCRIPTIONS = new Set([
  "cms/owner:getOwnerSession",
  "cms/modules:effective",
  "cms/contentTypes:getArchivedContentTypes",
])

const OPTIONAL_QUERIES = [
  "cms/ai:isConfigured",
  "cms/formSubmissions:getCounts",
  "cms/search:searchPages",
  "cms/search:searchMedia",
  "cms/pageHistory:listRevisions",
]

function openSubscriptions() {
  return new Set(
    mocks.calls.filter((call) => call.args !== "skip").map((call) => call.name)
  )
}

function render(ui: React.ReactNode) {
  return renderWithTestingLibrary(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("all-off admin shell subscriptions (F08d)", () => {
  beforeEach(() => {
    mocks.calls.length = 0
  })

  test("the owner shell and real palette have no optional Help participant", async () => {
    render(
      <AdminShell>
        <p>Owner content</p>
      </AdminShell>
    )

    expect(screen.getByText("Owner content")).toBeInTheDocument()
    // OD-4: Submissions is Forms (M08) navigation, absent without a participant.
    expect(screen.queryByText("Submissions")).not.toBeInTheDocument()
    expect(openSubscriptions()).toEqual(REQUIRED_SHELL_SUBSCRIPTIONS)
    // C3: committed off state withholds Redirects navigation; C5 keeps one state read.
    expect(screen.queryByText("Redirects")).not.toBeInTheDocument()
    expect(
      mocks.calls.filter((call) =>
        /^cms\/(?:modules|redirects):/.test(call.name)
      )
    ).toEqual([{ name: "cms/modules:effective", args: {} }])

    fireEvent.click(
      screen.getByRole("button", { name: "Open command palette" })
    )
    const search = await screen.findByRole("textbox", {
      name: "Search commands",
    })
    fireEvent.change(search, {
      target: { value: "how do I configure an imaginary assistant" },
    })

    expect(
      screen.queryByRole("button", { name: /Ask the assistant/i })
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Assistant")).not.toBeInTheDocument()
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument()
    const open = openSubscriptions()
    for (const name of OPTIONAL_QUERIES) expect(open.has(name)).toBe(false)
  })

  test("the Pages list keeps its filters and offers no full-text search", () => {
    render(<PagesListClient />)

    expect(
      screen.getByRole("combobox", { name: "Filter by status" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("searchbox", { name: "Search pages" })
    ).not.toBeInTheDocument()
    const open = openSubscriptions()
    expect(open.has("cms/pages:listPaginated")).toBe(true)
    expect(open.has("cms/search:searchPages")).toBe(false)
  })

  test("the Media browser keeps its list and offers no full-text search", () => {
    render(<MediaBrowser onItemClick={vi.fn()} />)

    expect(
      screen.queryByRole("textbox", { name: "Search media" })
    ).not.toBeInTheDocument()
    const open = openSubscriptions()
    expect(open.has("cms/media:listPaginated")).toBe(true)
    expect(open.has("cms/search:searchMedia")).toBe(false)
  })

  test("legacy revision History stays optional while snapshot history belongs to core Publication", () => {
    expect(pageEditorSource).not.toContain("api.cms.pageHistory")
    expect(pageEditorSource).not.toContain(
      'from "./page-editor/components/history-panel"'
    )
    expect(snapshotHistorySource).not.toContain("api.cms.pageHistory")
    expect(snapshotHistorySource).toContain(
      "api.cms.publication.listSnapshotHistory"
    )
    expect(snapshotHistorySource).toContain(
      "api.cms.publication.restoreSnapshotAsDraft"
    )
    expect(pageEditorSource).toContain(
      'import { ADMIN_HISTORY_BROWSER_BINDING } from "./contributions/history"'
    )
  })
})
