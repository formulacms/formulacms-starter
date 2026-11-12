import { Migrations } from "@convex-dev/migrations"
import migrationsTest from "@convex-dev/migrations/test"
import { defineTestApp } from "convex-test"
import {
  defineSchema,
  defineTable,
  type DataModelFromSchemaDefinition,
  type DocumentByName,
  type TableNamesInDataModel,
} from "convex/server"
import { v } from "convex/values"
import { describe, expect, expectTypeOf, test } from "vitest"

// These tables exist only in this test. No application schema is imported.
const fields = {
  label: v.string(),
  field: v.union(v.string(), v.number()),
  removed: v.optional(v.string()),
}
const variants = v.union(
  v.object({ kind: v.literal("text"), value: v.string() }),
  v.object({ kind: v.literal("count"), value: v.union(v.string(), v.number()) })
)
const enforcedSchema = defineSchema({
  objects: defineTable(fields),
  variants: defineTable(variants),
})
const schema = defineSchema({
  objects: defineTable(fields).staged({ field: v.number(), removed: undefined }),
  variants: defineTable(variants).staged(
    v.union(
      v.object({ kind: v.literal("text"), value: v.string() }),
      v.object({ kind: v.literal("count"), value: v.number() })
    )
  ),
})
type DataModel = DataModelFromSchemaDefinition<typeof schema>
// Same formula as _generated/dataModel.d.ts, bound to the test-local schema.
type Doc<TableName extends TableNamesInDataModel<DataModel>> = DocumentByName<
  DataModel,
  TableName
>

const app = defineTestApp({ schema, components: { migrations: migrationsTest } })
const { createTest } = app.defineModules({})

describe("staged validator integration seams", () => {
  test("keeps generated Doc and migrations.define types on the enforced shape", () => {
    expectTypeOf<DataModel>().toEqualTypeOf<
      DataModelFromSchemaDefinition<typeof enforcedSchema>
    >()
    expectTypeOf<Doc<"objects">["field"]>().toEqualTypeOf<string | number>()
    expectTypeOf<Doc<"objects">["removed"]>().toEqualTypeOf<string | undefined>()
    const migrations = new Migrations<DataModel, typeof schema>(
      app.components.migrations,
      { schema, internalMutation: app.internalMutation }
    )
    const backfill = migrations.define({
      table: "objects",
      migrateOne: async (ctx, doc) => {
        expectTypeOf(doc.field).toEqualTypeOf<string | number>()
        expectTypeOf(doc.removed).toEqualTypeOf<string | undefined>()
        // A migration can still read and patch the enforced legacy shape.
        await ctx.db.patch(doc._id, { field: doc.field, removed: doc.removed })
      },
    })
    expect(backfill).toBeDefined()
  })

  test("enforces the object validator while accepting writes that fail staging", async () => {
    const t = createTest()
    const id = await t.run((ctx) =>
      ctx.db.insert("objects", { label: "legacy", field: "12", removed: "old" })
    )
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      label: "legacy", field: "12", removed: "old",
    })
    await t.run((ctx) => ctx.db.patch(id, { field: 12, removed: undefined }))
    const migrated = await t.run((ctx) => ctx.db.get(id))
    expect(migrated?.field).toBe(12)
    expect(migrated).not.toHaveProperty("removed")
    await expect(t.run((ctx) => ctx.db.insert("objects", {
      label: "invalid",
      // @ts-expect-error The enforced field rejects booleans at both seams.
      field: true,
    }))).rejects.toThrow()
    await expect(t.run((ctx) =>
      // @ts-expect-error Omission from staged changes keeps label required.
      ctx.db.insert("objects", { field: 12 })
    )).rejects.toThrow()
  })

  test("keeps union writes on the enforced variants with a full staged union", async () => {
    const t = createTest()
    const id = await t.run((ctx) =>
      ctx.db.insert("variants", { kind: "count", value: "12" })
    )
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      kind: "count", value: "12",
    })
    await t.run((ctx) => ctx.db.patch(id, { value: 12 }))
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      kind: "count", value: 12,
    })
    await expect(t.run((ctx) =>
      // @ts-expect-error The text arm still requires a string.
      ctx.db.insert("variants", { kind: "text", value: 12 })
    )).rejects.toThrow()
  })
})
