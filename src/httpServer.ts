import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RuntimeConfig } from "./runtimeConfig.js";
import { createNitterMcpServer } from "./serverCore.js";

function getRequestUrl(req: IncomingMessage, host: string): URL {
  return new URL(req.url ?? "/", `http://${host}`);
}

function getSessionIdHeader(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function writeJsonError(
  res: ServerResponse,
  statusCode: number,
  code: number,
  message: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify(
      {
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
      },
      null,
      2,
    ),
  );
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const bodyText = Buffer.concat(chunks).toString("utf8");
  if (!bodyText.trim()) {
    return undefined;
  }

  return JSON.parse(bodyText);
}

export async function runHttpServer(config: RuntimeConfig): Promise<void> {
  const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
  const sseTransports = new Map<string, SSEServerTransport>();

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const hostHeader = req.headers.host ?? `${config.host}:${config.port}`;
    const requestUrl = getRequestUrl(req, hostHeader);

    try {
      if (requestUrl.pathname === config.httpPath) {
        let parsedBody: unknown;
        if (method === "POST") {
          try {
            parsedBody = await parseJsonBody(req);
          } catch {
            writeJsonError(res, 400, -32700, "Invalid JSON request body");
            return;
          }
        }

        const sessionId = getSessionIdHeader(req);
        if (sessionId) {
          if (sseTransports.has(sessionId)) {
            writeJsonError(
              res,
              400,
              -32000,
              "Bad Request: Session exists but uses a different transport protocol",
            );
            return;
          }

          const existingTransport = streamableTransports.get(sessionId);
          if (!existingTransport) {
            writeJsonError(res, 404, -32001, "Session not found");
            return;
          }

          await existingTransport.handleRequest(req, res, parsedBody);
          return;
        }

        if (method !== "POST" || !isInitializeRequest(parsedBody)) {
          writeJsonError(
            res,
            400,
            -32000,
            "Bad Request: No valid session ID provided",
          );
          return;
        }

        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            streamableTransports.set(newSessionId, newTransport);
          },
        });
        newTransport.onclose = () => {
          const connectedSessionId = newTransport.sessionId;
          if (connectedSessionId) {
            streamableTransports.delete(connectedSessionId);
          }
        };

        const mcpServer = createNitterMcpServer();
        await mcpServer.connect(newTransport);
        await newTransport.handleRequest(req, res, parsedBody);
        return;
      }

      if (config.sseCompatEnabled && requestUrl.pathname === config.ssePath && method === "GET") {
        const sseTransport = new SSEServerTransport(config.sseMessagesPath, res);
        if (streamableTransports.has(sseTransport.sessionId)) {
          writeJsonError(
            res,
            400,
            -32000,
            "Bad Request: Session exists but uses a different transport protocol",
          );
          return;
        }

        sseTransports.set(sseTransport.sessionId, sseTransport);
        sseTransport.onclose = () => {
          sseTransports.delete(sseTransport.sessionId);
        };

        const mcpServer = createNitterMcpServer();
        await mcpServer.connect(sseTransport);
        return;
      }

      if (
        config.sseCompatEnabled &&
        requestUrl.pathname === config.sseMessagesPath &&
        method === "POST"
      ) {
        const sessionId = requestUrl.searchParams.get("sessionId");
        if (!sessionId) {
          res.statusCode = 400;
          res.end("Missing sessionId query parameter");
          return;
        }

        if (streamableTransports.has(sessionId)) {
          writeJsonError(
            res,
            400,
            -32000,
            "Bad Request: Session exists but uses a different transport protocol",
          );
          return;
        }

        const sseTransport = sseTransports.get(sessionId);
        if (!sseTransport) {
          res.statusCode = 404;
          res.end("No transport found for sessionId");
          return;
        }

        await sseTransport.handlePostMessage(req, res);
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.statusCode = 404;
      res.end("Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        writeJsonError(res, 500, -32603, `Internal server error: ${message}`);
      }
    }
  });

  const shutdown = async () => {
    for (const transport of streamableTransports.values()) {
      try {
        await transport.close();
      } catch {
        // Ignore shutdown errors to continue closing remaining transports.
      }
    }
    for (const transport of sseTransports.values()) {
      try {
        await transport.close();
      } catch {
        // Ignore shutdown errors to continue closing remaining transports.
      }
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  process.once("SIGINT", () => {
    shutdown()
      .then(() => process.exit(0))
      .catch((error) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        console.error(message);
        process.exit(1);
      });
  });

  process.once("SIGTERM", () => {
    shutdown()
      .then(() => process.exit(0))
      .catch((error) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        console.error(message);
        process.exit(1);
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, config.host, () => resolve());
    server.on("error", reject);
  });

  console.error(
    `nitter-mcp listening on http://${config.host}:${config.port}${config.httpPath} (SSE compat ${config.sseCompatEnabled ? "enabled" : "disabled"})`,
  );
}
