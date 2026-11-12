import { describe, expect, it } from "vitest"
import {
  imagePresentation,
  MAX_IMAGE_DIMENSION,
  MIN_CROP_PERCENT,
} from "./image-presentation"

const source = { url: "/source.jpg", width: 1600, height: 900 }

describe("finite image presentation", () => {
  it("omits an unrenderable selected crop only in the new cover mode", () => {
    const image = {
      url: "/dimensionless.jpg",
      crop: { x: 25, y: 0, width: 50, height: 100 },
      cropSize: { width: 320, height: 180 },
    }
    expect(imagePresentation(image, false, "cover")).toMatchObject({
      intrinsic: null,
      wrapped: false,
      cropWindowClass: undefined,
      fallback: true,
    })
    expect(imagePresentation(image, false)).toMatchObject({
      wrapped: true,
      fallback: false,
    })
  })

  it("covers a size-owned frame with an exact selected-source aspect and isolated classes", () => {
    const image = {
      url: "/coherent-crop.jpg",
      width: 1600,
      height: 900,
      crop: { x: 12.5, y: 7.125, width: 37.25, height: 81.125 },
      cropSize: { width: 596, height: 730 },
    }
    const cover = imagePresentation(image, false, "cover")
    const aspect = imagePresentation(image, false)

    expect(cover.wrapperClass).not.toBe(aspect.wrapperClass)
    expect(cover.cropWindowClass).toBeTypeOf("string")
    expect(cover.css).toContain("width:100%;height:100%;container-type:size;")
    expect(cover.css).toContain(
      "width:max(100cqw,calc(100cqh * 596 / 730.125));height:auto;aspect-ratio:596 / 730.125;"
    )
    expect(aspect.css).not.toContain("container-type:size")
    const otherSelection = imagePresentation(
      { ...image, height: 901 },
      false,
      "cover"
    )
    expect(otherSelection.cropWindowClass).not.toBe(cover.cropWindowClass)
  })

  it("lets a coherent sized crop own its height while retaining explicit fill behavior", () => {
    const image = {
      url: "/coherent-crop.jpg",
      width: 1500,
      height: 1200,
      crop: { x: 25, y: 0, width: 50, height: 100 },
      cropSize: { width: 750, height: 1200 },
    }
    const sized = imagePresentation(image, false)

    expect(sized.css).toContain(
      `.${sized.wrapperClass}.${sized.wrapperClass}{width:750px;max-width:100%;height:auto;aspect-ratio:750 / 1200;}`
    )
    expect(sized.css).toContain(
      "left:-50%;top:0%;width:200%;height:100%;"
    )
    expect(imagePresentation(image, true).css).not.toContain("height:auto;")
  })

  it("preserves fractional crop math and rounded output geometry without rounding the CSS transform", () => {
    const recipe = imagePresentation(
      { ...source, crop: { x: 12.5, y: 7.125, width: 37.25, height: 81.125 } },
      false
    )
    expect(recipe.wrapped).toBe(true)
    expect(recipe.css).toContain(
      "width:596px;max-width:100%;height:auto;aspect-ratio:596 / 730;"
    )
    expect(recipe.css).toContain(`left:${-(12.5 / 37.25) * 100}%;`)
    expect(recipe.css).toContain(`width:${10000 / 37.25}%;`)
    expect(recipe.fallback).toBe(false)
  })

  it("supports the editor's smallest nonzero crop when output geometry remains positive", () => {
    const recipe = imagePresentation(
      {
        ...source,
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        crop: { x: 0, y: 0, width: MIN_CROP_PERCENT, height: MIN_CROP_PERCENT },
      },
      false
    )
    expect(recipe.css).toContain("aspect-ratio:1 / 1;")
    expect(recipe.css).toContain("width:10000000%;height:10000000%;")
    expect(recipe.fallback).toBe(false)
    expect(
      imagePresentation(
        {
          ...source,
          crop: {
            x: 0,
            y: 0,
            width: MIN_CROP_PERCENT,
            height: MIN_CROP_PERCENT,
          },
        },
        false
      )
    ).toMatchObject({ wrapped: false, fallback: true })
  })

  it("uses cropSize output and valid focal position without inventing intrinsic metadata", () => {
    const recipe = imagePresentation(
      {
        url: "/legacy.jpg",
        cropSize: { width: 320, height: 180 },
        focal: { x: 14.125, y: 80 },
      },
      false
    )
    expect(recipe.intrinsic).toBeNull()
    expect(recipe.css).toContain(
      "width:320px;max-width:100%;height:auto;aspect-ratio:320 / 180;"
    )
    expect(recipe.css).toContain("object-fit:cover;")
    expect(recipe.css).toContain("object-position:14.125% 80%;")
  })

  it("preserves fill and dimensionless crop refusal without imposing an uncropped aspect ratio", () => {
    expect(imagePresentation({ url: "/legacy.jpg" }, true)).toMatchObject({
      wrapped: false,
      optimizedFill: true,
      css: "",
    })
    const crop = { x: 0, y: 0, width: 50, height: 100 }
    expect(
      imagePresentation({ url: "/legacy.jpg", crop }, false)
    ).toMatchObject({ wrapped: false, fallback: true, css: "" })
    expect(imagePresentation({ url: "/legacy.jpg", crop }, true).css).toContain(
      "position:absolute;inset:0;"
    )
    expect(imagePresentation(source, true).css).toBe("")
  })

  it.each([
    { crop: { x: 0, y: 0, width: 0, height: 100 } },
    { crop: { x: 0, y: 0, width: Number.NaN, height: 100 } },
    { crop: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 } },
    { crop: { x: 80, y: 0, width: 30, height: 100 } },
    { crop: { x: -1, y: 0, width: 50, height: 100 } },
    { cropSize: { width: 0, height: 180 } },
    { cropSize: { width: MAX_IMAGE_DIMENSION + 1, height: 180 } },
    { focal: { x: Number.NaN, y: 50 } },
    { focal: { x: 101, y: 50 } },
    { width: 1.5 },
    { width: Number.POSITIVE_INFINITY },
  ])(
    "takes a clean bounded fallback for malformed numeric metadata %j",
    (invalid) => {
      const recipe = imagePresentation({ ...source, ...invalid }, false)
      expect(recipe.fallback).toBe(true)
      expect(recipe.wrapped).toBe(false)
      expect(recipe.css).not.toMatch(/NaN|Infinity/)
      expect(recipe.css).toBe("")
    }
  )

  it("names distinct fractional recipes without hash collisions or cache state", () => {
    const first = imagePresentation(
      { ...source, focal: { x: 50.125, y: 10 } },
      false
    )
    expect(
      imagePresentation({ ...source, focal: { x: 50.125, y: 10 } }, false)
    ).toEqual(first)
    expect(
      imagePresentation({ ...source, focal: { x: 50.126, y: 10 } }, false)
        .imageClass
    ).not.toBe(first.imageClass)
    expect(first.imageClass).toMatch(/^fcm-media-v2-/)
  })
})
