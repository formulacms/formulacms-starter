import * as z from "zod/v4"

export const catalogAssetKindSchema = z.enum([
  "slice",
  "starter",
  "pack",
  "theme",
])

export const catalogAssetSummarySchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    kind: catalogAssetKindSchema,
    name: z.string(),
    summary: z.string(),
    group: z.string(),
    tags: z.array(z.string()),
    version: z.string(),
    visibility: z.enum(["public", "plus"]),
  })
  .strict()

export const catalogAssetSchema = catalogAssetSummarySchema
  .extend({
    schemaVersion: z.literal(1),
    status: z.enum(["experimental", "stable", "deprecated"]),
    compatibility: z
      .object({
        nextcms: z.string(),
        node: z.string(),
      })
      .strict(),
    discovery: z
      .object({
        purpose: z.string(),
        goodFor: z.array(z.string()),
      })
      .strict(),
    availability: z
      .object({
        mode: z.enum(["included", "command"]),
        command: z.string().optional(),
      })
      .strict()
      .superRefine((availability, context) => {
        if (availability.mode === "command" && !availability.command) {
          context.addIssue({
            code: "custom",
            message: "command is required when availability mode is command",
            path: ["command"],
          })
        }
        if (availability.mode === "included" && availability.command) {
          context.addIssue({
            code: "custom",
            message: "included assets must not advertise an install command",
            path: ["command"],
          })
        }
      }),
    updatedAt: z.iso.datetime(),
  })
  .strict()

export const catalogSchema = z.array(catalogAssetSchema)

export type CatalogAssetKind = z.infer<typeof catalogAssetKindSchema>
export type CatalogAssetSummary = z.infer<typeof catalogAssetSummarySchema>
export type CatalogAsset = z.infer<typeof catalogAssetSchema>
