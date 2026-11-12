import { sliceProfile } from "@/test-utils/slice-profile"
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
  getDefaultNormalizer,
} from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { getFunctionName } from "convex/server"
import { render } from "@/test-utils/admin-i18n"
import {
  readSlicePresentationCatalog,
  slicePresentationCatalogWithArchives,
} from "@/convex/lib/slices/presentations"
import type { SlicePresentationCatalog } from "@/convex/lib/slices/presentationResolution"
import { SlicePresentationPanel } from "./slice-presentation-panel"

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  action: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("convex/react", () => ({ useQuery: mocks.query }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))
vi.mock("@/app/(core)/admin/(authenticated)/slices/actions", () => ({
  setPresentationArchivedAction: mocks.action,
}))

let sourceCatalog: SlicePresentationCatalog
let archivedCatalog: SlicePresentationCatalog
let sourceRevision: string
let archivedRevision: string
beforeAll(async () => {
  sourceCatalog = await readSlicePresentationCatalog()
  archivedCatalog = await slicePresentationCatalogWithArchives(sourceCatalog, [
    { type: "hero-with-image", presentationId: "centered" },
  ])
  sourceRevision = sourceCatalog.revision
  archivedRevision = archivedCatalog.revision
})
function makeCatalog(archived = false): SlicePresentationCatalog {
  return archived ? archivedCatalog : sourceCatalog
}
let catalog: SlicePresentationCatalog | undefined
let owner: { ownerId: string } | undefined | null
let usage:
  | { status: "ready"; counts: Record<string, number> }
  | { status: "unavailable" }
  | undefined
let countError = false
const panel = <SlicePresentationPanel type="hero-with-image" />
function actionFailureStatus() {
  const status = screen
    .getAllByRole("status")
    .find((element) =>
      /could not be confirmed|n’a pas pu être confirmée/.test(
        element.textContent ?? ""
      )
    )
  if (!status)
    throw new Error("Presentation action failure status is not visible")
  return status
}

beforeEach(() => {
  vi.clearAllMocks()
  owner = { ownerId: "owner-1" }
  catalog = makeCatalog()
  usage = undefined
  countError = false
  mocks.query.mockImplementation((reference, args) => {
    const name = getFunctionName(reference)
    if (name === "cms/owner:getOwnerSession") return owner
    if (args === "skip") return undefined
    if (name === "cms/sliceLibrary:getSlicePresentationUsageSummary") {
      if (countError) throw new Error("Count subscription failed")
      return usage
    }
    return catalog
  })
  mocks.action.mockResolvedValue(makeCatalog(true))
})

describe("presentation curation", () => {
  it("protects Default and shows truthful loading in the Active description slot", sliceProfile(["hero-with-image"]), () => {
    render(panel)
    const locked = screen.getByRole("button", {
      name: "Default cannot be archived: required fallback",
    })
    expect(locked).toBeDisabled()
    fireEvent.click(locked)
    expect(mocks.action).not.toHaveBeenCalled()
    const centeredCard = screen
      .getByText("Centered")
      .closest('[data-slot="card"]')!
    expect(
      centeredCard.querySelector('[data-slot="card-description"]')
    ).toHaveTextContent("Counting occurrences…")
    expect(
      within(centeredCard as HTMLElement).getByText("Active")
    ).toBeInTheDocument()
    expect(
      screen.getByText("Required fallback · stays active")
    ).toBeInTheDocument()
  })
  it("opens inline consent and cancel performs no action", sliceProfile(["hero-with-image"]), () => {
    render(panel)
    fireEvent.click(screen.getByRole("button", { name: "Archive Centered" }))
    expect(
      screen.getByRole("heading", { name: "Archive Centered?" })
    ).toBeInTheDocument()
    expect(
      screen.getByText("No Page content or Published Snapshot changes.")
    ).toBeInTheDocument()
    expect(mocks.action).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(
      screen.queryByRole("button", { name: "Confirm archive Centered" })
    ).not.toBeInTheDocument()
    expect(mocks.action).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
  it("confirms exact identity and trusted revision, without synthesizing catalog state", sliceProfile(["hero-with-image"]), async () => {
    render(panel)
    fireEvent.click(screen.getByRole("button", { name: "Archive Centered" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm archive Centered" })
    )
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
    expect(mocks.action).toHaveBeenCalledExactlyOnceWith({
      type: "hero-with-image",
      presentationId: "centered",
      archived: true,
      expectedCatalogRevision: sourceRevision,
    })
    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.queryByText("Archived")).not.toBeInTheDocument()
  })
  it.each(["en", "fr"] as const)(
    "Restore confirmation Cancel (%s) writes nothing", sliceProfile(["hero-with-image"]),
    (locale) => {
      catalog = makeCatalog(true)
      render(panel, { locale })
      fireEvent.click(
        screen.getByRole("button", {
          name:
            locale === "fr"
              ? "Restaurer Centrée pour les nouveaux choix"
              : "Restore Centered for new choices",
        })
      )
      expect(mocks.action).not.toHaveBeenCalled()
      fireEvent.click(
        screen.getByRole("button", {
          name: locale === "fr" ? "Annuler" : "Cancel",
        })
      )
      expect(screen.queryByRole("group")).not.toBeInTheDocument()
      expect(mocks.action).not.toHaveBeenCalled()
      expect(mocks.refresh).not.toHaveBeenCalled()
      expect(
        screen.getByText(locale === "fr" ? "Archivée" : "Archived")
      ).toBeInTheDocument()
    }
  )
  it.each(["en", "fr"] as const)(
    "Restore confirmation (%s) renders approved copy and commits exactly once", sliceProfile(["hero-with-image"]),
    async (locale) => {
      catalog = makeCatalog(true)
      render(panel, { locale })
      const french = locale === "fr"
      fireEvent.click(
        screen.getByRole("button", {
          name: french
            ? "Restaurer Centrée pour les nouveaux choix"
            : "Restore Centered for new choices",
        })
      )
      expect(mocks.action).not.toHaveBeenCalled()
      expect(
        screen.getByRole("heading", {
          name: french ? "Restaurer Centrée ?" : "Restore Centered?",
        })
      ).toBeInTheDocument()
      expect(
        screen.getByText(
          french
            ? "Disponible pour les nouvelles occurrences."
            : "Available for new occurrences."
        )
      ).toBeInTheDocument()
      expect(
        screen.getByText(
          french
            ? "Aucun changement du contenu des Pages ni des instantanés publiés."
            : "No Page content or Published Snapshot changes."
        )
      ).toBeInTheDocument()
      fireEvent.click(
        screen.getByRole("button", {
          name: french
            ? "Confirmer la restauration de Centrée"
            : "Confirm restore Centered",
        })
      )
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
      expect(mocks.action).toHaveBeenCalledExactlyOnceWith({
        type: "hero-with-image",
        presentationId: "centered",
        archived: false,
        expectedCatalogRevision: archivedRevision,
      })
      expect(
        screen.getByText(french ? "Archivée" : "Archived")
      ).toBeInTheDocument()
    }
  )
  it.each([undefined, null])(
    "skips catalog lookup while owner is %s", sliceProfile([]),
    (value) => {
      owner = value
      render(panel)
      expect(
        mocks.query.mock.calls.find(
          ([reference]) =>
            getFunctionName(reference) === "cms/slices:getPresentationCatalog"
        )?.[1]
      ).toBe("skip")
      expect(screen.getByRole("status")).toHaveTextContent(
        "could not be verified"
      )
      expect(screen.queryByRole("button")).not.toBeInTheDocument()
    }
  )
  it("discloses catalog loading and unavailable renderer without controls", sliceProfile([]), () => {
    catalog = undefined
    const view = render(panel)
    expect(screen.getByRole("status")).toHaveTextContent(
      "could not be verified"
    )
    catalog = {
      ...makeCatalog(),
      entries: makeCatalog().entries.map((entry) => ({
        ...entry,
        installed: false,
      })),
    }
    view.rerender(<SlicePresentationPanel type="hero-with-image" />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
  it.each([false, true])(
    "invalidates open consent on a live revision change (archived=%s)", sliceProfile(["hero-with-image"]),
    (archived) => {
      catalog = makeCatalog(archived)
      const view = render(panel)
      fireEvent.click(
        screen.getByRole("button", {
          name: archived
            ? "Restore Centered for new choices"
            : "Archive Centered",
        })
      )
      expect(mocks.action).not.toHaveBeenCalled()
      catalog = makeCatalog(!archived)
      view.rerender(<SlicePresentationPanel type="hero-with-image" />)
      expect(
        screen.queryByRole("button", {
          name: archived
            ? "Confirm restore Centered"
            : "Confirm archive Centered",
        })
      ).not.toBeInTheDocument()
      expect(mocks.action).not.toHaveBeenCalled()
    }
  )
  it.each([false, true])(
    "shows archive/restore refusal without refresh or fabricated membership (archived=%s)", sliceProfile(["hero-with-image"]),
    async (archived) => {
      catalog = makeCatalog(archived)
      mocks.action.mockRejectedValue(
        new Error("SLICE_PRESENTATION_CATALOG_STALE")
      )
      render(panel)
      fireEvent.click(
        screen.getByRole("button", {
          name: archived
            ? "Restore Centered for new choices"
            : "Archive Centered",
        })
      )
      fireEvent.click(
        screen.getByRole("button", {
          name: archived
            ? "Confirm restore Centered"
            : "Confirm archive Centered",
        })
      )
      await waitFor(() =>
        expect(actionFailureStatus()).toHaveTextContent(
          "The change could not be confirmed"
        )
      )
      expect(mocks.refresh).not.toHaveBeenCalled()
      expect(
        screen.getByText(archived ? "Archived" : "Active")
      ).toBeInTheDocument()
      expect(
        screen.queryByText(archived ? "Active" : "Archived")
      ).not.toBeInTheDocument()
    }
  )
  it.each([
    ["en", false],
    ["en", true],
    ["fr", false],
    ["fr", true],
  ] as const)(
    "never claims rollback after a committed change with failed acknowledgement (%s, previously archived=%s)", sliceProfile(["hero-with-image"]),
    async (locale, archived) => {
      catalog = makeCatalog(archived)
      mocks.action.mockImplementation(async () => {
        catalog = makeCatalog(!archived)
        throw new Error("acknowledgement unavailable")
      })
      const view = render(panel, { locale })
      const french = locale === "fr"
      fireEvent.click(
        screen.getByRole("button", {
          name: archived
            ? french
              ? "Restaurer Centrée pour les nouveaux choix"
              : "Restore Centered for new choices"
            : french
              ? "Archiver Centrée"
              : "Archive Centered",
        })
      )
      fireEvent.click(
        screen.getByRole("button", {
          name: archived
            ? french
              ? "Confirmer la restauration de Centrée"
              : "Confirm restore Centered"
            : french
              ? "Confirmer l’archivage de Centrée"
              : "Confirm archive Centered",
        })
      )
      await waitFor(() => expect(actionFailureStatus()).toBeInTheDocument())
      view.rerender(<SlicePresentationPanel type="hero-with-image" />)

      expect(
        screen.getByText(archived ? "Active" : french ? "Archivée" : "Archived")
      ).toBeInTheDocument()
      expect(mocks.action).toHaveBeenCalledExactlyOnceWith({
        type: "hero-with-image",
        presentationId: "centered",
        archived: !archived,
        expectedCatalogRevision: archived ? archivedRevision : sourceRevision,
      })
      expect(mocks.refresh).not.toHaveBeenCalled()
      const status = actionFailureStatus()
      expect(status).not.toHaveTextContent(
        /No presentation state was changed|Aucun état de présentation n’a été modifié|rollback/i
      )
      expect(status).toHaveTextContent(
        french
          ? "La modification n’a pas pu être confirmée. Vérifiez l’état actuel de la présentation avant de réessayer."
          : "The change could not be confirmed. Check the current presentation state before trying again."
      )
    }
  )
  it("keeps same-Type actions disabled during a mutation across revisions", sliceProfile(["hero-with-image"]), async () => {
    let finish!: (value: SlicePresentationCatalog) => void
    mocks.action.mockImplementation(
      () =>
        new Promise<SlicePresentationCatalog>((resolve) => {
          finish = resolve
        })
    )
    const view = render(panel)
    fireEvent.click(screen.getByRole("button", { name: "Archive Centered" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm archive Centered" })
    )
    expect(
      screen.getByRole("button", { name: "Archive Centered" })
    ).toBeDisabled()
    catalog = makeCatalog(true)
    view.rerender(<SlicePresentationPanel type="hero-with-image" />)
    expect(
      screen.getByRole("button", { name: "Restore Centered for new choices" })
    ).toBeDisabled()
    await act(async () => finish(makeCatalog(true)))
  })
  it("ignores a late previous-Type completion", sliceProfile(["hero-with-image"]), async () => {
    let finish!: (value: SlicePresentationCatalog) => void
    mocks.action.mockImplementation(
      () =>
        new Promise<SlicePresentationCatalog>((resolve) => {
          finish = resolve
        })
    )
    const view = render(panel)
    fireEvent.click(screen.getByRole("button", { name: "Archive Centered" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm archive Centered" })
    )
    view.rerender(<SlicePresentationPanel type="feature-grid" />)
    await act(async () => finish(makeCatalog(true)))
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
  })
  it("renders French labels and inline consent", sliceProfile(["hero-with-image"]), () => {
    render(panel, { locale: "fr" })
    expect(
      screen.getByRole("region", { name: "Présentations" })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Archiver Centrée" }))
    expect(
      screen.getByRole("heading", { name: "Archiver Centrée ?" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Confirmer l’archivage de Centrée" })
    ).toBeInTheDocument()
  })
  it("does not query or render a different Type", sliceProfile([]), () => {
    render(<SlicePresentationPanel type="feature-grid" />)
    expect(mocks.query).not.toHaveBeenCalled()
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
  })
})

describe("occurrence counts on every Active non-Default card", () => {
  function twoActiveChoices() {
    const centered = sourceCatalog.entries.find(
      (entry) => entry.type === "hero-with-image" && entry.id === "centered"
    )!
    catalog = {
      ...sourceCatalog,
      entries: [
        ...sourceCatalog.entries,
        { ...centered, id: "split", label: "Split" },
      ],
    } as unknown as SlicePresentationCatalog
  }
  it.each(["en", "fr"] as const)(
    "renders all approved count states on both cards (%s)", sliceProfile(["hero-with-image"]),
    (locale) => {
      twoActiveChoices()
      const french = locale === "fr"
      const view = render(panel, { locale })
      const centeredName = french ? "Centrée" : "Centered"
      const cards = () =>
        [centeredName, "Split"].map(
          (name) =>
            screen
              .getByText(name, { exact: true })
              .closest('[data-slot="card"]') as HTMLElement
        )
      for (const card of cards())
        expect(
          within(card).getByText(
            french ? "Calcul des occurrences…" : "Counting occurrences…"
          )
        ).toBeInTheDocument()
      for (const n of [0, 1, 12800]) {
        usage = { status: "ready", counts: { centered: n, split: n } }
        view.rerender(<SlicePresentationPanel type="hero-with-image" />)
        const number = new Intl.NumberFormat(locale).format(n)
        const copy = french
          ? `${number} ${n === 1 ? "occurrence existante" : "occurrences existantes"}`
          : `${number} existing ${n === 1 ? "occurrence" : "occurrences"}`
        for (const card of cards())
          expect(
            within(card).getByText(copy, {
              normalizer: getDefaultNormalizer({ collapseWhitespace: false }),
            })
          ).toBeInTheDocument()
      }
      usage = { status: "unavailable" }
      view.rerender(<SlicePresentationPanel type="hero-with-image" />)
      for (const card of cards()) {
        expect(
          within(card).getByText(
            french
              ? "Nombre d’occurrences indisponible"
              : "Occurrence count unavailable"
          )
        ).toBeInTheDocument()
        expect(within(card).getByRole("button")).toBeEnabled()
      }
      expect(
        screen.getByText(
          french
            ? "Disponible pour les nouvelles occurrences"
            : "Available for new occurrences"
        )
      ).toBeInTheDocument()
    }
  )
  it.each(["en", "fr"] as const)(
    "count error boundary preserves cards and Archive consent (%s)", sliceProfile(["hero-with-image"]),
    (locale) => {
      twoActiveChoices()
      countError = true
      const errors = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        render(panel, { locale })
        expect(
          screen.getAllByText(
            locale === "fr"
              ? "Nombre d’occurrences indisponible"
              : "Occurrence count unavailable"
          )
        ).toHaveLength(2)
        const label = locale === "fr" ? "Archiver Split" : "Archive Split"
        fireEvent.click(screen.getByRole("button", { name: label }))
        expect(
          screen.getByRole("heading", {
            name: locale === "fr" ? "Archiver Split ?" : "Archive Split?",
          })
        ).toBeInTheDocument()
        fireEvent.click(
          screen.getByRole("button", {
            name: locale === "fr" ? "Annuler" : "Cancel",
          })
        )
        expect(mocks.action).not.toHaveBeenCalled()
      } finally {
        errors.mockRestore()
      }
    }
  )
  it("does not guess zero from a ready reply missing the requested bucket", sliceProfile(["hero-with-image"]), () => {
    usage = { status: "ready", counts: {} }
    render(panel)
    expect(screen.getByText("Occurrence count unavailable")).toBeInTheDocument()
    expect(screen.queryByText("0 existing occurrences")).not.toBeInTheDocument()
  })
  it("Archived copy remains unchanged and makes no count subscription", sliceProfile(["hero-with-image"]), () => {
    catalog = makeCatalog(true)
    render(panel)
    expect(
      screen.getByText("Kept on existing occurrences. Hidden from new choices.")
    ).toBeInTheDocument()
    expect(
      mocks.query.mock.calls.some(
        ([ref]) =>
          getFunctionName(ref) ===
          "cms/sliceLibrary:getSlicePresentationUsageSummary"
      )
    ).toBe(false)
  })
})
