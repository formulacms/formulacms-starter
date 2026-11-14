import { NextResponse } from "next/server"
import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { convexAuthNextjsAccessToken } from "@/lib/auth/convexAuth"

// The public header's signed-in label. Public pages stay static, so they never
// read the auth cookie; the header asks this route from the browser instead.
// The answer is the account's display name only, never its username (ADR-0056
// rule 8), and it is private to the person asking.
const PRIVATE = { "Cache-Control": "private, no-store" }

export async function GET() {
  const token = await convexAuthNextjsAccessToken()
  let label: { name: string | null } | null = null
  if (token !== null) {
    try {
      label = await fetchQuery(api.users.getCurrentUserLabel, {}, { token })
    } catch {
      label = null
    }
  }
  return NextResponse.json(label, { headers: PRIVATE })
}
