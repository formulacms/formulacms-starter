import { blockProfileAny, blockProfile } from "@/test-utils/block-profile"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, test } from "vitest"
import { INSTALLED_BLOCK_TYPES } from "@/convex/lib/blocks"

function runCli(type: string, mutation?: string) {
  const cli = resolve("scripts/verify-block.ts")
  const bootstrap =
    mutation &&
    `
    import { registerHooks } from "node:module";
    const stubs = ${JSON.stringify(
      Object.fromEntries(
        ["image", "link"].map((name) => [
          `next/${name}`,
          pathToFileURL(resolve(`scripts/verify-block-stubs-${name}.mjs`)).href,
        ])
      )
    )};
    registerHooks({ resolve(specifier, context, nextResolve) {
      return stubs[specifier]
        ? { url: stubs[specifier], shortCircuit: true, format: "module" }
        : nextResolve(specifier, context);
    }});
    const { createElement, Fragment } = await import("react");
    const { BLOCK_COMPONENTS } = await import(${JSON.stringify(pathToFileURL(resolve("components/blocks/block-registry.tsx")).href)});
    const original = BLOCK_COMPONENTS[${JSON.stringify(type)}];
    BLOCK_COMPONENTS[${JSON.stringify(type)}] = (block, ctx) => {
      const rendered = original(block, ctx);
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
      env: { ...process.env, BLOCK_FIDELITY: "off" },
    }
  )
}

describe("RF4d verify-block accessibility consumer", () => {
  test.skipIf(INSTALLED_BLOCK_TYPES.length === 0).each(INSTALLED_BLOCK_TYPES)(
    "RF4d CLI checks %s in EN and FR", blockProfileAny(INSTALLED_BLOCK_TYPES),
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
  ])("RF4d CLI refuses French-only %s", blockProfile(["hero-with-image"]), (_label, mutation, diagnostic) => {
    const result = runCli("hero-with-image", mutation)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain("accessibility(fr)")
    expect(result.stderr).toContain(diagnostic)
  })
})
