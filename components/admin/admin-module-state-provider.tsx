"use client"

import { createContext, useContext, useEffect, type ReactNode } from "react"
import { useQueries } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { api } from "@/convex/_generated/api"
import { reportContainedModuleFailure } from "@/lib/modules/containment"
import type { ModuleGate } from "./module-gate"
export type { ModuleGate, ModuleGateState } from "./module-gate"

type Snapshot = FunctionReturnType<typeof api.cms.modules.effective>
type ModuleState = { snapshot: Snapshot | undefined; failed: boolean }
const ModuleStateContext = createContext<ModuleState>({
  snapshot: undefined,
  failed: false,
})

/** One committed-state subscription, mounted only after owner resolution. */
export function AdminModuleStateProvider({
  children,
  serverReadFailed = false,
}: {
  children: ReactNode
  serverReadFailed?: boolean
}) {
  const { effective } = useQueries({
    effective: { query: api.cms.modules.effective, args: {} },
  }) as { effective: Snapshot | Error | undefined }
  const failed = serverReadFailed || effective instanceof Error
  useEffect(() => {
    if (effective instanceof Error) {
      reportContainedModuleFailure(
        "optional-modules",
        "admin.shell-module-state",
        effective
      )
    }
  }, [effective])
  return (
    <ModuleStateContext.Provider
      value={{
        snapshot: effective instanceof Error ? undefined : effective,
        failed,
      }}
    >
      {children}
    </ModuleStateContext.Provider>
  )
}

export function useModuleGate(id: string): ModuleGate {
  const { snapshot, failed } = useContext(ModuleStateContext)
  if (failed) return { state: "error" }
  if (snapshot === undefined) return { state: "loading" }
  const entry = snapshot.modules.find((candidate) => candidate.id === id)
  if (!entry) return { state: "off" }
  if (entry.outcome === "needs_setup")
    return { state: "needs_setup", setup: entry.setup ?? [] }
  if (entry.outcome === "error")
    return { state: "error", errorCode: entry.errorCode }
  return { state: entry.outcome }
}

/** The later rendering host supplies localized global S5 copy. */
export function useModuleStateFailure(): boolean {
  return useContext(ModuleStateContext).failed
}
