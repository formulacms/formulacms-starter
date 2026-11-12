"use server"

import { revalidatePath } from "next/cache"
import { api } from "@/convex/_generated/api"
import { assertLocalDevelopment } from "@/lib/assert-local-dev"
import { fetchAuthMutation, requireAuth } from "@/lib/auth-server"
import { setStarterContentTypeSelection } from "@/lib/content-types/starter-curation"
import { requireInstallationOwner } from "@/lib/owner-server"

export async function setContentTypeArchivedAction({
  type,
  archived,
}: {
  type: string
  archived: boolean
}): Promise<void> {
  await requireAuth("Sign in to manage Content Types.")
  await fetchAuthMutation(api.cms.contentTypes.setContentTypeArchived, {
    type,
    archived,
  })
  revalidatePath("/admin/content-types")
  revalidatePath(`/admin/content-types/${type}`)
}

/**
 * Engine-local starter curation is deliberately narrower than settings
 * archive: only the installation owner can change the committed starter
 * recipe, and generated/customer installs have no eligible file.
 */
export async function setContentTypeStarterAction({
  type,
  inStarter,
}: {
  type: string
  inStarter: boolean
}): Promise<string[]> {
  await requireAuth("Sign in to curate the starter Content Types.")
  assertLocalDevelopment("Starter Content Type curation")
  await requireInstallationOwner(
    "Only the installation owner can curate starter Content Types in the engine."
  )
  const result = await setStarterContentTypeSelection({ type, inStarter })
  revalidatePath("/admin/content-types")
  revalidatePath(`/admin/content-types/${type}`)
  return result
}
