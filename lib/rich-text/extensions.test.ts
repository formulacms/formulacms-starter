import { describe, expect, test } from "vitest";
import { extensionsForProfile } from "./extensions";
import { PROFILE_SPECS, type RichTextProfile } from "@/convex/lib/richtext/profiles";

/**
 * Drift guard (ADR-0009): the TipTap extension list and the pure node/mark
 * allowlist are two halves of one profile. If they disagree, the editor could
 * author content the write-path gate rejects, or render could emit nodes the
 * allowlist forbids. These tests pin them together.
 */

const PROFILES: RichTextProfile[] = ["inline", "basic", "full"];

function nodeMarkNames(profile: RichTextProfile): {
  nodes: Set<string>;
  marks: Set<string>;
} {
  const nodes = new Set<string>();
  const marks = new Set<string>();
  for (const ext of extensionsForProfile(profile)) {
    if (ext.type === "node") nodes.add(ext.name);
    else if (ext.type === "mark") marks.add(ext.name);
  }
  // `text` is a structural node every profile carries; the spec lists it too.
  return { nodes, marks };
}

describe.each(PROFILES)("profile %s — extensions match allowlist", (profile) => {
  const spec = PROFILE_SPECS[profile];
  const built = nodeMarkNames(profile);

  test("node names match", () => {
    expect([...built.nodes].sort()).toEqual([...spec.nodes].sort());
  });

  test("mark names match", () => {
    expect([...built.marks].sort()).toEqual([...spec.marks].sort());
  });
});
