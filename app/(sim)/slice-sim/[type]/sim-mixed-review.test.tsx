import { sliceProfile } from "@/test-utils/slice-profile"
import { act, useLayoutEffect } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ apply: vi.fn(), undo: vi.fn() }))
vi.mock("./read-renderer-source", () => ({
  applySpacingBatchAction: mocks.apply,
  undoSpacingBatchAction: mocks.undo,
}))
import { VisualTweakProvider, useVisualTweak } from "./visual-tweak-store"
import { VisualTweakSaveBar } from "./visual-tweak-save-bar"

const target = {
  loc: "components/slices/hero-agency.tsx:11:5",
  tag: "section",
  sourceHash: "source-hash",
  sourceClassTokens: ["pt-4"],
  editable: true,
  templateWide: false,
  label: "Hero section",
  path: "primary",
}
const step = {
  role: "body",
  property: "font-size",
  initialValue: "1rem",
  delta: 1,
  rootFontSizePx: 16,
} as const

beforeEach(() => {
  mocks.apply.mockReset()
  mocks.undo.mockReset()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

function harness(compact: boolean) {
  let value: ReturnType<typeof useVisualTweak>
  function Probe() {
    const state = useVisualTweak()
    useLayoutEffect(() => {
      value = state
    }, [state])
    return <VisualTweakSaveBar compact={compact} />
  }
  render(
    <VisualTweakProvider type="hero-agency" view="desktop">
      <Probe />
    </VisualTweakProvider>
  )
  return () => value!
}

function openReview(compact: boolean) {
  if (compact)
    fireEvent.click(
      screen.getByRole("button", { name: "Review appearance changes" })
    )
}

function typographyReview() {
  const group = screen.getByRole("region", { name: "Typography" })
  expect(within(group).getByText("--text-body")).toBeVisible()
  expect(within(group).getByText("1rem → 1.0625rem")).toBeVisible()
  expect(
    within(group).getByRole("link", { name: "Design system" })
  ).toHaveAttribute("href", "/admin/design-system")
}

test.each([true, false])(
  "compact=%s reviews typography alone without a source Save", sliceProfile([]),
  async (compact) => {
    const current = harness(compact)
    await act(async () => {
      current().stepTypography(step)
    })
    openReview(compact)
    typographyReview()
    expect(
      screen.queryByRole("button", { name: "Save appearance changes" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Undo saved appearance changes" })
    ).not.toBeInTheDocument()
    expect(current().editCount).toBe(0)
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.undo).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(current().typography).toEqual({})
  }
)

test.each([true, false])(
  "compact=%s keeps mixed preview history and source save payloads separate", sliceProfile([]),
  async (compact) => {
    mocks.apply.mockResolvedValue({
      ok: true,
      applied: 1,
      skipped: 0,
      results: [
        {
          id: JSON.stringify([target.loc, "all", "spacing:pt"]),
          status: "applied",
        },
      ],
      files: ["components/slices/hero-agency.tsx"],
      version: 1,
      checkpointId: "spacing-checkpoint",
      diffs: [],
    })
    mocks.undo.mockResolvedValue({ ok: true, targets: [] })
    const current = harness(compact)
    await act(async () => {
      current().setEdit(target.loc, "pt", { suffix: "8", valueRem: 2, target })
      current().stepTypography(step)
    })
    openReview(compact)
    typographyReview()
    expect(current().editCount).toBe(1)
    expect(current().pendingRows).toHaveLength(1)
    const undoName = compact ? "Undo" : "Undo (⌘Z)"
    const redoName = compact ? "Redo" : "Redo (⇧⌘Z)"
    fireEvent.click(screen.getByRole("button", { name: undoName }))
    expect(current().typography).toEqual({})
    expect(current().editCount).toBe(1)
    fireEvent.click(screen.getByRole("button", { name: redoName }))
    typographyReview()
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(current().typography).toEqual({})
    expect(current().editCount).toBe(0)
    fireEvent.click(screen.getByRole("button", { name: undoName }))
    typographyReview()
    expect(current().editCount).toBe(1)
    fireEvent.click(screen.getByRole("button", { name: redoName }))
    expect(current().typography).toEqual({})
    expect(current().editCount).toBe(0)
    fireEvent.click(screen.getByRole("button", { name: undoName }))
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Save appearance changes" })
      )
    })
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith({
      type: "hero-agency",
      edits: [
        {
          kind: "class.replace",
          target: target.loc,
          tag: target.tag,
          scope: "all",
          group: "spacing:pt",
          sourceHash: target.sourceHash,
          expected: "pt-4",
          next: "pt-8",
          postcondition: { kind: "class-token", value: "pt-8" },
        },
      ],
    })
    expect(current().editCount).toBe(0)
    expect(current().pendingRows).toEqual([])
    typographyReview()
    expect(JSON.stringify(window.sessionStorage)).not.toContain("font-size")
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Undo saved appearance changes" })
      )
    })
    expect(mocks.undo).toHaveBeenCalledExactlyOnceWith({
      type: "hero-agency",
      checkpointId: "spacing-checkpoint",
    })
    expect(mocks.apply).toHaveBeenCalledTimes(1)
    expect(current().savedCheckpoint).toBeNull()
    typographyReview()
    expect(current().canUndo).toBe(false)
    expect(current().canRedo).toBe(false)
    expect(current().status?.message).toContain("history was cleared")
    expect(current().editCount).toBe(0)
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(current().typography).toEqual({})
  }
)
