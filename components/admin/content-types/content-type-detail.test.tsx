import { screen } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { adminContentTypeDetail } from "@/lib/admin/content-types"
import { isActiveContentType } from "@/convex/lib/contentTypes"
import { render } from "@/test-utils/admin-i18n"

vi.mock("convex/react", () => ({ useQuery: () => [] }))

vi.mock("./use-archived-content-types", () => ({
  useArchivedContentTypes: () => ({ status: "ready", archived: new Set() }),
}))

vi.mock("./content-type-lifecycle-panel", () => ({
  ContentTypeLifecyclePanel: () => null,
}))

vi.mock("./content-type-languages-card", () => ({
  ContentTypeLanguagesCard: () => null,
}))

import { ContentTypeDetail } from "./content-type-detail"

describe("ContentTypeDetail admin i18n", () => {
  test.runIf(isActiveContentType("author"))("translates descriptor-driven labels without changing descriptor data", () => {
    const detail = adminContentTypeDetail("author")
    expect(detail).not.toBeNull()

    render(<ContentTypeDetail detail={detail!} starter={null} />, {
      locale: "fr",
    })

    expect(screen.getByRole("heading", { name: "Auteur" })).toBeInTheDocument()
    expect(screen.getByText("Champs partagés")).toBeInTheDocument()
    expect(screen.getByText("Liens sociaux")).toBeInTheDocument()
    expect(screen.getAllByText("Affiché sur le site").length).toBeGreaterThan(0)
    expect(detail?.singular).toBe("Author")
  })
})
