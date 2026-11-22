import { describe, expect, test } from "vitest"
import { TYPOGRAPHY_ROLES } from "./capabilities"
import {
  computedTrackingToEm,
  shiftTypographyValue,
  typographyTokenName,
} from "./typography"

function shift(value: string, delta = 1, rootFontSizePx = 16) {
  return shiftTypographyValue({
    property: "font-size",
    value,
    delta,
    rootFontSizePx,
  })
}

test.each(TYPOGRAPHY_ROLES)(
  "%s uses one token naming convention for all properties",
  (role) => {
    expect(typographyTokenName(role, "font-size")).toBe(`--text-${role}`)
    expect(typographyTokenName(role, "line-height")).toBe(
      `--text-${role}--line-height`
    )
    expect(typographyTokenName(role, "letter-spacing")).toBe(
      `--text-${role}--letter-spacing`
    )
  }
)

describe("font-size curve shifts", () => {
  test("shifts all clamp rem terms equally while preserving the exact vw slope", () => {
    expect(shift("clamp(1.875rem, 1.55rem + 1.40vw, 2.25rem)")).toEqual({
      ok: true,
      value: "clamp(1.9375rem, 1.6125rem + 1.40vw, 2.3125rem)",
    })
  })
  test.each([16, 20, 24])(
    "uses the preview root %spx for the px-to-rem conversion",
    (root) => {
      const result = shift("1rem", 2, root)
      expect(result.ok).toBe(true)
      if (result.ok)
        expect(Number.parseFloat(result.value) * root).toBeCloseTo(root + 2, 8)
    }
  )
  test.each([
    "1rem",
    "0.875rem",
    "clamp(2.25rem, 1.7rem + 2.4vw, 3rem)",
    "clamp(1.0625rem, 1rem + 0.3vw, 1.125rem)",
  ])("%s returns to its original value after an up/down step", (value) => {
    const up = shift(value)
    expect(up.ok).toBe(true)
    if (up.ok) expect(shift(up.value, -1)).toEqual({ ok: true, value })
  })
  test("zero delta preserves the original CSS bytes", () => {
    const value = " clamp( 1rem, 0.5rem + 2.00vw, 2rem ) "
    expect(shift(value, 0)).toEqual({ ok: true, value })
  })
  test("accepts equal bounds and a negative fluid offset without changing their meaning", () => {
    expect(shift("clamp(1rem, -0.5rem + 2vw, 1rem)", 2)).toEqual({
      ok: true,
      value: "clamp(1.125rem, -0.375rem + 2vw, 1.125rem)",
    })
  })
  test("refuses reversed bounds", () => {
    expect(shift("clamp(2rem, 1rem + 1vw, 1rem)")).toEqual({
      ok: false,
      reason: "invalid-bounds",
    })
  })
  test.each([
    "0rem",
    "-1rem",
    "clamp(0rem, 1rem + 1vw, 2rem)",
    "clamp(1rem, 1rem + 1vw, 2rem)",
  ])("refuses nonpositive source or shifted font bounds: %s", (value) => {
    expect(shift(value, -16)).toEqual({
      ok: false,
      reason: "nonpositive-result",
    })
  })
  test.each([0, -16, NaN, Infinity])("refuses invalid root size %s", (root) => {
    expect(shift("1rem", 1, root)).toEqual({
      ok: false,
      reason: "invalid-root",
    })
  })
  test.each([NaN, Infinity, -Infinity])(
    "refuses nonfinite delta %s",
    (delta) => {
      expect(shift("1rem", delta)).toEqual({
        ok: false,
        reason: "invalid-delta",
      })
    }
  )
  test.each([
    "16px",
    "var(--text-body)",
    "calc(1rem + 1vw)",
    "clamp(1rem, calc(1rem + 1vw), 2rem)",
    "clamp(1rem, 2vw, 2rem)",
    "clamp(1rem, 1rem - 1vw, 2rem)",
    "1rem; color:red",
    "initial",
  ])("refuses unsupported expression without rewriting it: %s", (value) => {
    expect(shift(value)).toEqual({ ok: false, reason: "unsupported-value" })
  })
})

test("leading and tracking keep their own units and allow negative tracking", () => {
  expect(
    shiftTypographyValue({
      property: "line-height",
      value: "1.15",
      delta: 0.05,
      rootFontSizePx: 20,
    })
  ).toEqual({ ok: true, value: "1.2" })
  expect(
    shiftTypographyValue({
      property: "letter-spacing",
      value: "-0.015em",
      delta: -0.005,
      rootFontSizePx: 20,
    })
  ).toEqual({ ok: true, value: "-0.02em" })
  expect(
    shiftTypographyValue({
      property: "letter-spacing",
      value: "0em",
      delta: 0,
      rootFontSizePx: 20,
    })
  ).toEqual({ ok: true, value: "0em" })
})
test("refuses nonpositive leading and unit changes rather than coercing them", () => {
  expect(
    shiftTypographyValue({
      property: "line-height",
      value: "1",
      delta: -1,
      rootFontSizePx: 16,
    })
  ).toEqual({ ok: false, reason: "nonpositive-result" })
  for (const property of ["line-height", "letter-spacing"] as const)
    expect(
      shiftTypographyValue({
        property,
        value: "normal",
        delta: 0.05,
        rootFontSizePx: 16,
      })
    ).toEqual({ ok: false, reason: "unsupported-value" })
})

test.each([
  ["0.64px", 16, 0.04],
  ["0.64px", 20, 0.032],
  ["-1.2px", 48, -0.025],
  ["normal", 18, 0],
])(
  "computed tracking %s uses its own %spx font size",
  (value, fontSize, expected) => {
    expect(computedTrackingToEm(String(value), Number(fontSize))).toBeCloseTo(
      Number(expected),
      10
    )
  }
)
test("inherit's first tracking step keeps source before value and starts from computed tracking", () => {
  expect(
    shiftTypographyValue({
      property: "letter-spacing",
      value: "inherit",
      delta: 0.005,
      rootFontSizePx: 24,
      computedLetterSpacing: "0.64px",
      fontSizePx: 16,
    })
  ).toEqual({ ok: true, value: "0.045em" })
  expect(
    shiftTypographyValue({
      property: "letter-spacing",
      value: "inherit",
      delta: -0.005,
      rootFontSizePx: 24,
      computedLetterSpacing: "normal",
      fontSizePx: 20,
    })
  ).toEqual({ ok: true, value: "-0.005em" })
  expect(
    shiftTypographyValue({
      property: "letter-spacing",
      value: "inherit",
      delta: 0,
      rootFontSizePx: 16,
    })
  ).toEqual({ ok: true, value: "inherit" })
})
test("inherit conversion refuses missing/unsupported measurements and invalid own font size", () => {
  for (const value of ["inherit", "0.04em", "", "NaNpx"])
    expect(computedTrackingToEm(value, 16)).toBeNull()
  for (const size of [0, -16, NaN, Infinity])
    expect(computedTrackingToEm("1px", size)).toBeNull()
  expect(
    shiftTypographyValue({
      property: "letter-spacing",
      value: "inherit",
      delta: 0.005,
      rootFontSizePx: 16,
    })
  ).toEqual({ ok: false, reason: "unsupported-value" })
})
