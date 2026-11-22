/**
 * Capture the catalog thumbnail and full-page comparison snapshots for every
 * installed block type by driving the block simulator with Playwright.
 *
 * Run with the dev server already up:
 *   pnpm dev                      # in one terminal
 *   pnpm thumbnails               # in another
 *
 * Prereqs: `pnpm add -D playwright` and `pnpm exec playwright install chromium`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { INSTALLED_BLOCK_TYPES } from "@/convex/lib/blocks";
import { comparisonSnapshotFilename } from "@/lib/blocks/thumbnails";
import { loadBlockSimBaseUrl } from "./lib/block-sim-base";

const BASE_URL = loadBlockSimBaseUrl();
// Catalog thumbnails are deliberate 16:9 crops. Comparison snapshots must
// match the simulator's own viewport widths or they capture a different
// responsive breakpoint from the live render they are compared against.
const THUMBNAIL_VIEWPORTS = {
  desktop: { width: 896, height: 504 },
  mobile: { width: 390, height: 844 },
} as const;
const COMPARISON_VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;
type ViewportName = keyof typeof THUMBNAIL_VIEWPORTS;
const OUT_DIR = join(process.cwd(), "public", "block-sim");
const HIDE_DEV_OVERLAY =
  "#next-logo,[data-nextjs-dev-tools-button],nextjs-portal{display:none!important}";

function thumbnailFilename(type: string, viewport: ViewportName): string {
  return viewport === "desktop" ? `${type}.png` : `${type}.${viewport}.png`;
}

async function captureForViewport(
  context: BrowserContext,
  type: string,
  { fullPage }: { fullPage: boolean },
): Promise<Buffer> {
  const page = await context.newPage();
  try {
    await page.goto(
      `${BASE_URL}/block-sim/${type}?bare=${fullPage ? "1" : "thumb"}`,
      {
        waitUntil: "networkidle",
      },
    );
    await page
      .waitForFunction(
        () =>
          Array.from(document.images).every(
            (img) => img.complete && img.naturalWidth > 0,
          ),
        { timeout: 5000 },
      )
      .catch(() => undefined);
    await page.addStyleTag({ content: HIDE_DEV_OVERLAY });
    return await page.screenshot({ type: "png", fullPage });
  } finally {
    await page.close();
  }
}

export async function captureMany(
  types: readonly string[],
  { viewports = ["desktop"] as readonly ViewportName[] }: {
    viewports?: readonly ViewportName[];
  } = {},
): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const viewport of viewports) {
      for (const artifact of ["thumbnail", "comparison"] as const) {
        const fullPage = artifact === "comparison";
        const context = await browser.newContext({
          viewport: fullPage
            ? COMPARISON_VIEWPORTS[viewport]
            : THUMBNAIL_VIEWPORTS[viewport],
          deviceScaleFactor: 2,
          colorScheme: "light",
        });
        try {
          for (const type of types) {
            const buf = await captureForViewport(context, type, { fullPage });
            const filename = fullPage
              ? comparisonSnapshotFilename(type, viewport)
              : thumbnailFilename(type, viewport);
            await writeFile(join(OUT_DIR, filename), buf);
          }
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}

async function main() {

  console.log(`Capturing ${INSTALLED_BLOCK_TYPES.length} block thumbnails…`);
  await captureMany(INSTALLED_BLOCK_TYPES, { viewports: ["desktop", "mobile"] });
}

// Run main() only when executed as a script (pnpm thumbnails), not when the
// module is imported by a server action for on-demand single-block captures.
import { pathToFileURL } from "node:url";
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
     
    console.error(err);
    process.exit(1);
  });
}
