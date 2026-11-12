#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { createCatalogMcpServer } from "../lib/mcp/catalog-server"

serveStdio(createCatalogMcpServer, {
  onerror(error) {
    console.error(`formulacms catalog MCP error: ${error.message}`)
  },
})
