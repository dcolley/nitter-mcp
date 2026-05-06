# nitter-mcp

`nitter-mcp` is a Model Context Protocol (MCP) server that reads from a Nitter instance and returns normalized JSON for:

- tweet search (RSS endpoint)
- user feed (RSS endpoint)
- user search (HTML endpoint)

## Features

- strict `zod` schemas for MCP tool inputs and outputs
- normalized, LLM-friendly JSON payloads
- URL rewriting from Nitter/localhost links to `https://x.com/...`
- explicit rate-limit and upstream error classification
- transport selection via env (`stdio` or standalone HTTP)
- Streamable HTTP endpoint with optional deprecated SSE compatibility endpoints
- regression script that boots the server and calls tools over MCP stdio

## Requirements

- Node.js `>=18.17`
- Yarn `1.x`

## Quick start

### Stdio mode (default)

```bash
yarn install
yarn build
yarn start
```

For local development:

```bash
yarn dev
```

### Standalone HTTP mode

```bash
yarn install
yarn build
yarn start:http
```

For local development:

```bash
yarn dev:http
```

## Configuration

Environment variables:

- `NITTER_BASE_URL` (optional): base URL for your Nitter server
  - default: `https://nitter.net`
- `MCP_TRANSPORT` (optional): `stdio` (default) or `http`
- `MCP_HOST` (optional, HTTP mode): host bind address
  - default: `127.0.0.1`
- `MCP_PORT` (optional, HTTP mode): server port
  - default: `3000`
- `MCP_HTTP_PATH` (optional, HTTP mode): Streamable HTTP MCP endpoint path
  - default: `/mcp`
- `MCP_ENABLE_SSE_COMPAT` (optional, HTTP mode): enable deprecated HTTP+SSE compatibility
  - default: `true`
- `MCP_SSE_PATH` (optional, HTTP mode): deprecated SSE stream endpoint path
  - default: `/sse`
- `MCP_SSE_MESSAGES_PATH` (optional, HTTP mode): deprecated SSE POST messages endpoint path
  - default: `/messages`

### `.env` support and recommended setup

`nitter-mcp` reads environment variables from `process.env`.

- `.env` is **not required**
- `.env` is **not auto-loaded by this package**
- environment values are usually provided by your MCP host (recommended), shell, or process launcher

Recommended ways to set `NITTER_*`:

1. In MCP server config (best for Cursor/VS Code), use the server `env` block.
2. In shell for local runs, export before starting:

```bash
export NITTER_BASE_URL="https://nitter.net"
yarn start
```

3. One-off command:

```bash
NITTER_BASE_URL="https://nitter.net" yarn start
```

If you prefer a `.env` file workflow, use any external loader/tool in your own setup and launch `nitter-mcp` with those env vars populated.

URL rewriting is always applied recursively in tool responses:

- `${NITTER_BASE_URL}/...` -> `https://x.com/...`
- `https://localhost/...` -> `https://x.com/...`
- `http://localhost/...` -> `https://x.com/...`

## Tools

### `nitter_search_tweets`

Searches tweets via `/search/rss?f=tweets`.

Input:

- `query: string` (required)
- `since?: "YYYY-MM-DD"`
- `until?: "YYYY-MM-DD"`
- `minFaves?: number` (maps to `min_faves`)
- `include?: SearchFilters` (maps to `f-*` query params with `=on`)
- `exclude?: SearchFilters` (maps to `e-*` query params with `=on`)

`SearchFilters` keys:

- `nativeRetweets`
- `media`
- `videos`
- `news`
- `nativeVideo`
- `replies`
- `links`
- `images`
- `quote`
- `spaces`

### `nitter_feed_user`

Fetches a user's RSS feed via `/{username}/rss`.

Input:

- `username: string` (required)

### `nitter_search_users`

Searches users via `/search?f=users&q=...` and parses user cards from Nitter HTML.

Input:

- `query: string` (required)
- `cursor?: string` (pagination cursor)

## Error handling

Tools return MCP error responses (`isError: true`) with structured payloads:

- `RATE_LIMITED`
  - includes `statusCode`, `retryable: true`, optional `retryAfterSeconds`, and `snippet`
- `UPSTREAM_ERROR`
  - includes `statusCode`, `retryable` (true for `5xx`), and `snippet`
- `INVALID_PAYLOAD`
  - returned when expected RSS/HTML payload shape is not detected

Rate limit detection includes both direct HTTP `429` and common rate-limit phrases in Nitter responses.

## Regression check

Run a one-command stdio regression check (spawns server + MCP client calls):

```bash
yarn regression
```

Run HTTP + SSE compatibility regression check:

```bash
yarn regression:http
```

Optional env vars for regression:

- `NITTER_BASE_URL`
- `NITTER_TEST_QUERY`
- `NITTER_TEST_USERNAME`
- `MCP_HOST`
- `MCP_PORT`
- `MCP_HTTP_PATH`
- `MCP_SSE_PATH`

`yarn regression` treats `RATE_LIMITED`, `UPSTREAM_ERROR`, and `INVALID_PAYLOAD` as non-fatal warnings (common on public Nitter instances), and still verifies tool registration and MCP transport behavior.

`yarn regression:http` applies the same non-fatal handling while verifying Streamable HTTP and deprecated SSE compatibility endpoints.

## MCP config example (Cursor/VS Code)

```json
{
  "mcp": {
    "servers": {
      "nitter": {
        "command": "node",
        "args": ["/absolute/path/to/nitter-mcp/dist/index.js"],
        "env": {
          "NITTER_BASE_URL": "https://nitter.net"
        }
      }
    }
  }
}
```

## Standalone HTTP endpoint example

Run as an HTTP server:

```bash
MCP_TRANSPORT=http MCP_HOST=127.0.0.1 MCP_PORT=3000 yarn start
```

Then connect clients to:

- Streamable HTTP: `http://127.0.0.1:3000/mcp`
- Deprecated SSE stream: `http://127.0.0.1:3000/sse`
- Deprecated SSE messages: `http://127.0.0.1:3000/messages?sessionId=<id>`

You can add more vars in this `env` block.  
`nitter-mcp` consumes `NITTER_BASE_URL` plus `MCP_*` transport/runtime variables described above.  
`NITTER_TEST_QUERY` and `NITTER_TEST_USERNAME` are for regression scripts, not normal MCP server runtime.

## Publishing checklist (public GitHub repo)

- ensure `README.md`, `LICENSE`, and `package.json` metadata are up to date
- commit only source + lockfile (exclude `node_modules` and build output)
- run `yarn build` and `yarn regression` before pushing
- create the repository at [github.com/dcolley](https://github.com/dcolley) and push
