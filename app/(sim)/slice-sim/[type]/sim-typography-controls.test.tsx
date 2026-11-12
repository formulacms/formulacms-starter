import { sliceProfile } from "@/test-utils/slice-profile"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"
vi.mock("./read-renderer-source", () => ({
  applySpacingBatchAction: vi.fn(),
  undoSpacingBatchAction: vi.fn(),
}))
import { VisualTweakProvider, useVisualTweak } from "./visual-tweak-store"
import { useSliceTweak } from "./use-slice-tweak"
import { SimTypographyControls } from "./sim-typography-controls"
import type { TargetInfo } from "./slice-preview"

const target: TargetInfo = {
  loc: "title",
  tag: "h3",
  sourceHash: "a".repeat(64),
  sourceClassTokens: ["text-lead"],
  editable: true,
  templateWide: true,
  label: "Card title",
  path: "items[0].title",
  text: "Card title",
  classAnchor: "anchored",
  role: "lead",
  rect: { left: 0, top: 0, width: 100, height: 40 },
  metrics: {
    size: { width: 100, height: 40 },
    padding: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
    margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
    gap: "0px",
    fontSize: "20px",
    rootFontSize: "20px",
    lineHeight: "32px",
    letterSpacing: "0.8px",
  },
}
function Harness() {
  const store = useVisualTweak()
  const tweak = useSliceTweak({ target, onPreview: vi.fn() })
  return (
    <>
      <SimTypographyControls
        target={target}
        busy={tweak.busy}
        onStep={tweak.onTypographyStep}
      />
      <output aria-label="Typography state">
        {JSON.stringify(store.typography)}
      </output>
      <button onClick={store.undo}>Undo</button>
    </>
  )
}
function mount(missing = false) {
  return render(
    <VisualTweakProvider
      type="features-icon-grid"
      view="desktop"
      typographyTokens={
        missing
          ? {}
          : {
              lead: {
                "font-size": "clamp(1rem, 0.9rem + 0.3vw, 1.2rem)",
                "line-height": "1.6",
                "letter-spacing": "inherit",
              },
            }
      }
    >
      <Harness />
    </VisualTweakProvider>
  )
}
beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})
test("real lead controls use measured own-font tracking, root-size stepping and shared Undo", sliceProfile([]), () => {
  mount()
  expect(
    screen.getByRole("textbox", { name: "Letter spacing — site-wide lead" })
  ).toHaveValue("0.04em")
  fireEvent.click(
    screen.getByRole("button", { name: "Increase Letter spacing" })
  )
  expect(screen.getByLabelText("Typography state")).toHaveTextContent(
    '"before":"inherit","after":"0.045em"'
  )
  // A utility override remains truthful: display comes from measurements, not pending tokens.
  expect(
    screen.getByRole("textbox", { name: "Letter spacing — site-wide lead" })
  ).toHaveValue("0.04em")
  fireEvent.keyDown(
    screen.getByRole("textbox", { name: "Size — site-wide lead" }),
    { key: "ArrowUp" }
  )
  expect(screen.getByLabelText("Typography state")).toHaveTextContent(
    "clamp(1.05rem, 0.95rem + 0.3vw, 1.25rem)"
  )
  fireEvent.click(screen.getByRole("button", { name: "Increase Line height" }))
  expect(screen.getByLabelText("Typography state")).toHaveTextContent(
    '"after":"1.65"'
  )
  fireEvent.click(screen.getByRole("button", { name: "Undo" }))
  expect(screen.getByLabelText("Typography state")).not.toHaveTextContent(
    '"after":"1.65"'
  )
})
test("missing editable declarations are refused with the supported-context message", sliceProfile([]), () => {
  mount(true)
  expect(screen.getByRole("alert")).toHaveTextContent(
    "one unambiguous declaration per token"
  )
  expect(screen.getByRole("button", { name: "Increase Size" })).toBeDisabled()
})
