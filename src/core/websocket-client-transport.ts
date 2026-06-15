/**
 * WebSocketClientTransport - Client-side WebSocket transport for AgentSessionClient.
 *
 * Connects to Cloudflare Workers WebSocket endpoint.
 */

import type { ClientTransport } from "./agent-session-client.js";

export interface WebSocketClientTransportOptions {
  onDebug?: (message: string) => void;
  subprotocol?: string;
  url: string;
}

export class WebSocketClientTransport implements ClientTransport {
  private closed = false;
  private closeHandlers = new Set<() => void>();
  private connectRejecter: ((err: Error) => void) | null = null;
  private connectResolver: (() => void) | null = null;
  private messageHandlers = new Set<(message: any) => void>();
  private readonly onDebug?: (message: string) => void;
  private readonly subprotocol?: string;
  private readonly url: string;
  private ws: null | WebSocket = null;

  constructor(options: WebSocketClientTransportOptions) {
    this.url = options.url;
    this.subprotocol = options.subprotocol;
    this.onDebug = options.onDebug;
  }

  async connect(): Promise<void> {
    if (this.ws) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.connectResolver = resolve;
      this.connectRejecter = reject;
      this.closed = false;

      try {
        this.ws = this.subprotocol
          ? new WebSocket(this.url, this.subprotocol)
          : new WebSocket(this.url);
        this.ws.addEventListener("open", this.handleOpen);
        this.ws.addEventListener("message", this.handleMessage);
        this.ws.addEventListener("close", this.handleClose);
        this.ws.addEventListener("error", this.handleError);
      } catch (err) {
        this.debug(`WebSocket connection error: ${err}`);
        this.cleanup();
        reject(new Error(`Failed to connect: ${err}`));
      }
    });
  }

  async disconnect(): Promise<void> {
    if (!this.ws) {
      return;
    }

    this.closed = true;
    this.ws.close();
    this.cleanup();
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  onMessage(handler: (message: any) => void): void {
    this.messageHandlers.add(handler);
  }

  send(message: { [key: string]: any; type: string; }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.debug(
        `Cannot send - WebSocket not open. State: ${this.ws?.readyState}`,
      );
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
      this.debug(`Sent: ${JSON.stringify(message)}`);
    } catch (err) {
      this.debug(`Send error: ${err}`);
    }
  }

  private cleanup(): void {
    if (this.ws) {
      this.ws.removeEventListener("open", this.handleOpen);
      this.ws.removeEventListener("message", this.handleMessage);
      this.ws.removeEventListener("close", this.handleClose);
      this.ws.removeEventListener("error", this.handleError);
      this.ws = null;
    }
  }

  private debug(message: string): void {
    if (this.onDebug) {
      this.onDebug(message);
    }
  }

  private handleClose = (event: CloseEvent): void => {
    this.debug(`WebSocket closed: ${event.code} ${event.reason}`);
    this.cleanup();
    this.closeHandlers.forEach((h) => h());
  };

  private handleError = (event: Event): void => {
    this.debug(`WebSocket error: ${event.type}`);
    if (this.connectRejecter) {
      this.connectRejecter(new Error("WebSocket connection failed"));
      this.connectResolver = null;
      this.connectRejecter = null;
    }
    this.cleanup();
  };

  private handleMessage = (event: MessageEvent): void => {
    try {
      const data =
        typeof event.data === "string"
          ? JSON.parse(event.data)
          : JSON.parse(new TextDecoder().decode(event.data));
      this.debug(`Received: ${JSON.stringify(data)}`);
      this.messageHandlers.forEach((h) => h(data));
    } catch (err) {
      this.debug(`Failed to parse message: ${err}`);
    }
  };

  private handleOpen = (): void => {
    this.debug("WebSocket connected");
    if (this.connectResolver) {
      this.connectResolver();
      this.connectResolver = null;
      this.connectRejecter = null;
    }
  };
}
