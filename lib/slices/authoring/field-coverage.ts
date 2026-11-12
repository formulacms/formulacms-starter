import type { Slice } from "@/convex/lib/slices"
import type { Primitive } from "@/convex/lib/slices/primitives"
import { walkDef } from "@/convex/lib/slices/walk"

export type CoverageDescriptor = { primary: Primitive; items?: Primitive }
export type FieldCoverage = {
  type: string
  presentation: string
  sourceTarget: string
  path: string
  kind: string
  status: "bound" | "structural" | "unsupported" | "legacy"
  reason: string
}

/** A blocking migration obligation, never an exclusion or a successful gate.
 * Keep this inventory typed even when all declared migrations are satisfied. */
type CoverageMigrationPending = {
  type: Slice["type"]
  presentation: string
  sourceTarget: string
  paths: readonly string[]
  status: "migration-pending"
  reason: string
}
export const COVERAGE_MIGRATION_PENDING: readonly CoverageMigrationPending[] =
  []

/** Source-owned migration inventory. These exceptions describe exact seams,
 * never an exemption for all text, custom components, client islands or links.
 * Every registered presentation uses the same descriptor inventory. */
export const COVERAGE_EXCLUSIONS = [
  {
    type: "cta-band",
    path: "*",
    status: "legacy",
    reason:
      "Named CTA migration is separate; slice selection and first-control form fallback remain.",
  },
  {
    type: "features-icon-grid",
    path: "items[].icon",
    status: "structural",
    reason: "SliceIcon is aria-hidden decoration.",
  },
  {
    type: "hero-with-image",
    path: "primary.eyebrowLink",
    status: "structural",
    reason:
      "Announcement link destination; its authored label is bound separately.",
  },
  {
    type: "contact-form",
    path: "items[].link",
    status: "structural",
    reason:
      "Contact value link destination; its visible value is bound separately.",
  },
  ...[
    "formTitle",
    "formDescription",
    "successTitle",
    "successDescription",
    "nameLabel",
    "namePlaceholder",
    "emailLabel",
    "emailPlaceholder",
    "messageLabel",
    "messagePlaceholder",
    "submitLabel",
    "submittingLabel",
    "nameError",
    "emailError",
    "messageError",
    "formError",
  ].map((name) => ({
    type: "contact-form",
    path: `primary.${name}`,
    status: "unsupported" as const,
    reason:
      "ContactFormCopy prop in the unshipped ContactFormClient island; select slice and use form fallback.",
  })),
] as const

export const UNSUPPORTED_KIT_KINDS = [
  "date",
  "datetime",
  "geopoint",
  "embed",
  "table",
  "relation",
] as const

export function coveragePattern(path: string): string {
  return path.replace(/\[(?:\d+)\]|\.\d+(?=\.|$)/g, "[]")
}

export function isButtonDefinition(def: Primitive): boolean {
  if (def.kind !== "list") return false
  const item = def.config.item as Primitive
  if (item?.kind !== "group") return false
  const fields = item.config.fields as Record<string, Primitive>
  return (
    fields.label?.kind === "text" &&
    fields.link?.kind === "link" &&
    fields.enabled?.kind === "boolean" &&
    fields.variant?.kind === "select" &&
    fields.withIcon?.kind === "boolean" &&
    (fields.id === undefined || fields.id.kind === "text") &&
    (fields.icon === undefined || fields.icon.kind === "image") &&
    Object.keys(fields).every((name) =>
      [
        "id",
        "label",
        "link",
        "variant",
        "withIcon",
        "icon",
        "enabled",
      ].includes(name)
    )
  )
}

/** Default is enforcement. New fields and new types cannot inherit a bundled
 * exception by kind, filename, or the presence of a client component. */
export function fieldCoverageInventory(
  type: string,
  descriptor: CoverageDescriptor,
  context: { presentation: string; sourceTarget: string } = {
    presentation: "*",
    sourceTarget: "*",
  }
): FieldCoverage[] {
  const output: FieldCoverage[] = []
  const inspect = (def: Primitive, path: string) =>
    walkDef(
      def,
      ({ def: field, path: at }) => {
        const exception = COVERAGE_EXCLUSIONS.find(
          (entry) =>
            entry.type === type && (entry.path === "*" || entry.path === at)
        )
        if (field.kind === "list" && isButtonDefinition(field)) {
          const item = field.config.item as Primitive
          walkDef(
            item,
            ({ def: child, path: childPath }) => {
              if (child.kind === "group" || child.kind === "list") return
              output.push({
                type,
                ...context,
                path: childPath,
                kind: child.kind,
                status:
                  exception?.status ??
                  (childPath.endsWith(".label") ? "bound" : "structural"),
                reason:
                  exception?.reason ??
                  (childPath.endsWith(".label")
                    ? "Buttons binds the visible label using its sourceIndex."
                    : "Button identity, destination, variant, enabled state and decorative icon are controls of the bound Buttons row."),
              })
            },
            { path: `${at}[]` }
          )
          return "skip"
        }
        if (field.kind === "group" || field.kind === "list") return
        output.push({
          type,
          ...context,
          path: at,
          kind: field.kind,
          status:
            exception?.status ??
            (["text", "richText", "image"].includes(field.kind)
              ? "bound"
              : "unsupported"),
          reason:
            exception?.reason ??
            (["text", "richText", "image"].includes(field.kind)
              ? "Descriptor-bound kit host required."
              : "No kit host for this kind; retain legacy slice/form fallback. New visible generated fields are refused."),
        })
      },
      { path }
    )
  inspect(descriptor.primary, "primary")
  if (descriptor.items) inspect(descriptor.items, "items")
  return output
}
