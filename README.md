# @shiit/coding-agent

---
WARNING!!! THIS IS A HIGH EFFORT SLOP FORK, USE AT YOUR OWN RISK
---

Fork of `@mariozechner/pi-coding-agent` with client/server architecture support for Cloudflare Workers.

## Why This Fork

The upstream pi-coding-agent is designed as a monolithic CLI tool. This fork restructures it as a proper client/server architecture suitable for cloud deployment, with:

- `AgentSessionServer` - Server-side session management with WebSocket transport
- `AgentSessionClient` - Client that connects to the server remotely
- Streaming message IDs from `@shiit/agent-core`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Client (Browser/CLI)                                       │
│  AgentSessionClient + WebSocketClientTransport              │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Server (Cloudflare Worker)                                 │
│  AgentSessionServer + SessionManager + ToolBackend          │
└─────────────────────────────────────────────────────────────┘
```

## Installation

```bash
npm install @shiit/coding-agent
```

## Server Usage

```typescript
import { AgentSessionServer } from "@shiit/coding-agent";
import { WebSocketTransport } from "@shiit/coding-agent/server"; // or your transport

const server = new AgentSessionServer({
  sessionStore,
  sessionFactory,
  toolBackendFactory,
  modelRegistry,
  transport: new WebSocketTransport(8080),
});

await server.start();
```

## Client Usage

```typescript
import { AgentSessionClient, WebSocketClientTransport } from "@shiit/coding-agent";

const transport = new WebSocketClientTransport("wss://example.com");
const client = new AgentSessionClient(transport);

await client.connect();
const snapshot = await client.joinSession("session-id");

client.onEvent("session_updated", (event) => {
  console.log("Session updated:", event);
});
```

## Exports

### Server

- `AgentSessionServer` - Main server class
- `SessionManager` - Session lifecycle management
- `AgentSession` - Individual session handling

### Client

- `AgentSessionClient` - Client for connecting to server
- `WebSocketClientTransport` - WebSocket transport implementation

### Shared

- `AgentSessionRuntime` - Programmatic usage without transport
- All session types, tool backends, compaction utilities

## Key Features

- **Streaming message IDs** - Events include unique IDs for matching
- **Transport agnostic** - Works with WebSocket, HTTP, or custom transports
- **Session persistence** - SQLite-backed session store
- **Tool backend abstraction** - Pluggable file/git/exec backends

## What Was Lost from Upstream

This fork removes ~24,859 lines of TUI-dependent code:

### Deleted
- **`core/tools/`** - Built-in CLI tools (read, bash, edit, write, grep, find, ls). Tools are now provided by the environment instead of baked-in.
- **`core/export-html/`** - HTML export functionality (TUI-dependent)
- **`modes/interactive/`** - Full TUI interactive mode (~40+ files, all interactive components, themes, keybindings)
- **`core/keybindings.ts`** - Keybinding manager (TUI-dependent)
- **`main.ts`** - TUI entry point
- **CLI TUI files** - Config selector, session picker, model lister

### Stubbed
- **`core/bash-executor.ts`** - Now throws: "executeBash is not supported in cloud environment. Use tools instead."
- **`core/extensions/`** - Extension system is stubbed (no-op types and implementations). Was deeply integrated with TUI. If you need extensions, reference upstream v0.66.1.

### Why
- "Deploy anywhere" agents get tools from the environment, not baked-in defaults
- TUI rendering belongs in clients, not the agent runtime

## Changes from Upstream

1. Added `AgentSessionServer` / `AgentSessionClient` architecture
2. Added `@shiit/agent-core` dependency for message IDs
3. Added `WebSocketClientTransport` for client connectivity
4. Refactored internal session management for cloud deployment

## Version

Version `0.66.1` matches upstream `@mariozechner/pi-coding-agent@0.66.1`.

## Upstream

- Repository: https://github.com/badlogic/pi-mono
- Version: v0.66.1

## License

MIT