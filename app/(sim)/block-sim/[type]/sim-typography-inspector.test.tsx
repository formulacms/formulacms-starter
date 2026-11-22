import { createSampleBlock } from "@/convex/lib/blocks/sample"
import { blockProfile } from "@/test-utils/block-profile"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { sampleFields } from "./sim-sample-state"
import { installSimTestBridge } from "./sim-frame-test-support"
import {
  SIM_FRAME_CONNECTED,
  type SimFrameCallbacks,
  type SimFrameWindow,
} from "./sim-frame-bridge"
import type { TargetInfo } from "./block-preview"

vi.mock("./read-renderer-source", () => ({
  applySpacingBatchAction: vi.fn(),
  undoSpacingBatchAction: vi.fn(),
}))
import { VisualTweakProvider } from "./visual-tweak-store"
import { BlockTweakInspector } from "./block-tweak-inspector"

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})
afterEach(() => {
  delete (window as SimFrameWindow).__formulacmsSimFrame
})

test.each(["title", "basic", "plain"] as const)(
  "real inspector nests formatting for the selected %s field", blockProfile([]),
  async (contract) => {
    const bridge = installSimTestBridge(window)
    bridge.fields = sampleFields(createSampleBlock("hero-agency"))
    const field = bridge.fields.find((entry) => entry.contract === contract)!
    expect(field).toBeDefined()
    bridge.editorSessionId = () => "selected-editor"
    let callbacks!: SimFrameCallbacks
    bridge.connect = (_sessionId, next) => {
      callbacks = next
    }
    const format = vi.fn(() => true)
    bridge.format = format
    const target: TargetInfo = {
      loc: "selected-text",
      tag: contract === "title" ? "h3" : "p",
      sourceHash: "a".repeat(64),
      sourceClassTokens: ["text-lead"],
      editable: true,
      templateWide: true,
      label: "Selected text",
      path: field.path,
      text: "Selected text",
      classAnchor: "anchored",
      role: "lead",
      rect: { left: 0, top: 0, width: 100, height: 40 },
      metrics: {
        size: { width: 100, height: 40 },
        padding: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
        margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
        gap: "0px",
        fontSize: "18px",
        rootFontSize: "16px",
        lineHeight: "28.8px",
        letterSpacing: "normal",
      },
    }
    render(
      <VisualTweakProvider
        type="hero-agency"
        view="desktop"
        typographyTokens={{
          lead: {
            "font-size": "1.125rem",
            "line-height": "1.6",
            "letter-spacing": "inherit",
          },
        }}
      >
        <BlockTweakInspector
          target={target}
          onPreview={vi.fn()}
          onClose={vi.fn()}
        />
      </VisualTweakProvider>
    )
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
      )
    })
    expect(callbacks).toBeDefined()
    await act(async () => {
      callbacks.selection?.({
        path: field.path,
        editorSessionId: "selected-editor",
        from: 1,
        to: 1,
        text: {
          block: contract === "title" ? "heading" : "paragraph",
          headingLevel: contract === "title" ? 3 : null,
          marks: [],
        },
      })
    })
    const typography = within(
      screen.getByRole("region", { name: "Typography" })
    )
    expect(
      typography.getByRole("textbox", { name: "Size — site-wide lead" })
    ).toBeVisible()
    expect(screen.queryByRole("heading", { name: "Text" })).toBeNull()
    if (contract === "plain") {
      expect(
        typography.queryByRole("region", { name: "Character style" })
      ).toBeNull()
      expect(
        typography.queryByRole("region", { name: "Paragraph style" })
      ).toBeNull()
      expect(typography.queryByLabelText(/Current text block/)).toBeNull()
      return
    }
    const character = within(
      typography.getByRole("region", { name: "Character style" })
    )
    fireEvent.click(character.getByRole("button", { name: "Strong" }))
    expect(format).toHaveBeenCalledWith("bold")
    if (contract === "basic") {
      expect(
        typography.getByLabelText("Current text block P")
      ).toHaveTextContent("P")
      const paragraph = within(
        typography.getByRole("region", { name: "Paragraph style" })
      )
      expect(
        paragraph.getByRole("radiogroup", { name: "Text block" })
      ).toBeVisible()
    } else {
      expect(
        typography.getByLabelText("Current text block H3")
      ).toHaveTextContent("H3")
      expect(
        typography.queryByRole("region", { name: "Paragraph style" })
      ).toBeNull()
    }
  }
)
