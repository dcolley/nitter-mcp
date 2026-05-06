export type McpTransportMode = "stdio" | "http";

export type RuntimeConfig = {
  transport: McpTransportMode;
  host: string;
  port: number;
  httpPath: string;
  ssePath: string;
  sseMessagesPath: string;
  sseCompatEnabled: boolean;
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid MCP_PORT value "${value}". Expected a number in 1-65535.`);
  }

  return parsed;
}

function normalizePath(value: string | undefined, fallback: string, key: string): string {
  const path = (value ?? fallback).trim();
  if (!path.startsWith("/")) {
    throw new Error(`Invalid ${key} value "${path}". Paths must start with "/".`);
  }

  return path;
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const rawTransport = (env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();
  if (rawTransport !== "stdio" && rawTransport !== "http") {
    throw new Error('Invalid MCP_TRANSPORT. Use "stdio" or "http".');
  }

  return {
    transport: rawTransport,
    host: (env.MCP_HOST ?? "127.0.0.1").trim(),
    port: parsePort(env.MCP_PORT, 3000),
    httpPath: normalizePath(env.MCP_HTTP_PATH, "/mcp", "MCP_HTTP_PATH"),
    ssePath: normalizePath(env.MCP_SSE_PATH, "/sse", "MCP_SSE_PATH"),
    sseMessagesPath: normalizePath(
      env.MCP_SSE_MESSAGES_PATH,
      "/messages",
      "MCP_SSE_MESSAGES_PATH",
    ),
    sseCompatEnabled: parseBoolean(env.MCP_ENABLE_SSE_COMPAT, true),
  };
}
