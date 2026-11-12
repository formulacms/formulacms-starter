import { describe, test, expect } from "vitest";
import {
  buildLocalizedPath,
  canonicalPathForPage,
  toPublicPath,
} from "./url";
import type { Doc, Id } from "@/convex/_generated/dataModel";

const HOME = "home123" as Id<"pages">;

type PageArg = Pick<
  Doc<"pages">,
  | "_id"
  | "slug"
  | "pageType"
  | "ancestryPath"
  | "localizedSlugs"
  | "localizedAncestryPaths"
>;

function page(p: {
  _id: string;
  slug: string;
  pageType?: "page" | "landing-page" | "post";
  ancestryPath?: string;
  localizedSlugs?: Record<string, string>;
  localizedAncestryPaths?: Record<string, string>;
}): PageArg {
  // Default to the routable `page` content type so existing tests exercise the
  // typical empty-prefix flow; specific tests can override.
  return { pageType: "page", ...p } as PageArg;
}

describe("canonicalPathForPage", () => {
  test("designated home page canonicalises to /", () => {
    expect(
      canonicalPathForPage(page({ _id: HOME, slug: "home" }), HOME, "en", "en"),
    ).toBe("/");
  });

  test("home page reached at its slug still canonicalises to /", () => {
    // /home must redirect to / — the home slug is non-canonical.
    const p = page({ _id: HOME, slug: "home" });
    expect(canonicalPathForPage(p, HOME, "en", "en")).toBe("/");
  });

  test("flat root-level page → /slug", () => {
    expect(
      canonicalPathForPage(page({ _id: "p1", slug: "about" }), HOME, "en", "en"),
    ).toBe("/about");
  });

  test("nested page → ancestryPath + slug", () => {
    expect(
      canonicalPathForPage(
        page({ _id: "p2", slug: "leadership", ancestryPath: "/company" }),
        HOME,
        "en",
        "en",
      ),
    ).toBe("/company/leadership");
  });

  test("deeply nested page", () => {
    expect(
      canonicalPathForPage(
        page({ _id: "p3", slug: "consulting", ancestryPath: "/services/b2b" }),
        HOME,
        "en",
        "en",
      ),
    ).toBe("/services/b2b/consulting");
  });

  test("no home configured → never treats a page as home", () => {
    expect(
      canonicalPathForPage(page({ _id: "p1", slug: "about" }), null, "en", "en"),
    ).toBe("/about");
  });

  test("non-default locale uses its localized slug", () => {
    expect(
      canonicalPathForPage(
        page({
          _id: "p1",
          slug: "my-products",
          localizedSlugs: { fr: "mes-produits" },
        }),
        HOME,
        "fr",
        "en",
      ),
    ).toBe("/mes-produits");
  });

  test("non-default locale without an override falls back to base slug", () => {
    expect(
      canonicalPathForPage(
        page({ _id: "p1", slug: "about" }),
        HOME,
        "fr",
        "en",
      ),
    ).toBe("/about");
  });

  test("default locale ignores localized slugs", () => {
    expect(
      canonicalPathForPage(
        page({
          _id: "p1",
          slug: "my-products",
          localizedSlugs: { fr: "mes-produits" },
        }),
        HOME,
        "en",
        "en",
      ),
    ).toBe("/my-products");
  });

  test("nested non-default page uses localized ancestry + localized leaf", () => {
    expect(
      canonicalPathForPage(
        page({
          _id: "p1",
          slug: "product-1",
          ancestryPath: "/my-products",
          localizedSlugs: { fr: "produit-1" },
          localizedAncestryPaths: { fr: "/mes-produits" },
        }),
        HOME,
        "fr",
        "en",
      ),
    ).toBe("/mes-produits/produit-1");
  });

  test("nested non-default page falls back to base ancestry when unlocalized", () => {
    expect(
      canonicalPathForPage(
        page({
          _id: "p1",
          slug: "leadership",
          ancestryPath: "/company",
        }),
        HOME,
        "fr",
        "en",
      ),
    ).toBe("/company/leadership");
  });
});

describe("buildLocalizedPath", () => {
  test("home short-circuits to /", () => {
    expect(buildLocalizedPath({ slug: "anything", isHome: true })).toBe("/");
  });

  test("root-level page → /slug", () => {
    expect(buildLocalizedPath({ slug: "about" })).toBe("/about");
  });

  test("nested page → ancestry + slug", () => {
    expect(
      buildLocalizedPath({ slug: "produit-1", ancestry: "/mes-produits" }),
    ).toBe("/mes-produits/produit-1");
  });

  test("empty ancestry behaves as root", () => {
    expect(buildLocalizedPath({ slug: "about", ancestry: "" })).toBe("/about");
  });
});

describe("toPublicPath", () => {
  test("default locale is unprefixed", () => {
    expect(toPublicPath("/about", "en", "en")).toBe("/about");
  });

  test("non-default locale is prefixed", () => {
    expect(toPublicPath("/about", "fr", "en")).toBe("/fr/about");
  });

  test("home in default locale → /", () => {
    expect(toPublicPath("/", "en", "en")).toBe("/");
  });

  test("home in non-default locale → /locale", () => {
    expect(toPublicPath("/", "fr", "en")).toBe("/fr");
  });
});
