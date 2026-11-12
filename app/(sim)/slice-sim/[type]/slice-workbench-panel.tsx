import { readSimulatorTypography } from "./read-typography"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { createSampleSlice } from "@/lib/slices/sample"
import type { SliceType } from "@/lib/slices/builder"
import { flattenSliceContent } from "@/lib/slices/flatten-content"
import { getSliceReference } from "@/lib/slices/authoring/reference"
import {
  comparisonSnapshotFile,
  comparisonSnapshotUrl,
  type ThumbnailSlot,
  type ThumbnailVariant,
} from "@/lib/slices/thumbnails"
import { SnapshotButton } from "./snapshot-button"
import { isComparisonSnapshotStale } from "./snapshot-freshness"
import { SliceWorkbench } from "./slice-workbench"

/** The admin Slice Editor and simulator use one sample/selection/write surface. */
export async function SliceWorkbenchPanel({
  type,
  label,
}: {
  type: SliceType
  label: string
}) {
  const [sourceImages, snapshots, typographyTokens] = await Promise.all([
    getSourceReferences(type),
    getCapturedSnapshots(type),
    readSimulatorTypography(),
  ])
  return (
    <SliceWorkbench
      key={type}
      type={type}
      label={label}
      initialSourceUrls={sourceImages}
      typographyTokens={typographyTokens}
      initialSnapshot={snapshots}
      snapshotAction={<SnapshotButton type={type} iconOnly />}
      outline={flattenSliceContent(createSampleSlice(type))}
    />
  )
}

async function getSourceReferences(type: string): Promise<{
  desktop: string | null
  mobile: string | null
}> {
  const [desktop, mobile] = await Promise.all([
    getSliceReference(type, "desktop"),
    getSliceReference(type, "mobile"),
  ])
  return {
    desktop: desktop?.url ?? null,
    mobile: mobile?.url ?? null,
  }
}

async function getCapturedSnapshots(type: string): Promise<{
  current: { desktop: string | null; mobile: string | null }
  before: { desktop: string | null; mobile: string | null }
  stale: { desktop: boolean; mobile: boolean }
}> {
  const desktopFile = comparisonSnapshotFile(type, "desktop", "current")
  const mobileFile = comparisonSnapshotFile(type, "mobile", "current")
  const sourceFiles = [
    join(process.cwd(), "components", "slices", `${type}.tsx`),
    join(process.cwd(), "app", "globals.css"),
  ]
  const [
    currentDesktop,
    currentMobile,
    beforeDesktop,
    beforeMobile,
    staleDesktop,
    staleMobile,
  ] = await Promise.all([
    snapshotUrl(type, "desktop", "current"),
    snapshotUrl(type, "mobile", "current"),
    snapshotUrl(type, "desktop", "before"),
    snapshotUrl(type, "mobile", "before"),
    isComparisonSnapshotStale(sourceFiles, desktopFile),
    isComparisonSnapshotStale(sourceFiles, mobileFile),
  ])
  return {
    current: { desktop: currentDesktop, mobile: currentMobile },
    before: { desktop: beforeDesktop, mobile: beforeMobile },
    stale: { desktop: staleDesktop, mobile: staleMobile },
  }
}

async function snapshotUrl(
  type: string,
  variant: ThumbnailVariant,
  slot: ThumbnailSlot
): Promise<string | null> {
  const snapshotFile = comparisonSnapshotFile(type, variant, slot)
  return (await fileExists(snapshotFile))
    ? comparisonSnapshotUrl(type, variant, slot)
    : null
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    const info = await stat(absolutePath)
    return info.isFile()
  } catch {
    return false
  }
}
