import { describe, it, expect } from "vitest"
import { screen } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { PrePublishChecklistContent } from "./pre-publish-checklist"
import type { PrePublishChecklist } from "../lib/types"

function checklist(
  partial: Partial<PrePublishChecklist> = {}
): PrePublishChecklist {
  return { canPublish: true, blockers: [], warnings: [], ...partial }
}

describe("PrePublishChecklistContent", () => {
  it("shows a loading state when the checklist is not yet available", () => {
    render(<PrePublishChecklistContent warningsAcknowledged={false} />)
    expect(screen.getByText("Loading…")).toBeInTheDocument()
  })

  it("shows a ready state when there are no blockers or warnings", () => {
    render(
      <PrePublishChecklistContent
        checklist={checklist()}
        warningsAcknowledged={false}
      />
    )
    expect(screen.getByText("Ready to publish")).toBeInTheDocument()
  })

  it("lists blocker and warning messages under their headings", () => {
    render(
      <PrePublishChecklistContent
        checklist={checklist({
          canPublish: false,
          blockers: [
            { code: "b1", severity: "blocker", message: "Missing title" },
          ],
          warnings: [
            { code: "w1", severity: "warning", message: "Short description" },
          ],
        })}
        warningsAcknowledged={false}
      />
    )
    expect(screen.getByText("Blockers")).toBeInTheDocument()
    expect(screen.getByText("Missing title")).toBeInTheDocument()
    expect(screen.getByText("Warnings")).toBeInTheDocument()
    expect(screen.getByText("Short description")).toBeInTheDocument()
    expect(screen.queryByText("Warnings acknowledged")).not.toBeInTheDocument()
  })

  it("shows the acknowledged note only when warnings are acknowledged", () => {
    render(
      <PrePublishChecklistContent
        checklist={checklist({
          warnings: [{ code: "w1", severity: "warning", message: "Heads up" }],
        })}
        warningsAcknowledged
      />
    )
    expect(screen.getByText("Warnings acknowledged")).toBeInTheDocument()
  })
})

  it("translates a known server code instead of displaying its English message", () => {
    render(<PrePublishChecklistContent checklist={checklist({ canPublish: false, blockers: [{ code: "missing_default_locale_title", severity: "blocker", message: "SERVER ENGLISH", locales: ["en"] }] })} warningsAcknowledged={false} />, { locale: "fr" })
    expect(screen.getByText("Ajoutez un titre dans la langue par défaut (EN) avant de publier.", { exact: true })).toBeInTheDocument()
    expect(screen.queryByText("SERVER ENGLISH")).not.toBeInTheDocument()
  })

  it("localizes descriptor and field parameters in the rendered checklist", () => {
    render(<PrePublishChecklistContent checklist={checklist({ canPublish: false, blockers: [{ code: "missing_required_field", severity: "blocker", message: "Author is missing required name.", params: { contentType: "author", fieldName: "name" } }] })} warningsAcknowledged={false} />, { locale: "fr" })
    expect(screen.getByText("Auteur : le champ obligatoire Nom est vide.", { exact: true })).toBeInTheDocument()
    expect(screen.queryByText("Author is missing required name.")).not.toBeInTheDocument()
  })
