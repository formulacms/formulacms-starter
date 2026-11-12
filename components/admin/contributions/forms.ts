import type { ComponentType } from "react"
import type { LucideIcon } from "lucide-react"

/** System-owned browser contract for the optional Submissions navigation item. */
export type AdminFormsNavigationItem = Readonly<{
  name: "Submissions"
  href: "/admin/submissions"
  icon: LucideIcon
  keywords: string[]
  moduleId: "forms"
}>

/** Neutral sidebar inputs for the `admin.sidebar-status` slot. */
export type AdminFormsSidebarStatusProps = Readonly<{
  /** True once the owner session has resolved to the installation owner. */
  ownerReady: boolean
}>

export type AdminFormsBrowserBinding = Readonly<{
  navigationItem: AdminFormsNavigationItem
  /** Renders the Submissions unread badge; owns the unread-count query. */
  SidebarStatus: ComponentType<AdminFormsSidebarStatusProps>
}>

/** Community installs no M08 participant. Keep this a literal empty binding. */
export const ADMIN_FORMS_BROWSER_BINDING: AdminFormsBrowserBinding | null =
  null
