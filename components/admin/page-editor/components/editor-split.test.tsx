import { act, fireEvent, screen } from "@testing-library/react"
import type { ReactNode, Ref } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import {
  DEFAULT_BLOCKS_PERCENT,
  EditorSplit,
  SPLIT_STORAGE_KEY,
  readSplitLayout,
  writeSplitLayout,
} from "./editor-split"

// jsdom has no layout, so the panel library is replaced by a small fake with
// the same imperative API. The drag and keyboard math stay the library's.
const fake = vi.hoisted(() => ({ collapsed: new Set<string>() }))
vi.mock("react-resizable-panels", async () => {
  const { createContext, useContext, useRef } = await import("react")
  type Changed = (
    layout: Record<string, number>,
    meta: { isUserInteraction: boolean }
  ) => void
  const GroupContext = createContext<{ current?: Changed }>({})
  return {
    usePanelRef: () => useRef(null),
    Group: ({
      children,
      onLayoutChanged,
    }: {
      children: ReactNode
      onLayoutChanged: Changed
    }) => {
      const changed = useRef<Changed | undefined>(undefined)
      changed.current = onLayoutChanged
      return (
        <GroupContext.Provider value={changed}>
          <div>{children}</div>
        </GroupContext.Provider>
      )
    },
    Panel: ({
      id,
      panelRef,
      children,
    }: {
      id: string
      panelRef: Ref<unknown>
      children: ReactNode
    }) => {
      const changed = useContext(GroupContext)
      const notify = () =>
        act(() =>
          changed.current?.(
            { blocks: 40, preview: 60 },
            { isUserInteraction: false }
          )
        )
      if (panelRef && typeof panelRef === "object")
        panelRef.current = {
          isCollapsed: () => fake.collapsed.has(id),
          collapse: () => {
            fake.collapsed.add(id)
            notify()
          },
          resize: () => {
            fake.collapsed.clear()
            notify()
          },
        }
      return <div>{children}</div>
    },
    Separator: (props: Record<string, unknown>) => (
      <div
        role="separator"
        aria-labelledby={props["aria-labelledby"] as string}
      />
    ),
  }
})

function renderSplit() {
  return render(
    <EditorSplit
      blocks={<p>block list</p>}
      preview={(hideButton) => (
        <div>
          <p>live preview</p>
          {hideButton}
        </div>
      )}
    />
  )
}

afterEach(() => {
  fake.collapsed.clear()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe("remembered split layout", () => {
  it("reads the default when nothing or something invalid is stored", () => {
    const fallback = {
      blocks: DEFAULT_BLOCKS_PERCENT,
      hidden: null,
      view: "edit",
    }
    expect(readSplitLayout()).toEqual(fallback)
    window.localStorage.setItem(SPLIT_STORAGE_KEY, "{not json")
    expect(readSplitLayout()).toEqual(fallback)
    window.localStorage.setItem(
      SPLIT_STORAGE_KEY,
      JSON.stringify({ blocks: 140, hidden: "both", view: "side" })
    )
    expect(readSplitLayout()).toEqual(fallback)
  })

  it("round-trips a stored layout", () => {
    const layout = { blocks: 45, hidden: "preview", view: "preview" } as const
    writeSplitLayout(layout)
    expect(readSplitLayout()).toEqual(layout)
  })

  it("works when the browser refuses storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError")
    })
    expect(readSplitLayout().view).toBe("edit")
    expect(() =>
      writeSplitLayout({ blocks: 50, hidden: null, view: "edit" })
    ).not.toThrow()
    renderSplit()
    expect(screen.getByText("block list")).toBeInTheDocument()
    expect(screen.getByText("live preview")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: /Preview/ }))
    expect(screen.getByRole("radio", { name: /Preview/ })).toHaveAttribute(
      "data-state",
      "on"
    )
  })
})

describe("editor split", () => {
  it("shows both sides with their hide buttons and the divider", () => {
    renderSplit()
    expect(screen.getByRole("button", { name: "Hide blocks" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Hide preview" })).toBeVisible()
    expect(screen.getByRole("separator")).toHaveAccessibleName("Blocks")
  })

  it("opens a stored hidden side as a rail that shows it again", () => {
    writeSplitLayout({ blocks: 40, hidden: "preview", view: "edit" })
    renderSplit()
    expect(
      screen.getByRole("button", { name: "Show preview" })
    ).toBeInTheDocument()
    // The preview stays mounted while hidden, so its frame keeps its state.
    expect(screen.getByText("live preview")).toBeInTheDocument()
  })

  it("hides the block list behind a rail and shows it again", async () => {
    renderSplit()
    fireEvent.click(screen.getByRole("button", { name: "Hide blocks" }))
    const show = await screen.findByRole("button", { name: "Show blocks" })
    expect(show).toHaveFocus()
    expect(readSplitLayout().hidden).toBe("blocks")
    fireEvent.click(show)
    expect(
      await screen.findByRole("button", { name: "Hide blocks" })
    ).toHaveFocus()
    expect(screen.queryByRole("button", { name: "Show blocks" })).toBeNull()
    expect(readSplitLayout().hidden).toBeNull()
  })

  it("remembers the Edit / Preview switch for narrow windows", () => {
    renderSplit()
    expect(screen.getByRole("radio", { name: /Edit/ })).toHaveAttribute(
      "data-state",
      "on"
    )
    fireEvent.click(screen.getByRole("radio", { name: /Preview/ }))
    expect(readSplitLayout().view).toBe("preview")
  })
})
