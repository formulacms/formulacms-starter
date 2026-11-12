import {
  fireEvent,
  render as renderWithProvider,
  screen,
  waitFor,
} from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { NextIntlClientProvider } from "next-intl"
import { toast } from "sonner"
import fr from "@/messages/admin/fr.json"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

import type { Id } from "@/convex/_generated/dataModel"
import type { Page, PrePublishChecklist } from "./page-editor/lib/types"

// F09b: during a content replacement the owner writes the new-language version
// of a page in the editor. Saves go through the target-draft commands; nothing
// that publishes, schedules or previews the new language is offered.

const mocks = vi.hoisted(() => ({
  commandIds: [] as string[],
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
      return { defaultLocale: "en", enabledLocales: ["en"], timezone: "UTC" }
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

import { PageEditor } from "./page-editor"

const pageId = "page-1" as Id<"pages">
const NOTICE = {
  sourceLocale: "en",
  targetLocale: "fr",
  sharedChangedSinceSourcePublication: false,
}

function page(
  content: Page["content"],
  status: Page["status"] = "published",
  pageType: Page["pageType"] = "page"
): Page {
  return {
    _id: pageId,
    _creationTime: 1,
    slug: "about",
    localizedSlugs: {},
    pageType,
    status,
    createdAt: 100,
    updatedAt: 100,
    content,
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

function renderTargetEditor(pageType: Page["pageType"] = "page") {
  return render(
    <PageEditor
      page={page(
        { en: { title: "About", slices: [] } } as Page["content"],
        "published",
        pageType
      )}
      hasStaging={false}
      stagingUpdatedAt={undefined}
      publication={publication()}
      targetDraftLocale="fr"
    />
  )
}

describe("PageEditor new-language version during a replacement", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutations.clear()
    mocks.queries.length = 0
    mocks.commandIds = []
    mocks.languageNotice = NOTICE
    mocks.retainedTargetRemedy = null
    mocks.freshChecklist = { canPublish: true, blockers: [], warnings: [] }
    mocks.convex.query.mockImplementation(async (reference?: unknown) => {
      return getFunctionName(reference as never) ===
        "cms/pages:getPrePublishChecklist"
        ? mocks.freshChecklist
        : []
    })
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  // Tags are a shared field only blog posts declare.
  function stageTargetAndShared() {
    renderTargetEditor("post")
    const title = screen.getByLabelText("Page title")
    fireEvent.change(title, { target: { value: "À propos" } })
    fireEvent.click(screen.getByTitle("Settings"))
    const tags = screen.getByLabelText("Synthetic shared tags")
    fireEvent.change(tags, { target: { value: "synthetic-topic" } })
    return { title, tags }
  }

  function expectTargetWritesOnly() {
    expect(mutation("cms/publication:saveEditorDraft")).not.toHaveBeenCalled()
    expect(mutation("cms/pages:updateDraft")).not.toHaveBeenCalled()
    expect(mutation("cms/publication:publishLocale")).not.toHaveBeenCalled()
  }

  test("new: shared-half failure retains pending work and retry advances only the committed locale generation", async () => {
    const localeSave = mutation("cms/publication:saveLocaleDraft")
    localeSave
      .mockResolvedValueOnce({ generation: 7, updatedAt: 107 })
      .mockResolvedValueOnce({ generation: 8, updatedAt: 108 })
    const sharedSave = mutation("cms/publication:saveSharedDraft")
    sharedSave
      .mockRejectedValueOnce(new Error("Synthetic shared write failure"))
      .mockResolvedValueOnce({ generation: 5, updatedAt: 109 })
    const { title, tags } = stageTargetAndShared()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
    expect(toast.success).not.toHaveBeenCalled()
    expect(title).toHaveValue("À propos")
    expect(tags).toHaveValue("synthetic-topic")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    )
    expect(localeSave.mock.calls[0]![0]).toMatchObject({
      locale: "fr",
      expectedDraftGeneration: 0,
      expectedLifecycleGeneration: 3,
    })
    expect(sharedSave.mock.calls[0]![0]).toMatchObject({
      tags: ["synthetic-topic"],
      expectedSharedDraftGeneration: 4,
      expectedLifecycleGeneration: 3,
    })

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledOnce())
    expect(localeSave).toHaveBeenCalledTimes(2)
    expect(sharedSave).toHaveBeenCalledTimes(2)
    expect(localeSave.mock.calls[1]![0]).toMatchObject({
      locale: "fr",
      expectedDraftGeneration: 7,
      draft: { localized: { title: "À propos" } },
    })
    expect(sharedSave.mock.calls[1]![0]).toMatchObject({
      tags: ["synthetic-topic"],
      expectedSharedDraftGeneration: 4,
    })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    )
    expectTargetWritesOnly()
  })

  test("new: locale-half failure never starts shared persistence and retry retains both original generations", async () => {
    const localeSave = mutation("cms/publication:saveLocaleDraft")
    localeSave
      .mockRejectedValueOnce(new Error("Synthetic locale write failure"))
      .mockResolvedValueOnce({ generation: 1, updatedAt: 101 })
    const sharedSave = mutation("cms/publication:saveSharedDraft")
    sharedSave.mockResolvedValueOnce({ generation: 5, updatedAt: 102 })
    const { title, tags } = stageTargetAndShared()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
    expect(sharedSave).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(title).toHaveValue("À propos")
    expect(tags).toHaveValue("synthetic-topic")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    )

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledOnce())
    expect(localeSave).toHaveBeenCalledTimes(2)
    expect(sharedSave).toHaveBeenCalledOnce()
    for (const [args] of localeSave.mock.calls)
      expect(args).toMatchObject({ locale: "fr", expectedDraftGeneration: 0 })
    expect(sharedSave.mock.calls[0]![0]).toMatchObject({
      tags: ["synthetic-topic"],
      expectedSharedDraftGeneration: 4,
    })
    expectTargetWritesOnly()
  })

  test("new: manual changes during a pending shared half survive failure and are sent by retry", async () => {
    const localeSave = mutation("cms/publication:saveLocaleDraft")
    localeSave
      .mockResolvedValueOnce({ generation: 7, updatedAt: 107 })
      .mockResolvedValueOnce({ generation: 8, updatedAt: 108 })
    let rejectShared!: (reason: Error) => void
    const pendingShared = new Promise<{
      generation: number
      updatedAt: number
    }>((_, reject) => {
      rejectShared = reject
    })
    const sharedSave = mutation("cms/publication:saveSharedDraft")
    sharedSave
      .mockReturnValueOnce(pendingShared)
      .mockResolvedValueOnce({ generation: 5, updatedAt: 109 })
    const { title, tags } = stageTargetAndShared()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(sharedSave).toHaveBeenCalledOnce())
    expect(title).toBeEnabled()
    expect(tags).toBeEnabled()
    fireEvent.change(title, { target: { value: "Une saisie plus récente" } })
    fireEvent.change(tags, { target: { value: "newer-topic" } })
    rejectShared(new Error("Synthetic delayed shared write failure"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
    expect(toast.success).not.toHaveBeenCalled()
    expect(title).toHaveValue("Une saisie plus récente")
    expect(tags).toHaveValue("newer-topic")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    )

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledOnce())
    expect(localeSave.mock.calls[1]![0]).toMatchObject({
      locale: "fr",
      expectedDraftGeneration: 7,
      draft: { localized: { title: "Une saisie plus récente" } },
    })
    expect(sharedSave.mock.calls[1]![0]).toMatchObject({
      tags: ["newer-topic"],
      expectedSharedDraftGeneration: 4,
    })
    expectTargetWritesOnly()
  })

  test("saves the new-language text through the target draft command, never the current-language one", async () => {
    renderTargetEditor()

    // The French version starts empty: it is not the English text.
    const title = screen.getByLabelText("Page title")
    expect(title).toHaveValue("")
    fireEvent.change(title, { target: { value: "À propos" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mutation("cms/publication:saveLocaleDraft")).toHaveBeenCalledOnce()
    })
    expect(mutation("cms/publication:saveLocaleDraft")).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId,
        locale: "fr",
        expectedDraftGeneration: 0,
        expectedLifecycleGeneration: 3,
        slug: "a-propos",
        draft: expect.objectContaining({
          pageType: "page",
          localized: expect.objectContaining({ title: "À propos" }),
        }),
      })
    )
    expect(mutation("cms/publication:saveEditorDraft")).not.toHaveBeenCalled()
    expect(mutation("cms/publication:publishLocale")).not.toHaveBeenCalled()

    // A second save carries the generation the first one returned.
    fireEvent.change(title, { target: { value: "À propos de nous" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => {
      expect(mutation("cms/publication:saveLocaleDraft")).toHaveBeenCalledTimes(
        2
      )
    })
    expect(
      mutation("cms/publication:saveLocaleDraft").mock.calls[1]![0]
    ).toMatchObject({ locale: "fr", expectedDraftGeneration: 1 })
  })

  test("reopens a copied new-language draft and saves on top of its generation", async () => {
    const withCopy = publication()
    withCopy.locales.push({
      locale: "fr",
      draftGeneration: 1,
      publicGeneration: 0,
      releaseGeneration: 0,
    })
    render(
      <PageEditor
        page={{
          ...page({
            en: { title: "About", slices: [] },
            fr: { title: "About (copied)", slices: [] },
          } as Page["content"]),
          localizedSlugs: { fr: "about-fr" },
        }}
        hasStaging
        stagingUpdatedAt={undefined}
        publication={withCopy}
        targetDraftLocale="fr"
      />
    )

    const title = screen.getByLabelText("Page title")
    expect(title).toHaveValue("About (copied)")
    fireEvent.change(title, { target: { value: "À propos" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mutation("cms/publication:saveLocaleDraft")).toHaveBeenCalledOnce()
    })
    const call = mutation("cms/publication:saveLocaleDraft").mock.calls[0]![0]
    expect(call).toMatchObject({ locale: "fr", expectedDraftGeneration: 1 })
    expect(call.slug).toBeTruthy()
    expect(mutation("cms/publication:saveEditorDraft")).not.toHaveBeenCalled()
  })

  test("offers no publish, schedule, preview or language tabs, and says the version is private", () => {
    renderTargetEditor()

    for (const name of ["Publish", "Publish changes", "Preview", "Unpublish"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument()
    }
    expect(
      screen.queryByRole("button", { name: "More page actions" })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "EN" })).not.toBeInTheDocument()
    expect(
      screen.queryByTitle("Copy content between locales")
    ).not.toBeInTheDocument()
    expect(screen.getByText("Français version · private")).toBeInTheDocument()
    expect(
      screen.getByText(/It stays private until your site switches to Français/)
    ).toBeInTheDocument()
    expect(screen.getByText(/same in every language/)).toBeInTheDocument()

    expect(mocks.commandIds).toContain("page-editor:save")
    for (const id of [
      "page-editor:publish",
      "page-editor:schedule-publish",
      "page-editor:preview",
    ]) {
      expect(mocks.commandIds).not.toContain(id)
    }
    // The checklist refuses a language that is not switched on, so it is not asked.
    expect(
      mocks.queries.filter(
        (query) =>
          query.name === "cms/pages:getPrePublishChecklist" &&
          query.args !== "skip"
      )
    ).toEqual([])

    fireEvent.click(
      screen.getByRole("button", { name: "Back to the language change" })
    )
    expect(mocks.push).toHaveBeenCalledWith("/admin/settings/languages")
  })

  test("ordinary editing never opens on the new-language draft and keeps the shared-field notice", async () => {
    render(
      <PageEditor
        page={page({
          fr: { title: "À propos", slices: [] },
          en: { title: "About", slices: [] },
        } as Page["content"])}
        hasStaging={false}
        stagingUpdatedAt={undefined}
        publication={publication()}
        replacementTargetLocale="fr"
      />
    )

    expect(screen.getByLabelText("Page title")).toHaveValue("About")
    expect(
      screen.getByText("Your site is changing to Français.")
    ).toBeInTheDocument()
    expect(screen.getByText(/same in every language/)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Publish changes" })
    ).toBeInTheDocument()
  })

  test("after cancellation the ordinary Page editor exposes the exact retained-target deletion", async () => {
    mocks.languageNotice = null
    mocks.retainedTargetRemedy = {
      transitionId: "transition1",
      pageId,
      locale: "fr",
      draftGeneration: 5,
      lifecycleGeneration: 3,
    }
    const withTarget = publication()
    withTarget.locales.push({
      locale: "fr",
      draftGeneration: 5,
      publicGeneration: 0,
      releaseGeneration: 0,
    })

    render(
      <PageEditor
        page={page({
          en: { title: "About", slices: [] },
          fr: { title: "Brouillon conserve", slices: [] },
        } as Page["content"])}
        hasStaging
        stagingUpdatedAt={undefined}
        publication={withTarget}
      />
    )

    expect(
      screen.getByText("Français Working Draft blocks a language change")
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Français Working Draft" })
    )

    await waitFor(() => {
      expect(
        mutation("cms/language:deleteRetainedTargetDraft")
      ).toHaveBeenCalledWith({
        transitionId: "transition1",
        pageId,
        locale: "fr",
        draftGeneration: 5,
        lifecycleGeneration: 3,
      })
    })
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: "Delete the Français Working Draft?",
      description:
        "Only this private Français Working Draft will be deleted. Published versions of this Page will not change. This cannot be undone.",
      confirmText: "Delete Français Working Draft",
      cancelText: "Keep draft",
      destructive: true,
    })
  })
})

// Exercise the live editor → usePageSave → fresh readiness query → confirmation
// path. The subscribed checklist is empty, so it cannot supply these warnings.
function renderSourceEditorInFrench() {
  return renderWithProvider(
    <NextIntlClientProvider locale="es" messages={fr}>
      <PageEditor
        page={page({ en: { title: "About", slices: [] } } as Page["content"])}
        hasStaging
        stagingUpdatedAt={undefined}
        publication={publication()}
        replacementTargetLocale="fr"
      />
    </NextIntlClientProvider>
  )
}

function renderSourceEditorWithStatus(status: Page["status"] = "published") {
  return renderWithProvider(
    <NextIntlClientProvider locale="en" messages={fr}>
      <PageEditor
        page={page(
          { en: { title: "About", slices: [] } } as Page["content"],
          status
        )}
        hasStaging
        stagingUpdatedAt={undefined}
        publication={publication()}
        replacementTargetLocale="fr"
      />
    </NextIntlClientProvider>
  )
}

function freshWarnings(warnings: PrePublishChecklist["warnings"]) {
  mocks.freshChecklist = { canPublish: true, blockers: [], warnings }
}

const SEO_WARNING = {
  code: "missing_seo_title",
  severity: "warning",
  message: "SERVER ENGLISH SEO",
  locales: ["en"],
} as const

describe("PageEditor effective-dictionary publish and language notices", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutations.clear()
    mocks.languageNotice = NOTICE
    mocks.retainedTargetRemedy = null
    mocks.freshChecklist = { canPublish: true, blockers: [], warnings: [] }
    mocks.subscriptionChecklistResult = mocks.freshChecklist
    mocks.publishCommand = null
    mocks.convex.query.mockImplementation(async (reference?: unknown) =>
      getFunctionName(reference as never) === "cms/pages:getPrePublishChecklist"
        ? mocks.freshChecklist
        : []
    )
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  test("checklist failure blocks republish while keeping the editor usable", () => {
    mocks.subscriptionChecklistResult = new Error("checklist unavailable")
    renderSourceEditorWithStatus("published")

    const publishButton = screen.getByRole("button", {
      name: "Publier les modifications",
    })
    expect(publishButton).toBeDisabled()
    expect(publishButton).toHaveAttribute(
      "title",
      "Vous pourrez publier une fois la page vérifiée. Sélectionnez Réessayer."
    )
    const titleInput = screen.getByLabelText("Titre de la page")
    expect(titleInput).toBeEnabled()
    fireEvent.change(titleInput, { target: { value: "About revised" } })
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeEnabled()
    expect(
      mocks.convex.query.mock.calls.filter(
        ([reference]) =>
          getFunctionName(reference as never) ===
          "cms/pages:getPrePublishChecklist"
      )
    ).toHaveLength(0)

    // A published page's command palette action is Unpublish, so it remains
    // available when the publish readiness query fails.
    expect(mocks.publishCommand).toMatchObject({ disabled: false })
  })

  test("pending checklist keeps draft publish controls disabled and reports the command reason", () => {
    mocks.subscriptionChecklistResult = undefined
    renderSourceEditorWithStatus("draft")

    expect(screen.getByRole("button", { name: /^Publier$/ })).toBeDisabled()
    expect(mocks.publishCommand).toMatchObject({
      disabled: true,
      disabledReason: "Vérification du brouillon enregistré…",
    })
  })

  test("retry keeps draft publishing blocked while pending and restores eligibility after success", async () => {
    mocks.subscriptionChecklistResult = new Error("checklist unavailable")
    renderSourceEditorWithStatus("draft")

    const publishButton = screen.getByRole("button", {
      name: /^Publier$/,
    })
    expect(publishButton).toBeDisabled()
    const initialSubscriptionCount = mocks.queries.length

    mocks.subscriptionChecklistResult = undefined
    fireEvent.click(
      screen.getByRole("button", {
        name: "Préparation de la page: Indisponible",
      })
    )
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }))

    await waitFor(() =>
      expect(mocks.queries.length).toBeGreaterThan(initialSubscriptionCount)
    )
    expect(publishButton).toBeDisabled()
    expect(mocks.publishCommand).toMatchObject({ disabled: true })

    mocks.subscriptionChecklistResult = {
      canPublish: true,
      blockers: [],
      warnings: [],
    }
    fireEvent.change(screen.getByLabelText("Titre de la page"), {
      target: { value: "About us" },
    })
    await waitFor(() => expect(publishButton).toBeEnabled())
    expect(mocks.publishCommand).toMatchObject({ disabled: false })
  })

  test("fresh warnings use effective French copy and labels after saving; acknowledgement follows existing keys", async () => {
    freshWarnings([
      { ...SEO_WARNING, locales: ["en"] },
      {
        code: "missing_required_field",
        severity: "warning",
        message: "SERVER ENGLISH FIELD",
        params: { contentType: "author", fieldName: "name.first" },
      },
      {
        code: "broken_internal_link",
        severity: "warning",
        message: "SERVER ENGLISH RELATION",
        params: {
          variant: "disallowed_type",
          contentType: "post",
          targetTitle: "Équipe",
        },
      },
      {
        code: "future_warning",
        severity: "warning",
        message: "Future compatibility message",
      },
    ])
    const original = JSON.stringify(mocks.freshChecklist)
    renderSourceEditorInFrench()
    fireEvent.change(screen.getByLabelText("Titre de la page"), {
      target: { value: "About us" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Publier les modifications" })
    )
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce())
    expect(mutation("cms/publication:saveEditorDraft")).toHaveBeenCalledOnce()
    const freshQueryIndex = mocks.convex.query.mock.calls.findIndex(
      ([reference]) =>
        getFunctionName(reference as never) ===
        "cms/pages:getPrePublishChecklist"
    )
    expect(freshQueryIndex).toBeGreaterThanOrEqual(0)
    expect(
      mutation("cms/publication:saveEditorDraft").mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.convex.query.mock.invocationCallOrder[freshQueryIndex]!
    )
    expect(mocks.convex.query.mock.calls[freshQueryIndex]).toEqual([
      expect.anything(),
      { pageId, locale: "en" },
    ])
    expect(mocks.confirm.mock.calls[0]![0]).toMatchObject({
      title: "Publier malgré les avertissements ?",
      description: [
        "Ajoutez un titre pour les moteurs de recherche en EN avant de publier.",
        "Auteur : le champ obligatoire Nom.first est vide.",
        "Ce contenu (Article) renvoie à « Équipe », dont le type de contenu n’est pas autorisé ici. Choisissez une autre page.",
        "Future compatibility message",
      ].join("\n"),
      confirmText: "Publier quand même",
      cancelText: "Vérifier d’abord",
    })
    await waitFor(() =>
      expect(mutation("cms/publication:publishLocale")).toHaveBeenCalledOnce()
    )
    expect(JSON.stringify(mocks.freshChecklist)).toBe(original)

    // Message text is deliberately absent from checklistItemsKey: keep that
    // existing acknowledgement contract while presenting localized messages.
    mocks.freshChecklist.warnings[0]!.message = "CHANGED SERVER BYTES"
    fireEvent.change(screen.getByLabelText("Titre de la page"), {
      target: { value: "About us again" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Publier les modifications" })
    )
    await waitFor(() =>
      expect(mutation("cms/publication:publishLocale")).toHaveBeenCalledTimes(2)
    )
    expect(mocks.confirm).toHaveBeenCalledOnce()

    freshWarnings([
      {
        code: "missing_seo_description",
        severity: "warning",
        message: "NEW SERVER ENGLISH",
        locales: ["en"],
      },
    ])
    fireEvent.change(screen.getByLabelText("Titre de la page"), {
      target: { value: "About us later" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Publier les modifications" })
    )
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2))
    expect(mocks.confirm.mock.calls[1]![0]).toMatchObject({
      description:
        "Ajoutez une description pour les moteurs de recherche en EN avant de publier.",
    })
  })

  test("declined warnings are asked again and a changed warning locale requires acknowledgement", async () => {
    freshWarnings([{ ...SEO_WARNING, locales: ["en"] }])
    mocks.confirm.mockResolvedValueOnce(false)
    renderSourceEditorInFrench()
    fireEvent.click(
      screen.getByRole("button", { name: "Publier les modifications" })
    )
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce())
    expect(mutation("cms/publication:publishLocale")).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", { name: "Publier les modifications" })
    )
    await waitFor(() =>
      expect(mutation("cms/publication:publishLocale")).toHaveBeenCalledOnce()
    )
    expect(mocks.confirm).toHaveBeenCalledTimes(2)

    freshWarnings([{ ...SEO_WARNING, locales: ["fr"] }])
    fireEvent.change(screen.getByLabelText("Titre de la page"), {
      target: { value: "About us" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Publier les modifications" })
    )
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(3))
    expect(mocks.confirm.mock.calls[2]![0]).toMatchObject({
      description:
        "Ajoutez un titre pour les moteurs de recherche en FR avant de publier.",
    })
  })

  test("changed-source confirmation precedes checklist warnings and is required again for the next publication", async () => {
    mocks.languageNotice = {
      ...NOTICE,
      sharedChangedSinceSourcePublication: true,
    }
    freshWarnings([{ ...SEO_WARNING, locales: ["en"] }])
    renderSourceEditorInFrench()
    fireEvent.click(
      screen.getByRole("button", { name: "Publier les modifications" })
    )
    await waitFor(() =>
      expect(mutation("cms/publication:publishLocale")).toHaveBeenCalledOnce()
    )
    expect(mocks.confirm.mock.calls.map(([options]) => options.title)).toEqual([
      "Publier pendant le changement de langue de votre site ?",
      "Publier malgré les avertissements ?",
    ])
    fireEvent.change(screen.getByLabelText("Titre de la page"), {
      target: { value: "About us" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Publier les modifications" })
    )
    await waitFor(() =>
      expect(mutation("cms/publication:publishLocale")).toHaveBeenCalledTimes(2)
    )
    expect(mocks.confirm).toHaveBeenCalledTimes(3)
    expect(mocks.confirm.mock.calls[2]![0].title).toBe(
      "Publier pendant le changement de langue de votre site ?"
    )
  })

  test("source replacement notice renders effective French and retains locale endonyms", () => {
    renderSourceEditorInFrench()
    expect(
      screen.getByText("Votre site passe au Français.")
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        /Les paramètres de recherche, le texte des cartes et les autres champs partagés/
      )
    ).toHaveTextContent(
      "Les paramètres de recherche, le texte des cartes et les autres champs partagés sont identiques dans toutes les langues. Tout texte saisi dans ces champs sera donc aussi publié en English lors de la prochaine publication de cette page."
    )
    expect(screen.queryByText(/Your site is changing/)).not.toBeInTheDocument()
  })

  test("target replacement notice renders French privacy and reconfirmation without publication controls", () => {
    render(
      <PageEditor
        page={page({ en: { title: "About", slices: [] } } as Page["content"])}
        hasStaging={false}
        stagingUpdatedAt={undefined}
        publication={publication()}
        targetDraftLocale="fr"
      />,
      { locale: "fr" }
    )
    expect(
      screen.getByText(
        "Vous rédigez la version en Français de cette page. Elle reste privée jusqu’au passage de votre site au Français."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Après l’enregistrement, confirmez à nouveau le texte sur la page du changement de langue."
      )
    ).toBeInTheDocument()
    expect(screen.getByText(/Les paramètres de recherche/)).toHaveTextContent(
      "en English"
    )
    expect(
      screen.queryByRole("button", { name: /Publier/ })
    ).not.toBeInTheDocument()
  })

  test("row 39 uses French confirmation before publishing changed shared fields; declining stops publication", async () => {
    mocks.languageNotice = {
      ...NOTICE,
      sharedChangedSinceSourcePublication: true,
    }
    mocks.confirm.mockResolvedValueOnce(false)
    renderSourceEditorInFrench()
    fireEvent.click(
      screen.getByRole("button", { name: "Publier les modifications" })
    )
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce())
    expect(mocks.confirm.mock.calls[0]![0]).toEqual({
      title: "Publier pendant le changement de langue de votre site ?",
      description:
        "Les paramètres de recherche, le texte des cartes et les autres champs partagés ont changé depuis la dernière publication de cette page. Ils sont identiques dans toutes les langues : tout texte en Français saisi dans ces champs sera donc publié immédiatement en English.",
      confirmText: "Publier quand même",
      cancelText: "Vérifier d’abord",
    })
    expect(mutation("cms/publication:publishLocale")).not.toHaveBeenCalled()
  })

  test.each([null, undefined, NOTICE])(
    "row 39 skips confirmation when no changed shared draft exists (%j)",
    async (notice) => {
      mocks.languageNotice = notice
      renderSourceEditorInFrench()
      fireEvent.click(
        screen.getByRole("button", { name: "Publier les modifications" })
      )
      await waitFor(() =>
        expect(mutation("cms/publication:publishLocale")).toHaveBeenCalledOnce()
      )
      expect(mocks.confirm).not.toHaveBeenCalled()
      if (!notice)
        expect(
          screen.queryByText(/Les paramètres de recherche/)
        ).not.toBeInTheDocument()
    }
  )
})
