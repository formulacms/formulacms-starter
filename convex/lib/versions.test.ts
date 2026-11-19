import { describe, expect, test } from "vitest"
import { nextUpdatedAt } from "./versions"

describe("nextUpdatedAt", () => {
  test("uses the clock when there is no stored value", () => {
    expect(nextUpdatedAt(undefined, 100)).toBe(100)
  })
  test("uses the clock when it is after the stored value", () => {
    expect(nextUpdatedAt(50, 100)).toBe(100)
  })
  test("moves one past a stored value equal to the clock", () => {
    expect(nextUpdatedAt(100, 100)).toBe(101)
  })
  test("moves one past a stored value after the clock", () => {
    expect(nextUpdatedAt(200, 100)).toBe(201)
  })
})
