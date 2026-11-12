import type { SimFrameBridge, SimFrameWindow } from "./sim-frame-bridge"
export function installSimTestBridge(win: Window): SimFrameBridge {
  const frame = win as SimFrameWindow
  if (frame.__formulacmsSimFrame) return frame.__formulacmsSimFrame
  const bridge: SimFrameBridge = {
    generation: "test-generation",
    sessionId: "test-session",
    incomingRevision: 0,
    outgoingRevision: 0,
    acceptedParentRevision: 0,
    lastReplaceRevision: 0,
    appliedRevision: 0,
    current: () => frame.__formulacmsSimFrame === bridge,
    fields: [],
    targets: [],
    editorSessionId: () => null,
    connect() {},
    replace: () => true,
    flush: () => true,
    format: () => false,
    controller: () => null,
  }
  frame.__formulacmsSimFrame = bridge
  return bridge
}
export function simTestStamp(
  win: Window,
  direction: "parent" | "frame" = "parent"
) {
  const bridge = installSimTestBridge(win)
  return {
    generation: bridge.generation,
    sessionId: bridge.sessionId,
    revision:
      direction === "parent"
        ? ++bridge.incomingRevision
        : ++bridge.outgoingRevision,
  }
}
