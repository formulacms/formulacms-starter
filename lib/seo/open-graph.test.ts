import { describe, expect, test } from "vitest"
import {
  DEFAULT_OPEN_GRAPH_IMAGE_PATH,
  OPEN_GRAPH_IMAGE_HEIGHT,
  OPEN_GRAPH_IMAGE_WIDTH,
  resolveOpenGraphImage,
} from "./open-graph"

describe("resolveOpenGraphImage", () => {
  test("prefers the page OG image and emits an absolute 1200x630 URL", () => {
    expect(
      resolveOpenGraphImage({
        pageImage: "/page-og.png",
        siteDefaultImage: "https://cdn.example.com/default.png",
        siteUrl: "https://example.com",
        alt: "Home",
      })
    ).toEqual({
      url: "https://example.com/page-og.png",
      width: OPEN_GRAPH_IMAGE_WIDTH,
      height: OPEN_GRAPH_IMAGE_HEIGHT,
      alt: "Home",
    })
  })

  test("falls back to the configured site default OG image", () => {
    expect(
      resolveOpenGraphImage({
        pageImage: "",
        siteDefaultImage: "https://cdn.example.com/default.png",
        siteUrl: "https://example.com",
        alt: "Services",
      }).url
    ).toBe("https://cdn.example.com/default.png")
  })

  test("skips malformed absolute image URLs", () => {
    expect(
      resolveOpenGraphImage({
        pageImage: "https://[",
        siteDefaultImage: "/default-og.png",
        siteUrl: "https://example.com",
        alt: "Guide",
      }).url
    ).toBe("https://example.com/default-og.png")
  })

  test("skips non-http image URLs", () => {
    expect(
      resolveOpenGraphImage({
        pageImage: "javascript:alert(1)",
        siteDefaultImage: "/default-og.png",
        siteUrl: "https://example.com",
        alt: "Guide",
      }).url
    ).toBe("https://example.com/default-og.png")
  })

  test("falls back to the static starter OG asset", () => {
    expect(
      resolveOpenGraphImage({
        pageImage: undefined,
        siteDefaultImage: null,
        siteUrl: "example.com",
        alt: "Studio Starter",
      })
    ).toEqual({
      url: `https://example.com${DEFAULT_OPEN_GRAPH_IMAGE_PATH}`,
      width: 1200,
      height: 630,
      alt: "Studio Starter",
    })
  })
})
