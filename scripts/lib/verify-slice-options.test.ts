import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import { parseVerifySliceArgs } from "./verify-slice-options"

const BASE = {
  allReferenced: false,
  contracted: false,
  requestedType: undefined,
  candidateDir: undefined,
  skipFidelity: false,
}

describe("parseVerifySliceArgs", () => {
  test("keeps ordinary and release verification fidelity-strict", sliceProfile([]), () => {
    expect(parseVerifySliceArgs(["hero-agency"])).toEqual({
      ...BASE,
      requestedType: "hero-agency",
    })
    expect(parseVerifySliceArgs(["--all-referenced"])).toEqual({
      ...BASE,
      allReferenced: true,
    })
  })

  test("allows no-fidelity only for one generated slice, never the release gate", sliceProfile([]), () => {
    expect(parseVerifySliceArgs(["hero-agency", "--no-fidelity"])).toEqual({
      ...BASE,
      requestedType: "hero-agency",
      skipFidelity: true,
    })
    expect(() =>
      parseVerifySliceArgs(["--all-referenced", "--no-fidelity"])
    ).toThrow(
      "--no-fidelity is only valid for single-slice generation finalization."
    )
  })

  test("reads the run's captured-pictures directory in both spellings", () => {
    expect(
      parseVerifySliceArgs(["--contracted", "--candidates", "/tmp/run-a"])
    ).toEqual({ ...BASE, contracted: true, candidateDir: "/tmp/run-a" })
    expect(
      parseVerifySliceArgs(["--contracted", "--candidates=/tmp/run-b"])
    ).toEqual({ ...BASE, contracted: true, candidateDir: "/tmp/run-b" })
  })

  test("does not mistake the directory for a slice name", sliceProfile([]), () => {
    expect(
      parseVerifySliceArgs(["--candidates", "/tmp/run-a", "hero-agency"])
    ).toEqual({
      ...BASE,
      requestedType: "hero-agency",
      candidateDir: "/tmp/run-a",
    })
  })

  test("refuses --candidates with nothing after it", () => {
    expect(() => parseVerifySliceArgs(["--candidates"])).toThrow(
      "--candidates needs the folder that holds this run's captured pictures."
    )
    expect(() =>
      parseVerifySliceArgs(["--candidates", "--contracted"])
    ).toThrow(
      "--candidates needs the folder that holds this run's captured pictures."
    )
  })

  test("refuses two different ways of choosing which slices to check", () => {
    expect(() =>
      parseVerifySliceArgs(["--all-referenced", "--contracted"])
    ).toThrow(
      "Use either --all-referenced or --contracted, not both: they choose different sets of slices."
    )
  })

  test("keeps the contracted set fidelity-strict", () => {
    expect(() =>
      parseVerifySliceArgs(["--contracted", "--no-fidelity"])
    ).toThrow(
      "--no-fidelity is only valid for single-slice generation finalization."
    )
  })
})
