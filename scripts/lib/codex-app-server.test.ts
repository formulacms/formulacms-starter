// @vitest-environment node
import { EventEmitter } from "node:events"
import { describe, expect, test, vi } from "vitest"
import {
  resolveCodexCommand,
  withCodexModelListTransport,
} from "./codex-app-server"
import type {
  SubscriptionCliChild,
  SpawnSubscriptionCli,
} from "./subscription-cli-process"

/**
 * A fake app server: answers JSON-RPC line by line, so the transport's framing,
 * handshake, and teardown are exercised without the vendor binary. A line
 * with no id is a notification: it is logged and never answered.
 */
function fakeAppServer(
  respond: (request: { id: number; method: string; params?: unknown }) => unknown,
  log: string[] = [],
  lines: Record<string, unknown>[] = []
): { spawn: SpawnSubscriptionCli; child: SubscriptionCliChild } {
  const stdout = new EventEmitter() as SubscriptionCliChild["stdout"]
  const stderr = new EventEmitter() as SubscriptionCliChild["stderr"]
  const stdin = {
    write(chunk: string, callback?: (error?: Error | null) => void) {
      callback?.(null)
      for (const line of String(chunk).split("\n")) {
        if (line.trim() === "") continue
        const request = JSON.parse(line) as { id: number; method: string; params?: unknown }
        lines.push(request)
        log.push(`write:${request.method}`)
        if (!("id" in request)) continue
        const result = respond(request)
        queueMicrotask(() => {
          log.push(`reply:${request.method}`)
          stdout.emit(
            "data",
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`
          )
        })
      }
      return true
    },
    end() {},
    once() {},
  } as unknown as SubscriptionCliChild["stdin"]

  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin,
    stdout,
    stderr,
  }) as unknown as SubscriptionCliChild

  return { spawn: () => child, child }
}

describe("resolveCodexCommand", () => {
  test("prefers FORMULACMS_CODEX_BIN, falls back to NEXTCMS_CODEX_BIN, then PATH", () => {
    // The Codex CLI ships inside the ChatGPT desktop app and is often not on
    // PATH; the committed default stays machine-agnostic regardless.
    expect(
      resolveCodexCommand({ NEXTCMS_CODEX_BIN: "/Applications/x/codex" })
    ).toBe("/Applications/x/codex")
    expect(
      resolveCodexCommand({ FORMULACMS_CODEX_BIN: "/Applications/y/codex" })
    ).toBe("/Applications/y/codex")
    expect(
      resolveCodexCommand({
        FORMULACMS_CODEX_BIN: "/Applications/new/codex",
        NEXTCMS_CODEX_BIN: "/Applications/old/codex",
      })
    ).toBe("/Applications/new/codex")
    expect(resolveCodexCommand({})).toBe("codex")
    expect(
      resolveCodexCommand({
        FORMULACMS_CODEX_BIN: "  ",
        NEXTCMS_CODEX_BIN: "/Applications/old/codex",
      })
    ).toBe("/Applications/old/codex")
  })
})

describe("withCodexModelListTransport", () => {
  test("handshakes, paginates model/list, and kills the server afterwards", async () => {
    const seen: string[] = []
    const listParams: unknown[] = []
    const { spawn, child } = fakeAppServer(({ method, params }) => {
      seen.push(method)
      if (method === "initialize") return {}
      listParams.push(params)
      return {
        data: [
          {
            model: "gpt-5.6-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            inputModalities: ["text", "image"],
          },
        ],
        nextCursor: null,
      }
    })
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)

    const page = await withCodexModelListTransport(
      async (requestPage) => requestPage({ cursor: undefined, limit: 100 }),
      { command: "codex", spawn }
    )

    expect(seen).toEqual(["initialize", "model/list"])
    // Hidden models stay out; `modelProvider` is never sent (0.163 lacks it).
    expect(listParams).toEqual([{ cursor: null, limit: 100, includeHidden: false }])
    expect(page).toMatchObject({ nextCursor: null })
    expect(child).toBeDefined()
    kill.mockRestore()
  })

  // Official docs (https://developers.openai.com/codex/app-server): send
  // `initialize`, then acknowledge with the `initialized` notification.
  test("acknowledges the initialize reply with an initialized notification before model/list", async () => {
    const log: string[] = []
    const lines: Record<string, unknown>[] = []
    const { spawn } = fakeAppServer(
      ({ method }) => (method === "initialize" ? {} : { data: [], nextCursor: null }),
      log,
      lines
    )
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)

    await withCodexModelListTransport(
      async (requestPage) => requestPage({ cursor: undefined, limit: 100 }),
      { command: "codex", spawn }
    )

    expect(log).toEqual([
      "write:initialize",
      "reply:initialize",
      "write:initialized",
      "write:model/list",
      "reply:model/list",
    ])
    const notification = lines.find((line) => line.method === "initialized")
    expect(notification).toEqual({ method: "initialized", params: {} })
    expect(notification).not.toHaveProperty("id")
    kill.mockRestore()
  })

  test("reports a missing binary as missing-cli with zero attempts", async () => {
    const spawn: SpawnSubscriptionCli = () => {
      const error: NodeJS.ErrnoException = new Error("spawn codex ENOENT")
      error.code = "ENOENT"
      throw error
    }

    const error = await withCodexModelListTransport(async () => "unreachable", {
      command: "codex",
      spawn,
    }).catch((value: unknown) => value)

    expect(error).toMatchObject({ kind: "missing-cli", attempts: 0 })
  })

  test("tears the server down even when the caller throws", async () => {
    const { spawn } = fakeAppServer(() => ({}))

    const error = await withCodexModelListTransport(
      async () => {
        throw new Error("caller exploded")
      },
      { command: "codex", spawn }
    ).catch((value: unknown) => value)

    // The finally-scoped teardown is what makes cleanup structural: a throwing
    // caller must not be able to leak an app-server process.
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("caller exploded")
  })
})
