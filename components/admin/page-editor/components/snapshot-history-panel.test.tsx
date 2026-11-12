import { fireEvent, screen, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { getFunctionName } from "convex/server"
import { beforeEach, expect, test, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import { SnapshotHistoryPanelSlot } from "./snapshot-history-panel"

const mocks = vi.hoisted(() => ({
  queries: [] as Array<{ name: string; args: unknown }>,
  restore: vi.fn(),
  confirm: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  unavailablePaths: [] as string[],
  publishedAt: Date.UTC(2026, 9, 8, 14, 23, 45),
}))
vi.mock("convex/react", () => ({
  useQuery: (reference: unknown, args: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/settings:getSiteConfig") return { defaultLocale: "en" }
    mocks.queries.push({ name, args })
    expect(name).toBe("cms/publication:listSnapshotHistory")
    return [
      {
        snapshotId: "snapshot-1",
        generation: 2,
        publishedAt: mocks.publishedAt,
        payloadJson: "{}",
        unavailablePaths: mocks.unavailablePaths,
      },
    ]
  },
  useMutation: (reference: unknown) => {
    expect(getFunctionName(reference as never)).toBe(
      "cms/publication:restoreSnapshotAsDraft"
    )
    return mocks.restore
  },
}))
vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
}))
vi.mock("sonner", () => ({
  toast: { error: mocks.error, success: mocks.success },
}))
const expectations = {
  expectedDraftGeneration: 3,
  expectedSharedDraftGeneration: 4,
  expectedLifecycleGeneration: 1,
  expectedPublicGeneration: 2,
  expectedReleaseGeneration: 2,
}
const state = { locale: "fr", ...expectations }
const pageId = "page-1" as Id<"pages">
beforeEach(() => {
  vi.clearAllMocks()
  mocks.queries.length = 0
  mocks.unavailablePaths = []
  mocks.confirm.mockResolvedValue(true)
  mocks.restore.mockResolvedValue({
    locale: "fr",
    draftGeneration: 4,
    sharedDraftGeneration: 5,
    updatedAt: 321,
    removedTitleLinks: [],
  })
})
test("snapshot-active History calls the authoritative locale path and discloses shared/public effects", async () => {
  const reports = ["first", "second"].map((sliceId) => ({
    locale: "fr",
    sliceId,
    fieldPath: "primary.title",
    removedLinks: [{ href: `/${sliceId}-snapshot` }],
  }))
  mocks.restore.mockResolvedValue({
    locale: "fr",
    draftGeneration: 4,
    sharedDraftGeneration: 5,
    updatedAt: 321,
    removedTitleLinks: reports,
  })
  const onRestored = vi.fn(),
    onSnapshotRestored = vi.fn()
  render(
    <SnapshotHistoryPanelSlot
      pageId={pageId}
      restoreBlocked
      snapshotRestore={{ locale: "fr" }}
      readSnapshotRestore={() => expectations}
      onRestored={onRestored}
      onSnapshotRestored={onSnapshotRestored}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "Restore draft" }))
  await waitFor(() => expect(onRestored).toHaveBeenCalledWith(321, reports))
  expect(mocks.queries[0]).toEqual({
    name: "cms/publication:listSnapshotHistory",
    args: { pageId, locale: "fr" },
  })
  expect(mocks.restore).toHaveBeenCalledWith({
    ...state,
    pageId,
    snapshotId: "snapshot-1",
  })
  expect(mocks.confirm.mock.calls[0]![0].description).toContain(
    "Shared fields affect every language"
  )
  expect(onSnapshotRestored).toHaveBeenCalledWith({
    locale: "fr",
    draftGeneration: 4,
    sharedDraftGeneration: 5,
    updatedAt: 321,
    removedTitleLinks: reports,
  })
})
test("unsaved editor changes disable restore without any confirmation or mutation", () => {
  render(
    <SnapshotHistoryPanelSlot
      pageId={pageId}
      restoreBlocked
      snapshotRestore={{ locale: "fr" }}
      readSnapshotRestore={() => expectations}
      restoreDisabled
      onRestored={vi.fn()}
    />
  )
  expect(screen.getByRole("button", { name: "Restore draft" })).toBeDisabled()
  expect(screen.getByText(/Save or discard/)).toBeInTheDocument()
  expect(mocks.confirm).not.toHaveBeenCalled()
  expect(mocks.restore).not.toHaveBeenCalled()
})
test("absent-Type history discloses the blocked location and offers no partial restore", () => {
  mocks.unavailablePaths = ["content.fr.slices[1]"]
  render(
    <SnapshotHistoryPanelSlot
      pageId={pageId}
      restoreBlocked
      snapshotRestore={{ locale: "fr" }}
      readSnapshotRestore={() => expectations}
      onRestored={vi.fn()}
    />
  )
  expect(screen.getByText(/content.fr.slices\[1\]/)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Restore draft" })).toBeDisabled()
  expect(mocks.restore).not.toHaveBeenCalled()
})
test("a refused restore reports the error without refreshing or claiming success", async () => {
  const onRestored = vi.fn()
  mocks.restore.mockRejectedValue(new Error("PAGE_LOCALE_DRAFT_STALE"))
  render(
    <SnapshotHistoryPanelSlot
      pageId={pageId}
      restoreBlocked
      snapshotRestore={{ locale: "fr" }}
      readSnapshotRestore={() => expectations}
      onRestored={onRestored}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "Restore draft" }))
  await waitFor(() =>
    expect(mocks.error).toHaveBeenCalledWith("Restore failed")
  )
  expect(onRestored).not.toHaveBeenCalled()
  expect(mocks.success).not.toHaveBeenCalled()
})
test("confirmation retains the reviewed generations when current props change", async () => {
  let confirm: (value: boolean) => void = () => {}
  mocks.confirm.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        confirm = resolve
      })
  )
  const onRestored = vi.fn()
  const view = render(
    <SnapshotHistoryPanelSlot
      pageId={pageId}
      restoreBlocked
      snapshotRestore={{ locale: "fr" }}
      readSnapshotRestore={() => expectations}
      onRestored={onRestored}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "Restore draft" }))
  view.rerender(
    <SnapshotHistoryPanelSlot
      pageId={pageId}
      restoreBlocked
      snapshotRestore={{ locale: "fr" }}
      readSnapshotRestore={() => ({
        ...expectations,
        expectedDraftGeneration: 99,
      })}
      onRestored={onRestored}
    />
  )
  mocks.restore.mockRejectedValue(new Error("PAGE_LOCALE_DRAFT_STALE"))
  confirm(true)
  await waitFor(() =>
    expect(mocks.error).toHaveBeenCalledWith("Restore failed")
  )
  expect(mocks.restore).toHaveBeenCalledWith({
    ...state,
    pageId,
    snapshotId: "snapshot-1",
  })
  expect(onRestored).not.toHaveBeenCalled()
  expect(mocks.success).not.toHaveBeenCalled()
})

test("French admin copy, dates and refusal stay French while restoring English content", async () => {
  const onRestored = vi.fn()
  mocks.restore.mockRejectedValue(new Error("Untranslated backend failure"))
  render(
    <SnapshotHistoryPanelSlot
      pageId={pageId}
      restoreBlocked
      snapshotRestore={{ locale: "en" }}
      readSnapshotRestore={() => expectations}
      onRestored={onRestored}
    />,
    { locale: "fr" }
  )
  expect(screen.getByText("Historique publié · EN")).toBeInTheDocument()
  expect(
    screen.getByText(
      new Intl.DateTimeFormat("fr", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }).format(mocks.publishedAt)
    )
  ).toBeInTheDocument()
  fireEvent.click(
    screen.getByRole("button", { name: "Restaurer le brouillon" })
  )
  await waitFor(() =>
    expect(mocks.error).toHaveBeenCalledWith("Échec de la restauration")
  )
  expect(mocks.restore).toHaveBeenCalledWith({
    ...state,
    locale: "en",
    pageId,
    snapshotId: "snapshot-1",
  })
  expect(onRestored).not.toHaveBeenCalled()
  expect(mocks.success).not.toHaveBeenCalled()
})
test("a restore sends the numbers the editor's base reports and nothing from props", async () => {
  render(
    <SnapshotHistoryPanelSlot
      pageId={pageId}
      restoreBlocked
      snapshotRestore={{ locale: "fr" }}
      readSnapshotRestore={() => ({
        ...expectations,
        expectedDraftGeneration: 7,
      })}
      onRestored={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "Restore draft" }))
  await waitFor(() => expect(mocks.restore).toHaveBeenCalledOnce())
  expect(mocks.restore).toHaveBeenCalledWith({
    pageId,
    snapshotId: "snapshot-1",
    locale: "fr",
    ...expectations,
    expectedDraftGeneration: 7,
  })
})
test.each([
  ["no getter", undefined],
  ["a getter with no base", () => undefined],
])(
  "with %s a restore sends no request and asks nothing",
  async (_name, read) => {
    const onRestored = vi.fn()
    render(
      <SnapshotHistoryPanelSlot
        pageId={pageId}
        restoreBlocked
        snapshotRestore={{ locale: "fr" }}
        readSnapshotRestore={read}
        onRestored={onRestored}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Restore draft" }))
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("Restore failed")
    )
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(onRestored).not.toHaveBeenCalled()
  }
)

test("history restore keeps the same-type holder suffix hidden for posts", async () => {
  mocks.restore.mockResolvedValue({
    locale: "fr",
    draftGeneration: 4,
    sharedDraftGeneration: 5,
    updatedAt: 321,
    removedTitleLinks: [],
    addressNotices: [
      {
        locale: "fr",
        oldPath: "/old",
        newPath: "/current",
        check: {
          kind: "taken",
          locale: "fr",
          path: "/old",
          holder: {
            pageId: "holder",
            pageType: "post",
            title: "Existing post",
          },
        },
      },
    ],
  })
  render(
    <SnapshotHistoryPanelSlot
      pageId={pageId}
      restoreBlocked
      pageType="post"
      snapshotRestore={{ locale: "fr" }}
      readSnapshotRestore={() => expectations}
      onRestored={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "Restore draft" }))
  await waitFor(() => expect(mocks.success).toHaveBeenCalled())
  expect(String(mocks.success.mock.calls[0]![0])).toContain("Existing post")
  expect(String(mocks.success.mock.calls[0]![0])).not.toContain("(Post)")
})
