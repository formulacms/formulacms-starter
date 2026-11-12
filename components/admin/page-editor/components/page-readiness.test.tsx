import { fireEvent, screen } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { describe, expect, it, vi } from "vitest"
import type { PrePublishChecklist } from "../lib/types"
import { PageReadinessContent } from "./page-readiness"

function checklist(
  partial: Partial<PrePublishChecklist> = {}
): PrePublishChecklist {
  return { canPublish: false, blockers: [], warnings: [], ...partial }
}

describe("PageReadinessContent", () => {
  it("explains that the report is read-only and publish rechecks it", () => {
    render(
      <PageReadinessContent
        checklist={checklist()}
        warningsAcknowledged={false}
        canGenerateMeta={false}
        onAction={vi.fn()}
      />
    )

    expect(screen.getByText("Ready to publish")).toBeInTheDocument()
    expect(
      screen.getByText(
        "This report does not change your draft. Publishing runs a final check."
      )
    ).toBeInTheDocument()
  })

  it("lists current issues and delegates a bounded suggestion", () => {
    const onAction = vi.fn()
    render(
      <PageReadinessContent
        checklist={checklist({
          blockers: [
            {
              code: "broken_internal_link",
              severity: "blocker",
              message: "A linked page no longer exists.",
            },
          ],
          warnings: [
            {
              code: "missing_seo_title",
              severity: "warning",
              message: "Add an SEO title.",
            },
          ],
        })}
        warningsAcknowledged={false}
        canGenerateMeta
        onAction={onAction}
      />
    )

    expect(
      screen.getByText(
        "This content refers to a page that no longer exists. Replace the reference before publishing."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Add an SEO title for the selected language before publishing."
      )
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole("button", { name: "Generate SEO suggestion" })
    )
    expect(onAction).toHaveBeenCalledWith({
      id: "generate-meta",
      label: "Generate SEO suggestion",
    })
  })

  it("shows a loading state without inventing suggestions", () => {
    render(
      <PageReadinessContent
        warningsAcknowledged={false}
        canGenerateMeta={false}
        onAction={vi.fn()}
      />
    )

    expect(screen.getByText("Checking the saved draft…")).toBeInTheDocument()
    expect(screen.queryByText("Next steps")).not.toBeInTheDocument()
  })

  it.each([
    ["en", "We couldn’t check this page. You can keep editing.", "Try again"],
    [
      "fr",
      "Impossible de vérifier cette page. Vous pouvez continuer à la modifier.",
      "Réessayer",
    ],
  ] as const)(
    "NEW keeps a checklist error local and offers retry in %s",
    (locale, copy, retry) => {
      const onRetry = vi.fn()
      render(
        <PageReadinessContent
          checklistError
          warningsAcknowledged={false}
          canGenerateMeta={false}
          onRetry={onRetry}
          onAction={vi.fn()}
        />,
        { locale }
      )

      expect(screen.getByRole("alert")).toHaveTextContent(copy)
      expect(screen.queryByText("Ready to publish")).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: retry }))
      expect(onRetry).toHaveBeenCalledOnce()
    }
  )
})
