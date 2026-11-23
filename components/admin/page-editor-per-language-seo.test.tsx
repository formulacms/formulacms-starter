import { isActiveContentType } from "@/convex/lib/contentTypes"
import type { ReactNode } from "react"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

import type { Id } from "@/convex/_generated/dataModel"
import type { Block } from "@/convex/lib/blocks"
import type { Page, PrePublishChecklist } from "./page-editor/lib/types"

const owner = {
  ownerId: "owner-1",
  authId: "owner-auth-1",
  email: "owner@example.com",
  role: "admin" as const,
}

const mocks = vi.hoisted(() => ({
  actionNames: [] as string[],
  commandIds: [] as string[],
  confirm: vi.fn(async () => true),
  error: vi.fn(),
  latestChecklist: {
    canPublish: true,
    blockers: [],
    warnings: [
      {
        code: "missing_seo_title",
        severity: "warning",
        message: "Add an SEO title.",
        locales: ["en"],
      },
    ],
  } as PrePublishChecklist,
  convex: {
    query: vi.fn(async (reference: unknown) => {
      if (
        getFunctionName(reference as never) ===
        "cms/pages:getPrePublishChecklist"
      ) {
        return mocks.latestChecklist
      }
      return []
    }),
  },
  mutation: vi.fn(async () => ({ status: "acquired", updatedAt: 101 })),
  languageNotice: null as unknown,
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
  push: vi.fn(),
  queryNames: [] as string[],
  refresh: vi.fn(),
  replace: vi.fn(),
  success: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useAction: (reference: unknown) => {
    mocks.actionNames.push(getFunctionName(reference as never))
    return vi.fn()
  },
  useConvex: () => mocks.convex,
  useMutation: () => mocks.mutation,
  useQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    mocks.queryNames.push(name)
    if (name === "cms/owner:getOwnerSession") return owner
    if (name === "cms/settings:getSiteConfig") {
      return {
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        timezone: "UTC",
      }
    }
    if (name === "cms/pages:getPrePublishChecklist") {
      return {
        canPublish: true,
        blockers: [],
        warnings: [
          {
            code: "missing_seo_title",
            severity: "warning",
            message: "Add an SEO title.",
            locales: ["en"],
          },
        ],
      }
    }
    if (name === "cms/language:getSourcePublicationNotice") {
      return mocks.languageNotice
    }
    if (name === "cms/pages:listActiveEditors") return []
    if (name === "cms/pages:getPageEditorLock") {
      return { status: "available" }
    }
    return undefined
  },
  useQueries: (queries: Record<string, unknown>) =>
    Object.keys(queries).length
      ? {
          checklist: {
            canPublish: true,
            blockers: [],
            warnings: [
              {
                code: "missing_seo_title",
                severity: "warning",
                message: "Add an SEO title.",
                locales: ["en"],
              },
            ],
          },
        }
      : {},
}))

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  useRouter: () => ({
    push: mocks.push,
    refresh: mocks.refresh,
    replace: mocks.replace,
  }),
}))

vi.mock("sonner", () => ({
  toast: {
    dismiss: vi.fn(),
    error: mocks.error,
    loading: vi.fn(),
    message: vi.fn(),
    success: mocks.success,
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

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("./content-type-fields-panel", () => ({
  ContentTypeFieldsPanel: ({
    localizedValues,
  }: {
    localizedValues: Record<string, unknown>
  }) => (
    <output data-testid="localized-values">
      {JSON.stringify(localizedValues)}
    </output>
  ),
}))

// The panel's props are the editor's SEO state for the open language.
vi.mock("./page-editor/components/seo-panel", () => ({
  SeoPanel: (props: {
    seoOgTitle: string
    seoOgDescription: string
    seoNoIndex: boolean
    seoNoFollow: boolean
    seoOgImage: string
    onSeoOgTitleChange(value: string): void
    onSeoOgImageChange(value: string): void
  }) => (
    <div>
      <output data-testid="seo-values">
        {JSON.stringify({
          ogTitle: props.seoOgTitle,
          ogDescription: props.seoOgDescription,
          noIndex: props.seoNoIndex,
          noFollow: props.seoNoFollow,
          ogImage: props.seoOgImage,
        })}
      </output>
      <button
        type="button"
        onClick={() => props.onSeoOgTitleChange("Typed social")}
      >
        type social title
      </button>
      <button
        type="button"
        onClick={() => props.onSeoOgImageChange("https://example.com/new.jpg")}
      >
        type social image
      </button>
    </div>
  ),
}))

vi.mock("./page-editor/components/settings-panel", () => ({
  SettingsPanel: () => null,
}))

vi.mock("./page-editor/components/blocks-panel", () => ({
  BlocksPanel: ({ blocks }: { blocks: Block[] }) => (
    <output data-testid="page-editor-blocks">{JSON.stringify(blocks)}</output>
  ),
}))

import { PageEditor } from "./page-editor"

const pageId = "page-1" as Id<"pages">

// ADR-0037 amendment (2026-11-17): a post whose search, social and card values
// and category are written in each language; the social image is shared.
function post(): Page {
  return {
    _id: pageId,
    _creationTime: 1,
    slug: "hello-world",
    localizedSlugs: { fr: "bonjour-le-monde" },
    pageType: "post",
    status: "draft",
    createdAt: 100,
    updatedAt: 100,
    featured: false,
    promoteToFront: false,
    seo: { ogImage: "https://example.com/hello.jpg" },
    content: {
      en: {
        title: "Hello world",
        blocks: [],
        category: "News",
        seo: { ogTitle: "Hello social", ogDescription: "Hello text" },
      },
      fr: {
        title: "Bonjour le monde",
        blocks: [],
        category: "Actualités",
        cardExcerpt: "Un petit bonjour.",
        seo: {
          ogTitle: "Bonjour social",
          noIndex: true,
          structuredData: '{"@type":"Article"}',
          keywords: ["bonjour"],
        },
      },
    },
    tags: [],
    createdBy: "owner-1",
  } as unknown as Page
}

function seoValues() {
  return JSON.parse(screen.getByTestId("seo-values").textContent ?? "{}")
}

function publication() {
  return {
    authority: "snapshot_active" as const,
    lifecycleGeneration: 3,
    sharedDraftGeneration: 4,
    locales: ["en", "fr"].map((locale) => ({
      locale,
      draftGeneration: 2,
      publicGeneration: 1,
      releaseGeneration: 1,
    })),
  }
}

function openTab(name: "English" | "Français") {
  fireEvent.click(screen.getByTitle(name))
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe("PageEditor per-language search and social values", () => {
  test("each language tab shows its own values; the social image is shared", () => {
    render(
      <PageEditor
        page={post()}
        hasStaging={false}
        stagingUpdatedAt={undefined}
        publication={publication()}
      />
    )
    fireEvent.click(screen.getByTitle("SEO"))
    expect(seoValues()).toEqual({
      ogTitle: "Hello social",
      ogDescription: "Hello text",
      noIndex: false,
      noFollow: false,
      ogImage: "https://example.com/hello.jpg",
    })

    // Unsaved edits on English stay in English across a tab switch.
    fireEvent.click(screen.getByText("type social title"))
    fireEvent.click(screen.getByText("type social image"))
    openTab("Français")
    expect(seoValues()).toEqual({
      ogTitle: "Bonjour social",
      ogDescription: "",
      noIndex: true,
      noFollow: false,
      ogImage: "https://example.com/new.jpg",
    })
    openTab("English")
    expect(seoValues()).toMatchObject({
      ogTitle: "Typed social",
      noIndex: false,
      ogImage: "https://example.com/new.jpg",
    })
  })

  test.runIf(isActiveContentType("post"))("Copy from copies the other language's search, social and card values and category", async () => {
    render(
      <PageEditor
        page={post()}
        hasStaging={false}
        stagingUpdatedAt={undefined}
        publication={publication()}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Copy from FR/i }))
    await waitFor(() =>
      expect(screen.getByLabelText("Page title")).toHaveValue(
        "Bonjour le monde"
      )
    )
    expect(
      JSON.parse(screen.getByTestId("localized-values").textContent ?? "{}")
    ).toMatchObject({ category: "Actualités" })
    fireEvent.click(screen.getByTitle("SEO"))
    expect(seoValues()).toEqual({
      ogTitle: "Bonjour social",
      ogDescription: "",
      noIndex: true,
      noFollow: false,
      ogImage: "https://example.com/hello.jpg",
    })

    // The values the editor has no field for travel with the save.
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(mocks.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          localized: expect.objectContaining({
            locale: "en",
            draft: expect.objectContaining({
              cardExcerpt: "Un petit bonjour.",
              seo: {
                ogTitle: "Bonjour social",
                noIndex: true,
                structuredData: '{"@type":"Article"}',
                keywords: ["bonjour"],
              },
            }),
          }),
        })
      )
    )
  })

  test.runIf(isActiveContentType("post"))("Push sends this language's search, social and card values and category", async () => {
    render(
      <PageEditor
        page={post()}
        hasStaging={false}
        stagingUpdatedAt={undefined}
        publication={publication()}
      />
    )
    openTab("Français")
    fireEvent.click(screen.getByRole("button", { name: /Send FR to/i }))
    fireEvent.click(screen.getByRole("button", { name: /FR\s*EN/ }))
    // Push saves, opens English, then copies French into it.
    await waitFor(() => expect(mocks.success).toHaveBeenCalled())
    // The copy lands after the success toast; wait for it.
    await waitFor(() =>
      expect(screen.getByLabelText("Page title")).toHaveValue(
        "Bonjour le monde"
      )
    )
    fireEvent.click(screen.getByTitle("SEO"))
    expect(seoValues()).toMatchObject({
      ogTitle: "Bonjour social",
      noIndex: true,
    })

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(mocks.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          localized: expect.objectContaining({
            locale: "en",
            draft: expect.objectContaining({
              localized: expect.objectContaining({ category: "Actualités" }),
              cardExcerpt: "Un petit bonjour.",
              seo: {
                ogTitle: "Bonjour social",
                noIndex: true,
                structuredData: '{"@type":"Article"}',
                keywords: ["bonjour"],
              },
            }),
          }),
        })
      )
    )
  })
})
