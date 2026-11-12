#!/usr/bin/env tsx
/**
 * ADR-0025 §3 — enforces the public/admin token boundary.
 *
 * Public surface (components/public/**, app/(public)/**) MAY use:
 *   - any utility resolving to base-tokens (shadcn neutrals)
 *   - any utility resolving to public-tokens (ADR-0020 design system)
 *
 * Public surface MUST NOT use:
 *   - any utility resolving to admin-tokens (currently the --sidebar* family)
 *   - direct references to admin-shell components (components/admin/**, components/ui/sidebar*)
 *
 * Admin surface (components/admin/**, app/(core)/**) MAY use:
 *   - any utility resolving to base-tokens
 *   - any utility resolving to admin-tokens
 *
 * Admin surface MUST NOT use:
 *   - any utility resolving to public-tokens that is unambiguously editorial
 *     (currently `bg-surface, bg-surface-2, bg-surface-3, text-brand, text-heading,
 *      text-display, text-lead, text-body, text-caption, text-on-surface,
 *      text-on-surface-muted, py-section, px-gutter, max-w-content, max-w-wide,
 *      max-w-prose-content`).
 *
 * Anything not in either ban list is treated as base-tokens and allowed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "glob";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const PUBLIC_GLOBS = ["components/public/**/*.{ts,tsx}", "app/(public)/**/*.{ts,tsx}"];
const ADMIN_GLOBS = ["components/admin/**/*.{ts,tsx}", "app/(core)/**/*.{ts,tsx}"];

// Negative lookbehind `(?<![-\w])` keeps the regex from matching tokens that
// sit inside a longer identifier or kebab-case string (e.g. the slice slug
// `rich-text-body` would otherwise hit `text-body`). The token must be at a
// class-list boundary — start of line, whitespace, or a quote.
const ADMIN_ONLY_TOKEN_PATTERNS = [
  /(?<![-\w])(bg|text|border|ring|outline|from|to|via|fill|stroke|divide|placeholder)-sidebar(-[a-z]+)?\b/g,
];
const PUBLIC_ONLY_TOKEN_PATTERNS = [
  /(?<![-\w])bg-surface(-[23])?\b/g,
  /(?<![-\w])text-(brand|heading|display|lead|body|caption|on-surface(-muted)?)\b/g,
  /(?<![-\w])py-section\b/g,
  /(?<![-\w])px-gutter\b/g,
  /(?<![-\w])max-w-(content|wide|prose-content)\b/g,
];

async function scan(root: string, globs: string[], banned: RegExp[], label: string) {
  // Assertions and fixtures describe other surfaces; only runtime code owns tokens.
  const files = (await Promise.all(globs.map((g) => glob(g, {
    cwd: root,
    nodir: true,
    ignore: ["**/*.{test,spec}.{ts,tsx}"],
  })))).flat();
  const hits: Array<{ file: string; line: number; match: string; rule: string }> = [];
  for (const rel of files) {
    const content = fs.readFileSync(path.join(root, rel), "utf8");
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      for (const rx of banned) {
        for (const m of line.matchAll(new RegExp(rx.source, "g"))) {
          hits.push({ file: rel, line: i + 1, match: m[0], rule: rx.source });
        }
      }
    });
  }
  if (hits.length) {
    console.error(`\n✗ Token-boundary violations on ${label} surface (${hits.length}):`);
    for (const h of hits.slice(0, 50)) {
      console.error(`  ${h.file}:${h.line}  ${h.match}  (banned: /${h.rule}/)`);
    }
    if (hits.length > 50) console.error(`  ... and ${hits.length - 50} more`);
  } else {
    console.log(`✓ ${label} surface clean`);
  }
  return hits.length;
}

export async function checkTokenBoundary(root = ROOT): Promise<number> {
  const publicHits = await scan(root, PUBLIC_GLOBS, ADMIN_ONLY_TOKEN_PATTERNS, "public");
  const adminHits = await scan(root, ADMIN_GLOBS, PUBLIC_ONLY_TOKEN_PATTERNS, "admin");
  if (publicHits + adminHits > 0) return publicHits + adminHits;
  console.log("\n✓ Token boundary intact (ADR-0025 §3).");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void checkTokenBoundary().then((hits) => {
    if (hits > 0) process.exitCode = 1;
  });
}
