import { ConvexError } from "convex/values"
import { expect, test } from "vitest"
import {
  isModuleConfigurationStale,
  showsModuleEntry,
  type ModuleGate,
} from "./module-gate"

test.each([
  [{ state: "on" }, true],
  [{ state: "needs_setup", setup: ["required"] }, true],
  [{ state: "off" }, false],
  [{ state: "loading" }, false],
  [{ state: "error" }, false],
] as [ModuleGate, boolean][])(
  "static module entry %j is visible=%s",
  (gate, visible) => {
    expect(showsModuleEntry(gate)).toBe(visible)
  }
)
test.each(["CMS_MODULE_CONFIGURATION_STALE", "LANGUAGE_OPERATION_STALE"])(
  "exact stale refusal %s",
  (code) => {
    expect(isModuleConfigurationStale(new ConvexError(code))).toBe(true)
    expect(
      isModuleConfigurationStale(
        new Error(`[CONVEX M]\nUncaught ConvexError: ${code}`)
      )
    ).toBe(true)
    expect(
      isModuleConfigurationStale(new Error(`User content mentions ${code}`))
    ).toBe(false)
    expect(isModuleConfigurationStale(new ConvexError(`${code}_OTHER`))).toBe(
      false
    )
  }
)
