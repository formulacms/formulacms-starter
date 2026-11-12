import { notFound } from "next/navigation"
import { renderSliceSimDevPage } from "./dev-loader"

export type SliceSimPageProps = {
  params: Promise<{ type: string }>
  searchParams: Promise<{
    bare?: string
    opening?: string
    prototype?: string
    variant?: string
    /** Internal finite verification fixture; does not change the simulator UI. */
    coverage?: string
  }>
}

export const metadata = {
  title: "Block simulator",
  description:
    "Review registered block sample renders at desktop and mobile sizes.",
}

// Render one registered slice in isolation, filled with believable sample data,
// through the *real* public render pipeline (ADR-0016, Phase 1). This is the
// human "Simulate" preview, the authoring agent's render-verify target, and the
// Phase-3 screenshot/thumbnail source. Dev-only: the agent loop hits it
// unauthenticated in dev/build; it is never served in prod.

export default async function SliceSimPage({
  params,
  searchParams,
}: SliceSimPageProps) {
  if (process.env.NODE_ENV === "production") notFound()

  return renderSliceSimDevPage({ params, searchParams })
}
