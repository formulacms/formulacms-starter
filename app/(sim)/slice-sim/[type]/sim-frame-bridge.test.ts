import { expect, test } from "vitest"
import {
  historyIntent,
  simMessageMatches,
  type SimFrameBridge,
} from "./sim-frame-bridge"
test("current bridge accepts only its exact origin, WindowProxy, generation and session", () => {
  const source = {} as Window
  const bridge = { generation: "new", sessionId: "session" } as SimFrameBridge
  const data = {
    source: "formulacms-sim",
    generation: "new",
    sessionId: "session",
    revision: 1,
  }
  const event = { origin: "https://same.test", source, data }
  expect(simMessageMatches(event, event.origin, source, bridge)).toBe(true)
  for (const changed of [
    { origin: "https://other.test" },
    { source: {} as Window },
    { data: { ...data, generation: "old" } },
    { data: { ...data, sessionId: "other" } },
    { data: { ...data, revision: NaN } },
  ]) {
    expect(
      simMessageMatches({ ...event, ...changed }, event.origin, source, bridge)
    ).toBe(false)
  }
})
test("both documents share keyboard and beforeinput history intents without IME interception", () => {
  for (const metaKey of [true, false]) {
    const event = {
      metaKey,
      ctrlKey: !metaKey,
      altKey: false,
      key: "z",
      shiftKey: false,
      isComposing: false,
    } as KeyboardEvent
    expect(historyIntent(event)).toBe("undo")
    expect(historyIntent({ ...event, shiftKey: true } as KeyboardEvent)).toBe(
      "redo"
    )
    expect(historyIntent({ ...event, key: "y" } as KeyboardEvent)).toBe("redo")
    expect(
      historyIntent({ ...event, isComposing: true } as KeyboardEvent)
    ).toBeNull()
  }
  expect(historyIntent({ inputType: "historyUndo" } as InputEvent)).toBe("undo")
  expect(historyIntent({ inputType: "historyRedo" } as InputEvent)).toBe("redo")
})
