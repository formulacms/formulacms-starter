import type { ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { ConvexProvider, type ConvexReactClient } from "convex/react"
import { getFunctionName } from "convex/server"
import { describe, expect, it, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import { usePrePublishChecklist } from "./use-pre-publish-checklist"

const pageId = "page-1" as Id<"pages">

function clientFixture(
  localResult: (args: Record<string, unknown>) => unknown
) {
  const events: string[] = []
  const watchQuery = vi.fn((query: unknown, args: Record<string, unknown>) => ({
    localQueryResult: () => localResult(args),
    onUpdate: () => {
      const name = getFunctionName(query as never)
      events.push(`subscribe:${name}:${JSON.stringify(args)}`)
      return () => events.push(`unsubscribe:${name}:${JSON.stringify(args)}`)
    },
  }))
  return {
    client: { watchQuery } as unknown as ConvexReactClient,
    events,
    watchQuery,
  }
}

function wrapperFor(client: ConvexReactClient) {
  function ConvexTestWrapper({ children }: { children: ReactNode }) {
    return <ConvexProvider client={client}>{children}</ConvexProvider>
  }
  return ConvexTestWrapper
}

describe("usePrePublishChecklist Convex subscription", () => {
  it("NEW retains the same subscription across same-input rerenders while the result is Error", async () => {
    const fixture = clientFixture(() => new Error("checklist unavailable"))
    const hook = renderHook(() => usePrePublishChecklist(pageId, "en", true), {
      wrapper: wrapperFor(fixture.client),
    })

    await waitFor(() =>
      expect(hook.result.current.result).toBeInstanceOf(Error)
    )
    const subscription = [
      'subscribe:cms/pages:getPrePublishChecklist:{"pageId":"page-1","locale":"en"}',
    ]
    expect(fixture.events).toEqual(subscription)

    hook.rerender()
    hook.rerender()
    hook.rerender()
    await waitFor(() =>
      expect(hook.result.current.result).toBeInstanceOf(Error)
    )

    expect(fixture.events).toEqual(subscription)
  })

  it("NEW unsubscribes and resubscribes the same query and args when retried", async () => {
    let checklistResult: unknown = new Error("checklist unavailable")
    const fixture = clientFixture(() => checklistResult)
    const hook = renderHook(() => usePrePublishChecklist(pageId, "en", true), {
      wrapper: wrapperFor(fixture.client),
    })

    await waitFor(() => expect(fixture.events).toHaveLength(1))
    expect(hook.result.current.result).toBeInstanceOf(Error)
    checklistResult = { canPublish: true, blockers: [], warnings: [] }
    act(() => hook.result.current.retry())
    await waitFor(() => expect(fixture.events).toHaveLength(3))
    await waitFor(() =>
      expect(hook.result.current.result).toEqual(checklistResult)
    )

    const initialSubscription = fixture.events[0]!
    expect(fixture.events[1]).toBe(
      initialSubscription.replace("subscribe:", "unsubscribe:")
    )
    expect(fixture.events[2]).toBe(initialSubscription)
  })

  it("NEW switches to the new locale query without retaining the prior locale error", async () => {
    const frenchChecklist = { canPublish: true, blockers: [], warnings: [] }
    const fixture = clientFixture((args) =>
      args.locale === "fr"
        ? frenchChecklist
        : new Error("English checklist unavailable")
    )
    const hook = renderHook(
      ({ locale }: { locale: string }) =>
        usePrePublishChecklist(pageId, locale, true),
      {
        initialProps: { locale: "en" },
        wrapper: wrapperFor(fixture.client),
      }
    )

    await waitFor(() =>
      expect(hook.result.current.result).toBeInstanceOf(Error)
    )
    hook.rerender({ locale: "fr" })
    await waitFor(() =>
      expect(hook.result.current.result).toEqual(frenchChecklist)
    )
    expect(fixture.events).toEqual([
      'subscribe:cms/pages:getPrePublishChecklist:{"pageId":"page-1","locale":"en"}',
      'unsubscribe:cms/pages:getPrePublishChecklist:{"pageId":"page-1","locale":"en"}',
      'subscribe:cms/pages:getPrePublishChecklist:{"pageId":"page-1","locale":"fr"}',
    ])
  })
})
