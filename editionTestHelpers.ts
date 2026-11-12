import type { TestConvex } from "convex-test"
import type { Id } from "./convex/_generated/dataModel"
import appSchema from "./convex/schema"

type TestApp = TestConvex<typeof appSchema>

export async function approveEditionPageForTest(
  t: TestApp,
  pageId: Id<"pages">
): Promise<void> {
  void t
  void pageId
}

export async function approveDueEditionPagesForTest(t: TestApp): Promise<void> {
  void t
}

export async function releaseRejectedEditionApprovalsForTest(
  t: TestApp
): Promise<void> {
  void t
}
