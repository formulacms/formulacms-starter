// @vitest-environment node
import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"

async function source(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8")
}

function literalProfiles(value: string): string[] {
  return [...value.matchAll(/profile:\s*"([^"]+)"/g)].map((match) => match[1])
}

describe("migrated runtime workload assignments", () => {
  test("keeps field/rich translation mechanical and whole-page translation brand-sensitive", async () => {
    const value = await source("convex/agents/localizer.ts")
    expect(
      [...value.matchAll(/gate\(ctx,\s*"([^"]+)"\)/g)].map((match) => match[1])
    ).toEqual([
      "mechanical-translation",
      "mechanical-translation",
      "brand-translation",
    ])
    expect(value).toContain("profile: cfg.profile")
  })

  test("keeps editorial, outline/meta, and help assignments exact after slice retirement", async () => {
    // The slice-author/slice-renderer Convex actions retired 2026-07-14
    // (ADR-0032 amendment) — slice authoring now runs in the build lane via
    // dev-only Next server actions calling `scripts/lib/ai-engine.ts`, so
    // there is no runtime workflow assignment left to pin for them.
    const [contentWriter, help] = await Promise.all([
      source("convex/agents/contentWriter.ts"),
      source("convex/agents/helpAssistant.ts"),
    ])
    expect(literalProfiles(contentWriter).sort()).toEqual([
      "editorial-copy",
      "editorial-copy",
      "editorial-copy",
      "editorial-copy",
      "structured-outline-meta",
      "structured-outline-meta",
    ])
    expect(literalProfiles(help)).toEqual(["grounded-help"])
  })

  test("keeps the established workflow boundaries around the transport calls", async () => {
    const [localizer, contentWriter, help] = await Promise.all([
      source("convex/agents/localizer.ts"),
      source("convex/agents/contentWriter.ts"),
      source("convex/agents/helpAssistant.ts"),
    ])
    expect(localizer).toContain('requireOwnerAndOptionalModule(ctx, "ai")')
    expect(localizer).toContain("await requireAiTranslationModule(ctx)")
    expect(localizer).toContain("await enforceAiRateLimit(ctx)")
    expect(contentWriter).toContain("return withAiAudit(")
    expect(contentWriter).toContain("await gateAi(ctx")
    expect(help).toContain(
      "await ctx.runMutation(internal.cms.aiAuditLog.recordEvent"
    )
  })
})
