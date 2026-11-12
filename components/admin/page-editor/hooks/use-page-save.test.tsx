import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile, createInstalledDefaultSlice } from "@/test-utils/slice-profile"
import * as legacyParser from "@/lib/rich-text/legacy-html"
import { PreviewInlineEditor } from "../../preview-inline-editor"
import { adoptHeroTitles } from "@/lib/rich-text/adopt-hero-titles"

import { convexTest } from "@/convexTestWithExplicitAdmin"
import schema from "@/convex/schema"
import { api } from "@/convex/_generated/api"
import { act, render, renderHook, waitFor } from "@testing-library/react"
import { ConvexError } from "convex/values"
import { toast } from "sonner"
import { revalidatePagePaths } from "@/app/(core)/admin/(authenticated)/pages/actions"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
  vi,
} from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import type { Locale } from "@/lib/i18n/config"

import { AdminI18nProvider } from "@/test-utils/admin-i18n"
import { staleSaveMessage, type Page } from "../lib/types"
import {
  readRecoveryDraft,
  writeRecoveryDraft,
  recoveryKey,
} from "../lib/recovery"
import {
  usePageSave,
  type PageSaveDraft,
  type RetainedPageSaveBase,
  type RetainedSharedPageSaveDraft,
  type SaveSnapshotEditorDraft,
  type UpdateDraft,
  type PublishPage,
  type DiscardDraft,
  type UpdatePage,
} from "./use-page-save"

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock("@/app/(core)/admin/(authenticated)/pages/actions", () => ({
  revalidatePagePaths: vi.fn(async () => undefined),
}))

const pageId = "page_1" as Id<"pages">

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function makePage(overrides: Partial<Page> = {}): Page {
  return {
    _id: pageId,
    _creationTime: 1,
    slug: "home",
    pageType: "page",
    status: "draft",
    createdAt: 100,
    updatedAt: 100,
    content: {
      en: {
        title: "Home",
        slices: [],
      },
    },
    tags: [],
    createdBy: "user_1",
    ...overrides,
  } as Page
}

function makeDraft(overrides: Partial<PageSaveDraft> = {}): PageSaveDraft {
  return {
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
    ...overrides,
  }
}

function renderSaveHook({
  page = makePage(),
  initialDraft = makeDraft(),
  strictMode = false,
  initialLocale = "en" as Locale,
  hasStaging = false,
  stagingUpdatedAt = undefined as number | undefined,
  updateDraft = vi.fn<UpdateDraft>(async () => ({ updatedAt: 101 })),
  saveSnapshotDraft = undefined as SaveSnapshotEditorDraft | undefined,
  publishPage = vi.fn<PublishPage>(async () => ({ updatedAt: 500 })),
  discardDraft = vi.fn<DiscardDraft>(async () => null),
  updatePage = vi.fn<UpdatePage>(async () => ({ updatedAt: 102 })),
  // Save renews the editor lock before any staged write (the heartbeat pauses
  // on hidden tabs, so the lock can lapse under a returning user). Default to
  // "we hold it"; tests that care override it.
  refreshEditorLock = vi.fn(async () => true),
  onSaveConflict = vi.fn(async () => undefined),
  confirmDiscard = vi.fn(async () => true),
  captureDraft = undefined as
    | ((
        draft: PageSaveDraft,
        isCurrent: () => boolean
      ) => PageSaveDraft | null | Promise<PageSaveDraft | null>)
    | undefined,
  refuseDraft = undefined as
    | ((
        draft: PageSaveDraft,
        context: { snapshot: boolean; addressCleared: boolean }
      ) => boolean)
    | undefined,
  onPreparedDraft = undefined as ((draft: PageSaveDraft) => void) | undefined,
  recoveryDraftForFlush = undefined as
    ((draft: PageSaveDraft) => PageSaveDraft) | undefined,
  presentationCatalogRevision = undefined as string | undefined,
  getDraftWriteCount = undefined as (() => number) | undefined,
  retainedSaveBase = undefined as RetainedPageSaveBase | undefined,
  retainedSharedDraft = undefined as RetainedSharedPageSaveDraft | undefined,
} = {}) {
  let savedSlugByLocale: Record<string, string> = { en: page.slug }
  const confirmPrePublishReadiness = vi.fn(async () => true)
  const router = { refresh: vi.fn() }

  const hook = renderHook(
    ({
      draft,
      locale = "en",
      catalogRevision = presentationCatalogRevision,
      currentPage = page,
    }: {
      draft: PageSaveDraft
      locale?: Locale
      catalogRevision?: string
      currentPage?: Page
    }) =>
      usePageSave({
        page: currentPage,
        defaultLocale: "en",
        currentLocale: locale,
        initialPageDraftHandoff: null,
        draft,
        retainedSaveBase,
        retainedSharedDraft,
        captureDraft,
        refuseDraft,
        recoveryDraftForFlush,
        getDraftWriteCount,
        onPreparedDraft,
        presentationCatalogRevision: catalogRevision,
        hasStaging,
        stagingUpdatedAt,
        updateDraft,
        saveSnapshotDraft,
        publishPage,
        discardDraft,
        updatePage,
        refreshEditorLock,
        setSavedSlugByLocale(update) {
          savedSlugByLocale = update(savedSlugByLocale)
        },
        confirmPrePublishReadiness,
        confirmDiscard,
        onSaveConflict,
        router,
      }),
    {
      initialProps: {
        draft: initialDraft,
        locale: initialLocale,
      } as {
        draft: PageSaveDraft
        locale?: Locale
        catalogRevision?: string
        currentPage?: Page
      },
      wrapper: AdminI18nProvider,
      reactStrictMode: strictMode,
    }
  )

  return {
    ...hook,
    updateDraft,
    saveSnapshotDraft,
    publishPage,
    discardDraft,
    updatePage,
    refreshEditorLock,
    onSaveConflict,
    confirmPrePublishReadiness,
    confirmDiscard,
    router,
    getSavedSlugByLocale: () => savedSlugByLocale,
  }
}

it.each([false, true])(
  "reports lock refusal before either writer (snapshot=%s)",
  async (snapshot) => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.clearAllMocks()
    const saveSnapshotDraft = vi.fn<SaveSnapshotEditorDraft>(async () => ({
      updatedAt: 101,
    }))
    const hook = renderSaveHook({
      refreshEditorLock: vi.fn(async () => false),
      saveSnapshotDraft: snapshot ? saveSnapshotDraft : undefined,
    })
    hook.rerender({ draft: makeDraft({ title: "Unsaved text" }) })
    await act(async () => {
      expect(await hook.result.current.save()).toBe(false)
    })
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "This page couldn't be saved. Try again."
    )
    expect(hook.refreshEditorLock).toHaveBeenCalledOnce()
    expect(hook.result.current.hasUnsaved).toBe(true)
    expect(hook.result.current.isSaving).toBe(false)
    expect(hook.updateDraft).not.toHaveBeenCalled()
    expect(saveSnapshotDraft).not.toHaveBeenCalled()
    hook.unmount()
  }
)

describe("Save feedback lifetime", () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.clearAllMocks()
  })

  it.each([false, true])(
    "drops lock-refusal feedback after unmount (snapshot=%s)",
    async (snapshot) => {
      const lock = deferred<boolean>()
      const started = deferred<void>()
      const saveSnapshotDraft = vi.fn<SaveSnapshotEditorDraft>(async () => ({
        updatedAt: 101,
      }))
      const hook = renderSaveHook({
        refreshEditorLock: vi.fn(() => {
          started.resolve()
          return lock.promise
        }),
        saveSnapshotDraft: snapshot ? saveSnapshotDraft : undefined,
      })
      hook.rerender({
        draft: makeDraft({ title: "Unsaved before navigation" }),
      })
      let saving!: Promise<boolean>
      await act(async () => {
        saving = hook.result.current.save()
        await started.promise
      })
      expect(hook.refreshEditorLock).toHaveBeenCalledOnce()
      expect(hook.updateDraft).not.toHaveBeenCalled()
      expect(saveSnapshotDraft).not.toHaveBeenCalled()
      hook.unmount()
      expect(readRecoveryDraft(pageId, "en")?.title).toBe(
        "Unsaved before navigation"
      )
      await act(async () => {
        lock.resolve(false)
        expect(await saving).toBe(false)
      })
      expect(toast.error).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
      expect(hook.updateDraft).not.toHaveBeenCalled()
      expect(saveSnapshotDraft).not.toHaveBeenCalled()
    }
  )

  it.each([
    { snapshot: false, outcome: "success" },
    { snapshot: false, outcome: "rejection" },
    { snapshot: true, outcome: "success" },
    { snapshot: true, outcome: "rejection" },
  ] as const)(
    "drops writer $outcome feedback after unmount (snapshot=$snapshot)",
    async ({ snapshot, outcome }) => {
      const write = deferred<{ updatedAt: number }>()
      const started = deferred<void>()
      const writer = () => {
        started.resolve()
        return write.promise
      }
      const updateDraft = vi.fn<UpdateDraft>(writer)
      const saveSnapshotDraft = vi.fn<SaveSnapshotEditorDraft>(writer)
      const hook = renderSaveHook({
        updateDraft,
        saveSnapshotDraft: snapshot ? saveSnapshotDraft : undefined,
      })
      hook.rerender({
        draft: makeDraft({ title: "Submitted before navigation" }),
      })
      let saving!: Promise<boolean>
      await act(async () => {
        saving = hook.result.current.save()
        await started.promise
      })
      expect(snapshot ? saveSnapshotDraft : updateDraft).toHaveBeenCalledOnce()
      expect(snapshot ? updateDraft : saveSnapshotDraft).not.toHaveBeenCalled()
      hook.unmount()
      let saved!: boolean
      await act(async () => {
        if (outcome === "success") write.resolve({ updatedAt: 101 })
        else write.reject(new Error("Draft write failed"))
        saved = await saving
      })
      expect(toast.success).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      expect(saved).toBe(false)
    }
  )

  it.each([false, true])(
    "saves a dirty initial draft once after StrictMode replay (snapshot=%s)",
    async (snapshot) => {
      const saveSnapshotDraft = vi.fn<SaveSnapshotEditorDraft>(async () => ({
        updatedAt: 101,
      }))
      const hook = renderSaveHook({
        initialDraft: makeDraft({ title: "Dirty initial draft" }),
        strictMode: true,
        saveSnapshotDraft: snapshot ? saveSnapshotDraft : undefined,
      })
      // The cleanup really flushed; replay must not adopt its own recovery.
      expect(readRecoveryDraft(pageId, "en")?.title).toBe("Dirty initial draft")
      expect(hook.result.current.recoveryDraft).toBeNull()
      expect(hook.result.current.hasUnsaved).toBe(true)
      await act(async () => {
        expect(await hook.result.current.save()).toBe(true)
      })
      expect(
        snapshot ? saveSnapshotDraft : hook.updateDraft
      ).toHaveBeenCalledOnce()
      expect(toast.success).toHaveBeenCalledExactlyOnceWith("Saved")
      expect(toast.error).not.toHaveBeenCalled()
      expect(hook.result.current.recoveryDraft).toBeNull()
      expect(readRecoveryDraft(pageId, "en")).toBeNull()
      hook.unmount()
    }
  )
})

describe("Publish, discard and status feedback lifetime", () => {
  const actions = ["publish", "archive", "unpublish", "unarchive"] as const
  const scopeEnds = ["unmount", "locale switch", "page switch"] as const
  let originalLocation: Location
  let reload: ReturnType<typeof vi.fn>

  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.clearAllMocks()
    vi.mocked(revalidatePagePaths).mockReset()
    vi.mocked(revalidatePagePaths).mockResolvedValue(undefined)
    originalLocation = window.location
    reload = vi.fn()
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    })
  })

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    })
    vi.mocked(revalidatePagePaths).mockReset()
    vi.mocked(revalidatePagePaths).mockResolvedValue(undefined)
  })

  function endScope(
    hook: ReturnType<typeof renderSaveHook>,
    end: (typeof scopeEnds)[number]
  ) {
    if (end === "unmount") hook.unmount()
    else {
      hook.rerender({
        draft: makeDraft({ title: "New scope typing" }),
        locale: end === "locale switch" ? "fr" : "en",
        currentPage:
          end === "page switch"
            ? makePage({ _id: "page_2" as Id<"pages"> })
            : undefined,
      })
    }
  }

  it.each(
    actions.flatMap((action) =>
      (["mutation", "revalidation"] as const).flatMap((stage) =>
        (["resolve", "reject"] as const).map((outcome) => ({
          action,
          stage,
          outcome,
        }))
      )
    )
  )(
    "drops $action $stage $outcome feedback after unmount",
    async ({ action, stage, outcome }) => {
      const mutation = deferred<{ updatedAt: number }>()
      const revalidation = deferred<void>()
      const started = deferred<void>()
      const hook = renderSaveHook({
        hasStaging: true,
        publishPage: vi.fn(() => {
          started.resolve()
          return mutation.promise
        }),
        updatePage: vi.fn(() => {
          started.resolve()
          return mutation.promise
        }),
      })
      if (stage === "revalidation")
        vi.mocked(revalidatePagePaths).mockReturnValueOnce(revalidation.promise)
      let pending!: Promise<void>
      await act(async () => {
        pending = hook.result.current[action]()
        await started.promise
      })
      if (stage === "revalidation") {
        await act(async () => {
          mutation.resolve({ updatedAt: 500 })
          await mutation.promise
        })
        expect(revalidatePagePaths).toHaveBeenCalledExactlyOnceWith(pageId)
      }
      hook.unmount()
      await act(async () => {
        if (stage === "mutation") {
          if (outcome === "resolve") mutation.resolve({ updatedAt: 500 })
          else mutation.reject(new Error("Mutation failed"))
        } else {
          if (outcome === "resolve") revalidation.resolve()
          else revalidation.reject(new Error("Revalidation failed"))
        }
        await pending
      })
      expect(toast.success).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      expect(hook.router.refresh).not.toHaveBeenCalled()
      expect(reload).not.toHaveBeenCalled()
      expect(revalidatePagePaths).toHaveBeenCalledTimes(
        stage === "mutation" && outcome === "reject" ? 0 : 1
      )
    }
  )

  it.each(
    actions.flatMap((action) =>
      scopeEnds.slice(1).map((end) => ({ action, end }))
    )
  )(
    "drops $action feedback after $end without clearing new staging",
    async ({ action, end }) => {
      const mutation = deferred<{ updatedAt: number }>()
      const started = deferred<void>()
      const writer = () => {
        started.resolve()
        return mutation.promise
      }
      const hook = renderSaveHook({
        hasStaging: true,
        publishPage: vi.fn(writer),
        updatePage: vi.fn(writer),
      })
      let pending!: Promise<void>
      await act(async () => {
        pending = hook.result.current[action]()
        await started.promise
      })
      endScope(hook, end)
      await act(async () => {
        mutation.resolve({ updatedAt: 500 })
        await pending
      })
      expect(hook.result.current.hasStaging).toBe(true)
      expect(hook.result.current.hasUnsaved).toBe(true)
      expect(toast.success).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      expect(hook.router.refresh).not.toHaveBeenCalled()
      expect(revalidatePagePaths).toHaveBeenCalledExactlyOnceWith(pageId)
      hook.unmount()
    }
  )

  it.each(scopeEnds)("refuses discard confirmation after %s", async (end) => {
    const confirmation = deferred<boolean>()
    const hook = renderSaveHook({
      hasStaging: true,
      confirmDiscard: vi.fn(() => confirmation.promise),
    })
    let pending!: Promise<void>
    act(() => {
      pending = hook.result.current.discard()
    })
    expect(hook.confirmDiscard).toHaveBeenCalledOnce()
    endScope(hook, end)
    await act(async () => {
      confirmation.resolve(true)
      await pending
    })
    expect(hook.discardDraft).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(hook.router.refresh).not.toHaveBeenCalled()
    if (end !== "unmount") hook.unmount()
  })

  it.each(
    scopeEnds.flatMap((end) =>
      (["resolve", "reject"] as const).map((outcome) => ({ end, outcome }))
    )
  )(
    "drops discard $outcome feedback after $end and confines recovery removal to submitted scope",
    async ({ end, outcome }) => {
      const mutation = deferred<null>()
      const started = deferred<void>()
      const hook = renderSaveHook({
        hasStaging: true,
        discardDraft: vi.fn(() => {
          started.resolve()
          return mutation.promise
        }),
      })
      let pending!: Promise<void>
      await act(async () => {
        pending = hook.result.current.discard()
        await started.promise
      })
      writeRecoveryDraft(pageId, { base: null, ...{
        ...makeDraft(),
        locale: "en",
        savedAt: 1000,
      } })
      writeRecoveryDraft(pageId, { base: null, ...{
        ...makeDraft({ title: "French recovery" }),
        locale: "fr",
        savedAt: 1000,
      } })
      const otherPageId = "page_2" as Id<"pages">
      writeRecoveryDraft(otherPageId, { base: null, ...{
        ...makeDraft({ title: "Other page recovery" }),
        locale: "en",
        savedAt: 1000,
      } })
      endScope(hook, end)
      const nextRecovery = hook.result.current.recoveryDraft
      await act(async () => {
        if (outcome === "resolve") mutation.resolve(null)
        else mutation.reject(new Error("Discard failed"))
        await pending
      })
      expect(hook.discardDraft).toHaveBeenCalledExactlyOnceWith({ pageId })
      expect(readRecoveryDraft(pageId, "en") === null).toBe(
        outcome === "resolve"
      )
      expect(readRecoveryDraft(pageId, "fr")?.title).toBe("French recovery")
      expect(readRecoveryDraft(otherPageId, "en")?.title).toBe(
        "Other page recovery"
      )
      expect(toast.success).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      expect(reload).not.toHaveBeenCalled()
      expect(hook.router.refresh).not.toHaveBeenCalled()
      if (end !== "unmount") {
        expect(hook.result.current.recoveryDraft).toBe(nextRecovery)
        expect(hook.result.current.hasStaging).toBe(true)
        expect(hook.result.current.hasUnsaved).toBe(true)
        hook.unmount()
      }
    }
  )

  it("FIX-74F discard EN to FR to EN preserves newer locale and shared edits", async () => {
    const mutation = deferred<null>()
    const hook = renderSaveHook({ hasStaging: true, strictMode: true, discardDraft: vi.fn(() => mutation.promise) })
    let pending!: Promise<void>
    await act(async () => { pending = hook.result.current.discard(); await Promise.resolve() })
    expect(hook.discardDraft).toHaveBeenCalledOnce()
    hook.rerender({ draft: makeDraft({ title: "FR typing" }), locale: "fr" })
    const newer = makeDraft({ title: "New EN typing", seoOgTitle: "Shared typing", sharedFieldValues: { category: "new" } })
    hook.rerender({ draft: newer, locale: "en" })
    writeRecoveryDraft(pageId, { base: null, ...{ ...newer, locale: "en", savedAt: Date.now() + 1000 } })
    const recovery = readRecoveryDraft(pageId, "en")
    await act(async () => { mutation.resolve(null); await pending })
    expect(readRecoveryDraft(pageId, "en")).toEqual(recovery)
    expect(hook.result.current.hasUnsaved).toBe(true)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(hook.router.refresh).not.toHaveBeenCalled()
    hook.unmount()
  })

  it.each([...actions, "discard"] as const)(
    "preserves one success toast for active %s",
    async (action) => {
      const hook = renderSaveHook({ hasStaging: true, strictMode: true })
      await act(async () => {
        await hook.result.current[action]()
      })
      expect(toast.success).toHaveBeenCalledOnce()
      expect(toast.error).not.toHaveBeenCalled()
      expect(hook.router.refresh).toHaveBeenCalledTimes(
        action === "discard" ? 0 : 1
      )
      expect(reload).toHaveBeenCalledTimes(action === "discard" ? 1 : 0)
      expect(revalidatePagePaths).toHaveBeenCalledTimes(
        action === "discard" ? 0 : 1
      )
      hook.unmount()
    }
  )

  it.each(["publish", "archive", "unpublish", "unarchive", "discard"] as const)(
    "independent-review: suppresses %s after EN-FR-EN while mutation pending",
    async (action) => {
      const mutation = deferred<{ updatedAt: number }>()
      const started = deferred<void>()
      const writer = () => {
        started.resolve()
        return mutation.promise
      }
      const hook = renderSaveHook({
        hasStaging: true,
        publishPage: vi.fn(writer),
        updatePage: vi.fn(writer),
        discardDraft: vi.fn(async () => {
          await writer()
          return null
        }),
      })
      try {
        let pending!: Promise<void>
        await act(async () => {
          pending = hook.result.current[action]()
          await started.promise
        })
        hook.rerender({ draft: makeDraft(), locale: "fr" })
        hook.rerender({ draft: makeDraft(), locale: "en" })
        await act(async () => {
          mutation.resolve({ updatedAt: 500 })
          await pending
        })
        expect(toast.success).not.toHaveBeenCalled()
        expect(toast.error).not.toHaveBeenCalled()
        expect(hook.router.refresh).not.toHaveBeenCalled()
        expect(reload).not.toHaveBeenCalled()
      } finally {
        hook.unmount()
      }
    }
  )

  it("independent-review: refuses old discard confirmation after EN-FR-EN", async () => {
    const confirmation = deferred<boolean>()
    const hook = renderSaveHook({
      hasStaging: true,
      confirmDiscard: vi.fn(() => confirmation.promise),
    })
    try {
      let pending!: Promise<void>
      act(() => {
        pending = hook.result.current.discard()
      })
      expect(hook.confirmDiscard).toHaveBeenCalledOnce()
      hook.rerender({ draft: makeDraft(), locale: "fr" })
      hook.rerender({ draft: makeDraft(), locale: "en" })
      await act(async () => {
        confirmation.resolve(true)
        await pending
      })
      expect(hook.discardDraft).not.toHaveBeenCalled()
    } finally {
      hook.unmount()
    }
  })

  it.each(["older", "newer"] as const)(
    "keeps discard recovery ownership after EN-FR-EN (%s record)",
    async (age) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(2000)
      const mutation = deferred<null>()
      const started = deferred<void>()
      const hook = renderSaveHook({
        hasStaging: true,
        discardDraft: vi.fn(() => {
          started.resolve()
          return mutation.promise
        }),
      })
      try {
        let pending!: Promise<void>
        await act(async () => {
          pending = hook.result.current.discard()
          await started.promise
        })
        hook.rerender({ draft: makeDraft(), locale: "fr" })
        const newerDraft = makeDraft({ title: "New EN typing" })
        writeRecoveryDraft(pageId, { base: null, ...{
          ...newerDraft,
          locale: "en",
          savedAt: age === "newer" ? 2001 : 1999,
        } })
        hook.rerender({ draft: newerDraft, locale: "en" })
        const recovery = hook.result.current.recoveryDraft
        expect(recovery?.title).toBe(newerDraft.title)
        await act(async () => {
          mutation.resolve(null)
          await pending
        })
        expect(readRecoveryDraft(pageId, "en")?.title ?? null).toBe(
          age === "newer" ? newerDraft.title : null
        )
        expect(hook.result.current.recoveryDraft).toBe(recovery)
        expect(hook.result.current.hasStaging).toBe(true)
        expect(hook.result.current.hasUnsaved).toBe(true)
        expect(toast.success).not.toHaveBeenCalled()
        expect(toast.error).not.toHaveBeenCalled()
        expect(reload).not.toHaveBeenCalled()
        expect(hook.router.refresh).not.toHaveBeenCalled()
      } finally {
        hook.unmount()
        clock.mockRestore()
      }
    }
  )

  it("refuses old pre-publish readiness after EN-FR-EN", async () => {
    const readiness = deferred<boolean>()
    const hook = renderSaveHook({ hasStaging: true })
    hook.confirmPrePublishReadiness.mockReturnValueOnce(readiness.promise)
    try {
      let pending!: Promise<void>
      await act(async () => {
        pending = hook.result.current.publish()
      })
      expect(hook.confirmPrePublishReadiness).toHaveBeenCalledOnce()
      hook.rerender({ draft: makeDraft(), locale: "fr" })
      hook.rerender({ draft: makeDraft(), locale: "en" })
      await act(async () => {
        readiness.resolve(true)
        await pending
      })
      expect(hook.publishPage).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      expect(hook.router.refresh).not.toHaveBeenCalled()
    } finally {
      hook.unmount()
    }
  })

  it.each([
    "capture",
    "lock",
    "lock refusal",
    "updateDraft",
    "saveSnapshotDraft",
    "updatePage",
  ] as const)(
    "expires Save paused at %s across EN-FR-EN without adopting its baseline",
    async (stage) => {
      const capture = deferred<PageSaveDraft | null>()
      const lock = deferred<boolean>()
      const mutation = deferred<{ updatedAt: number }>()
      const started = deferred<void>()
      const submitted = makeDraft({
        title: "Submitted EN",
        parentId: "parent_1",
      })
      const newer = makeDraft({ title: "Newer EN typing" })
      const onPreparedDraft = vi.fn()
      let captureIsCurrent: (() => boolean) | undefined
      const pendingWriter = () => {
        started.resolve()
        return mutation.promise
      }
      const hook = renderSaveHook({
        onPreparedDraft,
        captureDraft:
          stage === "capture"
            ? (_draft, isCurrent) => {
                captureIsCurrent = isCurrent
                started.resolve()
                return capture.promise
              }
            : undefined,
        refreshEditorLock: vi.fn(() => {
          if (stage === "lock" || stage === "lock refusal") {
            started.resolve()
            return lock.promise
          }
          return Promise.resolve(true)
        }),
        updateDraft: vi.fn(
          stage === "updateDraft"
            ? pendingWriter
            : async () => ({ updatedAt: 101 })
        ),
        saveSnapshotDraft:
          stage === "saveSnapshotDraft" ? vi.fn(pendingWriter) : undefined,
        updatePage: vi.fn(
          stage === "updatePage"
            ? pendingWriter
            : async () => ({ updatedAt: 102 })
        ),
      })
      try {
        hook.rerender({ draft: submitted })
        let pending!: Promise<void>
        await act(async () => {
          pending = hook.result.current.publish()
          await started.promise
        })
        expect(hook.result.current.isSaving).toBe(true)
        if (captureIsCurrent) expect(captureIsCurrent()).toBe(true)
        const preparedBeforeReturn = onPreparedDraft.mock.calls.length
        hook.rerender({ draft: makeDraft(), locale: "fr" })
        hook.rerender({ draft: newer, locale: "en" })
        // The owner resolves recovery from the old lifetime, then keeps typing.
        act(() => hook.result.current.clearRecoveryDraftState())
        // New typing in the returned lifetime has its own browser recovery.
        const recovery = {
          ...newer,
          locale: "en" as const,
          savedAt: Date.now() + 1,
        }
        writeRecoveryDraft(pageId, { base: null, ...recovery })
        const storedRecovery = readRecoveryDraft(pageId, "en")
        if (captureIsCurrent) expect(captureIsCurrent()).toBe(false)
        await act(async () => {
          if (stage === "capture") capture.resolve(submitted)
          else if (stage === "lock" || stage === "lock refusal")
            lock.resolve(stage === "lock")
          else mutation.resolve({ updatedAt: 500 })
          await pending
        })
        expect(hook.result.current.isSaving).toBe(false)
        expect(onPreparedDraft).toHaveBeenCalledTimes(preparedBeforeReturn)
        expect(hook.updateDraft).toHaveBeenCalledTimes(
          stage === "updateDraft" || stage === "updatePage" ? 1 : 0
        )
        expect(hook.updatePage).toHaveBeenCalledTimes(
          stage === "updatePage" ? 1 : 0
        )
        if (hook.saveSnapshotDraft)
          expect(hook.saveSnapshotDraft).toHaveBeenCalledOnce()
        expect(hook.confirmPrePublishReadiness).not.toHaveBeenCalled()
        expect(hook.publishPage).not.toHaveBeenCalled()
        expect(hook.onSaveConflict).not.toHaveBeenCalled()
        expect(toast.success).not.toHaveBeenCalled()
        expect(toast.error).not.toHaveBeenCalled()
        expect(hook.router.refresh).not.toHaveBeenCalled()
        expect(reload).not.toHaveBeenCalled()
        expect(hook.result.current.hasUnsaved).toBe(true)
        expect(hook.result.current.savedAt).toBeNull()
        expect(readRecoveryDraft(pageId, "en")).toEqual(storedRecovery)
        // Exercise lastSavedRef through its real consumer after another render.
        hook.rerender({ draft: makeDraft(), locale: "en" })
        expect(hook.result.current.hasUnsaved).toBe(false)
        hook.rerender({ draft: newer, locale: "en" })
        expect(hook.result.current.hasUnsaved).toBe(true)
        expect(readRecoveryDraft(pageId, "en")).toEqual(storedRecovery)
      } finally {
        hook.unmount()
      }
    }
  )
})

describe("usePageSave (ADR-0041 Deploy 2 — staging seams)", () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.clearAllMocks()
  })

  it("NEW throttles browser serialization, flushes pagehide, and never persists a typing event", () => {
    vi.useFakeTimers()
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    try {
      const hook = renderSaveHook()
      for (const title of ["typing 1", "typing 2", "typing 3"])
        hook.rerender({ draft: makeDraft({ title }) })
      expect(setItem).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(249))
      expect(setItem).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(1))
      expect(setItem).toHaveBeenCalledOnce()
      expect(readRecoveryDraft(pageId, "en")?.title).toBe("typing 3")
      hook.rerender({ draft: makeDraft({ title: "last before navigation" }) })
      act(() => window.dispatchEvent(new Event("pagehide")))
      expect(readRecoveryDraft(pageId, "en")?.title).toBe(
        "last before navigation"
      )
      expect(hook.updateDraft).not.toHaveBeenCalled()
      expect(hook.updatePage).not.toHaveBeenCalled()
      expect(hook.publishPage).not.toHaveBeenCalled()
      hook.unmount()
    } finally {
      setItem.mockRestore()
      vi.useRealTimers()
    }
  })

  it("NEW flushes hidden visibility and leaves unresolved browser Restore intact", () => {
    const hook = renderSaveHook()
    hook.rerender({ draft: makeDraft({ title: "hidden draft" }) })
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden")
    try {
      act(() => document.dispatchEvent(new Event("visibilitychange")))
      expect(readRecoveryDraft(pageId, "en")?.title).toBe("hidden draft")
    } finally {
      visibility.mockRestore()
      hook.unmount()
    }
    const reopened = renderSaveHook()
    expect(reopened.result.current.recoveryDraft?.title).toBe("hidden draft")
    reopened.rerender({ draft: makeDraft({ title: "manual current work" }) })
    act(() => window.dispatchEvent(new Event("pagehide")))
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("hidden draft")
    reopened.unmount()
  })

  it.each([false, true])(
    "captures the presentation revision with the draft before lock renewal (snapshot=%s)", sliceProfile(["hero-with-image"]),
    async (snapshotAuthority) => {
      const lock = deferred<boolean>()
      const saveSnapshotDraft = vi.fn<SaveSnapshotEditorDraft>(async () => ({
        updatedAt: 101,
      }))
      const firstRevision = `sha256:${"a".repeat(64)}`
      const hook = renderSaveHook({
        refreshEditorLock: vi.fn(() => lock.promise),
        presentationCatalogRevision: firstRevision,
        ...(snapshotAuthority ? { saveSnapshotDraft } : {}),
      })
      const slice = {
        ...createInstalledDefaultSlice("hero-with-image"),
        presentationIdV1: "centered",
      }
      const submitted = makeDraft({ slices: [slice] })
      hook.rerender({ draft: submitted })
      let saving!: Promise<boolean>
      act(() => {
        saving = hook.result.current.save()
      })
      hook.rerender({
        draft: makeDraft({ title: "Later work", slices: [slice] }),
        catalogRevision: `sha256:${"b".repeat(64)}`,
      })
      await act(async () => {
        lock.resolve(true)
        expect(await saving).toBe(true)
      })
      const args = snapshotAuthority
        ? saveSnapshotDraft.mock.calls[0][0]
        : hook.updateDraft.mock.calls[0][0]
      expect(args.expectedPresentationCatalogRevision).toBe(firstRevision)
      const persisted = snapshotAuthority
        ? saveSnapshotDraft.mock.calls[0][0].localized?.draft
        : hook.updateDraft.mock.calls[0][0].content?.en
      expect(persisted).toMatchObject({
        localized: { title: "Home" },
        slices: [slice],
      })
      expect(hook.result.current.hasUnsaved).toBe(true)
    }
  )

  it("requires an explicit recovery choice before Save or clean Publish", async () => {
    const recovered = {
      ...makeDraft({ title: "Recovered text" }),
      locale: "en" as const,
      savedAt: 1000,
    }
    writeRecoveryDraft(pageId, { base: null, ...recovered })
    const hook = renderSaveHook()
    await act(async () => {
      expect(await hook.result.current.save()).toBe(false)
      await hook.result.current.publish()
    })
    expect(hook.refreshEditorLock).not.toHaveBeenCalled()
    expect(hook.updateDraft).not.toHaveBeenCalled()
    expect(hook.publishPage).not.toHaveBeenCalled()
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("Recovered text")
    // The refusal is shown inside the recovery bar, not as a toast.
    expect(toast.error).not.toHaveBeenCalled()
    expect(hook.result.current.recoveryRefused).toBe(true)
    act(() => hook.result.current.discardRecoveryDraft())
    expect(hook.result.current.recoveryRefused).toBe(false)
    hook.rerender({ draft: makeDraft({ title: "Current form" }) })
    await act(async () => expect(await hook.result.current.save()).toBe(true))
    expect(
      hook.updateDraft.mock.calls[0]?.[0].content?.en?.localized.title
    ).toBe("Current form")
  })

  it("keeps a conflict arriving during Save and refuses subsequent Publish", async () => {
    const write = deferred<{ updatedAt: number }>()
    const hook = renderSaveHook({
      updateDraft: vi.fn<UpdateDraft>(() => write.promise),
    })
    hook.rerender({ draft: makeDraft({ title: "Submitted text" }) })
    let saving!: Promise<boolean>
    act(() => {
      saving = hook.result.current.save()
    })
    await waitFor(() => expect(hook.updateDraft).toHaveBeenCalledOnce())
    const recovered = {
      ...makeDraft({ title: "Latest conflicted text" }),
      locale: "en" as const,
      savedAt: 1000,
    }
    writeRecoveryDraft(pageId, { base: null, ...recovered })
    act(() => hook.result.current.setRecoveryDraft(recovered))
    await act(async () => {
      write.resolve({ updatedAt: 101 })
      expect(await saving).toBe(true)
      await hook.result.current.publish()
    })
    expect(hook.result.current.recoveryDraft?.title).toBe(recovered.title)
    expect(readRecoveryDraft(pageId, "en")?.title).toBe(recovered.title)
    expect(hook.publishPage).not.toHaveBeenCalled()
  })

  it("captures an active buffer before renewing the lock, without relying on a React setter", async () => {
    const captured = makeDraft({ title: "Active text at Save" })
    const order: string[] = []
    const hook = renderSaveHook({
      captureDraft: () => {
        order.push("capture")
        return captured
      },
      refreshEditorLock: vi.fn(async () => {
        order.push("lock")
        return true
      }),
    })
    await act(async () => {
      const save = hook.result.current.save()
      hook.rerender({ draft: captured })
      await save
    })
    expect(order).toEqual(["capture", "lock"])
    expect(hook.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          en: expect.objectContaining({
            localized: expect.objectContaining({ title: captured.title }),
          }),
        },
      })
    )
    expect(hook.result.current.hasUnsaved).toBe(false)
  })

  it("refuses Save and Publish when the active input cannot be captured", async () => {
    const hook = renderSaveHook({ captureDraft: () => null })
    await act(async () => {
      expect(await hook.result.current.ensureSaved()).toBe(false)
      await hook.result.current.publish()
    })
    expect(hook.refreshEditorLock).not.toHaveBeenCalled()
    expect(hook.updateDraft).not.toHaveBeenCalled()
    expect(hook.publishPage).not.toHaveBeenCalled()
  })

  describe("refuseDraft", () => {
    const blankTitlePage = () =>
      makePage({ content: { en: { title: "", slices: [] } } })
    const snapshotSave = () =>
      vi.fn<SaveSnapshotEditorDraft>(async () => ({ updatedAt: 101 }))

    it("is not asked for a clean draft", async () => {
      const refuseDraft = vi.fn(() => true)
      const clean = renderSaveHook({
        page: blankTitlePage(),
        initialDraft: makeDraft({ title: "" }),
        captureDraft: (draft) => draft,
        refuseDraft,
      })
      await act(async () => {
        expect(await clean.result.current.ensureSaved()).toBe(true)
      })
      expect(refuseDraft).not.toHaveBeenCalled()
      expect(clean.updateDraft).not.toHaveBeenCalled()
    })

    it("is not asked for a shared-only edit, so the shared write is sent", async () => {
      const refuseDraft = vi.fn(() => true)
      const saveSnapshotDraft = snapshotSave()
      const hook = renderSaveHook({
        page: blankTitlePage(),
        initialDraft: makeDraft({ title: "" }),
        saveSnapshotDraft,
        captureDraft: (draft) => draft,
        refuseDraft,
      })
      hook.rerender({ draft: makeDraft({ title: "", seoNoIndex: true }) })
      await act(async () => {
        expect(await hook.result.current.ensureSaved()).toBe(true)
      })
      expect(refuseDraft).not.toHaveBeenCalled()
      expect(saveSnapshotDraft).toHaveBeenCalledTimes(1)
      const args = saveSnapshotDraft.mock.calls[0][0]
      expect(args.localized).toBeUndefined()
      expect(args.shared).toBeDefined()
    })

    it("refuses a localized change before any write and stays dirty", async () => {
      const refuseDraft = vi.fn(() => true)
      const saveSnapshotDraft = snapshotSave()
      const hook = renderSaveHook({
        saveSnapshotDraft,
        captureDraft: (draft) => draft,
        refuseDraft,
      })
      hook.rerender({ draft: makeDraft({ title: "" }) })
      await act(async () => {
        expect(await hook.result.current.ensureSaved()).toBe(false)
      })
      expect(refuseDraft).toHaveBeenCalledTimes(1)
      expect(refuseDraft).toHaveBeenCalledWith(
        expect.objectContaining({ title: "" }),
        { snapshot: true, addressCleared: false }
      )
      expect(saveSnapshotDraft).not.toHaveBeenCalled()
      expect(hook.result.current.hasUnsaved).toBe(true)
      expect(hook.result.current.isSaving).toBe(false)
      // The in-flight slot is released: a corrected draft saves.
      refuseDraft.mockReturnValue(false)
      await act(async () => {
        expect(await hook.result.current.save()).toBe(true)
      })
      expect(saveSnapshotDraft).toHaveBeenCalledTimes(1)
    })

    it("reports the legacy path so a cleared non-default address still saves", async () => {
      // The editor only refuses a blank address when snapshot is true.
      const refuseDraft = vi.fn(
        (
          draft: PageSaveDraft,
          ctx: { snapshot: boolean; addressCleared: boolean }
        ) => ctx.snapshot && draft.slug.trim() === ""
      )
      const page = makePage({
        localizedSlugs: { fr: "accueil" },
        content: {
          en: { title: "Home", slices: [] },
          fr: { title: "Accueil", slices: [] },
        },
      })
      const hook = renderSaveHook({
        page,
        initialLocale: "fr",
        initialDraft: makeDraft({ title: "Accueil", slug: "accueil" }),
        captureDraft: (draft) => draft,
        refuseDraft,
      })
      hook.rerender({
        draft: makeDraft({ title: "Accueil", slug: "" }),
        locale: "fr",
      })
      await act(async () => {
        expect(await hook.result.current.save()).toBe(true)
      })
      expect(refuseDraft).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "" }),
        { snapshot: false, addressCleared: false }
      )
      expect(hook.updateDraft).toHaveBeenCalledTimes(1)
    })

    it("does not report a clear when the saved address was already blank", async () => {
      const refuseDraft = vi.fn(() => false)
      const hook = renderSaveHook({
        page: makePage({ slug: "" }),
        initialDraft: makeDraft({ slug: "" }),
        captureDraft: (draft) => draft,
        refuseDraft,
      })
      hook.rerender({ draft: makeDraft({ slug: "", title: "New title" }) })
      await act(async () => {
        expect(await hook.result.current.save()).toBe(true)
      })
      expect(refuseDraft).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "" }),
        { snapshot: false, addressCleared: false }
      )
      expect(hook.updateDraft).toHaveBeenCalledTimes(1)
    })

    it("asks about a default-locale address-only clear and writes nothing", async () => {
      const refuseDraft = vi.fn(() => true)
      const hook = renderSaveHook({
        captureDraft: (draft) => draft,
        refuseDraft,
      })
      hook.rerender({ draft: makeDraft({ slug: "" }) })
      await act(async () => {
        expect(await hook.result.current.save()).toBe(false)
      })
      expect(refuseDraft).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "" }),
        { snapshot: false, addressCleared: true }
      )
      expect(hook.updateDraft).not.toHaveBeenCalled()
      // Allowed through, the cleared address still writes nothing.
      refuseDraft.mockReturnValue(false)
      await act(async () => {
        await hook.result.current.save()
      })
      expect(hook.updateDraft).not.toHaveBeenCalled()
    })
  })

  it("shares one in-flight Save between duplicate gestures", async () => {
    const lock = deferred<boolean>()
    const hook = renderSaveHook({
      refreshEditorLock: vi.fn(() => lock.promise),
    })
    hook.rerender({ draft: makeDraft({ title: "One Save" }) })
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = hook.result.current.save()
      second = hook.result.current.save()
    })
    expect(first).toBe(second)
    expect(hook.refreshEditorLock).toHaveBeenCalledTimes(1)
    await act(async () => {
      lock.resolve(true)
      await first
    })
    expect(hook.updateDraft).toHaveBeenCalledTimes(1)
  })

  it("preserves typing after capture when the older Save completes", async () => {
    const lock = deferred<boolean>()
    const captured = makeDraft({ title: "Captured A" })
    const hook = renderSaveHook({
      captureDraft: () => captured,
      refreshEditorLock: vi.fn(() => lock.promise),
    })
    let save!: Promise<boolean>
    act(() => {
      save = hook.result.current.save()
    })
    hook.rerender({ draft: makeDraft({ title: "Newer B" }) })
    await act(async () => {
      lock.resolve(true)
      await save
    })
    expect(hook.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          en: expect.objectContaining({
            localized: expect.objectContaining({ title: "Captured A" }),
          }),
        },
      })
    )
    expect(hook.result.current.hasUnsaved).toBe(true)
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("Newer B")
  })

  it("captures active text for Publish even when the canonical base is clean", async () => {
    const captured = makeDraft({ title: "Active publication" })
    const hook = renderSaveHook({ captureDraft: () => captured })
    await act(async () => {
      const publish = hook.result.current.publish()
      hook.rerender({ draft: captured })
      await publish
    })
    expect(hook.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          en: expect.objectContaining({
            localized: expect.objectContaining({ title: captured.title }),
          }),
        },
      })
    )
    expect(hook.publishPage).toHaveBeenCalledTimes(1)
  })

  it("refuses an old locale's Save after its lock reply arrives", async () => {
    const lock = deferred<boolean>()
    const hook = renderSaveHook({
      refreshEditorLock: vi.fn(() => lock.promise),
    })
    hook.rerender({ draft: makeDraft({ title: "English pending" }) })
    let save!: Promise<boolean>
    act(() => {
      save = hook.result.current.save()
    })
    hook.rerender({ draft: makeDraft({ title: "French draft" }), locale: "fr" })
    let saved = true
    await act(async () => {
      lock.resolve(true)
      saved = await save
    })
    expect(saved).toBe(false)
    expect(hook.updateDraft).not.toHaveBeenCalled()
    expect(hook.publishPage).not.toHaveBeenCalled()
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("English pending")
  })

  it("does not overwrite a target locale's recovery with its clean draft during a locale switch", () => {
    const recovered = {
      ...makeDraft({ title: "French recovered work" }),
      locale: "fr" as const,
      savedAt: 1000,
    }
    writeRecoveryDraft(pageId, { base: null, ...recovered })
    const hook = renderSaveHook({
      page: makePage({
        content: {
          en: { title: "Home", slices: [] },
          fr: { title: "French saved draft", slices: [] },
        },
      }),
    })
    hook.rerender({ draft: makeDraft({ title: "English pending" }) })
    expect(hook.result.current.hasUnsaved).toBe(true)
    hook.rerender({
      draft: makeDraft({
        title: "French saved draft",
        slug: "french-saved-draft",
      }),
      locale: "fr",
    })
    expect(hook.result.current.recoveryDraft?.title).toBe(recovered.title)
    expect(readRecoveryDraft(pageId, "fr")?.title).toBe(recovered.title)
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("English pending")
  })

  it("preserves unresolved locale recovery while unsaved shared fields carry into that locale", () => {
    const recovered = {
      ...makeDraft({ title: "French pending", slug: "accueil" }),
      locale: "fr" as const,
      savedAt: 1000,
    }
    writeRecoveryDraft(pageId, { base: null, ...recovered })
    const hook = renderSaveHook({
      page: makePage({
        content: {
          en: { title: "Home", slices: [] },
          fr: { title: "Accueil", slices: [] },
        },
      }),
    })
    hook.rerender({ draft: makeDraft({ seoOgTitle: "Shared pending" }) })
    hook.rerender({
      draft: makeDraft({
        title: "Accueil",
        slug: "accueil",
        seoOgTitle: "Shared pending",
      }),
      locale: "fr",
    })
    expect(hook.result.current.hasUnsaved).toBe(true)
    expect(readRecoveryDraft(pageId, "fr")?.title).toBe("French pending")
    act(() => hook.result.current.discardRecoveryDraft())
    act(() => window.dispatchEvent(new Event("pagehide")))
    expect(readRecoveryDraft(pageId, "fr")?.title).toBe("Accueil")
    expect(readRecoveryDraft(pageId, "fr")?.seoOgTitle).toBe("Shared pending")
  })

  it("keeps an unsaved shared edit dirty on the first visit to another locale", () => {
    const hook = renderSaveHook({
      page: makePage({
        content: {
          en: { title: "Home", slices: [] },
          fr: { title: "Accueil", slices: [] },
        },
      }),
    })
    hook.rerender({ draft: makeDraft({ seoOgTitle: "Shared unsaved title" }) })
    hook.rerender({
      draft: makeDraft({
        title: "Accueil",
        slug: "accueil",
        seoOgTitle: "Shared unsaved title",
      }),
      locale: "fr",
    })
    expect(hook.result.current.hasUnsaved).toBe(true)
  })

  it("keeps retained unsaved locale content dirty after a fresh mount", async () => {
    const hook = renderSaveHook({
      page: makePage({
        content: {
          en: { title: "Home", slices: [] },
          fr: { title: "Accueil", slices: [] },
        },
      }),
    })
    hook.rerender({
      draft: makeDraft({ title: "Retained French work", slug: "accueil" }),
      locale: "fr",
    })
    expect(hook.result.current.hasUnsaved).toBe(true)
    await act(async () => {
      await hook.result.current.save()
    })
    expect(hook.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          fr: expect.objectContaining({
            localized: expect.objectContaining({
              title: "Retained French work",
            }),
          }),
        },
      })
    )
  })

  it("recognizes saved shared fields in a newly visited locale", async () => {
    const hook = renderSaveHook({
      page: makePage({
        content: {
          en: { title: "Home", slices: [] },
          fr: { title: "Accueil", slices: [] },
        },
      }),
    })
    hook.rerender({ draft: makeDraft({ seoOgTitle: "Saved shared title" }) })
    await act(async () => {
      await hook.result.current.save()
    })
    hook.rerender({
      draft: makeDraft({
        title: "Accueil",
        slug: "accueil",
        seoOgTitle: "Saved shared title",
      }),
      locale: "fr",
    })
    expect(hook.result.current.hasUnsaved).toBe(false)
  })

  it("retains the latest page-wide staging token across a locale switch", async () => {
    const hook = renderSaveHook({
      hasStaging: true,
      stagingUpdatedAt: 200,
      updateDraft: vi.fn(async () => ({ updatedAt: 250 })),
    })
    hook.rerender({ draft: makeDraft({ title: "English saved" }) })
    await act(async () => {
      await hook.result.current.save()
    })
    hook.rerender({
      draft: makeDraft({ title: "French work", slug: "french-work" }),
      locale: "fr",
    })
    expect(hook.result.current.hasStaging).toBe(true)
    await act(async () => {
      await hook.result.current.save()
    })
    expect(hook.updateDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedUpdatedAt: 250 })
    )
  })

  it("does not publish while newer typing remains unsaved", async () => {
    const lock = deferred<boolean>()
    const hook = renderSaveHook({
      refreshEditorLock: vi.fn(() => lock.promise),
    })
    hook.rerender({ draft: makeDraft({ title: "Publish A" }) })
    let publish!: Promise<void>
    act(() => {
      publish = hook.result.current.publish()
    })
    hook.rerender({ draft: makeDraft({ title: "Newer B" }) })
    await act(async () => {
      lock.resolve(true)
      await publish
    })
    expect(hook.updateDraft).toHaveBeenCalledTimes(1)
    expect(hook.publishPage).not.toHaveBeenCalled()
    expect(hook.result.current.hasUnsaved).toBe(true)
  })

  // The heartbeat that renews the editor lock pauses while the tab is hidden
  // (a backgrounded editor should cost nothing), so a user returning after the
  // lock TTL can reach Save before the visibilitychange beat lands. `save()`
  // therefore renews the lock itself rather than racing that beat.
  it("renews the editor lock before staging a write", async () => {
    const hook = renderSaveHook()
    hook.rerender({ draft: makeDraft({ title: "Lock renewed" }) })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))

    await act(async () => {
      await hook.result.current.save()
    })

    expect(hook.refreshEditorLock).toHaveBeenCalled()
    expect(hook.updateDraft).toHaveBeenCalled()
  })

  it("writes nothing when another editor holds the lock", async () => {
    const refreshEditorLock = vi.fn(async () => false)
    const hook = renderSaveHook({ refreshEditorLock })
    hook.rerender({ draft: makeDraft({ title: "Blocked by other editor" }) })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))

    let saved = true
    await act(async () => {
      saved = await hook.result.current.save()
    })

    // Bail BEFORE any write, so the user gets the take-over affordance rather
    // than a half-applied save or a raw lock error from the mutation.
    expect(saved).toBe(false)
    expect(hook.updateDraft).not.toHaveBeenCalled()
    expect(hook.updatePage).not.toHaveBeenCalled()
    // The edit is still pending, not silently dropped.
    expect(hook.result.current.hasUnsaved).toBe(true)
  })

  it("keeps Save pending until a competing editor wins the lock", async () => {
    const lock = deferred<boolean>()
    const hook = renderSaveHook({
      refreshEditorLock: vi.fn(() => lock.promise),
    })
    hook.rerender({ draft: makeDraft({ title: "My unsaved edit" }) })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))

    let saveResult!: Promise<boolean>
    act(() => {
      saveResult = hook.result.current.save()
    })

    expect(hook.result.current.isSaving).toBe(true)
    expect(hook.refreshEditorLock).toHaveBeenCalledOnce()
    expect(hook.updateDraft).not.toHaveBeenCalled()
    expect(hook.updatePage).not.toHaveBeenCalled()

    let saved = true
    await act(async () => {
      lock.resolve(false)
      saved = await saveResult
    })

    expect(saved).toBe(false)
    expect(hook.result.current.isSaving).toBe(false)
    expect(hook.result.current.hasUnsaved).toBe(true)
    act(() => window.dispatchEvent(new Event("pagehide")))
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("My unsaved edit")
    expect(hook.updateDraft).not.toHaveBeenCalled()
    expect(hook.updatePage).not.toHaveBeenCalled()
    expect(hook.router.refresh).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("keeps the losing draft pending while a deferred stale write reports its conflict", async () => {
    const write = deferred<{ updatedAt: number }>()
    const onSaveConflict = vi.fn(async () => undefined)
    const hook = renderSaveHook({
      updateDraft: vi.fn<UpdateDraft>(() => write.promise),
      onSaveConflict,
    })
    hook.rerender({ draft: makeDraft({ title: "Losing draft" }) })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))

    let saveResult!: Promise<boolean>
    act(() => {
      saveResult = hook.result.current.save()
    })
    await waitFor(() => expect(hook.updateDraft).toHaveBeenCalledOnce())
    expect(hook.result.current.isSaving).toBe(true)
    expect(hook.result.current.hasUnsaved).toBe(true)
    expect(hook.router.refresh).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()

    let saved = true
    await act(async () => {
      write.reject(new Error(staleSaveMessage))
      saved = await saveResult
    })

    expect(saved).toBe(false)
    expect(hook.result.current.isSaving).toBe(false)
    expect(hook.result.current.hasUnsaved).toBe(true)
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("Losing draft")
    expect(onSaveConflict).toHaveBeenCalledOnce()
    expect(hook.router.refresh).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("keeps edits made during an in-flight save unsaved after the older save wins", async () => {
    const write = deferred<{ updatedAt: number }>()
    const hook = renderSaveHook({
      updateDraft: vi.fn<UpdateDraft>(() => write.promise),
    })
    hook.rerender({ draft: makeDraft({ title: "Draft A" }) })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))

    let saveResult!: Promise<boolean>
    act(() => {
      saveResult = hook.result.current.save()
    })
    await waitFor(() => expect(hook.updateDraft).toHaveBeenCalledOnce())
    expect(hook.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          en: expect.objectContaining({
            localized: expect.objectContaining({ title: "Draft A" }),
          }),
        }),
      })
    )

    hook.rerender({ draft: makeDraft({ title: "Draft B" }) })
    expect(hook.result.current.isSaving).toBe(true)
    expect(hook.result.current.hasUnsaved).toBe(true)
    act(() => window.dispatchEvent(new Event("pagehide")))
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("Draft B")

    await act(async () => {
      write.resolve({ updatedAt: 201 })
      expect(await saveResult).toBe(true)
    })

    expect(hook.result.current.isSaving).toBe(false)
    expect(hook.result.current.hasUnsaved).toBe(true)
    act(() => window.dispatchEvent(new Event("pagehide")))
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("Draft B")
    expect(hook.updateDraft).toHaveBeenCalledOnce()
  })

  it("stages localized content edits through updateDraft, sets hasStaging=true, does not touch pages.update", async () => {
    const hook = renderSaveHook()

    expect(hook.result.current.hasUnsaved).toBe(false)
    expect(hook.result.current.hasStaging).toBe(false)

    hook.rerender({ draft: makeDraft({ title: "Updated home" }) })

    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))
    act(() => window.dispatchEvent(new Event("pagehide")))
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("Updated home")

    let saved = false
    await act(async () => {
      saved = await hook.result.current.save()
    })

    expect(saved).toBe(true)
    // First save = lazy-create: no staging OCC token exists yet.
    expect(hook.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId,
        content: {
          en: {
            pageType: "page",
            localized: {
              title: "Updated home",
              metaTitle: undefined,
              metaDescription: undefined,
            },
            slices: [],
          },
        },
        expectedUpdatedAt: undefined,
      })
    )
    // No hierarchy / expiresAt / pageType / scheduledAt change → no
    // pages.update call.
    expect(hook.updatePage).not.toHaveBeenCalled()
    expect(hook.result.current.hasStaging).toBe(true)
    expect(hook.result.current.hasUnsaved).toBe(false)
    expect(hook.result.current.isSaving).toBe(false)
    expect(hook.result.current.savedAt).toBeInstanceOf(Date)
    expect(readRecoveryDraft(pageId, "en")).toBeNull()
    expect(hook.router.refresh).toHaveBeenCalledOnce()
  })

  it("saves localized content and hierarchy atomically under snapshot authority", async () => {
    const saveSnapshotDraft = vi.fn<SaveSnapshotEditorDraft>(async () => ({
      updatedAt: 201,
    }))
    const hook = renderSaveHook({ saveSnapshotDraft })

    hook.rerender({
      draft: makeDraft({
        title: "Atomic home",
        parentId: "page_parent" as Id<"pages">,
      }),
    })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))

    await act(async () => {
      await hook.result.current.save()
    })

    expect(saveSnapshotDraft).toHaveBeenCalledOnce()
    expect(saveSnapshotDraft).toHaveBeenCalledWith({
      localized: expect.objectContaining({
        locale: "en",
        slug: "home",
        draft: expect.objectContaining({
          localized: expect.objectContaining({ title: "Atomic home" }),
        }),
      }),
      shared: {
        parentId: "page_parent",
      },
    })
    expect(hook.updateDraft).not.toHaveBeenCalled()
    expect(hook.updatePage).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    "never sends tags when a non-post page is saved (snapshot=%s)",
    async (snapshot) => {
      const saveSnapshotDraft = vi.fn<SaveSnapshotEditorDraft>(async () => ({
        updatedAt: 201,
      }))
      const hook = renderSaveHook({
        saveSnapshotDraft: snapshot ? saveSnapshotDraft : undefined,
      })
      hook.rerender({
        draft: makeDraft({ title: "Renamed home", tags: ["stale"] }),
      })
      await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))
      await act(async () => {
        expect(await hook.result.current.save()).toBe(true)
      })
      if (snapshot) {
        expect(saveSnapshotDraft).toHaveBeenCalledOnce()
        const patch = saveSnapshotDraft.mock.calls[0]![0]
        expect(patch.localized).toBeDefined()
        expect(patch).not.toHaveProperty("shared")
      } else {
        expect(hook.updateDraft).toHaveBeenCalledOnce()
        const args = hook.updateDraft.mock.calls[0]![0]
        expect(args.content).toBeDefined()
        expect(args).not.toHaveProperty("tags")
      }
    }
  )

  it("sends changed tags when a blog post is saved", async () => {
    const hook = renderSaveHook({ page: makePage({ pageType: "post" }) })
    hook.rerender({
      draft: makeDraft({ pageType: "post", tags: ["topic"] }),
    })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))
    await act(async () => {
      expect(await hook.result.current.save()).toBe(true)
    })
    expect(hook.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["topic"] })
    )
  })

  it("persists clearing shared content after Save before route props refresh", async () => {
    const hook = renderSaveHook()
    hook.rerender({ draft: makeDraft({ seoOgTitle: "Temporary" }) })
    await act(async () => {
      await hook.result.current.save()
    })
    hook.rerender({ draft: makeDraft() })
    await act(async () => {
      await hook.result.current.save()
    })
    expect(hook.updateDraft).toHaveBeenCalledTimes(2)
    expect(hook.updateDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ seo: {} })
    )
    expect(hook.result.current.hasUnsaved).toBe(false)
  })

  it("persists returning localized content to its initial value before route props refresh", async () => {
    const hook = renderSaveHook()
    hook.rerender({ draft: makeDraft({ title: "Temporary" }) })
    await act(async () => {
      await hook.result.current.save()
    })
    hook.rerender({ draft: makeDraft() })
    await act(async () => {
      await hook.result.current.save()
    })
    expect(hook.updateDraft).toHaveBeenCalledTimes(2)
    expect(hook.updateDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: {
          en: expect.objectContaining({
            localized: expect.objectContaining({ title: "Home" }),
          }),
        },
      })
    )
  })

  it("threads the staging updatedAt as the OCC token on subsequent saves", async () => {
    const hook = renderSaveHook({
      hasStaging: true,
      stagingUpdatedAt: 200,
      updateDraft: vi.fn(async () => ({ updatedAt: 250 })),
    })

    hook.rerender({ draft: makeDraft({ title: "Round 1" }) })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))
    await act(async () => {
      await hook.result.current.save()
    })
    expect(hook.updateDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedUpdatedAt: 200 })
    )

    // Second save should use the fresh token returned above.
    hook.rerender({ draft: makeDraft({ title: "Round 2" }) })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))
    await act(async () => {
      await hook.result.current.save()
    })
    expect(hook.updateDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedUpdatedAt: 250 })
    )
  })

  it.each([false, true])(
    "refreshes the latest recovery buffer after a concurrent Save (snapshot=%s)",
    async (snapshotAuthority) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000)
      try {
        const write = deferred<{ updatedAt: number }>()
        const onSaveConflict = vi.fn(async () => {
          expect(readRecoveryDraft(pageId, "en")?.savedAt).toBe(2000)
          return undefined
        })
        const hook = renderSaveHook({
          onSaveConflict,
          ...(snapshotAuthority
            ? { saveSnapshotDraft: vi.fn(() => write.promise) }
            : { updateDraft: vi.fn(() => write.promise) }),
        })
        hook.rerender({ draft: makeDraft({ title: "Submitted buffer" }) })
        let saving!: Promise<boolean>
        act(() => {
          saving = hook.result.current.save()
        })
        await waitFor(() =>
          expect(
            snapshotAuthority ? hook.saveSnapshotDraft : hook.updateDraft
          ).toHaveBeenCalledOnce()
        )
        clock.mockReturnValue(1100)
        hook.rerender({
          draft: makeDraft({ title: "Latest compatible buffer" }),
        })
        act(() => window.dispatchEvent(new Event("pagehide")))
        expect(readRecoveryDraft(pageId, "en")?.savedAt).toBe(1100)
        clock.mockReturnValue(2000)
        await act(async () => {
          write.reject(
            new Error(
              snapshotAuthority ? "PAGE_LOCALE_DRAFT_STALE" : staleSaveMessage
            )
          )
          expect(await saving).toBe(false)
        })
        expect(onSaveConflict).toHaveBeenCalledOnce()
        expect(hook.result.current.hasUnsaved).toBe(true)
        hook.unmount()
        const reopened = renderSaveHook({ page: makePage({ updatedAt: 1500 }) })
        expect(reopened.result.current.recoveryDraft?.title).toBe(
          "Latest compatible buffer"
        )
        expect(readRecoveryDraft(pageId, "fr")).toBeNull()
      } finally {
        clock.mockRestore()
      }
    }
  )

  it("keeps dirty state and offers conflict recovery when a stale save is rejected", async () => {
    const onSaveConflict = vi.fn(async () => undefined)
    const hook = renderSaveHook({
      updateDraft: vi.fn(async () => {
        throw new Error(staleSaveMessage)
      }),
      onSaveConflict,
    })

    hook.rerender({ draft: makeDraft({ title: "Conflicting update" }) })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))

    let saved = true
    await act(async () => {
      saved = await hook.result.current.save()
    })

    expect(saved).toBe(false)
    expect(hook.result.current.hasUnsaved).toBe(true)
    expect(hook.result.current.isSaving).toBe(false)
    expect(onSaveConflict).toHaveBeenCalledOnce()
    expect(hook.router.refresh).not.toHaveBeenCalled()
  })

  it("never renders a raw server message when saving fails", async () => {
    const raw =
      "[CONVEX M(cms/publication:saveEditorDraft)] Server Error\n" +
      "at handler (../../convex/cms/publication.ts:1:1)"
    const hook = renderSaveHook({
      updateDraft: vi.fn(async () => {
        throw new Error(raw)
      }),
    })
    hook.rerender({ draft: makeDraft({ title: "Unsaved change" }) })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))

    await act(async () => {
      await hook.result.current.save()
    })

    expect(toast.error).toHaveBeenCalledWith(
      "This page couldn't be saved. Try again."
    )
    expect(toast.error).not.toHaveBeenCalledWith(raw)
  })

  it.each([
    [
      "PUBLICATION_REFERENCE_TARGET_LOCALE_UNAVAILABLE",
      "A referenced page isn't published in this language. Publish it first, then try again.",
    ],
    [
      "PUBLICATION_REFERENCE_TARGET_MISSING",
      "A referenced page no longer exists. Replace the reference, then try again.",
    ],
    [
      "PUBLICATION_REFERENCE_LIMIT",
      "This page has too many linked items to publish. Remove some links or related pages, then try again.",
    ],
  ])("maps %s to plain publish copy", async (code, expected) => {
    const hook = renderSaveHook({
      publishPage: vi.fn(async () => {
        throw new ConvexError(code)
      }),
    })

    await act(async () => {
      await hook.result.current.publish()
    })

    expect(toast.error).toHaveBeenCalledWith(expected)
    expect(String(vi.mocked(toast.error).mock.calls.at(-1)?.[0])).not.toContain(
      code
    )
  })

  it.each(["constructor", "__proto__", "PUBLICATION_UNKNOWN"])(
    "uses plain publish fallback for non-allowlisted local Convex code %s",
    async (code) => {
      const hook = renderSaveHook({
        publishPage: vi.fn(async () => {
          throw new ConvexError(code)
        }),
      })

      await act(async () => {
        await hook.result.current.publish()
      })

      const message = vi.mocked(toast.error).mock.calls.at(-1)?.[0]
      expect(message).toBe("This page couldn't be published. Try again.")
      expect(typeof message).toBe("string")
    }
  )

  it("redacts a transported Convex stack while retaining its known code", async () => {
    const raw =
      "[CONVEX M(cms/publication:publishLocale)] [Request ID: test] Server Error\n" +
      "Uncaught ConvexError: PUBLICATION_REFERENCE_TARGET_LOCALE_UNAVAILABLE\n" +
      "at writeReferences (../../convex/cms/publication.ts:698:14)"
    const hook = renderSaveHook({
      publishPage: vi.fn(async () => {
        throw new Error(raw)
      }),
    })

    await act(async () => {
      await hook.result.current.publish()
    })

    expect(toast.error).toHaveBeenCalledWith(
      "A referenced page isn't published in this language. Publish it first, then try again."
    )
    expect(String(vi.mocked(toast.error).mock.calls.at(-1)?.[0])).not.toContain(
      "../../convex"
    )
  })

  it("publish ensures the draft is saved (updateDraft) then calls publishPage with no OCC token", async () => {
    const hook = renderSaveHook()

    hook.rerender({ draft: makeDraft({ title: "Ready to publish" }) })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))

    await act(async () => {
      await hook.result.current.publish()
    })

    expect(hook.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          en: expect.objectContaining({
            localized: expect.objectContaining({ title: "Ready to publish" }),
          }),
        }),
      })
    )
    expect(hook.confirmPrePublishReadiness).toHaveBeenCalledOnce()
    // publishPage is called by pageId only (no expectedUpdatedAt per ADR §4).
    expect(hook.publishPage).toHaveBeenCalledWith({ pageId })
    expect(hook.updatePage).not.toHaveBeenCalled()
    // Post-publish: staging cleared.
    expect(hook.result.current.hasStaging).toBe(false)
    expect(hook.result.current.hasUnsaved).toBe(false)
    // Save → router.refresh once, publish → router.refresh once.
    expect(hook.router.refresh).toHaveBeenCalledTimes(2)
  })

  it("descriptor shared-field changes flow through updateDraft (not pages.update)", async () => {
    // ADR-0041 §1 stages descriptor sharedFields. Under Deploy 2 the
    // author `name` + `socials` edits belong to `updateDraft`, not the
    // legacy `pages.update` (that stays only for hierarchy / expiresAt /
    // scheduledAt / pageType).
    const hook = renderSaveHook({
      page: makePage({ pageType: "author", name: "Original" }),
    })
    hook.rerender({
      draft: makeDraft({
        pageType: "author",
        title: "Original",
        sharedFieldValues: {
          name: "Renamed via generic panel",
          socials: [{ platform: "GitHub", url: "https://github.com/x" }],
        },
      }),
    })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))
    let saved = false
    await act(async () => {
      saved = await hook.result.current.save()
    })
    expect(saved).toBe(true)
    expect(hook.updateDraft).toHaveBeenCalledTimes(1)
    const call = hook.updateDraft.mock.calls[0][0] as Record<string, unknown>
    expect(JSON.parse(call.sharedFieldsJson as string)).toEqual({
      name: "Renamed via generic panel",
      socials: [
        {
          platform: "GitHub",
          url: "https://github.com/x",
          itemId: expect.any(String),
        },
      ],
    })
    expect(hook.updatePage).not.toHaveBeenCalled()
  })

  it("does not include unchanged shared-field values in the updateDraft call", async () => {
    const hook = renderSaveHook({
      page: makePage({ pageType: "author", name: "Ada" }),
    })
    hook.rerender({
      draft: makeDraft({
        pageType: "author",
        title: "Home changed",
        sharedFieldValues: {
          name: "Ada", // unchanged
        },
      }),
    })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))
    await act(async () => {
      await hook.result.current.save()
    })
    // Localized title changed → updateDraft fires with content ...
    const call = hook.updateDraft.mock.calls[0][0] as Record<string, unknown>
    expect(call.content).toBeDefined()
    // ... but unchanged descriptor fields must not create an envelope.
    expect(call.sharedFieldsJson).toBeUndefined()
    // No hierarchy / scheduledAt / expiresAt / pageType change → no
    // pages.update call.
    expect(hook.updatePage).not.toHaveBeenCalled()
  })

  it("hierarchy-only edit flows through pages.update WITHOUT firing updateDraft (advisor regression guard)", async () => {
    // Regression fix from PR A advisor: previously the save path
    // unconditionally sent `content` to `updateDraft`, so a save touching
    // only a live-immediate field (ADR §1) still created a byte-identical
    // staging row and lit "Unpublished changes." That nagged a publish of
    // nothing. The staged-change gate below prevents that spurious write.
    const hook = renderSaveHook()
    hook.rerender({
      draft: makeDraft({
        title: "Home",
        parentId: "page_parent" as Id<"pages">,
      }),
    })
    await waitFor(() => expect(hook.result.current.hasUnsaved).toBe(true))
    await act(async () => {
      await hook.result.current.save()
    })
    expect(hook.updateDraft).not.toHaveBeenCalled()
    expect(hook.updatePage).toHaveBeenCalledTimes(1)
    const call = hook.updatePage.mock.calls[0][0] as {
      parentId?: string
      expiresAt?: number
    }
    expect(call.parentId).toBe("page_parent")
    // FR2c row C — the editor never writes the expiry compatibility field.
    expect(call).not.toHaveProperty("expiresAt")
    // Badge must NOT light on a live-immediate-only edit.
    expect(hook.result.current.hasStaging).toBe(false)
  })

  it("discard confirms + calls discardDraft, clears hasStaging + hasUnsaved", async () => {
    const originalLocation = window.location
    const reloadMock = vi.fn()
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadMock },
    })
    try {
      const hook = renderSaveHook({
        hasStaging: true,
        stagingUpdatedAt: 200,
      })
      expect(hook.result.current.hasStaging).toBe(true)
      await act(async () => {
        await hook.result.current.discard()
      })
      expect(hook.confirmDiscard).toHaveBeenCalledWith("never-published")
      expect(hook.discardDraft).toHaveBeenCalledWith({ pageId })
      expect(hook.result.current.hasStaging).toBe(false)
      expect(hook.result.current.hasUnsaved).toBe(false)
      // Deploy 2 PR B (9c3bd87) — discard prefers a full reload in browser
      // env so client `useState` (title, slices, bags) rebuilds from server
      // props; router.refresh alone left stale UI. router.refresh is only
      // the server-side fallback.
      expect(reloadMock).toHaveBeenCalledOnce()
      expect(hook.router.refresh).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      })
    }
  })

  it("discard branches on lifecycle — a published page triggers the `published` confirm variant", async () => {
    const hook = renderSaveHook({
      page: makePage({ status: "published", publishedAt: 900 }),
      hasStaging: true,
      stagingUpdatedAt: 200,
    })
    await act(async () => {
      await hook.result.current.discard()
    })
    expect(hook.confirmDiscard).toHaveBeenCalledWith("published")
    expect(hook.discardDraft).toHaveBeenCalledWith({ pageId })
  })

  it("uses plain fallback copy when discarding fails", async () => {
    const raw = "Server Error at ../../convex/cms/publication.ts:1:1"
    const hook = renderSaveHook({
      hasStaging: true,
      discardDraft: vi.fn(async () => {
        throw new Error(raw)
      }),
    })

    await act(async () => {
      await hook.result.current.discard()
    })

    expect(toast.error).toHaveBeenCalledWith(
      "Draft changes couldn't be discarded. Try again."
    )
    expect(toast.error).not.toHaveBeenCalledWith(raw)
  })

  it.each([
    ["unpublish", "This page couldn't be unpublished. Try again."],
    ["archive", "This page couldn't be archived. Try again."],
    ["unarchive", "This page couldn't be restored. Try again."],
  ] as const)(
    "uses plain fallback copy when %s fails",
    async (action, copy) => {
      const raw = "Server Error at ../../convex/cms/pages.ts:1:1"
      const hook = renderSaveHook({
        updatePage: vi.fn(async () => {
          throw new Error(raw)
        }),
      })

      await act(async () => {
        await hook.result.current[action]()
      })

      expect(toast.error).toHaveBeenCalledWith(copy)
      expect(toast.error).not.toHaveBeenCalledWith(raw)
    }
  )

  it("discard is a no-op when there is nothing staged", async () => {
    const hook = renderSaveHook({ hasStaging: false })
    await act(async () => {
      await hook.result.current.discard()
    })
    expect(hook.confirmDiscard).not.toHaveBeenCalled()
    expect(hook.discardDraft).not.toHaveBeenCalled()
  })
})

describe("Save waits for compiled renderer qualification", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    vi.clearAllMocks()
  })
  it("serializes two Save requests while source qualification waits, before lock or persistence", async () => {
    const gate = deferred<boolean>()
    const captured = makeDraft({ title: "Qualified pending text" })
    const captureDraft = vi.fn(
      async (_draft: PageSaveDraft, isCurrent: () => boolean) =>
        (await gate.promise) && isCurrent() ? captured : null
    )
    const hook = renderSaveHook({ captureDraft })
    let saving!: Promise<boolean>
    act(() => {
      saving = hook.result.current.save()
      expect(hook.result.current.save()).toBe(saving)
    })
    expect(hook.refreshEditorLock).not.toHaveBeenCalled()
    expect(hook.updateDraft).not.toHaveBeenCalled()
    await act(async () => {
      gate.resolve(true)
      expect(await saving).toBe(true)
    })
    expect(captureDraft).toHaveBeenCalledTimes(1)
    expect(hook.updateDraft).toHaveBeenCalledTimes(1)
  })
  it.each(["manual", "locale", "refusal"])(
    "refuses stale qualification after %s without accepting a captured draft",
    async (change) => {
      const gate = deferred<boolean>()
      const hook = renderSaveHook({
        captureDraft: async (_draft, isCurrent) =>
          (await gate.promise) && isCurrent()
            ? makeDraft({ title: "Old captured text" })
            : null,
      })
      let saving!: Promise<boolean>
      act(() => {
        saving = hook.result.current.save()
      })
      if (change === "manual")
        hook.rerender({ draft: makeDraft({ title: "New manual text" }) })
      if (change === "locale")
        hook.rerender({ draft: makeDraft(), locale: "fr" })
      await act(async () => {
        gate.resolve(change !== "refusal")
        expect(await saving).toBe(false)
      })
      expect(hook.refreshEditorLock).not.toHaveBeenCalled()
      expect(hook.updateDraft).not.toHaveBeenCalled()
    }
  )
})

describe("F1 a pending capture never overwrites newer typing", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    vi.clearAllMocks()
  })
  const open = (
    capture: (
      draft: PageSaveDraft,
      isCurrent: () => boolean
    ) => Promise<PageSaveDraft | null> | PageSaveDraft | null,
    writes?: { count: number }
  ) => {
    const onPreparedDraft = vi.fn()
    const saveSnapshotDraft = vi.fn<SaveSnapshotEditorDraft>(async () => ({
      updatedAt: 101,
    }))
    const hook = renderSaveHook({
      captureDraft: capture,
      onPreparedDraft,
      saveSnapshotDraft,
      getDraftWriteCount: writes ? () => writes.count : undefined,
      initialDraft: makeDraft({ title: "Typed before Save" }),
    })
    return { hook, onPreparedDraft, saveSnapshotDraft }
  }
  const pagehide = () => act(() => window.dispatchEvent(new Event("pagehide")))

  it("(a) refuses a capture that resolves after newer typing reached draftRef, and keeps that typing and its copy", async () => {
    const gate = deferred<PageSaveDraft>()
    const { hook, onPreparedDraft, saveSnapshotDraft } = open(() => gate.promise)
    let saving!: Promise<boolean>
    act(() => {
      saving = hook.result.current.save()
    })
    hook.rerender({ draft: makeDraft({ title: "Newer typing" }) })
    await act(async () => {
      gate.resolve(makeDraft({ title: "Older captured text" }))
      expect(await saving).toBe(false)
    })
    expect(onPreparedDraft).not.toHaveBeenCalled()
    expect(saveSnapshotDraft).not.toHaveBeenCalled()
    pagehide()
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("Newer typing")
    expect(hook.result.current.hasUnsaved).toBe(true)
  })

  it("(b) refuses a capture that resolves after a synchronous commit, before React effects ran", async () => {
    const writes = { count: 0 }
    const gate = deferred<PageSaveDraft>()
    const { hook, onPreparedDraft, saveSnapshotDraft } = open(
      () => gate.promise,
      writes
    )
    let saving!: Promise<boolean>
    act(() => {
      saving = hook.result.current.save()
    })
    // The parent committed newer typing synchronously; the hook's draftRef
    // (updated in an effect) has not seen it.
    writes.count += 1
    await act(async () => {
      gate.resolve(makeDraft({ title: "Older captured text" }))
      expect(await saving).toBe(false)
    })
    expect(onPreparedDraft).not.toHaveBeenCalled()
    expect(saveSnapshotDraft).not.toHaveBeenCalled()
  })

  it("(c) saves a pending capture when nothing newer was typed", async () => {
    const writes = { count: 3 }
    const gate = deferred<PageSaveDraft>()
    const { hook, onPreparedDraft, saveSnapshotDraft } = open(
      () => gate.promise,
      writes
    )
    let saving!: Promise<boolean>
    act(() => {
      saving = hook.result.current.save()
    })
    await act(async () => {
      gate.resolve(makeDraft({ title: "Captured text" }))
      expect(await saving).toBe(true)
    })
    expect(onPreparedDraft).toHaveBeenCalledOnce()
    expect(saveSnapshotDraft).toHaveBeenCalledOnce()
  })

  it("(d) keeps the synchronous capture path working, including writes made by the capture itself", async () => {
    const writes = { count: 0 }
    const { hook, onPreparedDraft, saveSnapshotDraft } = open((draft) => {
      // An inline flush commits during the capture and counts as part of it.
      writes.count += 1
      return { ...draft, title: "Flushed text" }
    }, writes)
    await act(async () => {
      expect(await hook.result.current.save()).toBe(true)
    })
    expect(onPreparedDraft).toHaveBeenCalledOnce()
    expect(saveSnapshotDraft).toHaveBeenCalledOnce()
  })

  it("(e) accepts an asynchronous capture whose synchronous part wrote", async () => {
    const writes = { count: 0 }
    const { hook, saveSnapshotDraft } = open(async (draft) => {
      writes.count += 1
      return { ...draft, title: "Flushed then awaited" }
    }, writes)
    await act(async () => {
      expect(await hook.result.current.save()).toBe(true)
    })
    expect(saveSnapshotDraft).toHaveBeenCalledOnce()
  })
})

describe("a refused save is classified from ConvexError.data first, then the message", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    vi.clearAllMocks()
  })
  it.each([
    ["string data", new ConvexError("PAGE_LOCALE_DRAFT_STALE")],
    ["string data (shared)", new ConvexError("PAGE_SHARED_DRAFT_STALE")],
    [
      "object data with a code",
      new ConvexError({ code: "PAGE_PUBLICATION_LIFECYCLE_STALE" }),
    ],
    [
      "a message that carries the code",
      new Error("[CONVEX M(cms/publication:saveEditorDraft)] PAGE_SHARED_DRAFT_STALE"),
    ],
  ])("routes %s to the conflict flow", async (_label, error) => {
    const onSaveConflict = vi.fn(async () => undefined)
    const hook = renderSaveHook({
      saveSnapshotDraft: vi.fn(async () => {
        throw error
      }),
      onSaveConflict,
    })
    hook.rerender({ draft: makeDraft({ title: "Kept words" }) })
    await act(async () => {
      expect(await hook.result.current.save()).toBe(false)
    })
    expect(onSaveConflict).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledWith("This page changed elsewhere")
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("Kept words")
  })
  it("does not treat another application error as a conflict", async () => {
    const onSaveConflict = vi.fn(async () => undefined)
    const hook = renderSaveHook({
      saveSnapshotDraft: vi.fn(async () => {
        throw new ConvexError("SLUG_REQUIRED")
      }),
      onSaveConflict,
    })
    hook.rerender({ draft: makeDraft({ title: "Words" }) })
    await act(async () => {
      expect(await hook.result.current.save()).toBe(false)
    })
    expect(onSaveConflict).not.toHaveBeenCalled()
  })
})

describe("D2 actual-consumer adoption", () => {
  // Real editor focus needs the same Range geometry seam as preview tests.
  const rangeRects = {
    getClientRects: Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getClientRects"
    ),
    getBoundingClientRect: Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getBoundingClientRect"
    ),
  }
  beforeAll(() => {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [new DOMRect()],
    })
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    })
  })
  afterAll(() => {
    for (const [key, descriptor] of Object.entries(rangeRects)) {
      if (descriptor) Object.defineProperty(Range.prototype, key, descriptor)
      else Reflect.deleteProperty(Range.prototype, key)
    }
  })
  it.each(["en", "fr"] as const)(
    "two linked Heroes: edit/real inline flush/Save/reopen in %s adopts both and retains located reports", sliceProfile(["hero-with-image"]),
    async (locale) => {
      window.sessionStorage.clear()
      const identity = {
        subject: "consumer-owner",
        tokenIdentifier: "https://convex.test|consumer-owner",
      }
      const t = convexTest({
        schema,
        modules: import.meta.glob("../../../../convex/**/*.ts"),
        ownerIdentity: identity,
        publicationAuthority: "legacy",
      })
      const owner = t.withIdentity(identity)
      const id = await owner.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        slug: "consumer",
        content: { [locale]: { title: "Home", slices: [] } },
      })
      await owner.mutation(api.cms.pages.acquirePageEditorLock, { pageId: id })
      const source = ["first", "second"].map((sliceId) => ({
        ...createSampleSlice("hero-with-image"),
        id: sliceId,
        primary: {
          ...createSampleSlice("hero-with-image").primary,
          title: `<p><strong>Hello</strong><br><a href="/${sliceId}">World</a></p>`,
        },
      }))
      await t.run(async (ctx) => {
        const staging = await ctx.db
          .query("pageStaging")
          .withIndex("by_pageId", (q) => q.eq("pageId", id))
          .unique()
        await ctx.db.patch(staging!._id, {
          content: { [locale]: { title: "Home", slices: source } },
        })
      })
      const adopted = adoptHeroTitles([source[0]], locale)
      const first = adopted.value[0]
      let flushed = ""
      let flush: (() => void) | null = null
      const inline = render(
        <PreviewInlineEditor
          value={(first.primary as { title: string }).title}
          contract="title"
          fieldPath="primary.title"
          label="Title"
          onChange={(value) => {
            flushed = value
          }}
          onCancel={() => {}}
          onCommit={() => {}}
          onCompositionChange={() => {}}
          onFlushHandleChange={(value) => {
            flush = value
          }}
        />
      )
      await waitFor(() => expect(flush).toBeTypeOf("function"))
      const page = makePage({
        _id: id,
        pageType: "landing-page",
        content: { [locale]: { title: "Home", slices: source } },
      } as Partial<Page>)
      let preparedDraft: PageSaveDraft | undefined
      const hook = renderSaveHook({
        page,
        onPreparedDraft: (value) => {
          preparedDraft = value
        },
        updateDraft: vi.fn<UpdateDraft>((args) =>
          owner.mutation(api.cms.pages.updateDraft, args)
        ),
        captureDraft: (draft) => {
          flush!()
          return {
            ...draft,
            slices: [
              {
                ...(preparedDraft?.slices[0] ?? first),
                primary: {
                  ...first.primary,
                  title: flushed,
                  eyebrow: "Edited sibling",
                },
              },
              preparedDraft?.slices[1] ?? source[1],
            ] as typeof source,
          }
        },
      })
      hook.rerender({
        locale,
        draft: makeDraft({
          pageType: "landing-page",
          title: "Home",
          slug: "consumer",
          slices: source,
          removedTitleLinks: adopted.reports,
        }),
      })
      let saved: boolean | undefined
      await act(async () => {
        saved = await hook.result.current.save()
      })
      expect(saved).toBe(true)
      const stored = await t.run((ctx) =>
        ctx.db
          .query("pageStaging")
          .withIndex("by_pageId", (q) => q.eq("pageId", id))
          .unique()
      )
      const reopened = stored!.content![locale] as { slices: typeof source }
      const expected = JSON.stringify({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [
              { type: "text", marks: [{ type: "bold" }], text: "Hello" },
              { type: "text", text: " World" },
            ],
          },
        ],
      })
      expect(reopened.slices.map((slice) => slice.primary.title)).toEqual([
        expected,
        expected,
      ])
      expect(reopened.slices.map((slice) => slice.id)).toEqual([
        "first",
        "second",
      ])
      const expectedReports = ["first", "second"].map((sliceId) => ({
        locale,
        sliceId,
        fieldPath: "primary.title",
        removedLinks: [{ href: `/${sliceId}` }],
      }))
      expect(preparedDraft!.removedTitleLinks).toEqual(expectedReports)
      expect(hook.result.current.titleAdoptionReports.current).toEqual(
        expectedReports
      )
      expect(adoptHeroTitles(reopened.slices, locale).value).toEqual(
        reopened.slices
      )
      expect(source[1].primary.title).toContain('<a href="/second">')
      const preparedHero = preparedDraft!.slices[0]
      expect(preparedHero.type).toBe("hero-with-image")
      const firstIds =
        "items" in preparedHero
          ? preparedHero.items.map(
              (item) => (item as { itemId?: string }).itemId
            )
          : []
      expect(firstIds.length).toBeGreaterThan(0)
      expect(firstIds.every(Boolean)).toBe(true)
      hook.rerender({
        locale,
        draft: { ...preparedDraft!, title: "Another edit" },
      })
      await act(async () => {
        saved = await hook.result.current.save()
      })
      expect(saved).toBe(true)
      const secondStage = await t.run((ctx) =>
        ctx.db
          .query("pageStaging")
          .withIndex("by_pageId", (q) => q.eq("pageId", id))
          .unique()
      )
      const secondHero = (
        secondStage!.content![locale] as { slices: typeof source }
      ).slices[0]
      expect(secondHero.items.map((item) => item.itemId)).toEqual(firstIds)

      hook.unmount()
      inline.unmount()
    }
  )
})

test("D2 failed HTML adoption refuses Save before any durable write", sliceProfile([]), () => {
  window.sessionStorage.clear()
  const source = createSampleSlice("hero-with-image")
  source.primary.title = "<p><strong>Do not lose this</strong></p>"
  const before = JSON.stringify(source)
  const hook = renderSaveHook()
  hook.rerender({ draft: makeDraft({ slices: [source] }) })
  const parser = vi
    .spyOn(legacyParser, "generateRichTextDocument")
    .mockImplementationOnce(() => {
      throw new Error("conversion failed")
    })
  try {
    expect(() => hook.result.current.save()).toThrow("conversion failed")
    expect(hook.updateDraft).not.toHaveBeenCalled()
    expect(hook.updatePage).not.toHaveBeenCalled()
    expect(JSON.stringify(source)).toBe(before)
  } finally {
    parser.mockRestore()
    hook.unmount()
  }
})

// Forwarding proof uses canonical values: an adopting reader cannot recreate
// these attached diagnostics. Inspect raw storage before readRecoveryDraft.
test.each(["lifecycle flush", "pending scope"] as const)(
  "canonical recovery capture recipient: %s", sliceProfile([]),
  (boundary) => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    vi.useFakeTimers()
    const slices = ["first", "second"].map((id) => ({
      ...createSampleSlice("hero-with-image"),
      id,
    }))
    const reports = slices.map((slice) => ({
      locale: "en",
      sliceId: slice.id,
      fieldPath: "primary.title",
      removedLinks: [{ href: `/${slice.id}-capture` }],
    }))
    const capture = vi.fn((draft: PageSaveDraft) => ({
      ...draft,
      removedTitleLinks: reports,
    }))
    const hook = renderSaveHook({ recoveryDraftForFlush: capture })
    try {
      hook.rerender({
        draft: makeDraft({ title: "Captured", slices }),
        locale: "en",
      })
      if (boundary === "lifecycle flush") {
        act(() => window.dispatchEvent(new Event("pagehide")))
      } else {
        // The second invocation prepares the pending old-scope buffer. A
        // later lifecycle capture of the new locale cannot repair that buffer.
        hook.rerender({ draft: makeDraft({ title: "French" }), locale: "fr" })
      }
      const raw = JSON.parse(
        window.sessionStorage.getItem(recoveryKey(pageId, "en"))!
      )
      expect(raw.slices).toEqual(slices)
      expect(raw.removedTitleLinks).toEqual(reports)
      expect(capture).toHaveBeenCalled()
      expect(hook.updateDraft).not.toHaveBeenCalled()
    } finally {
      hook.unmount()
      vi.useRealTimers()
    }
  }
)

it.each([false, true])(
  "captured editor scope expires permanently on switch and unmount (StrictMode=%s)",
  (strictMode) => {
    const hook = renderSaveHook({ strictMode })
    const original = hook.result.current.captureEditorScope()
    expect(original()).toBe(true)
    hook.rerender({ draft: makeDraft({ title: "Typing" }) })
    expect(original()).toBe(true)
    hook.rerender({ draft: makeDraft(), locale: "fr" })
    expect(original()).toBe(false)
    const french = hook.result.current.captureEditorScope()
    expect(french()).toBe(true)
    hook.rerender({ draft: makeDraft(), locale: "en" })
    expect(original()).toBe(false)
    expect(french()).toBe(false)
    const returned = hook.result.current.captureEditorScope()
    expect(returned()).toBe(true)
    hook.rerender({
      draft: makeDraft(),
      currentPage: makePage({ _id: "page_2" as Id<"pages"> }),
    })
    expect(returned()).toBe(false)
    hook.rerender({ draft: makeDraft() })
    expect(returned()).toBe(false)
    const beforeUnmount = hook.result.current.captureEditorScope()
    expect(beforeUnmount()).toBe(true)
    hook.unmount()
    expect(beforeUnmount()).toBe(false)
  }
)

it.each(
  [false, true].flatMap((snapshot) =>
    [undefined, 200].map((stagingUpdatedAt) => ({ snapshot, stagingUpdatedAt }))
  )
)(
  "retained History base conflicts without advancing it (snapshot=$snapshot, staging=$stagingUpdatedAt)",
  async ({ snapshot, stagingUpdatedAt }) => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.clearAllMocks()
    const original = renderSaveHook({ stagingUpdatedAt })
    const base = original.result.current.captureSaveBase("en")
    expect(base).toMatchObject({
      locale: "en",
      stagingUpdatedAt,
      pageUpdatedAt: 100,
    })
    original.unmount()
    writeRecoveryDraft(pageId, { base: null, ...{
      ...makeDraft({ title: "Newer unsaved English" }),
      locale: "en",
      savedAt: Date.now(),
    } })
    const hook = renderSaveHook({
      retainedSaveBase: base,
      page: makePage({
        updatedAt: 500,
        content: { en: { title: "Restored", slices: [] } },
      }),
      initialDraft: makeDraft({ title: "Newer unsaved English" }),
      hasStaging: true,
      stagingUpdatedAt: 500,
      saveSnapshotDraft: snapshot
        ? vi.fn(async () => ({ updatedAt: 501 }))
        : undefined,
    })
    expect(hook.result.current.hasUnsaved).toBe(true)
    expect(hook.result.current.recoveryDraft).toBeNull()
    expect(hook.result.current.captureSaveBase("en")).toEqual(base)
    await act(async () => {
      expect(await hook.result.current.save()).toBe(false)
    })
    expect(hook.onSaveConflict).toHaveBeenCalledOnce()
    expect(hook.updateDraft).not.toHaveBeenCalled()
    if (hook.saveSnapshotDraft)
      expect(hook.saveSnapshotDraft).not.toHaveBeenCalled()
    expect(hook.result.current.captureSaveBase("en")).toEqual(base)
    expect(hook.result.current.hasUnsaved).toBe(true)
    expect(hook.result.current.recoveryDraft).toBeNull()
    expect(readRecoveryDraft(pageId, "en")?.title).toBe("Newer unsaved English")
    // The retained conflict belongs only to EN. FR still uses the refreshed base.
    hook.rerender({
      draft: makeDraft({ title: "French edits", slug: "french-edits" }),
      locale: "fr",
    })
    await act(async () => {
      expect(await hook.result.current.save()).toBe(true)
    })
    expect(hook.onSaveConflict).toHaveBeenCalledOnce()
    if (!snapshot)
      expect(hook.updateDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedUpdatedAt: 500 })
      )
    hook.rerender({
      draft: makeDraft({ title: "Newer unsaved English" }),
      locale: "en",
    })
    expect(hook.result.current.captureSaveBase("en")).toEqual(base)
    expect(hook.result.current.hasUnsaved).toBe(true)
    hook.unmount()
  }
)

it.each(
  [false, true].flatMap((snapshot) =>
    [undefined, 200].map((stagingUpdatedAt) => ({ snapshot, stagingUpdatedAt }))
  )
)(
  "round4 retained shared baseline keeps old tokens across locales (snapshot=$snapshot, staging=$stagingUpdatedAt)",
  async ({ snapshot, stagingUpdatedAt }) => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.clearAllMocks()
    const original = renderSaveHook({ stagingUpdatedAt })
    const base = original.result.current.captureSaveBase("en")
    expect(original.result.current.captureSharedDraft(base)).toBeUndefined()
    const dirty = makeDraft({ seoOgTitle: "Newer social" })
    original.rerender({ draft: dirty })
    const retained = original.result.current.captureSharedDraft(base)!
    expect(retained.values.seoOgTitle).toBe("Newer social")
    expect(retained.baseline.seoOgTitle).toBe("")
    original.unmount()
    writeRecoveryDraft(pageId, { base: null, ...{ ...dirty, locale: "en", savedAt: Date.now() } })
    const hook = renderSaveHook({
      retainedSharedDraft: retained,
      page: makePage({ updatedAt: 500, seo: { ogTitle: "Restored social" } }),
      initialDraft: dirty,
      hasStaging: true,
      stagingUpdatedAt: 500,
      saveSnapshotDraft: snapshot
        ? vi.fn(async () => ({ updatedAt: 501 }))
        : undefined,
      strictMode: true,
    })
    for (const locale of ["en", "fr", "en"] as const) {
      hook.rerender({
        draft: dirty,
        locale,
        currentPage: makePage({
          updatedAt: 600,
          seo: { ogTitle: "Restored social" },
        }),
      })
      expect(hook.result.current.captureSaveBase(locale)).toMatchObject({
        pageUpdatedAt: 100,
        stagingUpdatedAt,
      })
      expect(hook.result.current.captureSharedDraft(base)?.baseline).toEqual(
        retained.baseline
      )
      expect(hook.result.current.hasUnsaved).toBe(true)
      expect(hook.result.current.recoveryDraft).toBeNull()
      await act(async () => {
        expect(await hook.result.current.save()).toBe(false)
      })
    }
    expect(hook.onSaveConflict).toHaveBeenCalledTimes(3)
    expect(hook.updateDraft).not.toHaveBeenCalled()
    if (hook.saveSnapshotDraft)
      expect(hook.saveSnapshotDraft).not.toHaveBeenCalled()
    hook.unmount()
  }
)
