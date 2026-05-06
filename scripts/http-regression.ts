/// <reference types="node" />

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";

type CallResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function summarizeContent(result: CallResult): string {
  const firstText = result.content?.find((item) => item.type === "text")?.text;
  return firstText ? firstText.slice(0, 140) : "no text content";
}

function readErrorCode(result: CallResult): string {
  if (
    typeof result.structuredContent === "object" &&
    result.structuredContent !== null &&
    "errorCode" in result.structuredContent
  ) {
    return String((result.structuredContent as { errorCode?: unknown }).errorCode);
  }

  return "UNKNOWN_ERROR";
}

async function callAndAssert(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const response = (await client.callTool({
    name,
    arguments: args,
  })) as CallResult;

  if (response.isError) {
    const errorCode = readErrorCode(response);

    if (
      errorCode === "RATE_LIMITED" ||
      errorCode === "UPSTREAM_ERROR" ||
      errorCode === "INVALID_PAYLOAD"
    ) {
      console.warn(`[warn] ${name}: ${errorCode}`);
      return response;
    }

    throw new Error(`${name} failed: ${summarizeContent(response)}`);
  }

  assert(response.structuredContent, `${name} missing structuredContent`);
  return response;
}

function createClient(name: string): Client {
  const permissiveValidator: jsonSchemaValidator = {
    getValidator: (() => (input: unknown) => ({
      valid: true,
      data: input,
      errorMessage: undefined,
    })) as jsonSchemaValidator["getValidator"],
  };

  return new Client(
    {
      name,
      version: "0.1.0",
    },
    {
      jsonSchemaValidator: permissiveValidator,
    },
  );
}

async function waitForServer(baseUrl: URL): Promise<void> {
  const deadline = Date.now() + 15000;
  const healthUrl = new URL("/health", baseUrl);

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }

    await delay(250);
  }

  throw new Error("Timed out waiting for HTTP server to become ready.");
}

async function runChecks(client: Client): Promise<{
  checkedTools: string[];
  tweetSearch: string;
  userFeed: string;
  userSearch: string;
  nonFatalErrors: string[];
}> {
  const query = process.env.NITTER_TEST_QUERY ?? "mcp server";
  const username = process.env.NITTER_TEST_USERNAME ?? "youtoy";

  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  assert(names.has("nitter_search_tweets"), "missing tool nitter_search_tweets");
  assert(names.has("nitter_feed_user"), "missing tool nitter_feed_user");
  assert(names.has("nitter_search_users"), "missing tool nitter_search_users");

  const tweetResult = await callAndAssert(client, "nitter_search_tweets", {
    query,
    include: { media: true },
    exclude: { replies: true },
    minFaves: 1,
  });
  const feedResult = await callAndAssert(client, "nitter_feed_user", {
    username,
  });
  const userResult = await callAndAssert(client, "nitter_search_users", {
    query: "mastra ai",
  });

  const regressionErrors = [tweetResult, feedResult, userResult]
    .filter((result) => result.isError)
    .map(readErrorCode);

  return {
    checkedTools: [...names].filter((toolName) => toolName.startsWith("nitter_")),
    tweetSearch: summarizeContent(tweetResult),
    userFeed: summarizeContent(feedResult),
    userSearch: summarizeContent(userResult),
    nonFatalErrors: regressionErrors,
  };
}

async function stopServer(serverProcess: ChildProcessWithoutNullStreams): Promise<void> {
  if (serverProcess.exitCode !== null) {
    return;
  }

  serverProcess.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => {
      serverProcess.once("exit", () => resolve());
    }),
    delay(3000),
  ]);

  if (serverProcess.exitCode === null) {
    serverProcess.kill("SIGKILL");
  }
}

async function run() {
  const host = process.env.MCP_HOST ?? "127.0.0.1";
  const port = process.env.MCP_PORT ?? "3137";
  const baseUrl = new URL(`http://${host}:${port}`);
  const mcpUrl = new URL(process.env.MCP_HTTP_PATH ?? "/mcp", baseUrl);
  const sseUrl = new URL(process.env.MCP_SSE_PATH ?? "/sse", baseUrl);
  const baseNitterUrl = process.env.NITTER_BASE_URL ?? "https://nitter.net";

  const serverPath = new URL("../dist/index.js", import.meta.url).pathname;
  const serverProcess = spawn("node", [serverPath], {
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      MCP_HOST: host,
      MCP_PORT: port,
      MCP_ENABLE_SSE_COMPAT: "true",
      NITTER_BASE_URL: baseNitterUrl,
    } as Record<string, string>,
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (chunk) => {
    process.stderr.write(`[server:stdout] ${String(chunk)}`);
  });
  serverProcess.stderr.on("data", (chunk) => {
    process.stderr.write(`[server:stderr] ${String(chunk)}`);
  });

  try {
    await waitForServer(baseUrl);

    const streamableClient = createClient("nitter-mcp-http-regression-client");
    const streamableTransport = new StreamableHTTPClientTransport(mcpUrl);
    await streamableClient.connect(streamableTransport);
    const streamableResult = await runChecks(streamableClient);
    await streamableClient.close();

    const sseClient = createClient("nitter-mcp-sse-regression-client");
    const sseTransport = new SSEClientTransport(sseUrl);
    await sseClient.connect(sseTransport);
    const sseResult = await runChecks(sseClient);
    await sseClient.close();

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl: baseUrl.toString(),
          streamableHttp: streamableResult,
          sseCompatibility: sseResult,
        },
        null,
        2,
      ),
    );
  } finally {
    await stopServer(serverProcess);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
