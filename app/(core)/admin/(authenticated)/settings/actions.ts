"use server"

import "server-only"

import { issueContactIpProofPairing } from "@/lib/auth/contact-ip-proof-pairing"
import { requireAuth } from "@/lib/auth-server"
import { requireInstallationOwner } from "@/lib/owner-server"

/**
 * Issues the short-lived, diagnostic-only proof after checking the durable
 * owner at the Next boundary. The proof is deliberately returned only so the
 * caller can immediately pass it to the protected Convex action.
 */
export async function issueContactIpProofPairingForSettings() {
  await requireAuth("Sign in to run diagnostics.")
  await requireInstallationOwner(
    "You don't have permission to run diagnostics."
  )

  return issueContactIpProofPairing()
}
