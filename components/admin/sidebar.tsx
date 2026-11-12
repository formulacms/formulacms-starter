"use client"

import { useModuleGate } from "./admin-module-state-provider"
import { showsModuleEntry } from "./module-gate"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useQuery } from "convex/react"
import { useTranslations } from "next-intl"
import { authClient } from "@/lib/auth-client"
import { api } from "@/convex/_generated/api"
import { ADMIN_FORMS_BROWSER_BINDING } from "./contributions/forms"
import { ADMIN_NAVIGATION, type AdminNavItem } from "./navigation"
import { LogOut } from "lucide-react"

export function AdminSidebar() {
  return <AdminSidebarContent />
}

function AdminSidebarContent() {
  const pathname = usePathname()
  const router = useRouter()
  const t = useTranslations("sidebar")
  const owner = useQuery(api.cms.owner.getOwnerSession)
  // The Submissions badge is a Forms (M08) sidebar status; the participant
  // owns its query, and without one the sidebar reads nothing optional.
  const formsBinding = ADMIN_FORMS_BROWSER_BINDING
  const ownerReady = owner !== undefined && owner !== null

  const activeHref = (item: AdminNavItem): boolean => {
    if (pathname === item.href) return true
    return item.href !== "/admin" && pathname.startsWith(item.href)
  }

  const redirectsGate = useModuleGate("redirects")
  const visibleNav = ADMIN_NAVIGATION.filter(
    (item) => item.moduleId !== "redirects" || showsModuleEntry(redirectsGate)
  )

  async function handleLogout() {
    await authClient.signOut()
    router.push("/sign-in")
    router.refresh()
  }

  return (
    <aside
      aria-label={t("brand")}
      className="fixed top-0 left-0 z-30 flex h-screen w-60 flex-col border-r bg-background"
    >
      <div className="border-b p-4">
        <p className="text-sm font-semibold tracking-tight">{t("brand")}</p>
      </div>

      <nav
        aria-label={t("brand")}
        className="flex-1 space-y-0.5 overflow-y-auto p-3"
      >
        {visibleNav.map((item) => {
          const isActive = activeHref(item)
          const label = t(
            `nav.${item.labelKey ?? item.name.toLowerCase()}` as Parameters<
              typeof t
            >[0]
          )

          return (
            <div key={item.name}>
              <Link
                href={item.href}
                className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <item.icon className="size-4 shrink-0" />
                <span className="flex-1">{label}</span>
                {formsBinding &&
                  item.href === formsBinding.navigationItem.href && (
                    <formsBinding.SidebarStatus ownerReady={ownerReady} />
                  )}
              </Link>
            </div>
          )
        })}
      </nav>

      <div className="border-t p-3">
        {owner && (
          <div className="mb-2 rounded-md border bg-muted/40 px-3 py-2">
            <p className="text-xs font-medium text-foreground">
              {t("role.admin")}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {owner.email ?? owner.authId}
            </p>
          </div>
        )}
        <button
          type="button"
          onClick={handleLogout}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <LogOut className="size-4 shrink-0" />
          {t("signOut")}
        </button>
      </div>
    </aside>
  )
}
