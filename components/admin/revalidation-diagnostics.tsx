"use client"

import { useRef, useState } from "react"
import { useAction, useQuery } from "convex/react"
import { useTranslations } from "next-intl"
import { api } from "@/convex/_generated/api"
import { issueContactIpProofPairingForSettings } from "@/app/(core)/admin/(authenticated)/settings/actions"
import { Button } from "@/components/ui/button"

type SelfTestResult =
  | { status: "ok"; httpStatus: number }
  | { status: "http_error"; httpStatus: number }
  | { status: "network_error" }
  | { status: "unconfigured" }

type PairingResult =
  { status: "pass" } | { status: "fail" } | { status: "unconfigured" }

function boundedHttpStatus(value: number | undefined) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined
}

export function RevalidationDiagnostics() {
  const t = useTranslations("settings.general.diagnostics")
  const owner = useQuery(api.cms.owner.getOwnerSession)
  const canView = owner !== undefined && owner !== null
  const canUpdate = canView
  const health = useQuery(
    api.cms.revalidate.getRevalidationHealth,
    canView ? {} : "skip"
  )
  const runSelfTest = useAction(api.cms.revalidate.runRevalidationSelfTest)
  const verifyPairing = useAction(
    api.cms.revalidate.verifyContactIpProofPairing
  )
  const [selfTest, setSelfTest] = useState<SelfTestResult | null>(null)
  const [pairing, setPairing] = useState<PairingResult | null>(null)
  const [selfTestError, setSelfTestError] = useState(false)
  const [pairingError, setPairingError] = useState(false)
  const [selfTestPending, setSelfTestPending] = useState(false)
  const [pairingPending, setPairingPending] = useState(false)
  const selfTestLock = useRef(false)
  const pairingLock = useRef(false)

  async function handleSelfTest() {
    if (selfTestLock.current) return
    selfTestLock.current = true
    setSelfTestPending(true)
    setSelfTestError(false)
    try {
      setSelfTest(await runSelfTest({}))
    } catch {
      setSelfTestError(true)
    }
    selfTestLock.current = false
    setSelfTestPending(false)
  }

  async function handlePairing() {
    if (pairingLock.current) return
    pairingLock.current = true
    setPairingPending(true)
    setPairingError(false)
    try {
      const issued = await issueContactIpProofPairingForSettings()
      if (issued.status === "unconfigured") {
        setPairing({ status: "unconfigured" })
      } else {
        // Keep the proof ephemeral: transport it directly to Convex, without
        // rendering, persisting, logging, or putting it in a notification.
        setPairing(await verifyPairing(issued.proof))
      }
    } catch {
      setPairingError(true)
    }
    pairingLock.current = false
    setPairingPending(false)
  }

  if (owner === undefined || (canView && health === undefined)) {
    return (
      <section className="rounded-lg border bg-card p-4" aria-busy>
        <h2 className="text-sm font-medium">{t("heading")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("loading")}</p>
      </section>
    )
  }

  if (!canView || !health) return null

  const latest = health.recentAttempts[0]
  const latestHttpStatus = boundedHttpStatus(latest?.httpStatus)
  const latestStatus = !latest
    ? t("noAttempts")
    : health.unconfigured
      ? t("unconfigured")
      : latest.status === "ok"
        ? t("healthy")
        : latest.status === "http_error"
          ? latestHttpStatus
            ? t("httpFailure", { status: latestHttpStatus })
            : t("httpFailureUnknown")
          : t("networkFailure")

  const failureHistory = health.consecutiveFailureCountCapped
    ? t("failureHistoryCapped")
    : health.consecutiveFailureCount > 0
      ? t("failureHistory", { count: health.consecutiveFailureCount })
      : null

  return (
    <section
      className="divide-y rounded-lg border bg-card"
      aria-labelledby="revalidation-diagnostics-heading"
    >
      <div className="p-4">
        <h2
          id="revalidation-diagnostics-heading"
          className="text-sm font-medium"
        >
          {t("heading")}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("description")}
        </p>
      </div>
      <div className="space-y-3 p-4 text-sm">
        <div>
          <p className="font-medium">{t("health.label")}</p>
          <p className="text-muted-foreground">{latestStatus}</p>
          {failureHistory && (
            <p className="mt-1 text-xs text-muted-foreground">
              {failureHistory}
            </p>
          )}
        </div>

        {canUpdate ? (
          <div className="space-y-3 border-t pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleSelfTest}
                disabled={selfTestPending}
                aria-describedby="revalidation-self-test-result"
              >
                {selfTestPending ? t("selfTest.pending") : t("selfTest.run")}
              </Button>
              <p
                id="revalidation-self-test-result"
                className="text-xs text-muted-foreground"
                aria-live="polite"
              >
                {selfTestError
                  ? t("selfTest.unavailable")
                  : selfTest?.status === "ok"
                    ? boundedHttpStatus(selfTest.httpStatus)
                      ? t("selfTest.success", {
                          status: selfTest.httpStatus,
                        })
                      : t("selfTest.successUnknown")
                    : selfTest?.status === "http_error"
                      ? boundedHttpStatus(selfTest.httpStatus)
                        ? t("selfTest.httpFailure", {
                            status: selfTest.httpStatus,
                          })
                        : t("selfTest.httpFailureUnknown")
                      : selfTest?.status === "network_error"
                        ? t("selfTest.networkFailure")
                        : selfTest?.status === "unconfigured"
                          ? t("selfTest.unconfigured")
                          : null}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handlePairing}
                disabled={pairingPending}
                aria-describedby="contact-ip-pairing-result"
              >
                {pairingPending ? t("pairing.pending") : t("pairing.run")}
              </Button>
              <p
                id="contact-ip-pairing-result"
                className="text-xs text-muted-foreground"
                aria-live="polite"
              >
                {pairingError
                  ? t("pairing.unavailable")
                  : pairing?.status === "pass"
                    ? t("pairing.pass")
                    : pairing?.status === "fail"
                      ? t("pairing.fail")
                      : pairing?.status === "unconfigured"
                        ? t("pairing.unconfigured")
                        : null}
              </p>
            </div>
          </div>
        ) : (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            {t("readOnly")}
          </p>
        )}
      </div>
    </section>
  )
}
