import { afterEach, describe, expect, test, vi } from "vitest"
import { planContentTypeGeneration } from "./generate"
import { parseContentTypeSpecJson } from "./spec"

// The declared admin languages; a test may replace the list.
const declared = vi.hoisted(() => ({ locales: ["en", "fr"] }))
vi.mock("../../i18n/admin-dictionaries", () => ({
  get ADMIN_DICTIONARY_LOCALES() {
    return declared.locales
  },
}))
afterEach(() => {
  declared.locales = ["en", "fr"]
})

const LABELS = {
  en: { singular: "Event", plural: "Events" },
  fr: { singular: "Événement", plural: "Événements" },
}

function eventSpec(labels: Record<string, unknown> = LABELS) {
  return parseContentTypeSpecJson(
    JSON.stringify({
      type: "event",
      labels,
      routing: { pathPrefix: "events" },
      capabilities: {
        blockBody: true,
        revisions: true,
        scheduling: true,
        presence: true,
        requiresBodyContent: false,
      },
      sharedFields: {
        startsAt: { kind: "datetime", public: true },
      },
      localizedFields: {
        title: { kind: "text", public: true },
      },
      referenceCard: {
        title: { scope: "localized", field: "title" },
      },
    })
  )
}

describe("planContentTypeGeneration", () => {
  test("plans every projection for a new content type without writing", async () => {
    const plan = await planContentTypeGeneration(eventSpec(), process.cwd())
    const paths = plan.files.map((file) => file.path)

    expect(paths).toContain("convex/lib/contentTypes/event.ts")
    expect(paths).toContain(
      "convex/lib/contentTypes/content-types.manifest.json"
    )
    expect(paths).toContain("convex/schema.ts")
    expect(paths).toContain("convex/lib/contentTypes/inputShapes.ts")
    expect(paths).toContain("components/content-types/index.ts")
    expect(paths).toContain("messages/admin/en.json")
    expect(paths).toContain("messages/admin/fr.json")
    expect(
      plan.files.find(
        (file) => file.path === "convex/lib/contentTypes/index.ts"
      )?.content
    ).toContain("event: eventContentType")
  })

  test("reads the admin languages from the declared list, not the folder", async () => {
    declared.locales = ["en"]
    const paths = (
      await planContentTypeGeneration(eventSpec(), process.cwd())
    ).files.map((file) => file.path)
    expect(paths).toContain("messages/admin/en.json")
    expect(paths).not.toContain("messages/admin/fr.json")
  })

  test("names the messages file of a declared language that has none", async () => {
    declared.locales = ["en", "fr", "de"]
    const spec = eventSpec({
      ...LABELS,
      de: { singular: "Veranstaltung", plural: "Veranstaltungen" },
    })
    await expect(
      planContentTypeGeneration(spec, process.cwd())
    ).rejects.toThrow("messages/admin/de.json is missing.")
  })
})
