/**
 * @fileoverview Tests for the plan-026 pnpm patch that adds URL
 * image support to pi-ai's provider encoders.
 *
 * The patch adds a `url?` field to `ImageContent` and branches in:
 *  - dist/api/anthropic-messages.js (2 spots: user messages,
 *    tool-result messages)
 *  - dist/api/openai-completions.js (2 spots: same)
 *  - dist/api/openai-responses-shared.js (2 spots: same — used
 *    by gpt-5.x)
 *
 * Strategy: use `convertMessages` for openai-completions (the
 * only encoder that exports it), and `streamSimple` + a mocked
 * fetch for anthropic-messages and openai-responses. The fetch
 * body is parsed and we assert on the image block's wire shape.
 *
 * If the patch is lost (e.g. pnpm install re-applied without the
 * patch), these tests will fail with a clear message about the
 * missing URL branch.
 */

import { describe, expect, it, vi } from "vitest";

import { convertMessages as openaiCompletionsConvert } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponsesStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as anthropicStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Model } from "@earendil-works/pi-ai";

const URL = "https://api.fungi.computer/img/ws-1/foo.png?exp=123&sig=abc";
const MIME = "image/png";

const openaiCompletionsModel: Model<"openai-completions"> = {
  api: "openai-completions",
  baseUrl: "https://example.invalid/v1",
  compat: {
    requiresAssistantAfterToolResult: false,
    supportsStore: false,
  },
  contextWindow: 128_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "gpt-4o-mini",
  input: ["text", "image"],
  maxTokens: 16_384,
  name: "gpt-4o-mini",
  provider: "openai",
};

const openaiResponsesModel: Model<"openai-responses"> = {
  api: "openai-responses",
  baseUrl: "https://example.invalid/v1",
  compat: {
    requiresAssistantAfterToolResult: false,
    supportsStore: false,
  },
  contextWindow: 272_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "gpt-5.4",
  input: ["text", "image"],
  maxTokens: 16_384,
  name: "gpt-5.4",
  provider: "openai",
};

const anthropicModel: Model<"anthropic-messages"> = {
  api: "anthropic-messages",
  baseUrl: "https://example.invalid",
  compat: {
    requiresAssistantAfterToolResult: false,
    supportsStore: false,
  },
  contextWindow: 200_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "claude-sonnet-4.5",
  input: ["text", "image"],
  maxTokens: 8_192,
  name: "claude-sonnet-4.5",
  provider: "anthropic",
};

const base64 = "iVBORw0KGgo=";

function userMsgWithImage(image: {
  data?: string;
  mimeType: string;
  url?: string;
  type: "image";
}) {
  return {
    content: [{ text: "describe this", type: "text" as const }, image],
    role: "user" as const,
    timestamp: Date.now(),
  };
}

function toolResultWithImage(image: {
  data?: string;
  mimeType: string;
  url?: string;
  type: "image";
}) {
  return {
    content: [image],
    isError: false,
    role: "toolResult" as const,
    timestamp: Date.now(),
    toolCallId: "tc-1",
    toolName: "read_image",
  };
}

// ---------------------------------------------------------------------------
// openai-completions: convertMessages is exported, so we can call it directly.
// ---------------------------------------------------------------------------

describe("pi-ai plan-026 URL image patch — openai-completions", () => {
  it("user message with URL → image_url.url is the URL (no data: prefix)", () => {
    const params = openaiCompletionsConvert(
      openaiCompletionsModel,
      {
        messages: [
          userMsgWithImage({ mimeType: MIME, type: "image", url: URL }),
        ],
      },
      openaiCompletionsModel.compat,
    );
    const msg = params[0]! as { role: string; content: unknown[] };
    const imagePart = (msg.content as Array<Record<string, unknown>>).find(
      (b) => b.type === "image_url",
    );
    expect(imagePart).toBeDefined();
    const url = (imagePart as { image_url: { url: string } }).image_url.url;
    expect(url).toBe(URL);
    expect(url).not.toMatch(/^data:/);
  });

  it("user message with only data → image_url.url is the data: URL (legacy path)", () => {
    const params = openaiCompletionsConvert(
      openaiCompletionsModel,
      {
        messages: [
          userMsgWithImage({ data: base64, mimeType: MIME, type: "image" }),
        ],
      },
      openaiCompletionsModel.compat,
    );
    const msg = params[0]! as { content: unknown[] };
    const imagePart = (msg.content as Array<Record<string, unknown>>).find(
      (b) => b.type === "image_url",
    );
    const url = (imagePart as { image_url: { url: string } }).image_url.url;
    expect(url).toBe(`data:${MIME};base64,${base64}`);
  });
});

// ---------------------------------------------------------------------------
// openai-responses (gpt-5.x) + anthropic-messages: convertMessages is
// internal. Use streamSimple with a mocked fetch and inspect the request
// body that the encoder produced.
// ---------------------------------------------------------------------------

function mockSseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

function sseDone(): string {
  return "data: [DONE]\n\n";
}

/**
 * Run streamSimple to completion. The fetch mock captures the
 * request body; the stream's first event resolves the deferred
 * once the body is captured. The body is returned as parsed JSON.
 */
async function captureRequestBody(
  streamFactory: (
    req: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ) => Promise<{ events: unknown[]; requestInit: RequestInit | undefined }>,
): Promise<unknown> {
  let captured: { url: string; init: RequestInit } | null = null;
  const fetchMock = vi.fn(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = { init: init ?? {}, url: String(url) };
      return mockSseResponse([sseDone()]);
    },
  );
  // Pin the global fetch for the duration of the call.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    const events: unknown[] = [];
    const iter = streamFactory(fetchMock as unknown as typeof fetch);
    try {
      for await (const event of iter) {
        events.push(event);
      }
    } catch {
      // The mock returns an empty SSE; the stream may throw on
      // missing content. We only care about the captured body.
    }
    if (!captured) throw new Error("fetch was not called");
    const body = captured.init.body;
    if (typeof body === "string") return JSON.parse(body);
    if (body instanceof Uint8Array)
      return JSON.parse(new TextDecoder().decode(body));
    if (body instanceof ReadableStream) {
      const text = await new Response(body).text();
      return JSON.parse(text);
    }
    throw new Error(`unexpected body type: ${typeof body}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("pi-ai plan-026 URL image patch — openai-responses (gpt-5.x)", () => {
  it("user message with URL → input_image.image_url is the URL", async () => {
    const body = (await captureRequestBody((fetch) =>
      openaiResponsesStreamSimple(
        openaiResponsesModel,
        {
          messages: [
            userMsgWithImage({ mimeType: MIME, type: "image", url: URL }),
          ],
        },
        { apiKey: "test-key", fetch: fetch as never },
      ),
    )) as {
      input: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    const imagePart = body.input[0]!.content.find(
      (b) => b.type === "input_image",
    );
    expect(imagePart).toBeDefined();
    const imageUrl = (imagePart as { image_url: string }).image_url;
    expect(imageUrl).toBe(URL);
    expect(imageUrl).not.toMatch(/^data:/);
  });

  it("user message with only data → input_image.image_url is the data: URL (legacy path)", async () => {
    const body = (await captureRequestBody((fetch) =>
      openaiResponsesStreamSimple(
        openaiResponsesModel,
        {
          messages: [
            userMsgWithImage({ data: base64, mimeType: MIME, type: "image" }),
          ],
        },
        { apiKey: "test-key", fetch: fetch as never },
      ),
    )) as {
      input: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    const imagePart = body.input[0]!.content.find(
      (b) => b.type === "input_image",
    );
    const imageUrl = (imagePart as { image_url: string }).image_url;
    expect(imageUrl).toBe(`data:${MIME};base64,${base64}`);
  });
});

describe("pi-ai plan-026 URL image patch — anthropic-messages", () => {
  it("user message with URL → source.type is 'url', no base64", async () => {
    const body = (await captureRequestBody((fetch) =>
      anthropicStreamSimple(
        anthropicModel,
        {
          messages: [
            userMsgWithImage({ mimeType: MIME, type: "image", url: URL }),
          ],
        },
        { apiKey: "test-key", fetch: fetch as never },
      ),
    )) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const imagePart = body.messages[0]!.content.find((b) => b.type === "image");
    expect(imagePart).toBeDefined();
    const source = (imagePart as { source: Record<string, unknown> }).source;
    expect(source.type).toBe("url");
    expect(source.url).toBe(URL);
    expect(source.data).toBeUndefined();
    expect(source.media_type).toBeUndefined();
  });

  it("user message with only data → source.type is 'base64' (legacy path)", async () => {
    const body = (await captureRequestBody((fetch) =>
      anthropicStreamSimple(
        anthropicModel,
        {
          messages: [
            userMsgWithImage({ data: base64, mimeType: MIME, type: "image" }),
          ],
        },
        { apiKey: "test-key", fetch: fetch as never },
      ),
    )) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const imagePart = body.messages[0]!.content.find((b) => b.type === "image");
    const source = (imagePart as { source: Record<string, unknown> }).source;
    expect(source.type).toBe("base64");
    expect(source.data).toBe(base64);
    expect(source.media_type).toBe(MIME);
  });

  it("tool result with URL → source.type is 'url'", async () => {
    const body = (await captureRequestBody((fetch) =>
      anthropicStreamSimple(
        anthropicModel,
        {
          messages: [
            toolResultWithImage({ mimeType: MIME, type: "image", url: URL }),
          ],
        },
        { apiKey: "test-key", fetch: fetch as never },
      ),
    )) as {
      messages: Array<{
        content: Array<{
          type: string;
          content?: Array<Record<string, unknown>>;
        }>;
      }>;
    };
    // Anthropic wraps tool results in a user message with
    // {type: "tool_result", content: [...inner blocks]}.
    const toolResult = body.messages[0]!.content.find(
      (b) => b.type === "tool_result",
    ) as { content: Array<Record<string, unknown>> };
    const imagePart = toolResult.content.find((b) => b.type === "image");
    expect(imagePart).toBeDefined();
    const source = (imagePart as { source: Record<string, unknown> }).source;
    expect(source.type).toBe("url");
    expect(source.url).toBe(URL);
  });
});
