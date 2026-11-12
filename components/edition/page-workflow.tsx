"use client"

import type { Id } from "@/convex/_generated/dataModel"

export type EditionPageWorkflowContext = {
  state: null
  status: "working_draft"
  requiresApproval: false
  stagingExists: boolean
  editingLocked: false
  canEdit: true
  canSubmit: false
  canApprove: false
  adminOverrideRequired: false
  canRequestChanges: false
  canWithdraw: false
  canReset: false
  canPublish: true
  isLoading: false
}

export type EditionPageWorkflowProps = {
  pageId: Id<"pages">
  workflow: EditionPageWorkflowContext
  hasStaging: boolean
  hasUnsaved: boolean
  ensureSaved(): Promise<boolean>
  onPublish(): Promise<void> | void
}

export function useEditionPageWorkflow(
  pageId: Id<"pages">
): EditionPageWorkflowContext {
  void pageId
  return {
    state: null,
    status: "working_draft",
    requiresApproval: false,
    stagingExists: false,
    editingLocked: false,
    canEdit: true,
    canSubmit: false,
    canApprove: false,
    adminOverrideRequired: false,
    canRequestChanges: false,
    canWithdraw: false,
    canReset: false,
    canPublish: true,
    isLoading: false,
  }
}

export function EditionPageWorkflow(props: EditionPageWorkflowProps) {
  void props
  return null
}
