import { McpServer } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import { catalogAssets } from "@/lib/catalog/assets"
import {
  getCatalogAsset,
  listCatalog,
  searchCatalog,
} from "@/lib/catalog/query"
import {
  catalogAssetKindSchema,
  catalogAssetSchema,
  catalogAssetSummarySchema,
} from "@/lib/catalog/schema"

const searchCatalogOutputSchema = z
  .object({
    count: z.number().int().nonnegative(),
    items: z.array(catalogAssetSummarySchema),
  })
  .strict()

const getCatalogAssetOutputSchema = z
  .object({
    asset: catalogAssetSchema,
  })
  .strict()

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function createCatalogMcpServer(): McpServer {
  const server = new McpServer({
    name: "nextcms-catalog",
    version: "0.1.0",
  })

  server.registerResource(
    "nextcms-catalog",
    "nextcms://catalog",
    {
      title: "formulacms catalog",
      description:
        "Index of public formulacms reference assets available to agent clients.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: jsonText(listCatalog()),
        },
      ],
    })
  )

  for (const asset of catalogAssets) {
    server.registerResource(
      `nextcms-catalog-${asset.slug}`,
      `nextcms://catalog/${asset.kind}/${asset.slug}`,
      {
        title: asset.name,
        description: asset.summary,
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: jsonText(asset),
          },
        ],
      })
    )
  }

  server.registerTool(
    "search_catalog",
    {
      title: "Search formulacms catalog",
      description:
        "Search public formulacms assets by words, asset kind, or catalog group.",
      inputSchema: z
        .object({
          query: z.string().max(200).optional(),
          kind: catalogAssetKindSchema.optional(),
          group: z.string().max(80).optional(),
          limit: z.number().int().min(1).max(20).default(20),
        })
        .strict(),
      outputSchema: searchCatalogOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const items = searchCatalog(input)
      const output = { count: items.length, items }
      return {
        content: [{ type: "text", text: jsonText(output) }],
        structuredContent: output,
      }
    }
  )

  server.registerTool(
    "get_catalog_asset",
    {
      title: "Get formulacms catalog asset",
      description:
        "Return complete public metadata for one formulacms asset by ID or slug.",
      inputSchema: z.object({ id: z.string().min(1).max(120) }).strict(),
      outputSchema: getCatalogAssetOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const asset = getCatalogAsset(id)
      if (!asset) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `No public formulacms catalog asset matches "${id}".`,
            },
          ],
        }
      }

      const output = { asset }
      return {
        content: [{ type: "text", text: jsonText(output) }],
        structuredContent: output,
      }
    }
  )

  return server
}
