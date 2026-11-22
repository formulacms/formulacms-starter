import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { afterEach, describe, expect, it } from "vitest"

const serverScript = fileURLToPath(
  new URL("../../scripts/mcp-catalog-server.ts", import.meta.url)
)

describe("formulacms catalog MCP stdio boundary", () => {
  let client: Client | undefined

  afterEach(async () => {
    await client?.close()
  })

  it("negotiates MCP and exposes readable resources and read-only tools", async () => {
    client = new Client({ name: "formulacms-catalog-test", version: "0.1.0" })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", serverScript],
        cwd: process.cwd(),
        stderr: "pipe",
      })
    )

    const { resources } = await client.listResources()
    expect(resources.map(({ uri }) => uri)).toContain("formulacms://catalog")
    expect(resources).toHaveLength(4)
    expect(resources.every(({ uri }) => uri.startsWith("formulacms://"))).toBe(
      true
    )

    const catalogResource = await client.readResource({
      uri: "formulacms://catalog",
    })
    expect(catalogResource.contents[0]).toMatchObject({
      uri: "formulacms://catalog",
      mimeType: "application/json",
    })

    // The old URIs still read, unlisted, with the same JSON.
    const text = async (uri: string) =>
      (await client!.readResource({ uri })).contents[0]
    const assetUri = resources.find(({ uri }) =>
      uri.startsWith("formulacms://catalog/")
    )!.uri
    for (const uri of ["formulacms://catalog", assetUri]) {
      const current = await text(uri)
      expect(current).toHaveProperty("text")
      expect(
        await text(uri.replace("formulacms://", "nextcms://"))
      ).toMatchObject({
        text: (current as { text: string }).text,
      })
    }
    await expect(text("nextcms://catalog/block/not-real")).rejects.toThrow(
      /not found/i
    )

    const { tools } = await client.listTools()
    expect(tools.map(({ name }) => name).sort()).toEqual([
      "get_catalog_asset",
      "search_catalog",
    ])
    expect(
      tools.every(
        (tool) =>
          tool.annotations?.readOnlyHint === true &&
          tool.annotations?.destructiveHint === false
      )
    ).toBe(true)

    const searchResult = await client.callTool({
      name: "search_catalog",
      arguments: { query: "lead capture" },
    })
    expect(searchResult.isError).not.toBe(true)
    expect(searchResult.structuredContent).toMatchObject({
      count: 1,
      items: [{ id: "block:contact-form" }],
    })

    const missingResult = await client.callTool({
      name: "get_catalog_asset",
      arguments: { id: "block:not-real" },
    })
    expect(missingResult.isError).toBe(true)
  })
})
