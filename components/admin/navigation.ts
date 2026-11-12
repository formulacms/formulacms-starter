import {
  ArrowLeftRight,
  Archive,
  FileText,
  Image,
  LayoutDashboard,
  Menu,
  Settings,
  Trash2,
  type LucideIcon,
} from "lucide-react"
import type { ContentType } from "@/convex/lib/contentTypes"
import { ADMIN_FORMS_BROWSER_BINDING } from "@/components/admin/contributions/forms"
import { MODULE_CATALOG } from "@/lib/modules/catalog"
import type { ModuleDescriptorV1 } from "@/lib/modules/types"

export type AdminNavItem = {
  name: string
  href: string
  icon: LucideIcon
  /** Explicit dictionary key for labels whose names are not safe key paths. */
  labelKey?: string
  keywords?: string[]
  /** Retained for command-palette compatibility with generated entries. */
  contentType?: ContentType
  /** Collection-level page list gate; `:own` grants do not qualify. */
  requiresAnyPageTypeList?: true
  /** Optional module that owns this static `admin.navigation` registration. */
  moduleId?: string
}

/**
 * Validates the installed navigation at module load (M01 recovery design B4,
 * RG1). An entry owned by a module must name an optional catalog module that
 * declares `admin.navigation`, and no two entries may share a route, so an
 * invalid registration throws before release instead of at runtime.
 *
 * The result is a compile-time constant. Nothing here reads module state: an
 * installed module's entry stays listed while the module is off, and its route
 * shows the off state.
 */
export function composeAdminNavigation(
  items: readonly AdminNavItem[],
  catalog: readonly ModuleDescriptorV1[] = MODULE_CATALOG
): readonly AdminNavItem[] {
  const hrefs = new Set<string>()
  for (const item of items) {
    if (hrefs.has(item.href)) {
      throw new Error(`Admin navigation already has an entry for "${item.href}".`)
    }
    hrefs.add(item.href)
    if (item.moduleId === undefined) continue
    const descriptor = catalog.find(
      (candidate) => candidate.id === item.moduleId
    )
    if (
      !descriptor ||
      descriptor.required ||
      !descriptor.contributions.includes("admin.navigation")
    ) {
      throw new Error(
        `Module "${item.moduleId}" cannot contribute "admin.navigation".`
      )
    }
  }
  return Object.freeze(items.map((item) => Object.freeze({ ...item })))
}

/** The Redirects module's static `admin.navigation` registration (M01c). */
export const REDIRECTS_NAVIGATION: AdminNavItem = {
  name: "Redirects",
  href: "/admin/redirects",
  icon: ArrowLeftRight,
  keywords: ["urls", "rewrites"],
  moduleId: "redirects",
}

export const ADMIN_NAVIGATION = composeAdminNavigation([
  { name: "Dashboard", href: "/admin", icon: LayoutDashboard },
  {
    name: "Content",
    href: "/admin/pages",
    icon: FileText,
    labelKey: "content",
    requiresAnyPageTypeList: true,
  },
  { name: "Menus", href: "/admin/menus", icon: Menu },
  { name: "Media", href: "/admin/media", icon: Image },
  REDIRECTS_NAVIGATION,
  // Submissions is the Forms (M08) navigation item; it is listed only when a
  // Forms participant is bound, and composition then requires its catalog
  // module.
  ...(ADMIN_FORMS_BROWSER_BINDING
    ? [ADMIN_FORMS_BROWSER_BINDING.navigationItem]
    : []),
  {
    name: "Archive",
    href: "/admin/archive",
    icon: Archive,
    labelKey: "archive",
    requiresAnyPageTypeList: true,
  },
  { name: "Trash", href: "/admin/trash", icon: Trash2 },
  { name: "Settings", href: "/admin/settings", icon: Settings },
])
