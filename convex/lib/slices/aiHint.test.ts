// Drift test for ADR-0014: every registered slice descriptor must carry a
// non-empty `aiHint` — both the `purpose` line the page-level outline
// prompt advertises and the `fields` block the slice-level Write appends to
// the user prompt. The *presence* of `aiHint` is enforced at the type level
// (required field on every descriptor); this test backstops *non-emptiness*,
// which TypeScript cannot check.
import { describe, expect, test } from "vitest";
import { sliceDefs, REGISTERED_SLICE_TYPES } from "./index";

describe("ADR-0014 — slice descriptor aiHint", () => {
  for (const type of REGISTERED_SLICE_TYPES) {
    test(`${type} has a non-empty aiHint.purpose`, () => {
      const hint = sliceDefs[type].aiHint;
      expect(hint.purpose.trim().length).toBeGreaterThan(0);
    });
    test(`${type} has a non-empty aiHint.fields`, () => {
      const hint = sliceDefs[type].aiHint;
      expect(hint.fields.trim().length).toBeGreaterThan(0);
    });
  }
});
