import { resolveSiteUrl } from "./site-url"

export const OPEN_GRAPH_IMAGE_WIDTH = 1200
export const OPEN_GRAPH_IMAGE_HEIGHT = 630
export const DEFAULT_OPEN_GRAPH_IMAGE_PATH = "/starter-og.svg"

export type OpenGraphImage = {
  url: string
  width: typeof OPEN_GRAPH_IMAGE_WIDTH
  height: typeof OPEN_GRAPH_IMAGE_HEIGHT
  alt: string
}

type ResolveOpenGraphImageArgs = {
  pageImage?: string | null
  siteDefaultImage?: string | null
  siteUrl: string
  alt: string
}

export function resolveOpenGraphImage({
  pageImage,
  siteDefaultImage,
  siteUrl,
  alt,
}: ResolveOpenGraphImageArgs): OpenGraphImage {
  const origin = resolveSiteUrl(siteUrl)
  const candidates = [
    firstPresent(pageImage),
    firstPresent(siteDefaultImage),
    DEFAULT_OPEN_GRAPH_IMAGE_PATH,
  ].filter((value): value is string => value !== undefined)

  return {
    url: absoluteUrl(candidates, origin),
    width: OPEN_GRAPH_IMAGE_WIDTH,
    height: OPEN_GRAPH_IMAGE_HEIGHT,
    alt,
  }
}

function firstPresent(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function absoluteUrl(candidates: string[], origin: string): string {
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, origin)
      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.toString()
      }
    } catch {
      continue
    }
  }
  return new URL(
    DEFAULT_OPEN_GRAPH_IMAGE_PATH,
    "http://localhost:3000"
  ).toString()
}
