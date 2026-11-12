import { catalogAssets } from "./assets"
import type {
  CatalogAsset,
  CatalogAssetKind,
  CatalogAssetSummary,
} from "./schema"

export type CatalogSearchFilters = {
  query?: string
  kind?: CatalogAssetKind
  group?: string
  limit?: number
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en")
}

function searchableText(asset: CatalogAsset): string {
  return normalize(
    [
      asset.id,
      asset.slug,
      asset.name,
      asset.summary,
      asset.group,
      ...asset.tags,
      asset.discovery.purpose,
      ...asset.discovery.goodFor,
    ].join(" ")
  )
}

export function summarizeCatalogAsset(
  asset: CatalogAsset
): CatalogAssetSummary {
  return {
    id: asset.id,
    slug: asset.slug,
    kind: asset.kind,
    name: asset.name,
    summary: asset.summary,
    group: asset.group,
    tags: asset.tags,
    version: asset.version,
    visibility: asset.visibility,
  }
}

export function listCatalog(): CatalogAssetSummary[] {
  return catalogAssets
    .map(summarizeCatalogAsset)
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function searchCatalog({
  query,
  kind,
  group,
  limit = 20,
}: CatalogSearchFilters = {}): CatalogAssetSummary[] {
  const terms = normalize(query ?? "")
    .split(/\s+/)
    .filter(Boolean)
  const normalizedGroup = group ? normalize(group) : undefined
  const boundedLimit = Math.max(1, Math.min(limit, 20))

  return catalogAssets
    .filter((asset) => !kind || asset.kind === kind)
    .filter(
      (asset) => !normalizedGroup || normalize(asset.group) === normalizedGroup
    )
    .filter((asset) => {
      const haystack = searchableText(asset)
      return terms.every((term) => haystack.includes(term))
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, boundedLimit)
    .map(summarizeCatalogAsset)
}

export function getCatalogAsset(idOrSlug: string): CatalogAsset | undefined {
  const lookup = normalize(idOrSlug)
  return catalogAssets.find(
    (asset) =>
      normalize(asset.id) === lookup || normalize(asset.slug) === lookup
  )
}
