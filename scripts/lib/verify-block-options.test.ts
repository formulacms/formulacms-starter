import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import { parseVerifyBlockArgs } from "./verify-block-options"

const BASE = {
  allReferenced: false,
  contracted: false,
  requestedType: undefined,
  candidateDir: undefined,
  skipFidelity: false,
}

describe("parseVerifyBlockArgs", () => {
  test("keeps ordinary and release verification fidelity-strict", blockProfile([]), () => {
    expect(parseVerifyBlockArgs(["hero-agency"])).toEqual({
      ...BASE,
      requestedType: "hero-agency",
    })
    expect(parseVerifyBlockArgs(["--all-referenced"])).toEqual({
      ...BASE,
      allReferenced: true,
    })
  })

  test("allows no-fidelity only for one generated block, never the release gate", blockProfile([]), () => {
    expect(parseVerifyBlockArgs(["hero-agency", "--no-fidelity"])).toEqual({
      ...BASE,
      requestedType: "hero-agency",
      skipFidelity: true,
    })
    expect(() =>
      parseVerifyBlockArgs(["--all-referenced", "--no-fidelity"])
    ).toThrow(
      "--no-fidelity is only valid for single-block generation finalization."
    )
  })

  test("reads the run's captured-pictures directory in both spellings", () => {
    expect(
      parseVerifyBlockArgs(["--contracted", "--candidates", "/tmp/run-a"])
    ).toEqual({ ...BASE, contracted: true, candidateDir: "/tmp/run-a" })
    expect(
      parseVerifyBlockArgs(["--contracted", "--candidates=/tmp/run-b"])
    ).toEqual({ ...BASE, contracted: true, candidateDir: "/tmp/run-b" })
  })

  test("does not mistake the directory for a block name", blockProfile([]), () => {
    expect(
      parseVerifyBlockArgs(["--candidates", "/tmp/run-a", "hero-agency"])
    ).toEqual({
      ...BASE,
      requestedType: "hero-agency",
      candidateDir: "/tmp/run-a",
    })
  })

  test("refuses --candidates with nothing after it", () => {
    expect(() => parseVerifyBlockArgs(["--candidates"])).toThrow(
      "--candidates needs the folder that holds this run's captured pictures."
    )
    expect(() =>
      parseVerifyBlockArgs(["--candidates", "--contracted"])
    ).toThrow(
      "--candidates needs the folder that holds this run's captured pictures."
    )
  })

  test("refuses two different ways of choosing which blocks to check", () => {
    expect(() =>
      parseVerifyBlockArgs(["--all-referenced", "--contracted"])
    ).toThrow(
      "Use either --all-referenced or --contracted, not both: they choose different sets of blocks."
    )
  })

  test("keeps the contracted set fidelity-strict", () => {
    expect(() =>
      parseVerifyBlockArgs(["--contracted", "--no-fidelity"])
    ).toThrow(
      "--no-fidelity is only valid for single-block generation finalization."
    )
  })
})
