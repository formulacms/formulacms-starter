import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile } from "@/test-utils/slice-profile"
import { act, useLayoutEffect } from "react"
import { render } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { sampleFields } from "./sim-sample-state"
import { installSimTestBridge } from "./sim-frame-test-support"
import {
  SIM_FRAME_CONNECTED,
  type SimFrameWindow,
  type SimFrameCallbacks,
} from "./sim-frame-bridge"

const mocks = vi.hoisted(() => ({ apply: vi.fn(), undo: vi.fn() }))
vi.mock("./read-renderer-source", () => ({
  applySpacingBatchAction: mocks.apply,
  undoSpacingBatchAction: mocks.undo,
}))
import { VisualTweakProvider, useVisualTweak } from "./visual-tweak-store"

beforeEach(() => {
  mocks.apply.mockReset()
  mocks.undo.mockReset()
  window.sessionStorage.clear()
  window.localStorage.clear()
})
afterEach(() => {
  delete (window as SimFrameWindow).__formulacmsSimFrame
})

const step = {
  role: "body",
  property: "font-size",
  initialValue: "1rem",
  delta: 1,
  rootFontSizePx: 16,
} as const
function harness() {
  let value: ReturnType<typeof useVisualTweak>
  function Probe() {
    const state = useVisualTweak()
    useLayoutEffect(() => {
      value = state
    }, [state])
    return null
  }
  render(
    <VisualTweakProvider type="hero-agency" view="desktop">
      <Probe />
    </VisualTweakProvider>
  )
  return () => value!
}

test("flushes the pending native sample before typography and uses latest queued preview state", sliceProfile([]), () => {
  const current = harness()
  const bridge = installSimTestBridge(window)
  const field = sampleFields(createSampleSlice("hero-agency")).find(
    (entry) => entry.contract === "plain"
  )!
  bridge.fields = [field]
  bridge.editorSessionId = () => "editor"
  let callbacks: SimFrameCallbacks
  let sessionId = ""
  bridge.connect = (id, next) => {
    sessionId = id
    callbacks = next
  }
  let pending = true
  bridge.flush = () => {
    if (!pending) return true
    pending = false
    return callbacks.change({
      generation: bridge.generation,
      sessionId,
      editorSessionId: "editor",
      revision: 1,
      path: field.path,
      value: "Edited sample",
      selection: null,
    })
  }
  act(() =>
    window.dispatchEvent(
      new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
    )
  )
  act(() => {
    current().stepTypography(step)
    current().stepTypography(step)
  })
  expect(current().typography.body?.["font-size"]?.after).toBe("1.125rem")
  expect(current().samples[field.path]).toBe("Edited sample")
  act(() => current().undo())
  expect(current().typography.body?.["font-size"]?.after).toBe("1.0625rem")
  act(() => current().undo())
  expect(current().typography).toEqual({})
  expect(current().samples[field.path]).toBe("Edited sample")
  act(() => current().undo())
  expect(current().samples[field.path]).not.toBe("Edited sample")
})

test("refused native flush admits no typography history", sliceProfile([]), () => {
  const current = harness()
  const bridge = installSimTestBridge(window)
  bridge.flush = () => false
  act(() =>
    window.dispatchEvent(
      new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
    )
  )
  act(() => current().stepTypography(step))
  expect(current().typography).toEqual({})
  expect(current().canUndo).toBe(false)
})

test("typography stays out of source Save, saved Undo and persisted spacing payloads", sliceProfile([]), async () => {
  const current = harness()
  act(() => current().stepTypography(step))
  await act(async () => {
    await current().save()
  })
  await act(async () => {
    await current().undoSaved()
  })
  expect(mocks.apply).not.toHaveBeenCalled()
  expect(mocks.undo).not.toHaveBeenCalled()
  expect(current().editCount).toBe(0)
  expect(current().typography.body?.["font-size"]?.after).toBe("1.0625rem")
  expect(current().savedCheckpoint).toBeNull()
  expect(JSON.stringify(window.sessionStorage)).not.toContain("font-size")
  act(() => current().discard())
  expect(current().typography).toEqual({})
  act(() => current().undo())
  expect(current().typography.body?.["font-size"]?.after).toBe("1.0625rem")
})
