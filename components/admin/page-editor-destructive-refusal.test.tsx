import { fireEvent, screen, waitFor } from "@testing-library/react"
import { ConvexError } from "convex/values"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Id } from "@/convex/_generated/dataModel"
import { render } from "@/test-utils/admin-i18n"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import type { Page } from "./page-editor/lib/types"

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  convex: { query: vi.fn(async () => []) },
  refusalCode: "PAGE_SOFT_DELETE_MENU_REFERENCE",
  routerPush: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useConvex: () => mocks.convex,
  useMutation: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/publication:softDeletePage") {
      return vi.fn(async () => {
        throw new ConvexError({ code: mocks.refusalCode, truncated: false })
      })
    }
    return vi.fn(async () => ({
      status: "acquired",
      updatedAt: 101,
      generation: 1,
    }))
  },
  useQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/owner:getOwnerSession") {
      return { ownerId: "owner-1", role: "admin" }
    }
    if (name === "cms/settings:getSiteConfig") {
      return {
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        timezone: "UTC",
      }
    }
    if (name === "cms/pages:getPrePublishChecklist") {
      return { canPublish: true, blockers: [], warnings: [] }
    }
    if (name === "cms/pages:listActiveEditors") return []
    if (name === "cms/pages:getPageEditorLock") return { status: "available" }
    return undefined
  },
  useQueries: (queries: Record<string, unknown>) =>
    Object.keys(queries).length
      ? { checklist: { canPublish: true, blockers: [], warnings: [] } }
      : {},
}))

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  useRouter: () => ({
    push: mocks.routerPush,
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}))

vi.mock("sonner", () => ({
  toast: {
    dismiss: vi.fn(),
    error: mocks.toastError,
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
  useRegisterAdminCommands: vi.fn(),
}))

vi.mock("./duplicate-page-dialog", () => ({ DuplicatePageDialog: () => null }))
vi.mock("./content-type-fields-panel", () => ({
  ContentTypeFieldsPanel: () => null,
}))
vi.mock("./page-editor/components/seo-panel", () => ({ SeoPanel: () => null }))
vi.mock("./page-editor/components/settings-panel", () => ({
  SettingsPanel: ({ onDelete }: { onDelete?: () => void }) => (
    <button type="button" onClick={onDelete}>
      Delete fixture
    </button>
  ),
}))
vi.mock("./page-editor/components/slices-panel", () => ({
  SlicesPanel: () => null,
}))

import { PageEditor } from "./page-editor"

const pageId = "page-1" as Id<"pages">

function page(pageType: "page" | "author"): Page {
  return {
    _id: pageId,
    _creationTime: 1,
    slug: "fixture",
    localizedSlugs: {},
    pageType,
    status: "archived",
    createdAt: 100,
    updatedAt: 100,
    content: {
      en: { title: "Fixture", slices: [] },
      fr: { title: "Fixture", slices: [] },
    },
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

describe("PageEditor destructive refusals", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.confirm.mockResolvedValue(true)
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it.each([
    {
      locale: "en" as const,
      code: "PAGE_SOFT_DELETE_MENU_REFERENCE",
      pageType: "page" as const,
      expected:
        "This page is still used in a live menu. Remove the menu link, then try again.",
    },
    {
      locale: "fr" as const,
      code: "PAGE_SOFT_DELETE_MENU_REFERENCE",
      pageType: "page" as const,
      expected:
        "Cette page est encore utilisée dans un menu actif. Retirez le lien du menu, puis réessayez.",
    },
    {
      locale: "en" as const,
      code: "PAGE_SOFT_DELETE_PUBLISHED_POST_REFERENCE",
      pageType: "author" as const,
      expected:
        "This Author is still used by a published Post. Remove it from the Post and publish that change, then try again.",
    },
    {
      locale: "fr" as const,
      code: "PAGE_SOFT_DELETE_PUBLISHED_POST_REFERENCE",
      pageType: "author" as const,
      expected:
        "Cet Auteur est encore utilisé par un Article publié. Retirez-le de l’Article, publiez la modification, puis réessayez.",
    },
  ])("maps $code to $locale plain copy", async (fixture) => {
    mocks.refusalCode = fixture.code
    render(
      <PageEditor
        page={page(fixture.pageType)}
        hasStaging={false}
        stagingUpdatedAt={undefined}
        publication={publication()}
      />,
      { locale: fixture.locale }
    )

    const messages = fixture.locale === "fr" ? fr : en
    fireEvent.click(
      screen.getByRole("button", { name: messages.editor.page.tabs.settings })
    )
    fireEvent.click(screen.getByRole("button", { name: "Delete fixture" }))

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(fixture.expected)
    )
    expect(mocks.routerPush).not.toHaveBeenCalled()
  })
})
