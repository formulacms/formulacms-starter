import { afterEach, describe, expect, test, vi } from "vitest"

const { revalidatePath, revalidateTag } = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}))

vi.mock("next/cache", () => ({ revalidatePath, revalidateTag }))

import { POST } from "./route"

function request(body: BodyInit | null, secret?: string) {
  return new Request("https://formulacms.test/api/revalidate", {
    method: "POST",
    headers: secret ? { "x-revalidate-secret": secret } : undefined,
    body,
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("POST /api/revalidate", () => {
  test("fails closed when no revalidation secret is configured", async () => {
    vi.stubEnv("REVALIDATE_SECRET", "")

    const response = await POST(
      request(JSON.stringify({}), "configured-secret")
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ revalidated: false })
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  test("rejects requests without the secret header", async () => {
    vi.stubEnv("REVALIDATE_SECRET", "configured-secret")

    const response = await POST(request(JSON.stringify({})))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ revalidated: false })
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  test("rejects requests with the wrong secret", async () => {
    vi.stubEnv("REVALIDATE_SECRET", "configured-secret")

    const response = await POST(request(JSON.stringify({}), "wrong-secret"))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ revalidated: false })
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  test("preserves the authorized cache invalidation behavior", async () => {
    vi.stubEnv("REVALIDATE_SECRET", "configured-secret")

    const response = await POST(
      request(
        JSON.stringify({
          paths: ["/about", "https://outside.test", "//outside.test"],
          layoutPaths: ["/(public)/[locale]", "https://outside.test"],
          tags: ["cms:pages", "unrecognized"],
        }),
        "configured-secret"
      )
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      revalidated: true,
      paths: ["/about"],
      layoutPaths: ["/(public)/[locale]"],
      tags: ["cms:pages"],
    })
    expect(revalidatePath).toHaveBeenCalledWith("/about")
    expect(revalidatePath).toHaveBeenCalledWith("/(public)/[locale]", "layout")
    expect(revalidatePath).toHaveBeenCalledTimes(2)
    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith("cms:pages", {
      expire: 0,
    })
  })

  test("does not purge caches for empty paths and tags", async () => {
    vi.stubEnv("REVALIDATE_SECRET", "configured-secret")

    const response = await POST(
      request(JSON.stringify({ paths: [], tags: [] }), "configured-secret")
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      revalidated: true,
      paths: [],
      layoutPaths: [],
      tags: [],
    })
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  test("returns bad request for invalid JSON after authorization", async () => {
    vi.stubEnv("REVALIDATE_SECRET", "configured-secret")

    const response = await POST(request("{", "configured-secret"))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ revalidated: false })
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(revalidateTag).not.toHaveBeenCalled()
  })
})
