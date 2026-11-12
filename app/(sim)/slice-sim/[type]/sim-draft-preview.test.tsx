import { sliceProfile } from "@/test-utils/slice-profile"
import { act } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { SIM_FRAME_CONNECTED, type SimFrameWindow } from "./sim-frame-bridge"
import { installSimTestBridge } from "./sim-frame-test-support"
import { SLICE_LAYER_READY_EVENT, SLICE_REAPPLY_EVENT } from "./slice-preview"
import { VisualTweakProvider } from "./visual-tweak-store"
import { VisualTweakSaveBar } from "./slice-tweak-inspector"
import type { PendingTweakTarget, Viewport } from "./visual-tweak-reducer"
vi.mock("./read-renderer-source", () => ({
  applySpacingBatchAction: vi.fn(),
  undoSpacingBatchAction: vi.fn(),
}))
import { applySpacingBatchAction } from "./read-renderer-source"

const original: PendingTweakTarget = {
  loc: "file:1:1",
  tag: "section",
  sourceHash: "saved-hash",
  sourceClassTokens: ["pt-4", "sm:pt-4", "max-sm:pt-4"],
  editable: true,
  templateWide: false,
  label: "Section",
  path: "",
}
const current = { ...original, sourcePath: "jsx.0" }
const variants = [
  "wrong-hash",
  "wrong-loc",
  "absent",
  "ambiguous",
  "conflict",
  "uneditable",
  "safe-s1",
  "safe-current",
] as const
test.each(
  (["all", "below-sm", "sm-and-up"] as Viewport[]).flatMap((scope) =>
    variants.map((variant) => ({ scope, variant }))
  )
)(
  "$scope $variant captures every hydration/ready/reload replay", sliceProfile([]),
  ({ scope, variant }) => {
    const safe = variant.startsWith("safe")
    const snapshots: PendingTweakTarget[] =
      variant === "absent"
        ? []
        : variant === "ambiguous"
          ? [current, { ...current, sourcePath: "jsx.1" }]
          : variant === "conflict"
            ? [current, { ...current, loc: "another:1:1" }]
            : [
                {
                  ...current,
                  ...(variant === "wrong-hash"
                    ? { sourceHash: "different" }
                    : {}),
                  ...(variant === "wrong-loc" ? { loc: "other:1:1" } : {}),
                  ...(variant === "uneditable" ? { editable: false } : {}),
                },
              ]
    for (const order of ["load-first", "targets-first"]) {
      const storedTarget = variant === "safe-current" ? current : original
      const stored = {
        all: {},
        "below-sm": {},
        "sm-and-up": {},
        [scope]: {
          [original.loc]: {
            pt: { target: storedTarget, suffix: "8", valueRem: 2 },
          },
        },
      }
      const storageKey = "nextcms:vt-batch:hero-agency"
      window.sessionStorage.clear()
      window.sessionStorage.setItem(storageKey, JSON.stringify(stored))
      const before = Object.getOwnPropertyDescriptor(
        window,
        "__formulacmsSimFrame"
      )
      Reflect.deleteProperty(window, "__formulacmsSimFrame")
      const bridge = installSimTestBridge(window)
      bridge.targets = snapshots
      const hello = () =>
        window.dispatchEvent(
          new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
        )
      if (order === "targets-first")
        window.addEventListener(`${SIM_FRAME_CONNECTED}:hello`, hello)
      const batches: Array<
        Array<{ scope: Viewport; sourceHash: string; valueRem: number }>
      > = []
      const collect = (event: Event) =>
        batches.push((event as CustomEvent).detail.edits)
      window.addEventListener(SLICE_REAPPLY_EVENT, collect)
      vi.mocked(applySpacingBatchAction).mockClear()
      let mounted: ReturnType<typeof render> | undefined
      try {
        for (let reload = 0; reload < 2; reload++) {
          const start = batches.length
          mounted = render(
            <VisualTweakProvider type="hero-agency" view="desktop">
              <VisualTweakSaveBar compact />
            </VisualTweakProvider>
          )
          if (order === "load-first") act(hello)
          act(() => {
            hello()
            window.dispatchEvent(new Event(SLICE_LAYER_READY_EVENT))
            window.dispatchEvent(new Event(SLICE_LAYER_READY_EVENT))
          })
          const emitted = batches.slice(start)
          expect(emitted.length).toBeGreaterThan(0)
          fireEvent.click(
            screen.getByRole("button", { name: "Review appearance changes" })
          )
          if (safe) {
            expect(emitted.some((batch) => batch.length === 1)).toBe(true)
            for (const batch of emitted)
              for (const row of batch)
                expect(row).toMatchObject({
                  scope,
                  sourceHash: original.sourceHash,
                  valueRem: 2,
                })
            expect(
              screen.getByRole("button", { name: "Save appearance changes" })
            ).toBeEnabled()
          } else {
            expect(emitted.every((batch) => batch.length === 0)).toBe(true)
            expect(
              screen.getByRole("button", { name: "Save appearance changes" })
            ).toBeDisabled()
            expect(screen.getByRole("alert")).toBeVisible()
            fireEvent.keyDown(document.body, { key: "s", ctrlKey: true })
            expect(applySpacingBatchAction).not.toHaveBeenCalled()
          }
          const persisted = JSON.parse(
            window.sessionStorage.getItem(storageKey)!
          )
          const rows = Object.values(persisted[scope]) as Array<{
            pt: {
              suffix: string
              valueRem: number
              disabledReason?: string
              target: PendingTweakTarget
            }
          }>
          expect(rows).toHaveLength(1)
          expect(rows[0].pt).toMatchObject({
            suffix: "8",
            valueRem: 2,
            target: { sourceHash: original.sourceHash },
          })
          if (!safe) expect(rows[0].pt.disabledReason).toBeTruthy()
          mounted.unmount()
          mounted = undefined
        }
      } finally {
        mounted?.unmount()
        window.removeEventListener(SLICE_REAPPLY_EVENT, collect)
        window.removeEventListener(`${SIM_FRAME_CONNECTED}:hello`, hello)
        if (before)
          Object.defineProperty(window, "__formulacmsSimFrame", before)
        else
          Reflect.deleteProperty(
            window as SimFrameWindow,
            "__formulacmsSimFrame"
          )
      }
    }
  }
)
