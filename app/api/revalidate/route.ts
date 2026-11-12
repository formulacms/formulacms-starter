import { createHash, timingSafeEqual } from "node:crypto"
import { revalidatePath, revalidateTag } from "next/cache"
import { ALL_CMS_TAGS, type CmsTag } from "@/lib/cms/tags"

function hasValidSecret(
  expected: string | undefined,
  submitted: string | null
) {
  if (!expected) {
    return false
  }

  const hash = (secret: string) => createHash("sha256").update(secret).digest()

  return timingSafeEqual(hash(expected), hash(submitted ?? ""))
}

/**
 * On-demand ISR revalidation, called by Convex after CMS content changes (see
 * convex/cms/revalidate.ts). Bypasses the time-based `revalidate` floor so
 * public content updates promptly.
 *
 * Purges both the Full Route Cache (`revalidatePath` per public URL) and the
 * `unstable_cache` Data Cache (`revalidateTag`). The latter is required because
 * the page/layout wrap their no-store Convex reads in `unstable_cache`
 * (lib/cms/cache.ts), which `revalidatePath` alone won't clear. Tags are
 * type-level (pages / menus / settings), so a caller only purges the reads its
 * change can affect — the request says which via `tags`.
 *
 * Security: gated by a shared secret (`REVALIDATE_SECRET`). Without it set, the
 * endpoint refuses all calls (fail closed) — the time-based revalidate still
 * keeps content fresh, just not instantly.
 */
export async function POST(request: Request) {
  const secret = process.env.REVALIDATE_SECRET
  if (!hasValidSecret(secret, request.headers.get("x-revalidate-secret"))) {
    return Response.json({ revalidated: false }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ revalidated: false }, { status: 400 })
  }

  const { paths, layoutPaths, tags } = (body ?? {}) as {
    paths?: unknown
    layoutPaths?: unknown
    tags?: unknown
  }

  const revalidatedPaths: string[] = []
  if (Array.isArray(paths)) {
    for (const p of paths) {
      // Only internal, relative paths — never an arbitrary string.
      if (typeof p === "string" && p.startsWith("/") && !p.startsWith("//")) {
        revalidatePath(p)
        revalidatedPaths.push(p)
      }
    }
  }

  const revalidatedLayoutPaths: string[] = []
  if (Array.isArray(layoutPaths)) {
    for (const path of layoutPaths) {
      if (
        typeof path === "string" &&
        path.startsWith("/") &&
        !path.startsWith("//")
      ) {
        revalidatePath(path, "layout")
        revalidatedLayoutPaths.push(path)
      }
    }
  }

  // Purge the CMS Data Cache by content type. Only known tags are honored (the
  // secret already gates the endpoint; this is defense-in-depth). Absent `tags`
  // → purge all CMS tags, preserving the original "any change refreshes
  // everything" behavior for callers that don't specify. Next 16's
  // revalidateTag takes a cacheLife profile; `{ expire: 0 }` forces immediate
  // expiry (vs. the named "max" profile, which keeps serving stale).
  const requested: CmsTag[] = Array.isArray(tags)
    ? ALL_CMS_TAGS.filter((t) => (tags as unknown[]).includes(t))
    : [...ALL_CMS_TAGS]
  for (const tag of requested) {
    revalidateTag(tag, { expire: 0 })
  }

  return Response.json({
    revalidated: true,
    paths: revalidatedPaths,
    layoutPaths: revalidatedLayoutPaths,
    tags: requested,
  })
}
