import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const marker = process.argv[2]
const mode = process.argv[3]
const survivorMarker = process.argv[4]
let firstOutOfOrderRequest
let initialized = false

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function spawnMarkerChild(target = marker) {
  if (!target) return
  spawn(
    process.execPath,
    [
      "--eval",
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(target)}, "survived"), 300)`,
    ],
    { stdio: "ignore" }
  )
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on(
  "line",
  (line) => {
    const message = JSON.parse(line)
    if (message.method === "initialize") {
      const validClient =
        message.params?.clientInfo?.name === "handoff-plus-runner" &&
        message.params?.clientInfo?.version === "1" &&
        message.params?.capabilities?.experimentalApi === true
      if (mode === "delay-initialize") {
        if (marker) appendFileSync(marker, String(process.pid))
        spawnMarkerChild(survivorMarker)
        return
      }
      const response = `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        ...(validClient
          ? { result: { serverInfo: { name: "fixture", version: "1" } } }
          : { error: { code: -32602, message: "invalid client info" } }),
      })}\n`
      process.stdout.write(response.slice(0, 7))
      setTimeout(() => process.stdout.write(response.slice(7)), 2)
      return
    }
    if (message.method === "initialized") {
      initialized = true
      return
    }
    if (!initialized) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32002, message: "not initialized" },
      })
      return
    }

    if (message.method === "test/out-of-order") {
      if (!firstOutOfOrderRequest) {
        firstOutOfOrderRequest = message
        return
      }
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.params.value })}\n` +
          `${JSON.stringify({ method: "test/progress", params: { step: 1 } })}\n` +
          `${JSON.stringify({ jsonrpc: "2.0", id: firstOutOfOrderRequest.id, result: firstOutOfOrderRequest.params.value })}\n`
      )
      return
    }

    if (message.method === "test/server-request") {
      send({
        jsonrpc: "2.0",
        id: "server-request-1",
        method: "item/commandExecution/requestApproval",
        params: { command: "must-not-run" },
      })
      return
    }
    if (message.id === "server-request-1" && message.error) {
      if (marker) appendFileSync(marker, JSON.stringify(message))
      return
    }

    if (message.method === "test/timeout") {
      spawnMarkerChild()
      return
    }
    if (message.method === "test/never") return
    if (message.method === "test/malformed") {
      process.stdout.write('{"broken"\n')
      return
    }
    if (message.method === "test/exit") {
      spawnMarkerChild()
      setTimeout(() => process.exit(17), 5)
      return
    }

    send({ jsonrpc: "2.0", id: message.id, result: null })
  }
)
