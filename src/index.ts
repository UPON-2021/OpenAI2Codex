import type { ExecutionContext } from "@cloudflare/workers-types";

interface Env {
  UPSTREAM_BASE_URL?: string;
  ALLOWED_ORIGIN?: string;
}

// ========== Chat Completions types (upstream / DeepSeek) ==========

interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  n?: number;
  stream_options?: {
    include_usage?: boolean;
  };
  tools?: ChatTool[];
  tool_choice?: unknown;
  reasoning_effort?: string;
  response_format?: unknown;
  stop?: string | string[];
  service_tier?: string;
}

interface ChatMessage {
  role: string;
  content?: string | ChatContentPart[] | null;
  reasoning_content?: string;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  function_call?: ChatFunctionCall | null;
}

interface ChatContentTextPart {
  type: "text" | "input_text" | "output_text";
  text?: string;
}

interface ChatContentImagePart {
  type: "image_url" | "input_image";
  image_url?: { url?: string } | string;
}

interface ChatContentReasoningPart {
  type: "reasoning" | "thinking";
  text?: string;
  thinking?: string;
}

type ChatContentPart =
  | ChatContentTextPart
  | ChatContentImagePart
  | ChatContentReasoningPart
  | Record<string, unknown>;

interface ChatTool {
  type: string;
  function?: ChatFunction;
}

interface ChatFunction {
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
}

interface ChatToolCall {
  index?: number;
  id?: string;
  type?: string;
  function: ChatFunctionCall;
}

interface ChatFunctionCall {
  name?: string;
  arguments?: string;
}

interface ChatCompletionsResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: ChatUsage;
}

interface ChatChoice {
  index: number;
  message: {
    role: "assistant";
    content?: string | null;
    reasoning_content?: string;
    tool_calls?: ChatToolCall[];
  };
  finish_reason: string;
}

interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ChatCompletionsChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatChunkChoice[];
  usage?: ChatUsage;
}

interface ChatChunkChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string | null;
    reasoning_content?: string;
    tool_calls?: ChatToolCall[];
  };
  finish_reason: string | null;
}

// ========== Responses types (client-facing) ==========

interface ResponsesRequest {
  model: string;
  input: Array<ResponsesInputItem>;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: ResponsesTool[];
  include?: string[];
  store?: boolean;
  reasoning?: {
    effort?: string;
    summary?: string;
  };
  tool_choice?: unknown;
  service_tier?: string;
  instructions?: string;
}

interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: string | ResponsesContentPart[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

interface ResponsesContentPart {
  type: "input_text" | "output_text" | "input_image";
  text?: string;
  image_url?: string;
}

interface ResponsesTool {
  type: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
}

interface ResponsesResponse {
  id: string;
  object: string;
  model: string;
  status: string;
  output: ResponsesOutput[];
  usage?: ResponsesUsage;
  incomplete_details?: { reason?: string };
  error?: { code?: string; message?: string };
}

interface ResponsesOutput {
  type: string;
  id?: string;
  role?: string;
  content?: ResponsesContentPart[];
  status?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  summary?: Array<{ type?: string; text?: string }>;
}

interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
}

interface ResponsesStreamEvent {
  type: string;
  response?: ResponsesResponse;
  item?: ResponsesOutput;
  output_index?: number;
  content_index?: number;
  delta?: string;
  text?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  summary_index?: number;
  code?: string;
  param?: string;
  sequence_number?: number;
}

// ========== Stream state ==========

interface ChatToResponsesStreamState {
  id: string;
  model: string;
  created: number;
  sentCreated: boolean;
  messageOutputIndex: number;
  nextOutputIndex: number;
  chatToolIndexToOutputIndex: Map<number, number>;
  finalized: boolean;
  contentText: string;
  reasoningText: string;
  toolCalls: Array<{ id?: string; name?: string; arguments: string }>;
  usage?: ChatUsage;
}

// ========== Constants ==========

const DEFAULT_UPSTREAM_BASE_URL = "https://api.deepseek.com";
const encoder = new TextEncoder();

// ========== Fetch handler ==========

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(buildOptionsResponse(request, env), request, env);
    }

    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return withCors(
          jsonResponse({
            ok: true,
            name: "responses2deepseek-proxy",
            endpoints: ["/v1/models", "/v1/chat/completions", "/v1/responses"]
          }),
          request,
          env
        );
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return withCors(jsonResponse({ ok: true }), request, env);
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        return withCors(await handleModels(request, env), request, env);
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        return withCors(await handleChatCompletions(request, env, ctx), request, env);
      }

      if (request.method === "POST" && url.pathname === "/v1/responses") {
        return withCors(await handleResponses(request, env, ctx), request, env);
      }

      return withCors(
        openAIErrorResponse(404, "invalid_request_error", "Endpoint not found"),
        request,
        env
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      return withCors(openAIErrorResponse(500, "api_error", message), request, env);
    }
  }
};

// ========== Handlers ==========

async function handleModels(request: Request, env: Env): Promise<Response> {
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(joinUrl(getUpstreamBaseUrl(env), "/v1/models"), {
      method: "GET",
      headers: buildUpstreamHeaders(request)
    });
  } catch {
    return openAIErrorResponse(502, "api_error", "Failed to reach upstream models endpoint");
  }

  if (!upstreamResponse.ok) {
    return convertUpstreamErrorResponse(upstreamResponse);
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: { "content-type": contentType || "application/octet-stream" }
    });
  }

  const upstreamJson = await upstreamResponse.json();
  return jsonResponse(upstreamJson);
}

// Direct pass-through to upstream Chat Completions (no conversion)
async function handleChatCompletions(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return openAIErrorResponse(400, "invalid_request_error", "Request body must be valid JSON");
  }

  if (!isRecord(body)) {
    return openAIErrorResponse(400, "invalid_request_error", "Request body must be an object");
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(joinUrl(getUpstreamBaseUrl(env), "/v1/chat/completions"), {
      method: "POST",
      headers: buildUpstreamHeaders(request),
      body: JSON.stringify(body)
    });
  } catch {
    return openAIErrorResponse(502, "api_error", "Failed to reach upstream chat/completions endpoint");
  }

  if (!upstreamResponse.ok) {
    return convertUpstreamErrorResponse(upstreamResponse);
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      }
    });
  }

  const data = await upstreamResponse.json();
  return jsonResponse(data);
}

// Responses API → Chat Completions → DeepSeek
async function handleResponses(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return openAIErrorResponse(400, "invalid_request_error", "Request body must be valid JSON");
  }

  if (!isRecord(body)) {
    return openAIErrorResponse(400, "invalid_request_error", "Request body must be an object");
  }

  const responsesRequest = body as unknown as ResponsesRequest;
  if (!responsesRequest.model || typeof responsesRequest.model !== "string") {
    return openAIErrorResponse(400, "invalid_request_error", "model is required");
  }
  if (!Array.isArray(responsesRequest.input) || responsesRequest.input.length === 0) {
    return openAIErrorResponse(400, "invalid_request_error", "input must be a non-empty array");
  }

  let chatRequest: ChatCompletionsRequest;
  try {
    chatRequest = responsesToChatCompletionsRequest(responsesRequest);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to map request";
    return openAIErrorResponse(400, "invalid_request_error", message);
  }

  // Always request streaming from upstream so we have a single code path
  chatRequest.stream = true;
  chatRequest.stream_options = { include_usage: true };

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(joinUrl(getUpstreamBaseUrl(env), "/v1/chat/completions"), {
      method: "POST",
      headers: buildUpstreamHeaders(request),
      body: JSON.stringify(chatRequest)
    });
  } catch {
    return openAIErrorResponse(502, "api_error", "Failed to reach upstream chat/completions endpoint");
  }

  if (!upstreamResponse.ok) {
    return convertUpstreamErrorResponse(upstreamResponse);
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? "";

  if (responsesRequest.stream) {
    if (!upstreamResponse.body) {
      return openAIErrorResponse(502, "api_error", "Upstream stream body is empty");
    }
    return streamChatToResponses(upstreamResponse.body, responsesRequest.model, ctx);
  }

  // Non-streaming: collect the upstream stream, build a single response
  if (contentType.includes("application/json")) {
    const chatJson = (await upstreamResponse.json()) as ChatCompletionsResponse;
    return jsonResponse(chatCompletionToResponsesResponse(chatJson, responsesRequest.model));
  }

  if (!upstreamResponse.body) {
    return openAIErrorResponse(502, "api_error", "Upstream response body is empty");
  }

  const responsesJson = await collectResponsesFromChatStream(upstreamResponse.body, responsesRequest.model);
  return jsonResponse(responsesJson);
}

// ========== Request conversion: Responses → Chat Completions ==========

function responsesToChatCompletionsRequest(req: ResponsesRequest): ChatCompletionsRequest {
  const out: ChatCompletionsRequest = {
    model: req.model,
    messages: convertResponsesInputToChatMessages(req.input)
  };

  if (typeof req.max_output_tokens === "number") {
    out.max_tokens = req.max_output_tokens;
  }
  if (typeof req.temperature === "number") {
    out.temperature = req.temperature;
  }
  if (typeof req.top_p === "number") {
    out.top_p = req.top_p;
  }
  if (req.reasoning?.effort) {
    out.reasoning_effort = req.reasoning.effort;
  }
  if (req.service_tier) {
    out.service_tier = req.service_tier;
  }

  // Merge system instructions into messages
  if (req.instructions) {
    out.messages.unshift({ role: "system", content: req.instructions });
  }

  const tools = convertResponsesTools(req.tools);
  if (tools.length > 0) {
    out.tools = tools;
  }
  if (req.tool_choice !== undefined) {
    out.tool_choice = req.tool_choice;
  }

  return out;
}

function convertResponsesInputToChatMessages(input: ResponsesInputItem[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pendingAssistant: ChatMessage | null = null;

  function flushAssistant() {
    if (pendingAssistant) {
      if (!pendingAssistant.content && (pendingAssistant.tool_calls?.length ?? 0) === 0) {
        pendingAssistant.content = "";
      }
      messages.push(pendingAssistant);
      pendingAssistant = null;
    }
  }

  for (const item of input) {
    if (item.role === "system") {
      flushAssistant();
      messages.push({ role: "system", content: coerceInputContent(item.content) });
    } else if (item.role === "user") {
      flushAssistant();
      messages.push({ role: "user", content: coerceInputContent(item.content) });
    } else if (item.role === "assistant") {
      if (!pendingAssistant) {
        pendingAssistant = { role: "assistant", content: "", tool_calls: [] };
      }
      const text = extractTextFromContent(item.content);
      if (text) {
        pendingAssistant.content = (pendingAssistant.content || "") + text;
      }
    } else if (item.type === "function_call") {
      if (!pendingAssistant) {
        pendingAssistant = { role: "assistant", content: "", tool_calls: [] };
      }
      (pendingAssistant.tool_calls ??= []).push({
        id: item.call_id || generateId("call"),
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments ?? "{}"
        }
      });
    } else if (item.type === "function_call_output") {
      flushAssistant();
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || "",
        content: item.output ?? ""
      });
    }
  }

  flushAssistant();
  return messages;
}

function convertResponsesTools(tools?: ResponsesTool[]): ChatTool[] {
  const out: ChatTool[] = [];
  for (const t of tools ?? []) {
    if (t.type !== "function" || !t.name) continue;
    out.push({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: t.strict
      }
    });
  }
  return out;
}

// ========== Response conversion: Chat Completions → Responses (non-streaming) ==========

function chatCompletionToResponsesResponse(
  completion: ChatCompletionsResponse,
  requestedModel: string
): ResponsesResponse {
  const output: ResponsesOutput[] = [];
  const choice = completion.choices?.[0];

  if (choice) {
    // Reasoning content
    if (choice.message.reasoning_content) {
      output.push({
        type: "reasoning",
        summary: [{
          type: "summary_text",
          text: choice.message.reasoning_content
        }]
      });
    }

    // Text content
    if (choice.message.content) {
      output.push({
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: choice.message.content
        }]
      });
    }

    // Tool calls
    for (const tc of choice.message.tool_calls ?? []) {
      output.push({
        type: "function_call",
        call_id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments ?? "{}"
      });
    }
  }

  return {
    id: completion.id || generateId("resp"),
    object: "response",
    model: requestedModel,
    status: finishReasonToStatus(choice?.finish_reason ?? "stop"),
    output,
    usage: completion.usage ? mapChatUsageToResponsesUsage(completion.usage) : undefined
  };
}

// ========== Response conversion: Chat SSE → Responses SSE (streaming) ==========

function createResponsesStreamState(model: string): ChatToResponsesStreamState {
  return {
    id: generateId("resp"),
    model,
    created: Math.floor(Date.now() / 1000),
    sentCreated: false,
    messageOutputIndex: -1,
    nextOutputIndex: 0,
    chatToolIndexToOutputIndex: new Map(),
    finalized: false,
    contentText: "",
    reasoningText: "",
    toolCalls: []
  };
}

function convertChatChunkToResponsesEvents(
  chunk: ChatCompletionsChunk,
  state: ChatToResponsesStreamState
): ResponsesStreamEvent[] {
  const choice = chunk.choices?.[0];
  if (!choice) {
    // Usage-only chunk (when stream_options.include_usage is set)
    if (chunk.usage) {
      state.usage = chunk.usage;
    }
    return [];
  }

  const events: ResponsesStreamEvent[] = [];

  // Ensure response.created is sent first
  if (!state.sentCreated) {
    state.sentCreated = true;
    state.id = chunk.id || state.id;
    state.model = chunk.model || state.model;
    state.created = chunk.created || state.created;
    events.push(makeCreatedEvent(state));
  }

  // Text content
  if (choice.delta?.content) {
    const delta = choice.delta.content;
    state.contentText += delta;

    if (state.messageOutputIndex === -1) {
      state.messageOutputIndex = state.nextOutputIndex++;
      events.push(makeMessageItemAddedEvent(state.messageOutputIndex));
    }

    events.push({
      type: "response.output_text.delta",
      output_index: state.messageOutputIndex,
      content_index: 0,
      delta
    });
  }

  // Reasoning content
  if (choice.delta?.reasoning_content) {
    const delta = choice.delta.reasoning_content;
    state.reasoningText += delta;
    events.push({
      type: "response.reasoning_summary_text.delta",
      delta
    });
  }

  // Tool calls
  if (choice.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      if (tc.index === undefined) continue;

      const hasId = !!tc.id;
      const hasArgs = tc.function?.arguments !== undefined && tc.function.arguments !== "";

      if (hasId) {
        // New tool call declared
        const outputIndex = state.nextOutputIndex++;
        state.chatToolIndexToOutputIndex.set(tc.index, outputIndex);
        state.toolCalls[tc.index] = {
          id: tc.id,
          name: tc.function?.name,
          arguments: ""
        };

        events.push({
          type: "response.output_item.added",
          output_index: outputIndex,
          item: {
            type: "function_call",
            call_id: tc.id,
            name: tc.function?.name,
            arguments: ""
          }
        });

        // Some APIs send name and first arguments in the same chunk
        if (tc.function?.arguments) {
          state.toolCalls[tc.index].arguments = tc.function.arguments;
          events.push({
            type: "response.function_call_arguments.delta",
            output_index: outputIndex,
            delta: tc.function.arguments
          });
        }
      } else if (hasArgs) {
        // Arguments delta for existing tool call
        const outputIndex = state.chatToolIndexToOutputIndex.get(tc.index);
        if (outputIndex !== undefined) {
          state.toolCalls[tc.index] = state.toolCalls[tc.index] ?? { id: "", name: "", arguments: "" };
          state.toolCalls[tc.index].arguments += tc.function.arguments;
          events.push({
            type: "response.function_call_arguments.delta",
            output_index: outputIndex,
            delta: tc.function.arguments
          });
        }
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    if (chunk.usage) {
      state.usage = chunk.usage;
    }
    state.finalized = true;
    events.push(makeCompletedEvent(state, choice.finish_reason));
  }

  return events;
}

function makeCreatedEvent(state: ChatToResponsesStreamState): ResponsesStreamEvent {
  return {
    type: "response.created",
    response: {
      id: state.id,
      object: "response",
      model: state.model,
      status: "in_progress",
      output: []
    }
  };
}

function makeMessageItemAddedEvent(outputIndex: number): ResponsesStreamEvent {
  return {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: {
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: []
    }
  };
}

function makeCompletedEvent(
  state: ChatToResponsesStreamState,
  finishReason: string
): ResponsesStreamEvent {
  const output: ResponsesOutput[] = [];

  // Reasoning
  if (state.reasoningText) {
    output.push({
      type: "reasoning",
      summary: [{ type: "summary_text", text: state.reasoningText }]
    });
  }

  // Text message
  if (state.contentText && state.messageOutputIndex >= 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: state.contentText }]
    });
  } else if (state.messageOutputIndex >= 0) {
    // Message item was added but no text came (edge case)
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: state.contentText }]
    });
  }

  // Tool calls
  for (let i = 0; i < state.toolCalls.length; i++) {
    const tc = state.toolCalls[i];
    if (tc) {
      output.push({
        type: "function_call",
        call_id: tc.id,
        name: tc.name,
        arguments: tc.arguments || "{}"
      });
    }
  }

  const status = finishReasonToStatus(finishReason);
  const incompleteDetails: { reason?: string } | undefined =
    finishReason === "length" ? { reason: "max_output_tokens" } : undefined;

  return {
    type: status === "completed" ? "response.completed" : `response.${status}`,
    response: {
      id: state.id,
      object: "response",
      model: state.model,
      status,
      output,
      usage: state.usage ? mapChatUsageToResponsesUsage(state.usage) : undefined,
      ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {})
    }
  };
}

async function streamChatToResponses(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string,
  ctx: ExecutionContext
): Promise<Response> {
  const state = createResponsesStreamState(model);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  ctx.waitUntil(
    (async () => {
      try {
        for await (const sse of iterateSseEvents(upstreamBody)) {
          if (sse.data === "[DONE]") break;

          const chunk = parseChatChunk(sse.data);
          if (!chunk) continue;

          const events = convertChatChunkToResponsesEvents(chunk, state);
          for (const event of events) {
            await writer.write(encodeResponsesSseEvent(event));
          }
        }

        if (!state.finalized) {
          for (const event of finalizeResponsesStreamState(state)) {
            await writer.write(encodeResponsesSseEvent(event));
          }
        }

        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        if (!state.finalized) {
          for (const event of finalizeResponsesStreamState(state)) {
            await writer.write(encodeResponsesSseEvent(event));
          }
          await writer.write(encoder.encode("data: [DONE]\n\n"));
        }
        console.error("streamChatToResponses failed", error);
      } finally {
        await writer.close();
      }
    })()
  );

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    }
  });
}

async function collectResponsesFromChatStream(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string
): Promise<ResponsesResponse> {
  const state = createResponsesStreamState(model);
  let lastCompletionResponse: ChatCompletionsResponse | undefined;

  for await (const sse of iterateSseEvents(upstreamBody)) {
    if (sse.data === "[DONE]") break;

    const chunk = parseChatChunk(sse.data);
    if (!chunk) continue;

    // Accumulate for building response
    if (chunk.usage) {
      state.usage = chunk.usage;
    }

    const choice = chunk.choices?.[0];
    if (choice) {
      if (!state.sentCreated) {
        state.sentCreated = true;
        state.id = chunk.id || state.id;
        state.model = chunk.model || state.model;
        state.created = chunk.created || state.created;
      }
      if (choice.delta?.content) {
        state.contentText += choice.delta.content;
        if (state.messageOutputIndex === -1) {
          state.messageOutputIndex = state.nextOutputIndex++;
        }
      }
      if (choice.delta?.reasoning_content) {
        state.reasoningText += choice.delta.reasoning_content;
      }
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (tc.index === undefined) continue;
          if (tc.id) {
            state.chatToolIndexToOutputIndex.set(tc.index, state.nextOutputIndex++);
            state.toolCalls[tc.index] = { id: tc.id, name: tc.function?.name, arguments: "" };
          }
          if (tc.function?.arguments && tc.index !== undefined) {
            state.toolCalls[tc.index] = state.toolCalls[tc.index] ?? { id: "", name: "", arguments: "" };
            state.toolCalls[tc.index].arguments += tc.function.arguments;
          }
        }
      }
      if (choice.finish_reason) {
        state.finalized = true;
        lastCompletionResponse = buildChatCompletionFromState(state, choice.finish_reason);
      }
    }
  }

  if (lastCompletionResponse) {
    return chatCompletionToResponsesResponse(lastCompletionResponse, model);
  }

  return buildResponsesFromState(state, model);
}

function buildChatCompletionFromState(
  state: ChatToResponsesStreamState,
  finishReason: string
): ChatCompletionsResponse {
  const toolCalls: ChatToolCall[] = state.toolCalls
    .map((tc, i) => ({
      index: i,
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments }
    }))
    .filter(tc => tc.function.name || tc.function.arguments);

  const message: ChatChoice["message"] = { role: "assistant" };
  if (state.contentText) message.content = state.contentText;
  if (state.reasoningText) message.reasoning_content = state.reasoningText;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: state.id,
    object: "chat.completion",
    created: state.created || Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: state.usage
  };
}

function buildResponsesFromState(
  state: ChatToResponsesStreamState,
  model: string
): ResponsesResponse {
  return chatCompletionToResponsesResponse(
    buildChatCompletionFromState(state, state.finalized ? "stop" : "stop"),
    model
  );
}

function finalizeResponsesStreamState(state: ChatToResponsesStreamState): ResponsesStreamEvent[] {
  if (state.finalized) return [];
  state.finalized = true;
  return [makeCompletedEvent(state, "stop")];
}

// ========== SSE utilities ==========

async function* iterateSseEvents(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<{ event: string; data: string }, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSseEvent(rawEvent);
        if (event) yield event;
        idx = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, "\n");
    const event = parseSseEvent(buffer);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(rawEvent: string): { event: string; data: string } | null {
  if (!rawEvent.trim()) return null;

  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of rawEvent.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return null;
  return { event: eventName, data: dataLines.join("\n") };
}

function parseChatChunk(data: string): ChatCompletionsChunk | null {
  try {
    return JSON.parse(data) as ChatCompletionsChunk;
  } catch {
    return null;
  }
}

function encodeResponsesSseEvent(event: ResponsesStreamEvent): Uint8Array {
  const eventName = event.type;
  const data = JSON.stringify(event);
  return encoder.encode(`event: ${eventName}\ndata: ${data}\n\n`);
}

// ========== Field mapping ==========

function mapChatUsageToResponsesUsage(usage: ChatUsage): ResponsesUsage {
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    input_tokens_details:
      usage.prompt_tokens_details?.cached_tokens !== undefined
        ? { cached_tokens: usage.prompt_tokens_details.cached_tokens }
        : undefined
  };
}

function finishReasonToStatus(reason: string): string {
  switch (reason) {
    case "stop":
    case "tool_calls":
      return "completed";
    case "length":
      return "incomplete";
    default:
      return "completed";
  }
}

// ========== Content extraction helpers ==========

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const p of content as ResponsesContentPart[]) {
    if ((p.type === "output_text" || p.type === "input_text") && typeof p.text === "string") {
      parts.push(p.text);
    }
  }
  return parts.join("");
}

function coerceInputContent(content: unknown): string | ChatContentPart[] {
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return typeof content === "object" && content !== null
    ? JSON.stringify(content)
    : String(content ?? "");

  const parts: ChatContentPart[] = [];
  for (const p of content as ResponsesContentPart[]) {
    if (p.type === "input_text" && typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "input_image" && typeof p.image_url === "string") {
      parts.push({ type: "image_url", image_url: p.image_url });
    }
  }

  return parts.length > 0 ? parts : "";
}

// ========== CORS ==========

function buildOptionsResponse(request: Request, env: Env): Response {
  return new Response(null, { status: 204, headers: buildCorsHeaders(request, env) });
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  buildCorsHeaders(request, env).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function buildCorsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const configured = env.ALLOWED_ORIGIN?.trim() || "*";
  const requestOrigin = request.headers.get("origin");

  if (configured === "*") {
    headers.set("access-control-allow-origin", "*");
  } else {
    const allowed = configured.split(",").map(o => o.trim()).filter(Boolean);
    const origin = requestOrigin && allowed.includes(requestOrigin) ? requestOrigin : allowed[0];
    if (origin) {
      headers.set("access-control-allow-origin", origin);
      headers.append("vary", "Origin");
    }
  }

  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type,x-api-key,x-goog-api-key");
  headers.set("access-control-max-age", "86400");
  return headers;
}

// ========== Error handling ==========

async function convertUpstreamErrorResponse(response: Response): Promise<Response> {
  const fallbackType = mapStatusToOpenAIErrorType(response.status);
  const fallbackMessage = `Upstream request failed with status ${response.status}`;

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    payload = undefined;
  }

  if (isRecord(payload)) {
    if (isRecord(payload.error)) {
      const message = typeof payload.error.message === "string" ? payload.error.message : fallbackMessage;
      const type = typeof payload.error.type === "string" ? payload.error.type : fallbackType;
      const code = typeof payload.error.code === "string" ? payload.error.code : undefined;
      return openAIErrorResponse(response.status, type, message, code);
    }
    const message = typeof payload.message === "string" ? payload.message : fallbackMessage;
    const code = typeof payload.code === "string" ? payload.code : undefined;
    return openAIErrorResponse(response.status, fallbackType, message, code);
  }

  const text = await response.text();
  return openAIErrorResponse(response.status, fallbackType, text || fallbackMessage);
}

function openAIErrorResponse(
  status: number,
  type: string,
  message: string,
  code?: string
): Response {
  return jsonResponse(
    { error: { message, type, param: null, code: code ?? null } },
    status
  );
}

function mapStatusToOpenAIErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}

// ========== General utilities ==========

function getUpstreamBaseUrl(env: Env): string {
  return (env.UPSTREAM_BASE_URL?.trim() || DEFAULT_UPSTREAM_BASE_URL).replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildUpstreamHeaders(request: Request): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");

  const authorization = request.headers.get("authorization");
  const xApiKey = request.headers.get("x-api-key");
  const xGoogApiKey = request.headers.get("x-goog-api-key");

  if (authorization) headers.set("authorization", authorization);
  if (xApiKey) headers.set("x-api-key", xApiKey);
  if (xGoogApiKey) headers.set("x-goog-api-key", xGoogApiKey);

  headers.set("user-agent", request.headers.get("user-agent") || "responses2deepseek-proxy/0.2.0");
  return headers;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
