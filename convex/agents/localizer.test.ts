import { describe, expect, test } from "vitest"
import { Semaphore } from "./localizer"

async function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

describe("Semaphore", () => {
  test("never exceeds the concurrency limit", async () => {
    const limit = 3
    const sem = new Semaphore(limit)
    let active = 0
    let peak = 0
    const results: number[] = []

    const work = Array.from({ length: 12 }, (_, i) => async () => {
      await sem.acquire()
      try {
        active++
        peak = Math.max(peak, active)
        await delay(5 + Math.random() * 10)
        results.push(i)
      } finally {
        active--
        sem.release()
      }
    })

    await Promise.all(work.map((fn) => fn()))

    expect(peak).toBeLessThanOrEqual(limit)
    expect(peak).toBe(limit)
    expect(results).toHaveLength(12)
  })

  test("preserves result ordering when mapped", async () => {
    const sem = new Semaphore(2)
    const items = [10, 20, 30, 40, 50]

    const results = await Promise.all(
      items.map(async (n) => {
        await sem.acquire()
        try {
          await delay(Math.random() * 10)
          return n * 2
        } finally {
          sem.release()
        }
      })
    )

    expect(results).toEqual([20, 40, 60, 80, 100])
  })

  test("releases slot on error so others proceed", async () => {
    const sem = new Semaphore(1)
    const log: string[] = []

    const failing = (async () => {
      await sem.acquire()
      try {
        throw new Error("boom")
      } finally {
        sem.release()
      }
    })()

    const succeeding = (async () => {
      await delay(5)
      await sem.acquire()
      try {
        log.push("ok")
      } finally {
        sem.release()
      }
    })()

    await expect(failing).rejects.toThrow("boom")
    await succeeding
    expect(log).toEqual(["ok"])
  })

  test("limit=1 serializes execution", async () => {
    const sem = new Semaphore(1)
    let active = 0
    let peak = 0

    await Promise.all(
      Array.from({ length: 5 }, async () => {
        await sem.acquire()
        try {
          active++
          peak = Math.max(peak, active)
          await delay(5)
        } finally {
          active--
          sem.release()
        }
      })
    )

    expect(peak).toBe(1)
  })
})
