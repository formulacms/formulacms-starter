"use client"

export type EditionReservedRolePolicy = {
  role: "editor" | "viewer"
  permissions: string[]
}

/** Community edits the two reserved policies but has no custom-role lifecycle. */
export function EditionRolesExtension(_props: {
  canManage: boolean
  canEdit: boolean
  reservedPolicies: EditionReservedRolePolicy[] | undefined
}) {
  return null
}
