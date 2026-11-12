import { sliceProfileAny, sliceProfile } from "@/test-utils/slice-profile"
import { fireEvent, screen } from "@testing-library/react"
import { beforeAll, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import { createSampleSlice } from "@/lib/slices/sample"
import { INSTALLED_SLICE_TYPES } from "@/convex/lib/slices"
import {
  readSlicePresentationCatalog,
  slicePresentationCatalogRevision,
  type SlicePresentationCatalog,
} from "@/convex/lib/slices/presentations"
import { SlicePresentationSelector } from "./slice-presentation-selector"

let catalog: SlicePresentationCatalog
beforeAll(async () => {
  catalog = await readSlicePresentationCatalog()
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

test("chooses the centered renderer while preserving the complete occurrence content", sliceProfile(["hero-with-image"]), async () => {
  const slice = createSampleSlice("hero-with-image")
  const before = JSON.stringify(slice)
  const onChange = vi.fn()
  render(
    <SlicePresentationSelector
      slice={slice}
      catalog={catalog}
      onChange={onChange}
    />
  )
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Presentation" }), {
    key: "ArrowDown",
  })
  fireEvent.click(await screen.findByRole("option", { name: "Centered" }))
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: /Confirm Centered/ }))
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange.mock.calls[0][0]).toEqual({
    ...slice,
    presentationIdV1: "centered",
  })
  expect(JSON.stringify(slice)).toBe(before)
})

test.each(["en", "fr"] as const)(
  "assigns a later catalog presentation using its plain trusted label in %s", sliceProfile(["hero-with-image"]),
  async (locale) => {
    // A future owned definition extends the app's finite ID union. Keep the
    // source catalog types unchanged while exercising that actual wire shape.
    const nextCatalog: SlicePresentationCatalog = JSON.parse(
      JSON.stringify({
        ...catalog,
        entries: [
          ...catalog.entries,
          {
            type: "hero-with-image",
            id: "grid-reviewed",
            label: "Grid reviewed",
            state: "active",
            installed: true,
            contractSha256: catalog.contractDigests["hero-with-image"],
            rendererSource:
              "components/slices/presentations/hero-with-image-grid-reviewed.tsx",
          },
        ],
      })
    )
    const currentCatalog = {
      ...nextCatalog,
      revision: await slicePresentationCatalogRevision(nextCatalog),
    }
    const slice = {
      ...createSampleSlice("hero-with-image"),
      presentationIdV1: "centered",
    }
    const before = JSON.stringify(slice)
    const onChange = vi.fn()
    render(
      <SlicePresentationSelector
        slice={slice}
        catalog={currentCatalog}
        onChange={onChange}
      />,
      { locale }
    )
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" })
    expect(
      await screen.findByRole("option", {
        name: locale === "en" ? "Default" : "Par défaut",
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("option", {
        name: locale === "en" ? "Centered" : "Centrée",
      })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("option", { name: "Grid reviewed" }))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", {
        name:
          locale === "en" ? /Confirm Grid reviewed/ : /Confirmer Grid reviewed/,
      })
    )
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange.mock.calls[0][0]).toEqual({
      ...slice,
      presentationIdV1: "grid-reviewed",
    })
    expect(onChange.mock.calls[0][0].primary).toBe(slice.primary)
    expect(onChange.mock.calls[0][0].items).toBe(slice.items)
    expect(JSON.stringify(slice)).toBe(before)
  }
)

test("keeps an unknown saved choice and shows its default fallback explicitly", sliceProfile(["hero-with-image"]), () => {
  const slice = {
    ...createSampleSlice("hero-with-image"),
    presentationIdV1: "removed-choice",
  }
  const onChange = vi.fn()
  render(
    <SlicePresentationSelector
      slice={slice}
      catalog={catalog}
      onChange={onChange}
    />
  )
  expect(screen.getByRole("status")).toHaveTextContent(
    "default design is shown"
  )
  expect(screen.getByRole("combobox")).toHaveTextContent(
    "Saved choice: removed-choice"
  )
  expect(onChange).not.toHaveBeenCalled()
  expect(slice.presentationIdV1).toBe("removed-choice")
})

test("shows a retained archived choice without offering it to new occurrences", sliceProfile(["hero-with-image"]), async () => {
  const archived = {
    ...catalog,
    entries: catalog.entries.map((entry) =>
      entry.id === "centered" ? { ...entry, state: "archived" as const } : entry
    ),
  }
  const slice = {
    ...createSampleSlice("hero-with-image"),
    presentationIdV1: "centered",
  }
  const onChange = vi.fn()
  render(
    <SlicePresentationSelector
      slice={slice}
      catalog={archived}
      onChange={onChange}
    />
  )
  expect(screen.getByRole("status")).toHaveTextContent(
    "retired from new choices"
  )
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" })
  const centered = await screen.findByRole("option", { name: "Centered" })
  expect(centered).toHaveAttribute("aria-disabled", "true")
  fireEvent.click(centered)
  expect(onChange).not.toHaveBeenCalled()
})

test("disables choices until the authoritative catalog is available", sliceProfile([]), () => {
  const onChange = vi.fn()
  render(
    <SlicePresentationSelector
      slice={createSampleSlice("hero-with-image")}
      onChange={onChange}
    />
  )
  expect(screen.getByRole("combobox")).toBeDisabled()
  expect(screen.getByRole("status")).toHaveTextContent("could not be verified")
  expect(onChange).not.toHaveBeenCalled()
})

test("keeps the ordinary form unchanged for an installed Type with only its default design", sliceProfileAny(["faq-simple", "features-icon-grid", "rich-text-body"]), () => {
  const type = INSTALLED_SLICE_TYPES.find(
    (type) =>
      catalog.entries.some(
        (entry) => entry.type === type && entry.id === "default"
      ) &&
      !catalog.entries.some(
        (entry) => entry.type === type && entry.id !== "default"
      )
  )
  if (!type) throw new Error("The test requires an installed default-only Type")
  render(
    <SlicePresentationSelector
      slice={createSampleSlice(type)}
      catalog={catalog}
      onChange={vi.fn()}
    />
  )
  expect(screen.queryByRole("combobox")).toBeNull()
})

test.each(["en", "fr"] as const)(
  "cancel keeps the draft unchanged; explicit confirm addresses the content locale in %s", sliceProfile(["hero-with-image"]),
  async (locale) => {
    const slice = {
      ...createSampleSlice("hero-with-image"),
      presentationIdV1: "centered",
    }
    const onChange = vi.fn()
    const context = {
      pageId: "page-home",
      pageTitle: "Home",
      occurrenceLabel: "Hero #2",
      locale: "fr",
      otherLocales: ["en"],
    }
    render(
      <SlicePresentationSelector
        slice={slice}
        catalog={catalog}
        context={context}
        onChange={onChange}
      />,
      { locale }
    )
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" })
    fireEvent.click(
      await screen.findByRole("option", {
        name: locale === "en" ? "Default" : "Par défaut",
      })
    )
    expect(screen.getByText("Home · Hero #2")).toBeInTheDocument()
    expect(
      screen.getByText(locale === "en" ? "French only" : "français uniquement")
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        locale === "en"
          ? /English and the public snapshot/
          : /anglais et l’instantané public/
      )
    ).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", {
        name: locale === "en" ? "Cancel" : "Annuler",
      })
    )
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole("combobox")).toHaveTextContent(
      locale === "en" ? "Centered" : "Centrée"
    )
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" })
    fireEvent.click(
      await screen.findByRole("option", {
        name: locale === "en" ? "Default" : "Par défaut",
      })
    )
    fireEvent.click(
      screen.getByRole("button", {
        name:
          locale === "en"
            ? /Confirm Default for this French/
            : /Confirmer Par défaut.*français/,
      })
    )
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      ...slice,
      presentationIdV1: "default",
    })
  }
)

for (const profileRow of [
  "page",
  "epoch",
  "locale",
  "occurrence",
  "type",
  "content",
  "catalog",
]) {
  test.each([profileRow])("pending replacement cannot survive a %s identity change", sliceProfile(["hero-with-image"]),
    async (change) => {
      const slice = createSampleSlice("hero-with-image")
      const context = {
        pageId: "page-a",
        contentEpoch: 1,
        pageTitle: "Home",
        occurrenceLabel: "Hero #1",
        locale: "en",
        otherLocales: ["fr"],
      }
      const onChange = vi.fn()
      const view = render(
        <SlicePresentationSelector
          slice={slice}
          catalog={catalog}
          context={context}
          onChange={onChange}
        />
      )
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" })
      fireEvent.click(await screen.findByRole("option", { name: "Centered" }))
      expect(
        screen.getByRole("button", { name: /Confirm Centered/ })
      ).toBeInTheDocument()
      const nextContext = {
        ...context,
        ...(change === "page" ? { pageId: "page-b" } : {}),
        ...(change === "epoch" ? { contentEpoch: 2 } : {}),
        ...(change === "locale" ? { locale: "fr", otherLocales: ["en"] } : {}),
      }
      const nextSlice =
        change === "type"
          ? createSampleSlice("hero-agency")
          : {
              ...slice,
              ...(change === "occurrence" ? { id: "another-hero" } : {}),
              ...(change === "content" ? { enabled: false } : {}),
            }
      const nextCatalog =
        change === "catalog"
          ? {
              ...catalog,
              entries: catalog.entries.map((entry) =>
                entry.id === "centered"
                  ? { ...entry, state: "archived" as const }
                  : entry
              ),
            }
          : catalog
      const trusted =
        change === "catalog"
          ? {
              ...nextCatalog,
              revision: await slicePresentationCatalogRevision(nextCatalog),
            }
          : nextCatalog
      view.rerender(
        <SlicePresentationSelector
          slice={nextSlice}
          catalog={trusted}
          context={nextContext}
          onChange={onChange}
        />
      )
      expect(
        screen.queryByRole("button", { name: /Confirm Centered/ })
      ).toBeNull()
      expect(onChange).not.toHaveBeenCalled()
      view.rerender(
        <SlicePresentationSelector
          slice={slice}
          catalog={catalog}
          context={context}
          onChange={onChange}
        />
      )
      expect(
        screen.queryByRole("button", { name: /Confirm Centered/ })
      ).toBeNull()
      expect(onChange).not.toHaveBeenCalled()
    }
  )
}
