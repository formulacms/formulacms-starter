import { describe, expect, test } from "vitest"
import { generateContentType } from "./generate"
import { parseContentTypeSpecJson } from "./spec"

describe("parseContentTypeSpecJson", () => {
  test("accepts a domain-neutral routable content type", () => {
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
          startsAt: {
            kind: "datetime",
            public: true,
          },
          venue: {
            kind: "relation",
            optional: true,
            public: true,
            config: { pageTypes: ["page"] },
          },
        },
        localizedFields: {
          title: {
            kind: "text",
            public: true,
            config: { placeholder: "Untitled event" },
          },
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

    expect(spec.type).toBe("event")
    expect(spec.routing).toEqual({ pathPrefix: "events" })
    expect(spec.sharedFields.venue).toMatchObject({
      kind: "relation",
      optional: true,
      public: true,
    })
    expect(spec.labels.fr.plural).toBe("Événements")
  })

  test("accepts a routable pure-form model for a reviewed custom renderer", () => {
    const spec = parseContentTypeSpecJson(
      JSON.stringify({
        type: "location",
        labels: {
          en: { singular: "Location", plural: "Locations" },
          fr: { singular: "Lieu", plural: "Lieux" },
        },
        routing: { pathPrefix: "locations" },
        capabilities: {
          blockBody: false,
          revisions: true,
          scheduling: false,
          presence: true,
          requiresBodyContent: false,
        },
        sharedFields: {},
        localizedFields: {
          title: { kind: "text", public: true },
          address: { kind: "text", public: true },
        },
        referenceCard: {
          title: { scope: "localized", field: "title" },
          subtitle: { scope: "localized", field: "address" },
        },
      })
    )

    expect(spec.capabilities.blockBody).toBe(false)
    expect(spec.routing).toEqual({ pathPrefix: "locations" })
  })

  test("rejects reference-card pointers that cannot produce display text", () => {
    expect(() =>
      parseContentTypeSpecJson(
        JSON.stringify({
          type: "event",
          labels: {
            en: { singular: "Event", plural: "Events" },
          },
          capabilities: {
            blockBody: false,
            revisions: true,
            scheduling: false,
            presence: true,
            requiresBodyContent: false,
          },
          sharedFields: {
            hero: { kind: "image", public: true },
          },
          localizedFields: {
            title: { kind: "text", public: true },
          },
          referenceCard: {
            title: { scope: "shared", field: "hero" },
          },
        })
      )
    ).toThrow("referenceCard.title.field must reference a string-valued field")
  })

  describe("reserved storage names", () => {
    function specWith(
      sharedFields: Record<string, unknown>,
      localizedFields: Record<string, unknown>
    ) {
      return JSON.stringify({
        type: "event",
        labels: { en: { singular: "Event", plural: "Events" } },
        capabilities: {
          blockBody: true,
          revisions: true,
          scheduling: false,
          presence: true,
          requiresBodyContent: false,
        },
        sharedFields,
        localizedFields: { title: { kind: "text", public: true }, ...localizedFields },
        referenceCard: { title: { scope: "localized", field: "title" } },
      })
    }

    test("refuses a shared field the staging row already stores", () => {
      expect(() =>
        parseContentTypeSpecJson(
          specWith({ pageId: { kind: "text", public: true } }, {})
        )
      ).toThrow("Invalid content-type spec: sharedFields.pageId conflicts")
    })

    test("refuses a localized field every language already stores", () => {
      expect(() =>
        parseContentTypeSpecJson(
          specWith({}, { cardExcerpt: { kind: "text", public: true } })
        )
      ).toThrow("Invalid content-type spec: localizedFields.cardExcerpt conflicts")
      expect(() =>
        parseContentTypeSpecJson(
          specWith({}, { blocks: { kind: "text", public: true } })
        )
      ).toThrow("localizedFields.blocks conflicts")
    })

    test("refuses a shared field the admin editor supports only on post", () => {
      for (const field of ["tags", "authorIds"]) {
        expect(() =>
          parseContentTypeSpecJson(
            specWith({ [field]: { kind: "text", public: true } }, {})
          )
        ).toThrow(
          `Invalid content-type spec: sharedFields.${field}: the admin editor supports this field only on "post"; rename the field.`
        )
      }
    })

    test("a dry run refuses a post-only field too and returns no plan", async () => {
      // The order of `scripts/generate-content-type.ts`: parse, then plan.
      const dryRun = async () =>
        generateContentType(
          parseContentTypeSpecJson(
            specWith({ tags: { kind: "text", public: true } }, {})
          ),
          { dryRun: true }
        )
      await expect(dryRun()).rejects.toThrow(
        'sharedFields.tags: the admin editor supports this field only on "post"'
      )
    })
  })
})
