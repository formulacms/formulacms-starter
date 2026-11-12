# formulacms catalog MCP

Status: local, read-only prototype.

The catalog MCP lets an MCP-compatible coding agent discover public formulacms
reference assets without granting access to CMS content, paid source,
installation, the filesystem, or shell commands. It is deterministic and does
not call an AI model.

## Run

From the repository root:

```sh
pnpm mcp:catalog
```

The process speaks MCP over standard input/output. It intentionally prints no
startup message to standard output because that channel carries protocol
messages.

Example client configuration:

```json
{
  "mcpServers": {
    "nextcms-catalog": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/formulacms", "mcp:catalog"]
    }
  }
}
```

## Surface

Resources:

- `nextcms://catalog`
- one `nextcms://catalog/<kind>/<slug>` resource per catalog asset

Tools:

- `search_catalog` searches public metadata using deterministic text matching.
- `get_catalog_asset` returns complete public metadata for an ID or slug.

Both tools declare themselves read-only, non-destructive, idempotent, and
closed-world. The canonical metadata lives in `lib/catalog`; the MCP server is
only an adapter.

## Deliberate limits

- Local stdio transport only; no remote deployment or HTTP endpoint.
- Three real public reference slices; no invented Plus products.
- No authentication, entitlement checks, downloads, or installation.
- No CMS reads or writes, publishing, schema changes, filesystem, or shell.
- The official TypeScript MCP v2 SDK is currently beta, so its package version
  is pinned and upgrades require a protocol regression check.

A production Plus MCP remains a separate decision. It requires a real catalog
API, authenticated registry, entitlement enforcement, and a security review.
