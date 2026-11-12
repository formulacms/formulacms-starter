// Shared layout for all /admin/settings/* pages: a left sidebar of sub-sections.
"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { LucideIcon } from "lucide-react"
import {
  Settings,
  Languages,
  Mail,
  UserCircle,
  Boxes,
  Package,
} from "lucide-react"
import { ADMIN_AI_SETTINGS_BROWSER_BINDING } from "@/components/admin/contributions/ai-settings"
import { ADMIN_AUTHORING_TOOLS_BROWSER_BINDING } from "@/components/admin/contributions/authoring-tools"

import { useModuleGate } from "@/components/admin/admin-module-state-provider"
import { showsModuleEntry } from "@/components/admin/module-gate"

type NavItem = { key: string; href: string; icon: LucideIcon; exact: boolean }

const NAV_ITEMS: NavItem[] = [
  { key: "general", href: "/admin/settings", icon: Settings, exact: true },
  {
    key: "languages",
    href: "/admin/settings/languages",
    icon: Languages,
    exact: false,
  },
  ...(ADMIN_AI_SETTINGS_BROWSER_BINDING
    ? [ADMIN_AI_SETTINGS_BROWSER_BINDING.navigationItem]
    : []),
  { key: "email", href: "/admin/settings/email", icon: Mail, exact: false },
  {
    key: "modules",
    href: "/admin/settings/modules",
    icon: Package,
    exact: false,
  },
  {
    key: "account",
    href: "/admin/settings/account",
    icon: UserCircle,
    exact: false,
  },
  {
    key: "contentTypes",
    href: "/admin/content-types",
    icon: Boxes,
    exact: false,
  },
  ...(ADMIN_AUTHORING_TOOLS_BROWSER_BINDING
    ? [ADMIN_AUTHORING_TOOLS_BROWSER_BINDING.settingsNavigationItem]
    : []),
]

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const aiGate = useModuleGate("ai")
  const pathname = usePathname()
  const t = useTranslations("settings.nav")

  // The parent (authenticated) layout already pads its <main> (p-6 lg:p-8) and
  // sets min-h-screen, so this sub-layout adds only a sidebar + a left gutter —
  // no extra outer padding (avoids double-padding) and no own min-height.
  return (
    <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:gap-0">
      <aside className="w-full min-w-0 border-b border-border pb-3 lg:w-56 lg:shrink-0 lg:border-r lg:border-b-0 lg:pr-3 lg:pb-0">
        <p className="mb-2 px-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase lg:mb-4">
          {t("heading")}
        </p>
        <nav className="flex gap-0.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
          {NAV_ITEMS.filter((item) => item.key !== "ai" || showsModuleEntry(aiGate)).map((item) => {
            const isActive = item.exact
              ? pathname === item.href
              : pathname.startsWith(item.href)
            return (
              <Link
                key={item.key}
                href={item.href}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {t(item.key as Parameters<typeof t>[0])}
              </Link>
            )
          })}
        </nav>
      </aside>

      <main className="min-w-0 flex-1 lg:pl-6">{children}</main>
    </div>
  )
}
