#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runHttpServer } from "./httpServer.js";
import { readRuntimeConfig } from "./runtimeConfig.js";
import { createNitterMcpServer } from "./serverCore.js";

async function runStdioServer(): Promise<void> {
  const server = createNitterMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main() {
  const config = readRuntimeConfig();

  if (config.transport === "http") {
    await runHttpServer(config);
    return;
  }

  await runStdioServer();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
