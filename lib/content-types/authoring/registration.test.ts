import { describe, expect, test } from "vitest"
import type { ContentTypeManifestEntry } from "./manifest"
import {
  renderContentTypeIndexRegions,
  renderInputShapeRegions,
  renderPageTypeRegions,
  renderRendererRegions,
  renderSchemaRegions,
} from "./registration"

const entries: ContentTypeManifestEntry[] = [
  {
    type: "event",
    module: "event",
    exportName: "eventContentType",
    labels: { en: { singular: "Event", plural: "Events" } },
    selected: true,
    sliceBody: true,
    pathPrefix: "events",
    renderer: "default-slice-body",
    sharedFieldKeys: ["startsAt"],
    localizedFieldKeys: ["title"],
  },
  {
    type: "quote",
    module: "quote",
    exportName: "quoteContentType",
    labels: { en: { singular: "Quote", plural: "Quotes" } },
    selected: true,
    sliceBody: false,
    renderer: "none",
    sharedFieldKeys: ["speaker"],
    localizedFieldKeys: ["title", "body"],
  },
]

describe("content-type registration projections", () => {
  test("projects every storage and runtime enumeration from one manifest", () => {
    const index = renderContentTypeIndexRegions(entries)
    const pageTypes = renderPageTypeRegions(entries)
    const schema = renderSchemaRegions(entries)
    const inputs = renderInputShapeRegions(entries)
    const renderers = renderRendererRegions(entries)

    expect(index.imports).toContain(
      'import { eventContentType } from "./event"'
    )
    expect(index.definitions).toContain("event: eventContentType")
    expect(index.validator).toContain('v.literal("quote")')
    expect(pageTypes.pageTypes).toContain('"event"')
    expect(schema.liveArms).toContain(
      "armLocalizedContentValidator(eventContentType)"
    )
    expect(schema.liveArms).toContain(
      "armLocalizedContentValidatorNoSlices(quoteContentType)"
    )
    expect(schema.stagingArms).toContain("eventStagingArmFields")
    expect(schema.pageDocValidator).toContain("...quoteArmFields")
    expect(schema.pageWithStagedOverlayValidator).toContain(
      "...eventArmFields"
    )
    expect(schema.pageWithStagedOverlayValidator).toContain(
      "...stagedOverlayExtras"
    )
    expect(inputs.arms).toContain("eventDraftInput")
    expect(inputs.arms).toContain(
      [
        "const quoteDraftInput = v.object({",
        '  pageType: v.literal("quote"),',
        "  localized: quoteContentType.localizedValidator,",
        "})",
      ].join("\n")
    )
    expect(renderers.imports).toContain("DefaultSliceBodyRenderer")
    expect(renderers.registry).toContain(
      'event: { kind: "sliceBody", Component: DefaultSliceBodyRenderer }'
    )
    expect(renderers.registry).not.toContain("quote:")
  })
})
