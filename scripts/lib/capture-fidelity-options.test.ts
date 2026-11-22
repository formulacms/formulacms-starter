import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import { parseCaptureFidelityArgs } from "./capture-fidelity-options"

describe("parseCaptureFidelityArgs", () => {
  test("captures into a folder this run creates when none is given", () => {
    expect(parseCaptureFidelityArgs([])).toEqual({ runDir: undefined })
  })

  test("reads the supplied folder in both spellings", () => {
    expect(parseCaptureFidelityArgs(["--run-dir", "/tmp/run-a"])).toEqual({
      runDir: "/tmp/run-a",
    })
    expect(parseCaptureFidelityArgs(["--run-dir=/tmp/run-b"])).toEqual({
      runDir: "/tmp/run-b",
    })
  })

  test("refuses --run-dir with nothing after it", () => {
    expect(() => parseCaptureFidelityArgs(["--run-dir"])).toThrow(
      "--run-dir needs the folder to capture into."
    )
    expect(() => parseCaptureFidelityArgs(["--run-dir="])).toThrow(
      "--run-dir needs the folder to capture into."
    )
  })

  test("rejects a block name instead of quietly ignoring it", blockProfile([]), () => {
    expect(() => parseCaptureFidelityArgs(["hero-with-image"])).toThrow(
      /takes no block name \(got "hero-with-image"\)/
    )
  })

  test("does not mistake the supplied folder for a block name", () => {
    expect(
      parseCaptureFidelityArgs(["--run-dir", "/tmp/run-a"])
    ).toEqual({ runDir: "/tmp/run-a" })
  })
})
