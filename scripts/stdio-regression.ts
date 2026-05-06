/// <reference types="node" />

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

    // Public instances can rate limit or return blocking pages unexpectedly.
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

async function run() {
  const serverPath = new URL("../dist/index.js", import.meta.url).pathname;
  const baseUrl = process.env.NITTER_BASE_URL ?? "https://nitter.net";
  const query = process.env.NITTER_TEST_QUERY ?? "mcp server";
  const username = process.env.NITTER_TEST_USERNAME ?? "youtoy";

  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      NITTER_BASE_URL: baseUrl,
    } as Record<string, string>,
  });

  const permissiveValidator: jsonSchemaValidator = {
    getValidator: (() => (input: unknown) => ({
      valid: true,
      data: input,
      errorMessage: undefined,
    })) as jsonSchemaValidator["getValidator"],
  };

  const client = new Client({
    name: "nitter-mcp-regression-client",
    version: "0.1.0",
  }, {
    jsonSchemaValidator: permissiveValidator,
  });

  try {
    await client.connect(transport);

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

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl,
          nonFatalErrors: regressionErrors,
          checkedTools: [...names].filter((name) =>
            name.startsWith("nitter_"),
          ),
          tweetSearch: summarizeContent(tweetResult),
          userFeed: summarizeContent(feedResult),
          userSearch: summarizeContent(userResult),
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
