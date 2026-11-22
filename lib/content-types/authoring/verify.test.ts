import { describe, expect, test } from "vitest"
import type { ContentTypeManifestEntry } from "./manifest"
import { readContentTypeManifest } from "./registration"
import {
  contentTypeFieldSimilarity,
  rendererRegistrationErrors,
  verifyContentTypes,
} from "./verify"

describe("verifyContentTypes", () => {
  test("verifies every registered content type through the manifest", async () => {
    const result = await verifyContentTypes({
      root: process.cwd(),
      type: "all",
    })

    expect(result.errors).toEqual([])
    // Read the list: the starter registers fewer types than the source.
    expect(result.verifiedTypes).toEqual(
      (await readContentTypeManifest(process.cwd())).map(({ type }) => type)
    )
  })

  test("verifies one requested type without reporting on the others", async () => {
    // The renderer-side checks deliberately run across the whole manifest —
    // a broken registration is a repository fact, not a per-type one — but the
    // descriptor pass and the report must narrow to what was asked for.
    const result = await verifyContentTypes({
      root: process.cwd(),
      type: "post",
    })

    expect(result.errors).toEqual([])
    expect(result.verifiedTypes).toEqual(["post"])
  })

  test("reports an unknown type rather than silently verifying nothing", async () => {
    const result = await verifyContentTypes({
      root: process.cwd(),
      type: "not-a-content-type",
    })

    expect(result.errors).toContain("Unknown content type: not-a-content-type.")
    expect(result.verifiedTypes).toEqual([])
  })

  test("warns from domain fields rather than universal title metadata", () => {
    const base: ContentTypeManifestEntry = {
      type: "event",
      module: "event",
      exportName: "eventContentType",
      labels: { en: { singular: "Event", plural: "Events" } },
      selected: true,
      blockBody: true,
      renderer: "default-block-body",
      sharedFieldKeys: ["startsAt", "venueId"],
      localizedFieldKeys: ["title", "summary"],
    }
    const nearDuplicate: ContentTypeManifestEntry = {
      ...base,
      type: "session",
      module: "session",
      exportName: "sessionContentType",
      sharedFieldKeys: ["startsAt", "venueId"],
    }

    expect(contentTypeFieldSimilarity(base, nearDuplicate)).toBe(1)
  })

  test("scores two types that declare nothing beyond universal metadata as identical", () => {
    // The ADR-0039 case the guard exists for: a new type that differs from an
    // existing one only by name. Both comparison sets reduce to empty once the
    // universal metadata is excluded — that must read as identical, not as
    // "nothing in common".
    const base: ContentTypeManifestEntry = {
      type: "page",
      module: "page",
      exportName: "pageContentType",
      labels: { en: { singular: "Page", plural: "Pages" } },
      selected: true,
      blockBody: true,
      renderer: "default-block-body",
      sharedFieldKeys: [],
      localizedFieldKeys: ["title", "metaTitle", "metaDescription"],
    }
    const twin: ContentTypeManifestEntry = {
      ...base,
      type: "microsite",
      module: "microsite",
      exportName: "micrositeContentType",
    }

    expect(contentTypeFieldSimilarity(base, twin)).toBe(1)
  })

  test("does not equate a bare type with one that has distinguishing fields", () => {
    const bare: ContentTypeManifestEntry = {
      type: "page",
      module: "page",
      exportName: "pageContentType",
      labels: { en: { singular: "Page", plural: "Pages" } },
      selected: true,
      blockBody: true,
      renderer: "default-block-body",
      sharedFieldKeys: [],
      localizedFieldKeys: ["title"],
    }
    const distinguished: ContentTypeManifestEntry = {
      ...bare,
      type: "job",
      module: "job",
      exportName: "jobContentType",
      sharedFieldKeys: ["department", "jobStatus"],
    }

    expect(contentTypeFieldSimilarity(bare, distinguished)).toBe(0)
  })

  test("stays silent about field twins whose duplication is a recorded decision", async () => {
    // page and landing-page are field-identical by ADR-0037. Now that the
    // metric scores them 1, the allowlist is what keeps the check from crying
    // wolf on every run — the warning has to stay rare to stay readable.
    const result = await verifyContentTypes({
      root: process.cwd(),
      type: "all",
    })

    expect(
      result.warnings.filter((warning) => warning.includes("similar by field identity"))
    ).toEqual([])
  })

  test("blocks a routable pure-form type until its renderer is registered", () => {
    const entry: ContentTypeManifestEntry = {
      type: "location",
      module: "location",
      exportName: "locationContentType",
      labels: { en: { singular: "Location", plural: "Locations" } },
      selected: true,
      blockBody: false,
      pathPrefix: "locations",
      renderer: "none",
      sharedFieldKeys: [],
      localizedFieldKeys: ["title", "address"],
    }

    expect(rendererRegistrationErrors([entry])).toEqual([
      expect.stringContaining("needs a registered public renderer"),
    ])
    expect(
      rendererRegistrationErrors([
        {
          ...entry,
          renderer: "custom-pure-form",
          rendererModule: "./location",
          rendererExport: "LocationRenderer",
        },
      ])
    ).toEqual([])
  })

})
