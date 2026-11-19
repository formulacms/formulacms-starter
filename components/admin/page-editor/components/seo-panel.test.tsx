import { screen } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { expect, test, vi } from "vitest"
import { SeoPanel } from "./seo-panel"

function renderPanel(metaGenerationAvailable: boolean, locale: "en" | "fr" = "en") {
  render(
    <SeoPanel
      currentLocale="en"
      title="Family dentistry"
      slices={[]}
      metaTitle=""
      metaDescription=""
      seoNoIndex={false}
      seoNoFollow={false}
      seoOgTitle=""
      seoOgDescription=""
      seoOgImage=""
      canGenerate
      metaGenerationAvailable={metaGenerationAvailable}
      isGeneratingMeta={false}
      fieldSourceMetaTitle=""
      fieldSourceMetaDescription=""
      fieldTranslate={undefined}
      fieldGenerate={undefined}
      onGenerateMeta={vi.fn()}
      onMetaTitleChange={vi.fn()}
      onMetaDescriptionChange={vi.fn()}
      onSeoNoIndexChange={vi.fn()}
      onSeoNoFollowChange={vi.fn()}
      onSeoOgTitleChange={vi.fn()}
      onSeoOgDescriptionChange={vi.fn()}
      onSeoOgImageChange={vi.fn()}
    />,
    { locale }
  )
}

test("shows metadata generation when either configured lane is reachable", () => {
  renderPanel(true)
  expect(
    screen.getByRole("button", { name: "Generate meta from page" })
  ).toBeInTheDocument()
})

test("hides metadata generation when neither configured lane is reachable", () => {
  renderPanel(false)
  expect(
    screen.queryByRole("button", { name: "Generate meta from page" })
  ).not.toBeInTheDocument()
})

test("renders editor SEO controls in French", () => {
  renderPanel(true, "fr")
  expect(
    screen.getByRole("button", {
      name: "Générer les métadonnées depuis la page",
    })
  ).toBeInTheDocument()
  expect(screen.getByText("Réseaux sociaux et indexation")).toBeInTheDocument()
})

// ADR-0037 amendment (2026-11-17): every field is per language except the
// social image, which carries the "Same in every language." hint.
test.each([
  ["en", "Social & indexing", "Same in every language."],
  ["fr", "Réseaux sociaux et indexation", "Identique dans toutes les langues."],
] as const)(
  "marks only the social image as shared (%s)",
  (locale, heading, hint) => {
    renderPanel(true, locale)
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
      new RegExp(`^${heading}$`)
    )
    expect(screen.getByTestId("og-image-hint")).toHaveTextContent(hint)
    expect(screen.getAllByText(hint)).toHaveLength(1)
  }
)
