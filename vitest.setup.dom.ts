// Setup for the jsdom ("dom") Vitest project: register jest-dom's custom
// matchers (toBeInTheDocument, toHaveTextContent, …) and clean up the rendered
// tree after every test so component tests stay isolated.
import "@testing-library/jest-dom/vitest"
import { afterAll, afterEach, vi } from "vitest"
import { cleanup } from "@testing-library/react"

// Capture the real timer before individual tests can install fake timers.
const realSetTimeout = globalThis.setTimeout

// `server-only` is supplied by Next.js at build time. The DOM project must
// still be able to traverse a server-action import graph without executing
// that build-time guard.
vi.mock("server-only", () => ({}))

// jsdom ships no ResizeObserver, and Radix's positioning layer (tooltip arrow,
// popper-backed content) constructs one on mount. A no-op stub is enough:
// nothing under test asserts on measured sizes.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

afterEach(() => {
  cleanup()
})

// Radix FocusScope restores focus on a zero-delay unmount timer. Let it finish
// while this file's jsdom globals still exist instead of dispatching a Node
// CustomEvent on an old jsdom element after environment teardown.
// https://github.com/radix-ui/primitives/issues/4148
afterAll(() => new Promise<void>((resolve) => realSetTimeout(resolve, 0)))
