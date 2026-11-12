import { sliceProfile } from "@/test-utils/slice-profile"
import { StrictMode } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"
import { enumerateTweakLocations } from "@/lib/slices/visual-tweak/tweak-loc-core.cjs"
import {
  applyClassOperationBatch,
  hashTweakSource,
} from "@/lib/slices/visual-tweak/class-operations"
import type { SliceCodeSnapshot } from "@/lib/slices/visual-tweak/read-code"
const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }))
vi.mock("./read-code", () => ({ readSliceCodeAction: mocks.read }))
vi.mock("./read-renderer-source", () => ({
  applySpacingBatchAction: mocks.save,
  undoSpacingBatchAction: vi.fn(),
}))
import { SliceCodeViewer } from "./slice-code-viewer"
import { useVisualTweak, VisualTweakProvider } from "./visual-tweak-store"

const FILE = "components/slices/example.tsx"
const fixtures = [
  ["literal", "section", '<section className="pt-4">Text</section>'],
  ["bare", "section", "<section>Text</section>"],
  ["cn", "section", '<section className={cn("pt-4", "grid")}>Text</section>'],
  [
    "kit",
    "HeadingSlot",
    '<HeadingSlot level={2} className="pt-4">Title</HeadingSlot>',
  ],
  [
    "list",
    "div",
    '<section><div className="grid pt-4">{primary.cards.map((card) => <article className="pt-4">{card.title}</article>)}</div></section>',
  ],
  [
    "repeated",
    "article",
    '<section>{primary.cards.map((card) => <article className="pt-4">{card.title}</article>)}</section>',
  ],
] as const
const cases = fixtures.flatMap(([kind, tag, body]) =>
  (["all", "sm-and-up", "below-sm"] as const).map((scope) => ({
    kind,
    tag,
    body,
    scope,
  }))
)
beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
})

test.each(cases)(
  "$kind × $scope: saved classes match the real store and Code panel", sliceProfile([]),
  async ({ tag, body, scope }) => {
    const source = `import { HeadingSlot } from "@/components/slice-kit/heading-slot"; export function Example({primary}) { return ${body} }`
    const entries = enumerateTweakLocations(source, FILE)
    const entry = entries.find((row) => row.tag === tag)!
    expect(entry).toBeDefined()
    const hash = hashTweakSource(source)
    const tokens =
      entry.className.kind === "literal"
        ? entry.className.literal.value.split(/\s+/)
        : entry.className.kind === "cn"
          ? entry.className.literals.flatMap((literal) =>
              literal.value.split(/\s+/)
            )
          : []
    const target = {
      loc: entry.loc,
      tag,
      sourceHash: hash,
      sourceClassTokens: tokens,
      editable: true,
      templateWide: entry.templateWide,
      path: entry.loc,
      label: "Selected",
    }
    const next = `${scope === "all" ? "" : scope === "below-sm" ? "max-sm:" : "sm:"}pt-8`
    const result = applyClassOperationBatch({
      source,
      file: FILE,
      operations: [
        {
          kind: "class.replace",
          target: entry.loc,
          tag,
          sourceHash: hash,
          scope,
          group: "spacing:pt",
          expected: scope === "all" && tokens.includes("pt-4") ? "pt-4" : null,
          next,
          postcondition: { kind: "class-token", value: next },
        },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const snapshot: SliceCodeSnapshot = {
      type: "hero-agency",
      renderer: { path: FILE, source, digest: hash },
      css: { path: "app/globals.css", source: "", digest: "b".repeat(64) },
      locations: entries.map(({ loc, tag, line, column }) => ({
        loc,
        tag,
        line,
        column,
      })),
    }
    mocks.read.mockResolvedValue({ ok: true, snapshot })
    function Harness() {
      const store = useVisualTweak()
      return (
        <>
          <button
            onClick={() =>
              store.setEdit(entry.loc, "pt", {
                suffix: "8",
                valueRem: 2,
                target,
              })
            }
          >
            Nudge
          </button>
          <output aria-label="Pending classes">
            {store.pendingRows[0]?.after}
          </output>
          <SliceCodeViewer type="hero-agency" target={null} />
        </>
      )
    }
    const view =
      scope === "all" ? "desktop" : scope === "below-sm" ? "mobile" : "tablet"
    render(
      <VisualTweakProvider type="hero-agency" view={view}>
        <Harness />
      </VisualTweakProvider>
    )
    fireEvent.click(screen.getByText("Nudge"))
    const savedEntry = enumerateTweakLocations(result.source, FILE).find(
      (row) => row.loc === entry.loc
    )!
    const saved =
      savedEntry.className.kind === "literal"
        ? savedEntry.className.literal.value
        : savedEntry.className.kind === "cn"
          ? savedEntry.className.literals
              .map((literal) => literal.value)
              .join(" ")
          : ""
    expect(screen.getByLabelText("Pending classes")).toHaveTextContent(saved)
    await waitFor(() =>
      expect(
        screen.getByText(
          (_, element) =>
            element?.tagName === "CODE" &&
            element.textContent ===
              `- ${tokens.join(" ") || "(no class)"}\n+ ${saved}`
        )
      ).toBeInTheDocument()
    )
    expect(result.source).toContain(next)
    expect(mocks.save).not.toHaveBeenCalled()
  }
)

test("device scope changes reapply even an empty batch to the persistent frame", sliceProfile([]), () => {
  const reapply = vi.fn()
  const event = "formulacms:slice-reapply"
  window.addEventListener(event, reapply)
  try {
    const mounted = render(
      <StrictMode>
        <VisualTweakProvider type="hero-agency" view="desktop">
          <NonceReapply />
        </VisualTweakProvider>
      </StrictMode>
    )
    expect(reapply).not.toHaveBeenCalled()
    for (const view of ["mobile", "tablet", "desktop"] as const) {
      mounted.rerender(
        <StrictMode>
          <VisualTweakProvider type="hero-agency" view={view}>
            <NonceReapply />
          </VisualTweakProvider>
        </StrictMode>
      )
      expect((reapply.mock.calls.at(-1)?.[0] as CustomEvent).detail).toEqual({
        edits: [],
      })
    }
    expect(reapply).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole("button", { name: "Reset sample nonce" }))
    expect(reapply).toHaveBeenCalledTimes(4)
    expect((reapply.mock.calls.at(-1)?.[0] as CustomEvent).detail).toEqual({
      edits: [],
    })
    fireEvent.click(screen.getByRole("button", { name: "Reset sample nonce" }))
    expect(reapply).toHaveBeenCalledTimes(5)
  } finally {
    window.removeEventListener(event, reapply)
  }
})

function NonceReapply() {
  const { resetSamples } = useVisualTweak()
  return <button onClick={resetSamples}>Reset sample nonce</button>
}
