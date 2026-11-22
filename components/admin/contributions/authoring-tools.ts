import { Layers } from "lucide-react"
import { DeletionOverlayProvider } from "@/components/providers/deletion-overlay-provider"
import type { AdminAuthoringToolsBrowserBinding } from "@/components/admin/contributions/authoring-tools.types"

/** Local Block Editor composition; source tools stay unavailable in production. */
export const ADMIN_AUTHORING_TOOLS_BROWSER_BINDING: AdminAuthoringToolsBrowserBinding | null =
  process.env.NODE_ENV === "production"
    ? null
    : {
        settingsNavigationItem: {
          key: "blocks",
          href: "/admin/blocks",
          icon: Layers,
          exact: false,
        },
        SettingsDesignSystemEntry: () => null,
        DeletionOverlay: DeletionOverlayProvider,
      }
