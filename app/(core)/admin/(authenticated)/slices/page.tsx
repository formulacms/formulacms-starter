import { getTranslations } from "next-intl/server"
import { stat } from "node:fs/promises"
import { connection } from "next/server"
import { notFound } from "next/navigation"
import { ADMIN_AI_SETTINGS_BROWSER_BINDING } from "@/components/admin/contributions/ai-settings"
import { ADMIN_AI_SETTINGS_SERVER_BINDING } from "@/components/admin/contributions/ai-settings.server"
import { api } from "@/convex/_generated/api"
import { fetchAuthQuery } from "@/lib/auth-server"
import { isLocalDevelopment } from "@/lib/assert-local-dev"
import { getSliceCatalog } from "@/lib/slices/catalog"
import { getStarterShipList } from "@/lib/slices/starter-ship"
import { thumbnail } from "@/lib/slices/thumbnails"
import {
  SliceCatalogGrid,
  type SliceCatalogTile,
} from "@/components/admin/slices/slice-catalog-grid"
import { resolveSliceVerificationScenario } from "@/lib/slices/verification"

/** The block guide, as shipped inside the owner's own project. */
const SLICE_GUIDE_PATH = "docs/starter/content-model-authoring.md"

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    return (await stat(absolutePath)).isFile()
  } catch {
    return false
  }
}

export default async function AdminSlicesPage({
  searchParams,
}: {
  searchParams?: Promise<{ verify?: string | string[] }>
}) {
  if (process.env.NODE_ENV === "production") notFound()

  // Force dynamic rendering so the request's auth cookies reach the archived-
  // state read below (fetchAuthQuery → owner operation access). Without this the
  // page can render without auth and the read silently falls back to empty.
  await connection()

  const t = await getTranslations("slices.catalog")
  const catalog = getSliceCatalog()

  // Archived Slice Types come from the siteSettings singleton. A failed read
  // is an explicit unknown state: the catalog stays browsable, but it must not
  // claim every type is active or expose lifecycle mutations.
  const verificationScenario = resolveSliceVerificationScenario(
    (await searchParams)?.verify
  )
  const archivedTypeList =
    verificationScenario === "archive-read-failure"
      ? null
      : await fetchAuthQuery(api.cms.slices.getArchivedSliceTypes, {}).catch(
          () => null
        )
  const archivedTypes = archivedTypeList ? new Set(archivedTypeList) : null

  // "Add slice" comes from the AI module's settings binding; without it the
  // header row stays as it is. A failed readiness read means "not ready".
  const addSlice =
    ADMIN_AI_SETTINGS_BROWSER_BINDING && ADMIN_AI_SETTINGS_SERVER_BINDING
      ? {
          Entry: ADMIN_AI_SETTINGS_BROWSER_BINDING.SlicesAddEntry,
          ready: await ADMIN_AI_SETTINGS_SERVER_BINDING.resolveSliceCreatorReady().catch(
            () => false
          ),
        }
      : null

  // Which slices are marked to ship to formulacms-starter. `null` ⇒ the engine-only
  // ship-list file doesn't resolve (a generated starter / agency fork), so the
  // starter badge stays hidden because every tile resolves to `shipped: false`.
  const shipList = await getStarterShipList()
  const shippedTypes = new Set(shipList ?? [])

  const tiles: SliceCatalogTile[] = await Promise.all(
    catalog.map(async (item) => {
      const { url, file } = thumbnail(item.type)
      return {
        ...item,
        thumbnailUrl: (await fileExists(file)) ? url : null,
        archived: archivedTypes?.has(item.type) ?? null,
        shipped: shippedTypes.has(item.type),
      }
    })
  )

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p
            data-testid="slices-intro"
            className="mt-1 text-sm text-muted-foreground"
          >
            {t("intro")}{" "}
            <span className="font-medium text-foreground">
              {t.rich("guide", {
                path: SLICE_GUIDE_PATH,
                code: (chunks) => <code>{chunks}</code>,
              })}
            </span>
          </p>
        </div>
        {addSlice && <addSlice.Entry ready={addSlice.ready} />}
      </div>

      {/* Shipping writes the committed engine-only ship-list, so the toggle
          needs both a resolvable list and a local dev server — the same pair
          `setStarterShippedAction` enforces. */}
      <SliceCatalogGrid
        items={tiles}
        canShip={shipList !== null && isLocalDevelopment()}
        isEngine={shipList !== null}
      />
    </div>
  )
}
