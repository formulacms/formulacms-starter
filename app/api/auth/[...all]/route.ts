import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs"
import { getNextAuthEnv } from "@/lib/env"
import { addNextAuthClientProof } from "@/lib/auth/next-auth-client-proof"

const { handler } = convexBetterAuthNextJs(getNextAuthEnv())

export const GET = handler.GET

export async function POST(request: Request) {
  return await handler.POST(await addNextAuthClientProof(request))
}
