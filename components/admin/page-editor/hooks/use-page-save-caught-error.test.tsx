import type { ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { ConvexError } from "convex/values"
import { NextIntlClientProvider } from "next-intl"
import { toast } from "sonner"
import { beforeEach, expect, it, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import type { Id } from "@/convex/_generated/dataModel"
import type { Page } from "../lib/types"
import {
  usePageSave,
  type PageSaveDraft,
  type UpdateDraft,
} from "./use-page-save"

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock("@/app/(core)/admin/(authenticated)/pages/actions", () => ({
  revalidatePagePaths: vi.fn(async () => undefined),
}))
beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

const page = {
  _id: "page_1" as Id<"pages">,
  _creationTime: 1,
  slug: "home",
  pageType: "page",
  status: "draft",
  createdAt: 100,
  updatedAt: 100,
  content: { en: { title: "Home", slices: [] } },
  tags: [],
  createdBy: "user_1",
} as Extract<Page, { pageType: "page" }>
const draft: PageSaveDraft = {
  title: "Home",
  slug: "home",
  pageType: "page",
  parentId: "",
  authorIds: [],
  tags: [],
  metaTitle: "",
  metaDescription: "",
  slices: [],
  seoNoIndex: false,
  seoNoFollow: false,
  seoOgTitle: "",
  seoOgDescription: "",
  seoOgImage: "",
  sharedFieldValues: {},
  localizedFieldValues: {},
}

it.each([
  ["en", true, false],
  ["fr", true, false],
  ["en", false, false],
  ["fr", false, false],
  ["en", false, true],
  ["fr", false, true],
] as const)(
  "save failure %s coded=%s blank FR snapshot=%s keeps draft and displays translated safe copy",
  async (locale, coded, snapshot) => {
    const messages = locale === "fr" ? fr : en
    const error = coded
      ? new ConvexError({
          code: "SLUG_TAKEN",
          message: "Private server slug diagnostic",
        })
      : new Error("Private server slug diagnostic")
    const updateDraft = vi.fn<UpdateDraft>().mockRejectedValue(error)
    const saveSnapshotDraft = vi.fn().mockRejectedValue(error)
    const onSaveConflict = vi.fn(async () => undefined)
    const hook = renderHook(
      ({ draft }) =>
        usePageSave({
          page: snapshot
            ? {
                ...page,
                content: {
                  ...page.content,
                  fr: { title: "Accueil", slices: [] },
                },
              }
            : page,
          defaultLocale: "en",
          currentLocale: snapshot ? "fr" : "en",
          initialPageDraftHandoff: null,
          draft,
          hasStaging: false,
          stagingUpdatedAt: undefined,
          updateDraft,
          saveSnapshotDraft: snapshot ? saveSnapshotDraft : undefined,
          publishPage: vi.fn(async () => ({ updatedAt: 500 })),
          discardDraft: vi.fn(async () => null),
          updatePage: vi.fn(async () => ({ updatedAt: 102 })),
          refreshEditorLock: vi.fn(async () => true),
          setSavedSlugByLocale: vi.fn(),
          confirmPrePublishReadiness: vi.fn(async () => true),
          confirmDiscard: vi.fn(async () => true),
          onSaveConflict,
          router: { refresh: vi.fn() },
        }),
      {
        initialProps: { draft },
        wrapper: ({ children }: { children: ReactNode }) => (
          <NextIntlClientProvider locale={locale} messages={messages}>
            {children}
          </NextIntlClientProvider>
        ),
      }
    )
    hook.rerender({
      draft: { ...draft, title: snapshot ? "" : "Changed title" },
    })
    let saved: boolean | undefined
    await act(async () => {
      saved = await hook.result.current.save()
    })
    expect(saved).toBe(false)
    expect(snapshot ? saveSnapshotDraft : updateDraft).toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(hook.result.current.hasUnsaved).toBe(true)
    expect(onSaveConflict).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      coded
        ? messages.caughtErrors.slugTaken
        : messages.editor.pageSave.saveFailed
    )
    expect(toast.error).not.toHaveBeenCalledWith(
      "Private server slug diagnostic"
    )
  }
)

it.each(["en", "fr"] as const)(
  "a server SLUG_REQUIRED on a save shows the address message: %s",
  async (locale) => {
    const messages = locale === "fr" ? fr : en
    const updateDraft = vi
      .fn<UpdateDraft>()
      .mockRejectedValue(new ConvexError("SLUG_REQUIRED"))
    const hook = renderHook(
      ({ draft }) =>
        usePageSave({
          page,
          defaultLocale: "en",
          currentLocale: "en",
          initialPageDraftHandoff: null,
          draft,
          hasStaging: false,
          stagingUpdatedAt: undefined,
          updateDraft,
          publishPage: vi.fn(async () => ({ updatedAt: 500 })),
          discardDraft: vi.fn(async () => null),
          updatePage: vi.fn(async () => ({ updatedAt: 102 })),
          refreshEditorLock: vi.fn(async () => true),
          setSavedSlugByLocale: vi.fn(),
          confirmPrePublishReadiness: vi.fn(async () => true),
          confirmDiscard: vi.fn(async () => true),
          onSaveConflict: vi.fn(async () => undefined),
          router: { refresh: vi.fn() },
        }),
      {
        initialProps: { draft },
        wrapper: ({ children }: { children: ReactNode }) => (
          <NextIntlClientProvider locale={locale} messages={messages}>
            {children}
          </NextIntlClientProvider>
        ),
      }
    )
    hook.rerender({ draft: { ...draft, title: "Changed title" } })
    await act(async () => {
      expect(await hook.result.current.save()).toBe(false)
    })
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(messages.editor.pageSave.slugRequired)
    expect(hook.result.current.hasUnsaved).toBe(true)
  }
)

it.each(["en", "fr"] as const)(
  "archiving the home page is refused with the plain home sentence: %s",
  async (locale) => {
    const messages = locale === "fr" ? fr : en
    const updatePage = vi
      .fn()
      .mockRejectedValue(new ConvexError("PAGE_HOME_LIFECYCLE_REFUSED"))
    const hook = renderHook(
      () =>
        usePageSave({
          page,
          defaultLocale: "en",
          currentLocale: "en",
          initialPageDraftHandoff: null,
          draft,
          hasStaging: false,
          stagingUpdatedAt: undefined,
          updateDraft: vi.fn<UpdateDraft>(),
          publishPage: vi.fn(async () => ({ updatedAt: 500 })),
          discardDraft: vi.fn(async () => null),
          updatePage,
          refreshEditorLock: vi.fn(async () => true),
          setSavedSlugByLocale: vi.fn(),
          confirmPrePublishReadiness: vi.fn(async () => true),
          confirmDiscard: vi.fn(async () => true),
          onSaveConflict: vi.fn(async () => undefined),
          router: { refresh: vi.fn() },
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <NextIntlClientProvider locale={locale} messages={messages}>
            {children}
          </NextIntlClientProvider>
        ),
      }
    )
    await act(async () => {
      await hook.result.current.archive()
    })
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(
      locale === "fr"
        ? "La page d’accueil ne peut pas être archivée."
        : "The home page can’t be archived."
    )
    expect(toast.success).not.toHaveBeenCalled()
  }
)
