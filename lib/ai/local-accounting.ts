import { accountingOperation } from "./accounting-contract"
import "server-only"
import { fetchAuthMutation } from "@/lib/auth-server"
import { api } from "@/convex/_generated/api"
import type { GenerationAccounting } from "./accounting-contract"
/** Owner-only mutations re-establish authority for each admission/settlement. */
export function createLocalAccounting(): GenerationAccounting {
  return accountingOperation({
    admit: (request) =>
      fetchAuthMutation(api.cms.ai.admitLocalAttempt, { request }),
    settle: (request) =>
      fetchAuthMutation(api.cms.ai.settleLocalAttempt, request),
  })
}
