import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server"
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

function jsonContents(uri: URL, value: unknown) {
  return {
    contents: [
      { uri: uri.href, mimeType: "application/json", text: jsonText(value) },
    ],
  }
}

const catalogIndexMetadata = {
  title: "formulacms catalog",
  description:
    "Index of public formulacms reference assets available to agent clients.",
  mimeType: "application/json",
}

export function createCatalogMcpServer(): McpServer {
  const server = new McpServer({
    name: "formulacms-catalog",
    version: "0.1.0",
  })

  server.registerResource(
    "formulacms-catalog",
    "formulacms://catalog",
    catalogIndexMetadata,
    async (uri) => jsonContents(uri, listCatalog())
  )

  for (const asset of catalogAssets) {
    server.registerResource(
      `formulacms-catalog-${asset.slug}`,
      `formulacms://catalog/${asset.kind}/${asset.slug}`,
      {
        title: asset.name,
        description: asset.summary,
        mimeType: "application/json",
      },
      async (uri) => jsonContents(uri, asset)
    )
  }

  // The old nextcms:// URIs stay readable, but unlisted, so owners' agents
  // configured before the rename keep working. Planned removal: the release
  // after 0.3.0 (ADR-0048 amendment, 2026-11-16).
  server.registerResource(
    "nextcms-catalog",
    new ResourceTemplate("nextcms://catalog", { list: undefined }),
    catalogIndexMetadata,
    async (uri) => jsonContents(uri, listCatalog())
  )
  server.registerResource(
    "nextcms-catalog-asset",
    new ResourceTemplate("nextcms://catalog/{kind}/{slug}", {
      list: undefined,
    }),
    { mimeType: "application/json" },
    async (uri, { kind, slug }) => {
      const asset = catalogAssets.find(
        (candidate) => candidate.kind === kind && candidate.slug === slug
      )
      if (!asset) throw new ResourceNotFoundError(uri.href)
      return jsonContents(uri, asset)
    }
  )

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
