import { describe, test, expect, vi } from "vitest";
import { WebSocketClientTransport } from "../../src/core/websocket-client-transport.js";

describe("WebSocketClientTransport", () => {
  test("implements ClientTransport interface", () => {
    const transport = new WebSocketClientTransport({
      url: "wss://test.example.com/ws",
    });

    expect(typeof transport.connect).toBe("function");
    expect(typeof transport.disconnect).toBe("function");
    expect(typeof transport.send).toBe("function");
    expect(typeof transport.onMessage).toBe("function");
    expect(typeof transport.onClose).toBe("function");
  });

  test("can be constructed with url and debug callback", () => {
    const debugFn = vi.fn();
    const transport = new WebSocketClientTransport({
      url: "wss://test.example.com/ws",
      onDebug: debugFn,
    });

    expect(transport).toBeDefined();
  });
});
