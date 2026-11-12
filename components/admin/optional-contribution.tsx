"use client"

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { catchError } from "next/error"
import { unstable_rethrow } from "next/navigation"
import Link from "next/link"
import { reportContainedModuleFailure } from "@/lib/modules/containment"
import type { AdminContributionSlot } from "./admin-contributions"
import { useModuleGate } from "./admin-module-state-provider"
import { moduleFailureState } from "./module-gate"

type ContributionProps = {
  moduleId: string
  slot: AdminContributionSlot | "admin.language-add" | "admin.page-languages"
  finishSetup: { label: string; href: string }
  fallbackText: string
  /** Static host rendering only; never the participant or a data reader. */
  disabledPreview?: ReactNode
  children: ReactNode
}
const RunContext = createContext<
  (<T>(work: () => T | Promise<T>) => Promise<T | undefined>) | null
>(null)

/** Use for an optional event/command run; catches sync throws and async rejects. */
export function useOptionalContributionRun() {
  const run = useContext(RunContext)
  if (!run) throw new Error("Optional contribution run requires its boundary")
  return run
}

function ContributionSetup({
  disabledPreview,
  finishSetup,
  slot,
}: Omit<ContributionProps, "children">) {
  return (
    <div data-module-slot={slot}>
      {disabledPreview && <div inert>{disabledPreview}</div>}
      <Link href={finishSetup.href}>{finishSetup.label}</Link>
    </div>
  )
}

function ContributionFailure({
  error,
  ...props
}: Omit<ContributionProps, "children"> & { error: unknown }) {
  const state = moduleFailureState(error)
  useEffect(() => {
    if (state === "error")
      reportContainedModuleFailure(props.moduleId, "admin.contribution", error)
  }, [props.moduleId, error, state])
  if (state === "off") return null
  if (state === "needs_setup") return <ContributionSetup {...props} />
  return (
    <div role="alert" data-module-slot={props.slot}>
      {props.fallbackText}
    </div>
  )
}
const ContributionBoundary = catchError<Omit<ContributionProps, "children">>(
  (props, { error }) => <ContributionFailure {...props} error={error} />
)

function ContributionRunBoundary({ children, ...props }: ContributionProps) {
  const [failure, setFailure] = useState<{ error: unknown } | null>(null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  async function run<T>(work: () => T | Promise<T>): Promise<T | undefined> {
    if (!active.current) return undefined
    try {
      const result = await work()
      return active.current ? result : undefined
    } catch (error) {
      unstable_rethrow(error)
      if (active.current) setFailure({ error })
      return undefined
    }
  }
  if (failure) return <ContributionFailure {...props} error={failure.error} />
  return <RunContext.Provider value={run}>{children}</RunContext.Provider>
}

/** Named containment stays below the required host, retaining its local state. */
export function OptionalContribution({
  children,
  ...props
}: ContributionProps) {
  const gate = useModuleGate(props.moduleId)
  if (
    gate.state === "loading" ||
    gate.state === "off" ||
    gate.state === "error"
  )
    return null
  if (gate.state === "needs_setup") return <ContributionSetup {...props} />
  return (
    <ContributionBoundary {...props}>
      <ContributionRunBoundary {...props}>{children}</ContributionRunBoundary>
    </ContributionBoundary>
  )
}
