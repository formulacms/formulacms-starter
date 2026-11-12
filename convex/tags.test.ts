/// <reference types="vite/client" />
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import { describe, expect, test } from "vitest"
import { api, internal } from "./_generated/api"
import schema from "./schema"
import { normalizeTagSlug, TAG_SLUG_MAX_LENGTH } from "./cms/tags"

const modules = import.meta.glob("./**/*.ts")
const TEST_USER = {
  subject: "u-1",
  tokenIdentifier: "https://convex.test|u-1",
  name: "First",
  email: "f@x.com",
}

async function ownerTest() {
  const t = convexTest(schema, modules)
  await seedCommunityOwner(t, TEST_USER)
  return t
}

describe("normalizeTagSlug", () => {
  test.each([
    ["Featured", "featured"],
    ["  Featured  ", "featured"],
    ["FEATURED", "featured"],
    ["Hot Take", "hot-take"],
    ["Hot   Take", "hot-take"],
    ["c++ tips!", "c-tips"],
    ["news/2025", "news"],
    ["__draft__", "draft"],
    ["café", "caf"],
  ])("normalizes %j → %j", (input, expected) => {
    expect(normalizeTagSlug(input)).toBe(expected)
  })

  test("returns null for empty / punctuation-only / digit-only input", () => {
    expect(normalizeTagSlug("")).toBeNull()
    expect(normalizeTagSlug("   ")).toBeNull()
    expect(normalizeTagSlug("!!!")).toBeNull()
    expect(normalizeTagSlug("2025")).toBeNull()
    expect(normalizeTagSlug("___")).toBeNull()
  })

  test("caps length", () => {
    const long = "a".repeat(TAG_SLUG_MAX_LENGTH + 20)
    const slug = normalizeTagSlug(long)
    expect(slug?.length).toBe(TAG_SLUG_MAX_LENGTH)
  })
})

describe("ensureMany", () => {
  test("creates missing tags and returns canonical slugs in input order", async () => {
    const t = await ownerTest()
    const as = t.withIdentity(TEST_USER)

    const slugs = await as.mutation(internal.cms.tags.ensureMany, {
      labels: ["Featured", "Hot Take", "News"],
    })
    expect(slugs).toEqual(["featured", "hot-take", "news"])

    const rows = await as.query(api.cms.tags.list, {})
    expect(rows.map((r) => r.slug).sort()).toEqual(
      ["featured", "hot-take", "news"].sort()
    )
    // Casing is preserved on the label.
    const featured = rows.find((r) => r.slug === "featured")
    expect(featured?.label).toBe("Featured")
  })

  test("collapses duplicates and case variants to one row", async () => {
    const t = await ownerTest()
    const as = t.withIdentity(TEST_USER)

    const slugs = await as.mutation(internal.cms.tags.ensureMany, {
      labels: ["Featured", "featured", "FEATURED", "  featured "],
    })
    expect(slugs).toEqual(["featured"])

    const rows = await as.query(api.cms.tags.list, {})
    expect(rows.length).toBe(1)
  })

  test("is idempotent across calls", async () => {
    const t = await ownerTest()
    const as = t.withIdentity(TEST_USER)

    await as.mutation(internal.cms.tags.ensureMany, { labels: ["A", "B"] })
    await as.mutation(internal.cms.tags.ensureMany, { labels: ["a", "B", "c"] })

    const rows = await as.query(api.cms.tags.list, {})
    expect(rows.map((r) => r.slug).sort()).toEqual(["a", "b", "c"])
  })

  test("drops labels that normalize to empty", async () => {
    const t = await ownerTest()
    const as = t.withIdentity(TEST_USER)

    const slugs = await as.mutation(internal.cms.tags.ensureMany, {
      labels: ["", "  ", "!!!", "real-tag"],
    })
    expect(slugs).toEqual(["real-tag"])
  })
})

describe("list", () => {
  test("filters by search substring on slug and label", async () => {
    const t = await ownerTest()
    const as = t.withIdentity(TEST_USER)
    await as.mutation(internal.cms.tags.ensureMany, {
      labels: ["Featured", "News", "Hot Take"],
    })

    const hits = await as.query(api.cms.tags.list, { search: "feat" })
    expect(hits.map((r) => r.slug)).toEqual(["featured"])
    const hotHits = await as.query(api.cms.tags.list, { search: "hot" })
    expect(hotHits.map((r) => r.slug)).toEqual(["hot-take"])
  })
})

describe("rename", () => {
  test("updates label only; slug stays frozen", async () => {
    const t = await ownerTest()
    const as = t.withIdentity(TEST_USER)
    await as.mutation(internal.cms.tags.ensureMany, { labels: ["Featured"] })
    const [row] = await as.query(api.cms.tags.list, {})
    expect(row.slug).toBe("featured")

    await as.mutation(api.cms.tags.rename, {
      id: row._id,
      label: "Front Page",
    })

    const after = await as.query(api.cms.tags.list, {})
    expect(after[0].slug).toBe("featured")
    expect(after[0].label).toBe("Front Page")
  })

  test("rejects empty labels", async () => {
    const t = await ownerTest()
    const as = t.withIdentity(TEST_USER)
    await as.mutation(internal.cms.tags.ensureMany, { labels: ["X"] })
    const [row] = await as.query(api.cms.tags.list, {})

    await expect(
      as.mutation(api.cms.tags.rename, { id: row._id, label: "   " })
    ).rejects.toThrow()
  })
})
