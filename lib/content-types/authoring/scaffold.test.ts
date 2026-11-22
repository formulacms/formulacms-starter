import { describe, expect, test } from "vitest"
import { scaffoldContentType } from "./scaffold"
import { parseContentTypeSpecJson } from "./spec"

function customRendererSpec(overrides: Record<string, unknown> = {}) {
  return parseContentTypeSpecJson(
    JSON.stringify({
      type: "job-opening",
      labels: { en: { singular: "Job opening", plural: "Job openings" } },
      renderer: "custom",
      routing: { pathPrefix: "job-openings" },
      capabilities: {
        blockBody: true,
        revisions: true,
        scheduling: true,
        presence: true,
        requiresBodyContent: false,
      },
      sharedFields: {
        department: { kind: "text", optional: true, public: true },
        remoteType: {
          kind: "select",
          public: true,
          config: {
            options: ["remote", "hybrid", "onsite"],
            default: "onsite",
            labels: { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" },
          },
        },
        internalNotes: { kind: "text", optional: true },
        applyUrl: { kind: "link", optional: true, public: true },
      },
      localizedFields: {
        title: { kind: "text", public: true },
        summary: { kind: "text", optional: true, public: true },
      },
      referenceCard: { title: { scope: "localized", field: "title" } },
      ...overrides,
    })
  )
}

describe("scaffoldContentType", () => {
  test("emits a complete descriptor for an arbitrary content model", () => {
    const spec = parseContentTypeSpecJson(
      JSON.stringify({
        type: "event",
        labels: {
          en: { singular: "Event", plural: "Events" },
          fr: { singular: "Événement", plural: "Événements" },
        },
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
          venue: {
            kind: "relation",
            optional: true,
            public: true,
            config: { pageTypes: ["page"] },
          },
        },
        localizedFields: {
          title: { kind: "text", public: true },
          summary: {
            kind: "text",
            optional: true,
            public: true,
            config: { multiline: true },
          },
        },
        referenceCard: {
          title: { scope: "localized", field: "title" },
          subtitle: { scope: "localized", field: "summary" },
        },
        seo: { schemaOrgType: "Event", ogType: "website" },
      })
    )

    const output = scaffoldContentType(spec)

    expect(output.descriptorPath).toBe(
      "convex/lib/contentTypes/event.ts"
    )
    expect(output.descriptorSource).toContain(
      'export const eventContentType'
    )
    expect(output.descriptorSource).toContain(
      'startsAt: datetime().public()'
    )
    expect(output.descriptorSource).toContain(
      'venue: relation({ pageTypes: ["page"] }).optional().public()'
    )
    expect(output.descriptorSource).toContain(
      'routing: { pathPrefix: "events" }'
    )
    expect(output.descriptorSource).toContain("referenceCard:")
    expect(output.descriptorSource).not.toContain("Product")
    expect(output.manifestEntry).toMatchObject({
      type: "event",
      module: "event",
      exportName: "eventContentType",
      selected: true,
      blockBody: true,
      renderer: "default-block-body",
    })
  })

  test("quotes select option labels keyed by a hyphenated value", () => {
    const spec = parseContentTypeSpecJson(
      JSON.stringify({
        type: "job",
        labels: {
          en: { singular: "Job", plural: "Jobs" },
        },
        capabilities: {
          blockBody: true,
          revisions: true,
          scheduling: true,
          presence: true,
          requiresBodyContent: false,
        },
        sharedFields: {
          employmentType: {
            kind: "select",
            public: true,
            config: {
              options: ["full-time", "part-time"],
              default: "full-time",
              labels: { "full-time": "Full-time", "part-time": "Part-time" },
            },
          },
        },
        localizedFields: {
          title: { kind: "text", public: true },
        },
        referenceCard: {
          title: { scope: "localized", field: "title" },
        },
      })
    )

    const output = scaffoldContentType(spec)

    // Unquoted hyphenated keys (e.g. `full-time: "Full-time"`) are a syntax
    // error — the object-literal emitter must always quote object keys.
    expect(output.descriptorSource).toContain('"full-time": "Full-time"')
    expect(output.descriptorSource).toContain('"part-time": "Part-time"')
  })
})

describe("scaffoldContentType — renderer emission", () => {
  test("writes no renderer file when the shared block body will do", () => {
    const output = scaffoldContentType(customRendererSpec({ renderer: undefined }))

    expect(output.rendererPath).toBeUndefined()
    expect(output.rendererSource).toBeUndefined()
    expect(output.manifestEntry.renderer).toBe("default-block-body")
  })

  test("emits a renderer and registers it when the spec asks for one", () => {
    const output = scaffoldContentType(customRendererSpec())

    expect(output.rendererPath).toBe(
      "components/content-types/job-opening.tsx"
    )
    expect(output.manifestEntry).toMatchObject({
      renderer: "custom-block-body",
      rendererModule: "./job-opening",
      rendererExport: "JobOpeningRenderer",
    })
  })

  // verify-renderer-contract.test.ts holds the renderer-contract case of
  // the emitted renderer (source-only).

  test("reads select labels off the descriptor rather than restating them", () => {
    const source = scaffoldContentType(customRendererSpec()).rendererSource!

    expect(source).toContain(
      "selectLabel(jobOpeningContentType.sharedFields.remoteType, remoteType)"
    )
    expect(source).not.toContain('"On-site"')
  })

  test("renders no admin-only field and names what it left out", () => {
    const source = scaffoldContentType(customRendererSpec()).rendererSource!

    // `internalNotes` is not `.public()`, so it never reaches the stub at all.
    expect(source).not.toContain("internalNotes")
    // `applyUrl` is public but a link — rendering it needs a layout decision
    // the generator has no basis to make, so it is named, not guessed at.
    expect(source).toContain("applyUrl (link)")
  })

  test("carries a docblock skeleton with the ADR-0039 justification prompt", () => {
    const source = scaffoldContentType(customRendererSpec()).rendererSource!

    expect(source).toContain("Public renderer for `job-opening`")
    expect(source).toContain("ADR-0039 justification")
  })

  test("refuses a routable pure-form type that asks for the shared renderer", () => {
    // There is no pure-form fallback to fall back to, so this would generate a
    // tree that immediately fails `rendererRegistrationErrors`.
    expect(() =>
      scaffoldContentType(
        customRendererSpec({
          renderer: "default",
          capabilities: {
            blockBody: false,
            revisions: false,
            scheduling: false,
            presence: false,
            requiresBodyContent: false,
          },
        })
      )
    ).toThrow(/no pure-form fallback/)
  })

  test("gives a routable pure-form type a custom renderer by default", () => {
    const output = scaffoldContentType(
      customRendererSpec({
        renderer: undefined,
        capabilities: {
          blockBody: false,
          revisions: false,
          scheduling: false,
          presence: false,
          requiresBodyContent: false,
        },
      })
    )

    expect(output.manifestEntry.renderer).toBe("custom-pure-form")
    expect(output.rendererSource).toContain("PureFormRendererProps")
    expect(output.rendererSource).not.toContain("BlockList")
  })
})
