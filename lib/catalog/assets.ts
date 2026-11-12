import { catalogSchema } from "./schema"

/**
 * A deliberately small catalog of real reference slices already shipped by
 * formulacms. Paid Plus source and unshipped roadmap assets do not belong here.
 */
export const catalogAssets = catalogSchema.parse([
  {
    schemaVersion: 1,
    id: "slice:hero-agency",
    slug: "hero-agency",
    kind: "slice",
    name: "Hero Agency",
    summary:
      "High-impact agency hero with eyebrow text and split footer layout.",
    group: "heroes",
    tags: ["agency", "hero", "services", "value-proposition"],
    version: "0.2.0",
    visibility: "public",
    status: "stable",
    compatibility: {
      nextcms: ">=0.2.0 <0.3.0",
      node: ">=20",
    },
    discovery: {
      purpose:
        "Capture an agency's primary value proposition and location or status.",
      goodFor: ["agency home pages", "studio landing pages", "service brands"],
    },
    availability: {
      mode: "included",
    },
    updatedAt: "2026-07-23T00:00:00.000Z",
  },
  {
    schemaVersion: 1,
    id: "slice:features-icon-grid",
    slug: "features-icon-grid",
    kind: "slice",
    name: "Features Icon Grid",
    summary: "Responsive grid of feature cards under a section heading.",
    group: "features",
    tags: ["capabilities", "features", "grid", "services"],
    version: "0.2.0",
    visibility: "public",
    status: "stable",
    compatibility: {
      nextcms: ">=0.2.0 <0.3.0",
      node: ">=20",
    },
    discovery: {
      purpose:
        "Present product capabilities or service highlights as scannable cards.",
      goodFor: ["feature overviews", "service lists", "benefit summaries"],
    },
    availability: {
      mode: "included",
    },
    updatedAt: "2026-07-23T00:00:00.000Z",
  },
  {
    schemaVersion: 1,
    id: "slice:contact-form",
    slug: "contact-form",
    kind: "slice",
    name: "Contact Form",
    summary: "Contact detail cards beside a localized, validated contact form.",
    group: "misc",
    tags: ["contact", "form", "lead-generation", "local-business"],
    version: "0.2.0",
    visibility: "public",
    status: "stable",
    compatibility: {
      nextcms: ">=0.2.0 <0.3.0",
      node: ">=20",
    },
    discovery: {
      purpose:
        "Give visitors direct contact options and a structured message form.",
      goodFor: ["contact pages", "lead capture", "local business websites"],
    },
    availability: {
      mode: "included",
    },
    updatedAt: "2026-07-23T00:00:00.000Z",
  },
])
