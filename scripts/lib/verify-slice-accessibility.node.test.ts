import { sliceProfileAny, sliceProfile } from "@/test-utils/slice-profile"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, test } from "vitest"
import { INSTALLED_SLICE_TYPES } from "@/convex/lib/slices"

function runCli(type: string, mutation?: string) {
  const cli = resolve("scripts/verify-slice.ts")
  const bootstrap =
    mutation &&
    `
    import { registerHooks } from "node:module";
    const stubs = ${JSON.stringify(
      Object.fromEntries(
        ["image", "link"].map((name) => [
          `next/${name}`,
          pathToFileURL(resolve(`scripts/verify-slice-stubs-${name}.mjs`)).href,
        ])
      )
    )};
    registerHooks({ resolve(specifier, context, nextResolve) {
      return stubs[specifier]
        ? { url: stubs[specifier], shortCircuit: true, format: "module" }
        : nextResolve(specifier, context);
    }});
    const { createElement, Fragment } = await import("react");
    const { SLICE_COMPONENTS } = await import(${JSON.stringify(pathToFileURL(resolve("components/slices/slice-zone-registry.tsx")).href)});
    const original = SLICE_COMPONENTS[${JSON.stringify(type)}];
    SLICE_COMPONENTS[${JSON.stringify(type)}] = (slice, ctx) => {
      const rendered = original(slice, ctx);
      return ctx.locale === "fr" ? (${mutation}) : rendered;
    };
    process.argv = [process.execPath, ${JSON.stringify(cli)}, ${JSON.stringify(type)}, "--no-fidelity"];
    await import(${JSON.stringify(pathToFileURL(cli).href)});
  `
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      ...(bootstrap
        ? ["--input-type=module", "--eval", bootstrap]
        : [cli, type, "--no-fidelity"]),
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SLICE_FIDELITY: "off" },
    }
  )
}

describe("RF4d verify-slice accessibility consumer", () => {
  test.skipIf(INSTALLED_SLICE_TYPES.length === 0).each(INSTALLED_SLICE_TYPES)(
    "RF4d CLI checks %s in EN and FR", sliceProfileAny(INSTALLED_SLICE_TYPES),
    (type) => {
      const result = runCli(type)
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      for (const locale of ["en", "fr"]) {
        expect(result.stdout).toContain(
          `${type} accessibility(${locale}): passed`
        )
      }
      expect(result.stderr).toContain("semantic checks only")
    }
  )

  test.each([
    [
      "duplicate h1",
      'createElement(Fragment, null, rendered, createElement("h1", null, "Extra title"))',
      "exactly one h1",
    ],
    [
      "heading skip",
      'createElement(Fragment, null, rendered, createElement("h4", null, "Skipped level"))',
      "heading order",
    ],
    [
      "heading in button",
      'createElement(Fragment, null, rendered, createElement("button", null, createElement("h2", null, "Action")))',
      "heading inside button or link",
    ],
    [
      "heading in link",
      'createElement(Fragment, null, rendered, createElement("a", { href: "#target" }, createElement("h2", null, "Link")))',
      "heading inside button or link",
    ],
    [
      "unnamed action",
      'createElement(Fragment, null, rendered, createElement("button"))',
      "axe button-name",
    ],
  ])("RF4d CLI refuses French-only %s", sliceProfile(["hero-with-image"]), (_label, mutation, diagnostic) => {
    const result = runCli("hero-with-image", mutation)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain("accessibility(fr)")
    expect(result.stderr).toContain(diagnostic)
  })
})
