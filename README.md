# @shiit/coding-agent

---

## WARNING!!! THIS IS A HIGH EFFORT SLOP FORK, USE AT YOUR OWN RISK

Fork of `@mariozechner/pi-coding-agent` with client/server architecture support for Cloudflare Workers.

## Purpose

The core agent runtime. `AgentSessionServer` manages `AgentSession` instances and broadcasts events to connected clients via the `Transport` interface. Decoupled from any specific UI — works with `@shiit/tui`, browser terminals, or any custom client.

## Why This Fork

The upstream pi-coding-agent is designed as a monolithic CLI tool. This fork restructures it as a proper client/server architecture suitable for cloud deployment, with:

- `AgentSessionServer` - Server-side session management with WebSocket transport
- `AgentSessionClient` - Client that connects to the server remotely
- Streaming message IDs from `@shiit/agent-core`

## Architecture

```
Client (@shiit/tui / browser / custom)
    ↑↓ WebSocket / in-memory / custom transport
Transport (WebSocketTransport / InMemoryTransport / custom)
    ↑↓ AgentSessionSyncEvent / SessionCommand
AgentSessionServer
    ↓ manages
AgentSession (per session)
    ↓ uses
SessionStore (persistence)
ToolBackend (tool execution)
ModelRegistry (AI models)
```

## Installation

```bash
bun add @shiit/coding-agent
```

## Subpath Exports

| Export                       | Purpose                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `@shiit/coding-agent`        | Server (`AgentSessionServer`, `Transport`, `ToolBackend`, etc.) |
| `@shiit/coding-agent/client` | Client (`AgentSessionClient`, `WebSocketClientTransport`)       |
| `@shiit/coding-agent/hooks`  | React hooks for client integration                              |

## Server Usage

```typescript
import { AgentSessionServer } from "@shiit/coding-agent";

const server = new AgentSessionServer(
  sessionStore, // SessionStore implementation
  sessionFactory, // SessionFactory implementation
  toolBackendFactory, // (sessionId: string) => ToolBackend
  modelRegistry, // ModelRegistry
  transport, // Transport implementation
);

server.start();
```

> Note: `AgentSessionServer` takes **positional arguments**, not an options object.

## Client Usage

```typescript
import {
  AgentSessionClient,
  WebSocketClientTransport,
} from "@shiit/coding-agent/client";

const transport = new WebSocketClientTransport({
  url: "wss://user.fungi.computer/ws/session/session-id",
});

const client = new AgentSessionClient(transport);
await client.connect();

// Subscribe to all events
client.subscribeGlobal((event) => {
  console.log("Event:", event);
});

// Subscribe to a specific session
client.subscribeSession("session-id", (event) => {
  console.log("Session event:", event);
});
```

> Note: `WebSocketClientTransport` takes an **options object** with `url`, not a plain string.

## Key Exports

### Server

| Export                                                                               | What It Is                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `AgentSessionServer`                                                                 | Manages sessions, broadcasts events via Transport |
| `Transport` / `Connection`                                                           | Abstract transport interface                      |
| `ToolBackend`                                                                        | Abstract tool execution interface                 |
| `SessionStore` / `SessionData` / `SessionListItem`                                   | Persistence abstractions                          |
| `SessionSnapshot` / `SessionCommand` / `AgentSessionSyncEvent` / `GlobalServerEvent` | Protocol types                                    |
| `AgentSession`                                                                       | Individual session instance                       |
| `createAgentSession` / `AgentSessionRuntime` / `AgentSessionServices`                | SDK entrypoints                                   |
| `SettingsManager`                                                                    | Session settings management                       |
| `AuthStorage` / `FileAuthStorageBackend`                                             | Auth persistence                                  |

### Client

| Export                     | What It Is                                  |
| -------------------------- | ------------------------------------------- |
| `AgentSessionClient`       | Client for connecting to AgentSessionServer |
| `WebSocketClientTransport` | WebSocket transport implementation          |
| `InMemoryTransport`        | In-memory transport for testing             |

### Extensions

| Export                          | What It Is                         |
| ------------------------------- | ---------------------------------- |
| `Extension` / `ExtensionRunner` | Extension system                   |
| `defineTool` / `defineCommand`  | Extension tool/command definitions |

### Utilities

| Export                                                 | What It Is                  |
| ------------------------------------------------------ | --------------------------- |
| `compact` / `shouldCompact` / `calculateContextTokens` | Session compaction          |
| `InMemorySessionStore`                                 | In-memory store for testing |

## Key Features

- **Transport-agnostic**: Works with WebSocket, in-memory, or custom transports
- **Multi-client**: Multiple clients can connect to the same session simultaneously
- **Snapshot sync**: New clients receive full session state on connect
- **Session persistence**: Pluggable `SessionStore` (SQLite, in-memory, etc.)
- **Tool backend**: Pluggable tool execution (file ops, bash, git, etc.)
- **Model registry**: Supports multiple AI models with switching
- **Extension system**: Dynamically loaded tools and commands
- **Compaction**: Automatic context window management

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

## Fork Origin

Forked from `@mariozechner/pi-coding-agent@0.66.1` with cloud-specific modifications:

- `AgentSessionServer` for client/server architecture
- Transport and session store abstractions
- Cloud-specific build patches

## Notes

- See `@fungi-computer/cloudflare-workspace` for Cloudflare Workers integration
- See `@shiit/tui` for a terminal UI client
- See `@fungi-computer/session` (zombie package, to be deleted per ARCH-001) — not used by production code

## Version

Version `0.66.1` matches upstream `@mariozechner/pi-coding-agent@0.66.1`.

## Upstream

- Repository: https://github.com/badlogic/pi-mono
- Version: v0.66.1

## License

MIT
