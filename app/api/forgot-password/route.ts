import { fetchAction } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import {
  hashAuthClientIdentity,
  signAuthIpHash,
} from "@/convex/lib/authIpProof"

function clientIdentityFromHeaders(h: Headers): string | null {
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded || h.get("x-real-ip")?.trim() || null
}

async function readEmail(request: Request): Promise<string> {
  try {
    const body: unknown = await request.json()
    if (
      typeof body === "object" &&
      body !== null &&
      "email" in body &&
      typeof body.email === "string"
    ) {
      return body.email
    }
  } catch {
    return ""
  }
  return ""
}

export async function POST(request: Request): Promise<Response> {
  try {
    const clientIdentity = clientIdentityFromHeaders(request.headers)
    const proof = clientIdentity
      ? await signAuthIpHash(await hashAuthClientIdentity(clientIdentity))
      : null

    await fetchAction(api.cms.passwordRecovery.requestPasswordReset, {
      email: await readEmail(request),
      redirectTo: "/reset-password",
      ...(proof
        ? {
            ipHash: proof.ipHash,
            ipHashExpiresAt: proof.expiresAt,
            ipHashSignature: proof.signature,
          }
        : {}),
    })
  } catch (err) {
    // Keep the public response neutral even for transport/config failures.
    console.error("[forgot-password] request failed:", err)
  }

  return Response.json({ ok: true })
}
