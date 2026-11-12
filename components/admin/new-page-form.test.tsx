import { sliceProfile } from "@/test-utils/slice-profile"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "../../messages/admin/en.json"
import fr from "../../messages/admin/fr.json"
import type { MarkdownImportData } from "./import-markdown-dialog"

const mocks = vi.hoisted(() => ({
  createPage: vi.fn(),
  error: vi.fn(),
  push: vi.fn(),
  queryNames: [] as string[],
  stashPageDraftHandoff: vi.fn(),
  success: vi.fn(),
  requestedType: null as string | null,
  installedTypes: null as string[] | null,
  importCallbacks: [] as ((data: MarkdownImportData) => void)[],
  usePaginatedQuery: vi.fn(),
  useQuery: vi.fn(),
}))

vi.mock("@/convex/lib/slices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/convex/lib/slices")>()
  return {
    ...actual,
    get INSTALLED_SLICE_TYPES() {
      return mocks.installedTypes ?? actual.INSTALLED_SLICE_TYPES
    },
  }
})

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: async () => null }),
  useMutation: () => mocks.createPage,
  usePaginatedQuery: mocks.usePaginatedQuery,
  // The module-state provider's read: an effective snapshot without the AI module.
  useQueries: (request: Record<string, { query: unknown }>) =>
    Object.fromEntries(
      Object.entries(request).map(([key, { query }]) => {
        const name = getFunctionName(query as never)
        mocks.queryNames.push(name)
        return [
          key,
          name === "cms/modules:effective" ? { modules: [] } : undefined,
        ]
      })
    ),
  useQuery: (reference: unknown, args: unknown) => {
    mocks.queryNames.push(getFunctionName(reference as never))
    return mocks.useQuery(reference, args)
  },
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => ({ get: () => mocks.requestedType }),
}))

vi.mock("sonner", () => ({
  toast: { error: mocks.error, success: mocks.success },
}))

vi.mock("./import-markdown-dialog", () => ({
  ImportMarkdownDialog: ({
    onImport,
  }: {
    onImport: (data: MarkdownImportData) => void
  }) => {
    mocks.importCallbacks.push(onImport)
    return null
  },
}))

vi.mock("./page-editor/lib/page-draft-handoff", () => ({
  stashPageDraftHandoff: mocks.stashPageDraftHandoff,
}))

import { AdminModuleStateProvider } from "./admin-module-state-provider"
import { NewPageForm } from "./new-page-form"

function renderForm(
  locale: "en" | "fr" = "en",
  messages: typeof en = locale === "fr" ? fr : en
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <NewPageForm />
    </NextIntlClientProvider>
  )
}

describe("NewPageForm", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queryNames.length = 0
    mocks.requestedType = null
    mocks.installedTypes = null
    mocks.importCallbacks.length = 0
    mocks.usePaginatedQuery.mockReturnValue({
      loadMore: vi.fn(),
      results: [],
      status: "Exhausted",
    })
    mocks.useQuery.mockImplementation((reference) => {
      const name = getFunctionName(reference)
      if (name === "cms/owner:getOwnerSession") {
        return {
          ownerId: "owner-1",
          authId: "owner-auth-1",
          email: "owner@example.com",
          role: "admin",
        }
      }
      if (name === "cms/settings:getSiteConfig") {
        return { enabledLocales: ["en"], defaultLocale: "en" }
      }
      if (name === "cms/roles:myPermissions") {
        return {
          permissions: ["content:ai:all", "pages.page:create:all"],
        }
      }
      if (name.endsWith("getArchivedContentTypes")) {
        return []
      }
      return []
    })
    mocks.createPage.mockResolvedValue("page-1")
    mocks.stashPageDraftHandoff.mockReturnValue(true)
  })

  test(
    "opens no AI subscription while the AI module is off",
    sliceProfile(["rich-text-body"]),
    () => {
      // Writing is installed; the route passes its (empty) route data.
      render(
        <NextIntlClientProvider locale="en" messages={en}>
          <AdminModuleStateProvider>
            <NewPageForm
              aiWritingRouteData={{
                editorialCopy: null,
                structuredOutlineMeta: null,
              }}
            />
          </AdminModuleStateProvider>
        </NextIntlClientProvider>
      )

      fireEvent.change(screen.getByLabelText("Title"), {
        target: { value: "Ordinary page" },
      })
      expect(screen.getByRole("button", { name: "Create page" })).toBeEnabled()
      expect(screen.getByRole("button", { name: "Import .md" })).toBeEnabled()
      expect(
        screen.queryByRole("button", { name: "Write page with AI" })
      ).not.toBeInTheDocument()
      expect(mocks.queryNames).toContain("cms/modules:effective")
      for (const name of [
        "cms/aiSettings:status",
        "cms/aiJobs:pageJobProgress",
        "cms/agents:getContentPresets",
        "cms/ai:isConfigured",
      ])
        expect(mocks.queryNames).not.toContain(name)
    }
  )

  test.each([
    ["en", []],
    ["fr", []],
    ["en", ["hero-agency"]],
    ["fr", ["hero-agency"]],
  ] as const)(
    "hides Markdown import and its dialog without Rich Text Body while blank Create stays available in %s (%j)",
    sliceProfile([]),
    async (locale, installedTypes) => {
      mocks.installedTypes = [...installedTypes]
      renderForm(locale)
      expect(
        screen.queryByRole("button", {
          name:
            locale === "fr"
              ? fr.pages.newForm.importMarkdown
              : en.pages.newForm.importMarkdown,
        })
      ).toBeNull()
      expect(mocks.importCallbacks).toHaveLength(0)
      fireEvent.change(
        screen.getByLabelText(locale === "fr" ? "Titre" : "Title"),
        { target: { value: "Ordinary page" } }
      )
      const create = screen.getByRole("button", {
        name: locale === "fr" ? "Créer : page" : "Create page",
      })
      expect(create).toBeEnabled()
      fireEvent.click(create)
      await waitFor(() => expect(mocks.createPage).toHaveBeenCalledOnce())
      expect(mocks.createPage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: { en: { title: "Ordinary page", slices: [] } },
        })
      )
      expect(mocks.stashPageDraftHandoff).not.toHaveBeenCalled()
    }
  )

  test.each([
    ["en", []],
    ["fr", []],
    ["en", ["hero-agency"]],
    ["fr", ["hero-agency"]],
  ] as const)(
    "refuses a retained import callback before creating a page when Rich Text Body is absent in %s (%j)",
    sliceProfile(["rich-text-body"]),
    async (locale, installedTypes) => {
      renderForm(locale)
      const retainedImport = mocks.importCallbacks.at(-1)!
      expect(retainedImport).toBeTypeOf("function")
      mocks.installedTypes = [...installedTypes]
      await act(async () =>
        retainedImport({
          title: "Imported",
          body: '{"type":"doc","content":[]}',
        })
      )
      expect(mocks.createPage).not.toHaveBeenCalled()
      expect(mocks.stashPageDraftHandoff).not.toHaveBeenCalled()
      expect(mocks.push).not.toHaveBeenCalled()
      expect(mocks.error).toHaveBeenCalledWith(
        (locale === "fr" ? fr : en).pages.newForm.availabilityNotConfirmed
      )
    }
  )

  test.each(["en", "fr"] as const)(
    "invalid Markdown candidate refuses before writes and handoff in %s",
    sliceProfile(["rich-text-body"]),
    async (locale) => {
      renderForm(locale)
      await act(async () =>
        Reflect.apply(mocks.importCallbacks.at(-1)!, undefined, [
          { title: "Invalid", body: null },
        ])
      )
      expect(mocks.createPage).not.toHaveBeenCalled()
      expect(mocks.stashPageDraftHandoff).not.toHaveBeenCalled()
      expect(mocks.push).not.toHaveBeenCalled()
      expect(mocks.error).toHaveBeenCalledWith(
        (locale === "fr" ? fr : en).pages.newForm.availabilityNotConfirmed
      )
    }
  )

  test(
    "preserves the Markdown draft handoff when Rich Text Body is installed",
    sliceProfile(["rich-text-body"]),
    async () => {
      renderForm()
      const imported = {
        title: "Imported",
        body: '{"type":"doc","content":[]}',
      }
      await act(async () => mocks.importCallbacks.at(-1)!(imported))
      expect(mocks.createPage).toHaveBeenCalledOnce()
      expect(mocks.stashPageDraftHandoff).toHaveBeenCalledWith("page-1", {
        slices: [
          expect.objectContaining({
            type: "rich-text-body",
            primary: { body: imported.body },
          }),
        ],
      })
      expect(mocks.push).toHaveBeenCalledWith("/admin/pages/page-1")
    }
  )

  test(
    "hides owner-facing creation actions from an unrelated account",
    sliceProfile([]),
    () => {
      mocks.useQuery.mockImplementation((reference) => {
        const name = getFunctionName(reference)
        if (name === "cms/owner:getOwnerSession") return null
        if (name === "cms/settings:getSiteConfig") {
          return { enabledLocales: ["en"], defaultLocale: "en" }
        }
        if (name === "cms/roles:myPermissions") return undefined
        if (name.endsWith("getArchivedContentTypes")) return []
        return undefined
      })

      renderForm()

      expect(screen.getByRole("button", { name: "Create page" })).toBeDisabled()
      expect(screen.queryByRole("button", { name: "Starter hero" })).toBeNull()
      expect(
        screen.queryByRole("button", { name: "Write page with AI" })
      ).toBeNull()
    }
  )

  test(
    "lets the owner create an Author without a member account",
    sliceProfile([]),
    async () => {
      mocks.requestedType = "author"
      mocks.useQuery.mockImplementation((reference) => {
        const name = getFunctionName(reference)
        if (name === "cms/owner:getOwnerSession") {
          return {
            ownerId: "owner-1",
            authId: "owner-auth-1",
            email: "owner@example.com",
            role: "admin",
          }
        }
        if (name === "cms/settings:getSiteConfig") {
          return { enabledLocales: ["en"], defaultLocale: "en" }
        }
        if (name.endsWith("getArchivedContentTypes")) return []
        return undefined
      })

      renderForm()

      fireEvent.change(screen.getByLabelText("Title"), {
        target: { value: "Ada Lovelace" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Create author" }))

      await waitFor(() => {
        expect(mocks.createPage).toHaveBeenCalledWith(
          expect.objectContaining({
            pageType: "author",
            status: "draft",
          })
        )
      })
      expect(screen.queryByText("Starter hero")).not.toBeInTheDocument()
    }
  )

  test(
    "keeps Author creation independent of Team permissions",
    sliceProfile([]),
    () => {
      mocks.requestedType = "author"
      mocks.useQuery.mockImplementation((reference) => {
        const name = getFunctionName(reference)
        if (name === "cms/owner:getOwnerSession") {
          return {
            ownerId: "owner-1",
            authId: "owner-auth-1",
            email: "owner@example.com",
            role: "admin",
          }
        }
        if (name === "cms/settings:getSiteConfig") {
          return { enabledLocales: ["en"], defaultLocale: "en" }
        }
        if (name.endsWith("getArchivedContentTypes")) return []
        return undefined
      })

      renderForm()

      expect(screen.getByRole("option", { name: "Author" })).toBeInTheDocument()
      expect(screen.getByLabelText("Content type")).toHaveValue("author")
    }
  )

  test(
    "prospective create-own keeps the Post creation path visible",
    sliceProfile([]),
    () => {
      mocks.requestedType = "post"
      mocks.useQuery.mockImplementation((reference) => {
        const name = getFunctionName(reference)
        if (name === "cms/owner:getOwnerSession") {
          return {
            ownerId: "owner-1",
            authId: "owner-auth-1",
            email: "owner@example.com",
            role: "admin",
          }
        }
        if (name === "cms/settings:getSiteConfig") {
          return { enabledLocales: ["en"], defaultLocale: "en" }
        }
        if (name === "cms/roles:myPermissions") {
          return { permissions: ["pages.post:create:own"] }
        }
        if (name.endsWith("getArchivedContentTypes")) return []
        return undefined
      })

      renderForm()
      fireEvent.change(screen.getByLabelText("Title"), {
        target: { value: "Owned Post" },
      })
      expect(screen.getByRole("button", { name: "Create post" })).toBeEnabled()
    }
  )

  test(
    "starts with the first owner-available type when no type is requested",
    sliceProfile([]),
    async () => {
      mocks.useQuery.mockImplementation((reference) => {
        const name = getFunctionName(reference)
        if (name === "cms/owner:getOwnerSession") {
          return {
            ownerId: "owner-1",
            authId: "owner-auth-1",
            email: "owner@example.com",
            role: "admin",
          }
        }
        if (name === "cms/settings:getSiteConfig") {
          return { enabledLocales: ["en"], defaultLocale: "en" }
        }
        if (name === "cms/roles:myPermissions") {
          return { permissions: ["pages.post:create:own"] }
        }
        if (name.endsWith("getArchivedContentTypes")) return []
        return undefined
      })

      renderForm()

      expect(screen.getByLabelText("Content type")).toHaveValue("page")
      fireEvent.change(screen.getByLabelText("Title"), {
        target: { value: "Owned landing page" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Create page" }))

      await waitFor(() => {
        expect(mocks.createPage).toHaveBeenCalledWith(
          expect.objectContaining({
            pageType: "page",
            title: "Owned landing page",
          })
        )
      })
    }
  )

  test(
    "heading and submit button track the selected content type",
    sliceProfile([]),
    () => {
      mocks.useQuery.mockImplementation((reference) => {
        const name = getFunctionName(reference)
        if (name === "cms/owner:getOwnerSession") {
          return {
            ownerId: "owner-1",
            authId: "owner-auth-1",
            email: "owner@example.com",
            role: "admin",
          }
        }
        if (name === "cms/settings:getSiteConfig") {
          return { enabledLocales: ["en"], defaultLocale: "en" }
        }
        if (name === "cms/roles:myPermissions") {
          return { permissions: ["*"] }
        }
        if (name.endsWith("getArchivedContentTypes")) return []
        return undefined
      })

      renderForm()
      expect(
        screen.getByRole("heading", { name: "New page" })
      ).toBeInTheDocument()
      expect(
        screen.getByRole("button", { name: "Create page" })
      ).toBeInTheDocument()

      fireEvent.change(screen.getByLabelText("Content type"), {
        target: { value: "post" },
      })

      expect(
        screen.getByRole("heading", { name: "New post" })
      ).toBeInTheDocument()
      expect(
        screen.getByRole("button", { name: "Create post" })
      ).toBeInTheDocument()
    }
  )

  test(
    "keeps the requested Author type available to the owner",
    sliceProfile([]),
    async () => {
      mocks.requestedType = "author"
      mocks.useQuery.mockImplementation((reference) => {
        const name = getFunctionName(reference)
        if (name === "cms/owner:getOwnerSession") {
          return {
            ownerId: "owner-1",
            authId: "owner-auth-1",
            email: "owner@example.com",
            role: "admin",
          }
        }
        if (name === "cms/settings:getSiteConfig") {
          return { enabledLocales: ["en"], defaultLocale: "en" }
        }
        if (name.endsWith("getArchivedContentTypes")) return []
        return undefined
      })

      renderForm()

      expect(screen.getByLabelText("Content type")).toHaveValue("author")
      fireEvent.change(screen.getByLabelText("Title"), {
        target: { value: "Owner author" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Create author" }))

      await waitFor(() => {
        expect(mocks.createPage).toHaveBeenCalledWith(
          expect.objectContaining({
            pageType: "author",
            title: "Owner author",
          })
        )
      })
    }
  )

  test(
    "fails closed while archive state is loading",
    sliceProfile(["rich-text-body"]),
    () => {
      mocks.useQuery.mockImplementation((reference) => {
        const name = getFunctionName(reference)
        if (name === "cms/owner:getOwnerSession") {
          return {
            ownerId: "owner-1",
            authId: "owner-auth-1",
            email: "owner@example.com",
            role: "admin",
          }
        }
        if (name === "cms/settings:getSiteConfig") {
          return { enabledLocales: ["en"], defaultLocale: "en" }
        }
        if (name === "cms/roles:myPermissions") {
          return { permissions: ["pages.page:create:all"] }
        }
        if (name.endsWith("getArchivedContentTypes")) return undefined
        return []
      })

      renderForm()

      expect(
        screen.getByText(
          "Checking which Content Types are available for new documents…"
        )
      ).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Create page" })).toBeDisabled()
      expect(screen.getByRole("button", { name: "Import .md" })).toBeDisabled()
    }
  )

  test(
    "renders the new-page form in French",
    sliceProfile(["rich-text-body"]),
    () => {
      renderForm("fr")

      expect(
        screen.getByRole("heading", { name: "Nouveau contenu : page" })
      ).toBeInTheDocument()
      expect(screen.getByLabelText("Titre")).toHaveAttribute(
        "placeholder",
        "Ma nouvelle page"
      )
      expect(screen.getByLabelText("Type de contenu")).toHaveValue("page")
      expect(screen.getByLabelText("Langue")).toHaveDisplayValue(
        "English (par défaut)"
      )
      expect(
        screen.getByRole("button", { name: "Créer : page" })
      ).toBeDisabled()
      expect(
        screen.getByRole("button", { name: "Importer un fichier .md" })
      ).toBeEnabled()
    }
  )
})
