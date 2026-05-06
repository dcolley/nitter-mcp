import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  NitterClient,
  NitterPayloadError,
  NitterRateLimitedError,
  NitterUpstreamError,
  type SearchFilters,
} from "./nitterClient.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const searchFiltersSchema = z
  .object({
    nativeRetweets: z.boolean().optional(),
    media: z.boolean().optional(),
    videos: z.boolean().optional(),
    news: z.boolean().optional(),
    nativeVideo: z.boolean().optional(),
    replies: z.boolean().optional(),
    links: z.boolean().optional(),
    images: z.boolean().optional(),
    quote: z.boolean().optional(),
    spaces: z.boolean().optional(),
  })
  .strict();

const searchTweetsInputSchema = z
  .object({
    query: z.string().min(1),
    since: z.string().regex(DATE_PATTERN).optional(),
    until: z.string().regex(DATE_PATTERN).optional(),
    minFaves: z.number().int().nonnegative().optional(),
    include: searchFiltersSchema.optional(),
    exclude: searchFiltersSchema.optional(),
  })
  .strict();

const searchUsersInputSchema = z
  .object({
    query: z.string().min(1),
    cursor: z.string().min(1).optional(),
  })
  .strict();

const feedUserInputSchema = z
  .object({
    username: z.string().min(1),
  })
  .strict();

const rssItemSchema = z.object({
  title: z.string(),
  creator: z.string(),
  descriptionHtml: z.string(),
  descriptionText: z.string(),
  pubDate: z.string(),
  guid: z.string(),
  link: z.string(),
});

const rssChannelSchema = z.object({
  title: z.string(),
  link: z.string(),
  description: z.string(),
  language: z.string(),
  ttl: z.number().nullable(),
  selfLink: z.string(),
});

const tweetSearchOutputSchema = z.object({
  requestUrl: z.string(),
  kind: z.literal("tweet_search"),
  query: z.string(),
  channel: rssChannelSchema,
  items: z.array(rssItemSchema),
});

const userFeedOutputSchema = z.object({
  requestUrl: z.string(),
  kind: z.literal("user_feed"),
  username: z.string(),
  channel: rssChannelSchema,
  items: z.array(rssItemSchema),
});

const userSearchOutputSchema = z.object({
  requestUrl: z.string(),
  kind: z.literal("user_search"),
  query: z.string(),
  users: z.array(
    z.object({
      username: z.string(),
      displayName: z.string(),
      profileUrl: z.string(),
      avatarUrl: z.string(),
      bio: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

function serializeData(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function buildToolSuccess<T extends Record<string, unknown>>(
  summary: string,
  data: T,
) {
  return {
    content: [{ type: "text" as const, text: `${summary}\n\n${serializeData(data)}` }],
    structuredContent: data,
  };
}

function formatFilterSummary(prefix: string, filters?: SearchFilters): string {
  if (!filters) {
    return `${prefix}: none`;
  }

  const enabled = Object.entries(filters)
    .filter(([, isOn]) => Boolean(isOn))
    .map(([name]) => name);

  return `${prefix}: ${enabled.length > 0 ? enabled.join(", ") : "none"}`;
}

function formatToolError(error: unknown) {
  if (error instanceof NitterRateLimitedError) {
    const retryHint = error.details.retryAfterSeconds
      ? ` Retry after approximately ${error.details.retryAfterSeconds}s.`
      : " Retry after a short delay.";
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Nitter server is rate limited.${retryHint}`,
        },
      ],
      structuredContent: {
        errorCode: "RATE_LIMITED",
        statusCode: error.details.statusCode,
        retryable: true,
        retryAfterSeconds: error.details.retryAfterSeconds,
        snippet: error.details.snippet,
      },
    };
  }

  if (error instanceof NitterUpstreamError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `${error.message}. Upstream status: ${error.statusCode}.`,
        },
      ],
      structuredContent: {
        errorCode: "UPSTREAM_ERROR",
        statusCode: error.statusCode,
        retryable: error.statusCode >= 500,
        snippet: error.snippet,
      },
    };
  }

  if (error instanceof NitterPayloadError) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: error.message }],
      structuredContent: {
        errorCode: "INVALID_PAYLOAD",
        retryable: false,
      },
    };
  }

  const fallbackMessage =
    error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
  return {
    isError: true,
    content: [{ type: "text" as const, text: fallbackMessage }],
    structuredContent: {
      errorCode: "UNKNOWN_ERROR",
      retryable: false,
    },
  };
}

export function createNitterMcpServer(): McpServer {
  const nitterClient = new NitterClient();
  const server = new McpServer({
    name: "nitter-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "nitter_search_tweets",
    {
      description:
        "Search tweets from Nitter RSS and return normalized JSON. Supports include/exclude filters, date range, and min likes.",
      inputSchema: searchTweetsInputSchema,
      outputSchema: tweetSearchOutputSchema,
    },
    async (args) => {
      try {
        const result = await nitterClient.searchTweets(args);
        const summary = [
          `Tweet search for "${args.query}"`,
          `Results: ${result.items.length}`,
          formatFilterSummary("Include", args.include),
          formatFilterSummary("Exclude", args.exclude),
        ].join("\n");

        return buildToolSuccess(summary, result);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "nitter_feed_user",
    {
      description:
        "Fetch a user's Nitter RSS feed and return normalized JSON tweet items.",
      inputSchema: feedUserInputSchema,
      outputSchema: userFeedOutputSchema,
    },
    async ({ username }) => {
      try {
        const result = await nitterClient.feedByUser(username);
        const summary = `User feed for @${username}\nResults: ${result.items.length}`;
        return buildToolSuccess(summary, result);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "nitter_search_users",
    {
      description:
        "Search users from Nitter HTML search results and return normalized JSON user cards.",
      inputSchema: searchUsersInputSchema,
      outputSchema: userSearchOutputSchema,
    },
    async ({ query, cursor }) => {
      try {
        const result = await nitterClient.searchUsers({ query, cursor });
        const summary = [
          `User search for "${query}"`,
          `Results: ${result.users.length}`,
          `Next cursor: ${result.nextCursor ?? "none"}`,
        ].join("\n");
        return buildToolSuccess(summary, result);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  return server;
}
