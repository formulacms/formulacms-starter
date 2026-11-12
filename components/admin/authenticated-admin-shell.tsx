import { redirect, unstable_rethrow } from "next/navigation"
import { api } from "@/convex/_generated/api"
import { fetchAuthQuery, safeIsAuthenticated } from "@/lib/auth-server"
import { AdminShell } from "@/components/admin/admin-shell"
import { INSTALLED_ADMIN_CONTRIBUTIONS } from "./admin-contributions"
import { reportContainedModuleFailure } from "@/lib/modules/containment"
import { ADMIN_AI_HELP_SERVER_BINDING } from "@/components/admin/contributions/ai-help.server"

export async function AuthenticatedAdminShell({
  children,
}: {
  children: React.ReactNode
}) {
  // The authenticated route group is also the direct-route boundary. A
  // Better Auth session alone is insufficient: only the exact durable owner
  // binding may render the admin tree.
  if (!(await safeIsAuthenticated())) redirect("/sign-in")
  const owner = await fetchAuthQuery(api.cms.owner.getOwnerSession, {})
  if (!owner) redirect("/sign-in")
  // shell-module-state: no binding means no optional state read at all.
  // The participant gates itself on the live module state, so route data is
  // passed whatever the outcome: switching a module does not re-render this
  // server layout.
  let moduleStateFailed = false
  const helpModuleId = INSTALLED_ADMIN_CONTRIBUTIONS["admin.ai-help"]?.moduleId
  if (ADMIN_AI_HELP_SERVER_BINDING) {
    try {
      await fetchAuthQuery(api.cms.modules.effective, {})
    } catch (error) {
      unstable_rethrow(error)
      moduleStateFailed = true
      reportContainedModuleFailure(
        "optional-modules",
        "admin.shell-module-state",
        error
      )
    }
  }
  // loadRouteData: a separate boundary for this participant alone.
  let aiHelpRouteData
  if (!moduleStateFailed && helpModuleId && ADMIN_AI_HELP_SERVER_BINDING) {
    try {
      aiHelpRouteData = await ADMIN_AI_HELP_SERVER_BINDING.loadRouteData()
    } catch (error) {
      unstable_rethrow(error)
      reportContainedModuleFailure(helpModuleId, "admin.contribution", error)
    }
  }
  return (
    <AdminShell
      moduleStateFailed={moduleStateFailed}
      {...(aiHelpRouteData === undefined ? {} : { aiHelpRouteData })}
    >
      {children}
    </AdminShell>
  )
}
