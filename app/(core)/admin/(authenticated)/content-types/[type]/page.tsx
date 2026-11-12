import { connection } from "next/server"
import { notFound } from "next/navigation"
import { api } from "@/convex/_generated/api"
import { fetchAuthQuery } from "@/lib/auth-server"
import { adminContentTypeDetail } from "@/lib/admin/content-types"
import { ContentTypeDetail } from "@/components/admin/content-types/content-type-detail"
import { ArchivedContentTypesErrorBoundary } from "@/components/admin/content-types/use-archived-content-types"
import { getStarterCurationState } from "@/lib/content-types/starter-curation"

export default async function ContentTypeDetailPage({
  params,
}: {
  params: Promise<{ type: string }>
}) {
  await connection()
  const owner = await fetchAuthQuery(api.cms.owner.getOwnerSession, {})
  if (!owner) notFound()

  const { type } = await params
  const detail = adminContentTypeDetail(type)
  if (!detail) notFound()
  const starterState =
    owner.role === "admin" ? await getStarterCurationState() : null
  const starter =
    starterState?.available === true
      ? { included: starterState.contentTypes.includes(detail.type) }
      : null

  return (
    <ArchivedContentTypesErrorBoundary>
      <ContentTypeDetail detail={detail} starter={starter} />
    </ArchivedContentTypesErrorBoundary>
  )
}
