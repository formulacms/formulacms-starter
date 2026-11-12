import { ArchivedContentTypesErrorBoundary } from "@/components/admin/content-types/use-archived-content-types"
import { ADMIN_AI_WRITING_SERVER_BINDING } from "@/components/admin/contributions/ai-writing.server"
import { NewPageForm } from "@/components/admin/new-page-form"

export default async function NewPagePage() {
  const aiWritingRouteData = ADMIN_AI_WRITING_SERVER_BINDING
    ? await ADMIN_AI_WRITING_SERVER_BINDING.loadRouteData()
    : undefined
  return (
    <div className="max-w-2xl space-y-6">
      <ArchivedContentTypesErrorBoundary>
        <NewPageForm
          {...(aiWritingRouteData === undefined ? {} : { aiWritingRouteData })}
        />
      </ArchivedContentTypesErrorBoundary>
    </div>
  )
}
