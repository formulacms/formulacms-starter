import type { TypographyPreviewEdits } from "@/lib/slices/visual-tweak/typography"
import type {
  PreviewInlineController,
  PreviewInlineFormat,
  PreviewInlineTextState,
} from "@/components/admin/preview-inline-editor"
import type { PendingTweakTarget } from "./visual-tweak-reducer"
import type {
  SampleField,
  SampleSelection,
  SampleValues,
} from "./sim-sample-state"
export const SIM_FRAME_SOURCE = "formulacms-sim"
export const SIM_FRAME_CONNECTED = "formulacms:sim-frame-connected"
export type SimEdit = {
  generation: string
  sessionId: string
  editorSessionId: string
  revision: number
  path: string
  value: string
  selection: SampleSelection
}
export type SimFrameInput = {
  generation: string
  sessionId: string
  revision: number
  values: SampleValues
  selection: SampleSelection
  replay: number
  reset: number
  mode: "edit" | "preview"
  typography?: TypographyPreviewEdits
}
export type SimFrameCallbacks = {
  selection?(
    input: {
      path: string
      editorSessionId: string
      from: number
      to: number
      text: PreviewInlineTextState
    } | null
  ): void
  change(edit: SimEdit): boolean
  groupEnd(): void
  history(intent: "undo" | "redo"): void
  save(): void
}
export type SimFrameBridge = {
  generation: string
  sessionId: string
  /** Highest accepted transport revision; not a DOM acknowledgement. */
  acceptedParentRevision: number
  lastReplaceRevision: number
  appliedRevision: number
  /** Current host selection intent; native same-origin object only. */
  readTargetPath?(): string | null
  current(): boolean
  incomingRevision: number
  outgoingRevision: number
  fields: SampleField[]
  targets: PendingTweakTarget[]
  editorSessionId(): string | null
  connect(sessionId: string, callbacks: SimFrameCallbacks): void
  replace(input: SimFrameInput): boolean
  flush(): boolean
  format(command: PreviewInlineFormat): boolean
  controller(): PreviewInlineController | null
}
export type SimFrameWindow = Window & { __formulacmsSimFrame?: SimFrameBridge }
export function currentSimBridge(win: Window | null): SimFrameBridge | null {
  try {
    return (win as SimFrameWindow | null)?.__formulacmsSimFrame ?? null
  } catch {
    return null
  }
}
export function postSimMessage(message: Record<string, unknown>) {
  const bridge = currentSimBridge(window)
  if (!bridge) return
  window.parent.postMessage(
    {
      source: SIM_FRAME_SOURCE,
      ...message,
      generation: bridge.generation,
      sessionId: bridge.sessionId,
      revision: ++bridge.outgoingRevision,
    },
    window.location.origin
  )
}
export function postToSimFrame(
  win: Window | null,
  message: Record<string, unknown>
) {
  const bridge = currentSimBridge(win)
  if (!bridge || !win) return
  win.postMessage(
    {
      source: SIM_FRAME_SOURCE,
      ...message,
      generation: bridge.generation,
      sessionId: bridge.sessionId,
      revision: ++bridge.incomingRevision,
    },
    window.location.origin
  )
}
export function simMessageMatches(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  origin: string,
  expected: Window | null,
  bridge: SimFrameBridge | null
): boolean {
  const data = event.data
  return (
    !!expected &&
    !!bridge &&
    event.origin === origin &&
    event.source === expected &&
    !!data &&
    typeof data === "object" &&
    data.source === SIM_FRAME_SOURCE &&
    data.generation === bridge.generation &&
    data.sessionId === bridge.sessionId &&
    Number.isSafeInteger(data.revision) &&
    data.revision > 0
  )
}
export function historyIntent(
  event: KeyboardEvent | InputEvent
): "undo" | "redo" | null {
  if (event.isComposing) return null
  if ("inputType" in event)
    return event.inputType === "historyUndo"
      ? "undo"
      : event.inputType === "historyRedo"
        ? "redo"
        : null
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null
  const key = event.key.toLowerCase()
  return key === "z"
    ? event.shiftKey
      ? "redo"
      : "undo"
    : key === "y"
      ? "redo"
      : null
}
