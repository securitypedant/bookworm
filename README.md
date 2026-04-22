# BookWorm

BookWorm is an educational demo for Cloudflare's Think-style agents. Each reader enters their name on the home page, which opens a dedicated long-running agent instance with a durable bookshelf, reminder scheduling, Open Library metadata, and chat-installed Think extensions.

[<img src="https://img.youtube.com/vi/tlE2Fn8WAgw/0.jpg">](https://youtu.be/tlE2Fn8WAgw "Introducing Think")

Live deployment: `https://bookworm.craigsdemos.workers.dev`

## Features

- Per-reader Think agent instances keyed by name
- Durable bookshelf with `to-read`, `reading`, and `read`
- Book reviews and ratings
- Open Library search, canonical links, and cover images
- Scheduled reading reminders
- Background reading digest generation with fibers
- Chat-installed Think extensions with workspace and context persistence
- Reader profile memory stored through a custom Think `memory` context provider

## Stack

- Cloudflare Workers + Durable Objects
- `agents`
- `@cloudflare/think`
- `@cloudflare/shell`
- React + Vite
- Workers AI via `workers-ai-provider`

## Local Development

Install dependencies:

```bash
npm install
```

Generate worker types:

```bash
npm run types
```

Start local dev:

```bash
npm start
```

Build production assets:

```bash
npm run build
```

Deploy:

```bash
npm run deploy
```

## Cloudflare Bindings

Configured in `wrangler.jsonc`:

- `BookWormAgent`: Durable Object binding
- `WORKSPACE_R2`: R2 bucket for workspace spillover
- `AI`: Workers AI binding
- `LOADER`: Worker Loader binding for Think extensions

The current config also pins the demo account id and uses the `bookworm-workspace` bucket.

## Architecture

### Server

`src/server.ts` defines `BookWormAgent extends Think<Env>`.

Important pieces:

- `workspace`: uses `Workspace` backed by DO SQLite and R2
- `configureSession()`: defines the Think session contexts and cached prompt
- `memory` context: backed by `/bookworm-reader-memory.json` in the workspace
- built-in tools: bookshelf, reminders, Open Library, reader memory, extensions, digest generation
- `extensionLoader`: wired to `LOADER`
- `HostBridgeLoopback`: exported for extension support

### Client

`src/client.tsx` renders:

- home page for reader name entry
- agent-backed chat UI
- live bookshelf panel
- reminders panel
- installed extensions panel
- digest status panel

Chat messages render Markdown with `react-markdown` and `remark-gfm`. Completed tool results are collapsed behind disclosure widgets.

## Data Model

### Agent State

The bookshelf UI uses agent state for live updates:

- owner name
- books
- extension count
- digest status

### Think Memory

Reader profile memory is stored in the `memory` context block and persisted via the workspace file:

- `/bookworm-reader-memory.json`

This holds:

- `ownerName`
- `preferences[]`

### Workspace Files

BookWorm also writes durable artifacts into the workspace:

- `/bookworm-library.json`
- `/bookworm-profile.json`
- `/bookworm-extensions.json`
- `/bookworm-reading-digest.md`

## Important Implementation Notes

- The project must use `agents/vite` in `vite.config.ts`. Without it, `@callable()` methods will not register correctly at runtime.
- Reader memory intentionally uses a custom provider instead of the default auto-backed context path.
- Dynamically installed extensions must have their declared context blocks registered into the live session.
- Tool result syncing in the client is intentionally idempotent to avoid React nested update errors during streaming.

## Extension Notes

BookWorm supports chat-installed Think extensions.

Extensions can:

- define tools and hooks in the Think extension format
- persist data in workspace files
- persist data in extension-owned writable context blocks

BookWorm requires approval before installing or removing extensions.

## Useful Files

- `src/server.ts`
- `src/client.tsx`
- `src/shared.ts`
- `src/styles.css`
- `wrangler.jsonc`
- `vite.config.ts`

## Git

Initial project commit:

```text
feat: build BookWorm think agent demo
```
