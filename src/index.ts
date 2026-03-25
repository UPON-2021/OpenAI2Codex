interface Env {
  UPSTREAM_BASE_URL?: string;
  ALLOWED_ORIGIN?: string;
}

interface ModelCard {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  [key: string]: unknown;
}

interface ModelListResponse {
  object: string;
  data: ModelCard[];
  [key: string]: unknown;
}

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
  service_tier?: string;
  functions?: ChatFunction[];
  function_call?: unknown;
}

interface ChatMessage {
  role: string;
  content?: unknown;
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
  image_url?: {
    url?: string;
  } | string;
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
    content?: string;
    reasoning_content?: string;
    tool_calls?: ChatToolCall[];
  };
  finish_reason: string;
}

interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
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
    content?: string;
    reasoning_content?: string;
    tool_calls?: ChatToolCall[];
  };
  finish_reason: string | null;
}

interface ResponsesRequest {
  model: string;
  input: Array<ResponsesInputItem>;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream: true;
  tools?: ResponsesTool[];
  include?: string[];
  store?: boolean;
  reasoning?: {
    effort: string;
    summary?: string;
  };
  tool_choice?: unknown;
  service_tier?: string;
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
  incomplete_details?: {
    reason?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
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
  summary?: Array<{
    type?: string;
    text?: string;
  }>;
}

interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
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

interface ChatStreamState {
  id: string;
  model: string;
  created: number;
  sentRole: boolean;
  sawToolCall: boolean;
  finalized: boolean;
  nextToolCallIndex: number;
  outputIndexToToolIndex: Map<number, number>;
  includeUsage: boolean;
  usage?: ChatUsage;
  contentText: string;
  reasoningText: string;
  toolCalls: Array<{
    id?: string;
    name?: string;
    arguments: string;
  }>;
  finishReason: string;
}

const DEFAULT_UPSTREAM_BASE_URL = "";
const encoder = new TextEncoder();

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
            name: "hypergryph-openai-compat-proxy",
            endpoints: ["/v1/models", "/v1/chat/completions"]
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

async function handleModels(request: Request, env: Env): Promise<Response> {
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(joinUrl(getUpstreamBaseUrl(env), "/v1/models"), {
      method: "GET",
      headers: buildUpstreamHeaders(request)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reach upstream models endpoint";
    return openAIErrorResponse(502, "api_error", message);
  }

  if (!upstreamResponse.ok) {
    return convertUpstreamErrorResponse(upstreamResponse);
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: {
        "content-type": contentType || "application/octet-stream"
      }
    });
  }

  const upstreamJson = (await upstreamResponse.json()) as ModelListResponse;
  return jsonResponse(upstreamJson);
}

async function handleChatCompletions(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return openAIErrorResponse(400, "invalid_request_error", "Request body must be valid JSON");
  }

  if (!isRecord(body)) {
    return openAIErrorResponse(400, "invalid_request_error", "Request body must be an object");
  }

  const chatRequest = body as ChatCompletionsRequest;
  if (!chatRequest.model || typeof chatRequest.model !== "string") {
    return openAIErrorResponse(400, "invalid_request_error", "model is required");
  }
  if (!Array.isArray(chatRequest.messages) || chatRequest.messages.length === 0) {
    return openAIErrorResponse(400, "invalid_request_error", "messages must be a non-empty array");
  }
  if (typeof chatRequest.n === "number" && chatRequest.n !== 1) {
    return openAIErrorResponse(400, "invalid_request_error", "Only n=1 is supported");
  }

  const requestedModel = chatRequest.model;

  let responsesRequest: ResponsesRequest;
  try {
    responsesRequest = chatCompletionsToResponses(chatRequest, requestedModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to map request";
    return openAIErrorResponse(400, "invalid_request_error", message);
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(joinUrl(getUpstreamBaseUrl(env), "/v1/responses"), {
      method: "POST",
      headers: buildUpstreamHeaders(request),
      body: JSON.stringify(responsesRequest)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reach upstream responses endpoint";
    return openAIErrorResponse(502, "api_error", message);
  }

  if (!upstreamResponse.ok) {
    return convertUpstreamErrorResponse(upstreamResponse);
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  if (chatRequest.stream) {
    if (!upstreamResponse.body) {
      return openAIErrorResponse(502, "api_error", "Upstream stream body is empty");
    }
    return streamResponsesToChat(upstreamResponse.body, requestedModel, chatRequest, ctx);
  }

  if (contentType.includes("application/json")) {
    const responseJson = (await upstreamResponse.json()) as ResponsesResponse;
    return jsonResponse(responsesToChatCompletions(responseJson, requestedModel));
  }

  if (!upstreamResponse.body) {
    return openAIErrorResponse(502, "api_error", "Upstream response body is empty");
  }

  const completion = await collectChatCompletionFromStream(
    upstreamResponse.body,
    requestedModel,
    Boolean(chatRequest.stream_options?.include_usage)
  );
  return jsonResponse(completion);
}

function chatCompletionsToResponses(
  request: ChatCompletionsRequest,
  upstreamModel: string
): ResponsesRequest {
  const input = convertChatMessagesToResponsesInput(request.messages);
  const out: ResponsesRequest = {
    model: upstreamModel,
    input,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"]
  };

  if (typeof request.max_completion_tokens === "number") {
    out.max_output_tokens = request.max_completion_tokens;
  } else if (typeof request.max_tokens === "number") {
    out.max_output_tokens = request.max_tokens;
  }
  if (typeof request.temperature === "number") {
    out.temperature = request.temperature;
  }
  if (typeof request.top_p === "number") {
    out.top_p = request.top_p;
  }
  if (request.reasoning_effort) {
    out.reasoning = {
      effort: request.reasoning_effort,
      summary: "auto"
    };
  }
  if (request.service_tier) {
    out.service_tier = request.service_tier;
  }

  const tools = convertChatTools(request.tools, request.functions);
  if (tools.length > 0) {
    out.tools = tools;
  }
  if (request.tool_choice !== undefined) {
    out.tool_choice = request.tool_choice;
  } else if (request.function_call !== undefined) {
    out.tool_choice = request.function_call;
  }

  return out;
}

function convertChatMessagesToResponsesInput(messages: ChatMessage[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "user":
        items.push({
          role: message.role,
          content: convertUserFacingContent(message.content)
        });
        break;
      case "assistant":
        items.push(...convertAssistantMessage(message));
        break;
      case "tool":
        items.push({
          type: "function_call_output",
          call_id: message.tool_call_id || message.name || crypto.randomUUID(),
          output: coerceText(message.content)
        });
        break;
      case "function":
        items.push({
          type: "function_call_output",
          call_id: message.name || crypto.randomUUID(),
          output: coerceText(message.content)
        });
        break;
      default:
        items.push({
          role: "user",
          content: convertUserFacingContent(message.content)
        });
        break;
    }
  }

  return items;
}

function convertAssistantMessage(message: ChatMessage): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const assistantText = coerceAssistantText(message);

  if (assistantText) {
    items.push({
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: assistantText
        }
      ]
    });
  }

  const toolCalls = [...(message.tool_calls ?? [])];
  if (message.function_call) {
    toolCalls.push({
      id: message.name || crypto.randomUUID(),
      type: "function",
      function: message.function_call
    });
  }

  for (const toolCall of toolCalls) {
    items.push({
      type: "function_call",
      call_id: toolCall.id || crypto.randomUUID(),
      name: toolCall.function?.name || "unknown_function",
      arguments: toolCall.function?.arguments || "{}"
    });
  }

  return items;
}

function convertUserFacingContent(content: unknown): string | ResponsesContentPart[] {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return coerceText(content);
  }

  const parts: ResponsesContentPart[] = [];
  for (const part of content as ChatContentPart[]) {
    if (!isRecord(part) || typeof part.type !== "string") {
      continue;
    }

    if (
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string"
    ) {
      parts.push({
        type: "input_text",
        text: part.text
      });
      continue;
    }

    if (part.type === "image_url" || part.type === "input_image") {
      const imageUrl = extractImageUrl(part.image_url);
      if (imageUrl) {
        parts.push({
          type: "input_image",
          image_url: imageUrl
        });
      }
    }
  }

  return parts.length > 0 ? parts : coerceText(content);
}

function convertChatTools(tools?: ChatTool[], functions?: ChatFunction[]): ResponsesTool[] {
  const out: ResponsesTool[] = [];

  for (const tool of tools ?? []) {
    if (tool.type !== "function" || !tool.function?.name) {
      continue;
    }
    out.push({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: tool.function.strict
    });
  }

  for (const func of functions ?? []) {
    if (!func.name) {
      continue;
    }
    out.push({
      type: "function",
      name: func.name,
      description: func.description,
      parameters: func.parameters,
      strict: func.strict
    });
  }

  return out;
}

function responsesToChatCompletions(
  response: ResponsesResponse,
  requestedModel: string
): ChatCompletionsResponse {
  let content = "";
  let reasoningContent = "";
  const toolCalls: ChatToolCall[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) {
          content += part.text;
        }
      }
      continue;
    }

    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments ?? "{}"
        }
      });
      continue;
    }

    if (item.type === "reasoning") {
      for (const summary of item.summary ?? []) {
        if (summary.type === "summary_text" && summary.text) {
          reasoningContent += summary.text;
        }
      }
    }
  }

  const message: ChatChoice["message"] = {
    role: "assistant"
  };
  if (content) {
    message.content = content;
  }
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: response.id || generateChatCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: responsesStatusToFinishReason(
          response.status,
          response.incomplete_details?.reason,
          toolCalls.length > 0
        )
      }
    ],
    usage: response.usage ? mapUsage(response.usage) : undefined
  };
}

function createStreamState(model: string, includeUsage: boolean): ChatStreamState {
  return {
    id: generateChatCompletionId(),
    model,
    created: Math.floor(Date.now() / 1000),
    sentRole: false,
    sawToolCall: false,
    finalized: false,
    nextToolCallIndex: 0,
    outputIndexToToolIndex: new Map<number, number>(),
    includeUsage,
    contentText: "",
    reasoningText: "",
    toolCalls: [],
    finishReason: "stop"
  };
}

function convertResponsesEventToChatChunks(
  event: ResponsesStreamEvent,
  state: ChatStreamState
): ChatCompletionsChunk[] {
  switch (event.type) {
    case "response.created":
      if (event.response?.id) {
        state.id = event.response.id;
      }
      return ensureRoleChunk(state);
    case "response.output_text.delta":
      return handleTextDelta(event, state);
    case "response.output_item.added":
      return handleOutputItemAdded(event, state);
    case "response.function_call_arguments.delta":
      return handleFunctionArgumentsDelta(event, state);
    case "response.reasoning_summary_text.delta":
      return handleReasoningDelta(event, state);
    case "response.completed":
    case "response.incomplete":
    case "response.failed":
      return handleCompletedEvent(event, state);
    default:
      return [];
  }
}

function ensureRoleChunk(state: ChatStreamState): ChatCompletionsChunk[] {
  if (state.sentRole) {
    return [];
  }
  state.sentRole = true;
  return [makeDeltaChunk(state, { role: "assistant" })];
}

function handleTextDelta(
  event: ResponsesStreamEvent,
  state: ChatStreamState
): ChatCompletionsChunk[] {
  if (!event.delta) {
    return [];
  }
  state.contentText += event.delta;
  return [...ensureRoleChunk(state), makeDeltaChunk(state, { content: event.delta })];
}

function handleOutputItemAdded(
  event: ResponsesStreamEvent,
  state: ChatStreamState
): ChatCompletionsChunk[] {
  if (event.item?.type !== "function_call") {
    return [];
  }

  state.sawToolCall = true;
  const toolIndex = state.nextToolCallIndex++;
  const outputIndex = typeof event.output_index === "number" ? event.output_index : toolIndex;
  state.outputIndexToToolIndex.set(outputIndex, toolIndex);
  state.toolCalls[toolIndex] = {
    id: event.item.call_id,
    name: event.item.name,
    arguments: ""
  };

  return [
    ...ensureRoleChunk(state),
    makeDeltaChunk(state, {
      tool_calls: [
        {
          index: toolIndex,
          id: event.item.call_id,
          type: "function",
          function: {
            name: event.item.name,
            arguments: ""
          }
        }
      ]
    })
  ];
}

function handleFunctionArgumentsDelta(
  event: ResponsesStreamEvent,
  state: ChatStreamState
): ChatCompletionsChunk[] {
  if (!event.delta || typeof event.output_index !== "number") {
    return [];
  }

  const toolIndex = state.outputIndexToToolIndex.get(event.output_index);
  if (toolIndex === undefined) {
    return [];
  }

  state.toolCalls[toolIndex] = state.toolCalls[toolIndex] ?? {
    id: event.call_id,
    name: event.name,
    arguments: ""
  };
  state.toolCalls[toolIndex].arguments += event.delta;

  return [
    makeDeltaChunk(state, {
      tool_calls: [
        {
          index: toolIndex,
          function: {
            arguments: event.delta
          }
        }
      ]
    })
  ];
}

function handleReasoningDelta(
  event: ResponsesStreamEvent,
  state: ChatStreamState
): ChatCompletionsChunk[] {
  if (!event.delta) {
    return [];
  }
  state.reasoningText += event.delta;
  return [
    ...ensureRoleChunk(state),
    makeDeltaChunk(state, {
      reasoning_content: event.delta
    })
  ];
}

function handleCompletedEvent(
  event: ResponsesStreamEvent,
  state: ChatStreamState
): ChatCompletionsChunk[] {
  if (state.finalized) {
    return [];
  }

  state.finalized = true;
  state.finishReason = "stop";

  if (event.response?.usage) {
    state.usage = mapUsage(event.response.usage);
  }

  if (event.response) {
    state.finishReason = responsesStatusToFinishReason(
      event.response.status,
      event.response.incomplete_details?.reason,
      state.sawToolCall
    );
  } else if (state.sawToolCall) {
    state.finishReason = "tool_calls";
  }

  const chunks: ChatCompletionsChunk[] = [makeFinishChunk(state, state.finishReason)];
  if (state.includeUsage && state.usage) {
    chunks.push({
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [],
      usage: state.usage
    });
  }

  return chunks;
}

function makeDeltaChunk(
  state: ChatStreamState,
  delta: ChatChunkChoice["delta"]
): ChatCompletionsChunk {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null
      }
    ]
  };
}

function makeFinishChunk(
  state: ChatStreamState,
  finishReason: string
): ChatCompletionsChunk {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason
      }
    ]
  };
}

async function streamResponsesToChat(
  upstreamBody: ReadableStream<Uint8Array>,
  requestedModel: string,
  request: ChatCompletionsRequest,
  ctx: ExecutionContext
): Promise<Response> {
  const state = createStreamState(requestedModel, Boolean(request.stream_options?.include_usage));
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  ctx.waitUntil(
    (async () => {
      try {
        for await (const sse of iterateSseEvents(upstreamBody)) {
          if (sse.data === "[DONE]") {
            break;
          }

          const event = parseResponsesStreamEvent(sse.data);
          if (!event) {
            continue;
          }

          const chunks = convertResponsesEventToChatChunks(event, state);
          for (const chunk of chunks) {
            await writer.write(encodeSseData(chunk));
          }
        }

        if (!state.finalized) {
          for (const chunk of finalizeStreamState(state)) {
            await writer.write(encodeSseData(chunk));
          }
        }

        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        if (!state.finalized) {
          for (const chunk of finalizeStreamState(state)) {
            await writer.write(encodeSseData(chunk));
          }
          await writer.write(encoder.encode("data: [DONE]\n\n"));
        }
        console.error("streamResponsesToChat failed", error);
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

async function collectChatCompletionFromStream(
  upstreamBody: ReadableStream<Uint8Array>,
  requestedModel: string,
  includeUsage: boolean
): Promise<ChatCompletionsResponse> {
  const state = createStreamState(requestedModel, includeUsage);
  let finalResponse: ResponsesResponse | undefined;

  for await (const sse of iterateSseEvents(upstreamBody)) {
    if (sse.data === "[DONE]") {
      break;
    }

    const event = parseResponsesStreamEvent(sse.data);
    if (!event) {
      continue;
    }

    if (
      (event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed") &&
      event.response
    ) {
      finalResponse = event.response;
    }

    convertResponsesEventToChatChunks(event, state);
  }

  if (finalResponse) {
    return responsesToChatCompletions(finalResponse, requestedModel);
  }

  return buildCompletionFromState(state);
}

function buildCompletionFromState(state: ChatStreamState): ChatCompletionsResponse {
  const toolCalls: ChatToolCall[] = state.toolCalls
    .map((toolCall, index) => ({
      index,
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments
      }
    }))
    .filter((toolCall) => toolCall.function.name || toolCall.function.arguments);

  const message: ChatChoice["message"] = {
    role: "assistant"
  };
  if (state.contentText) {
    message.content = state.contentText;
  }
  if (state.reasoningText) {
    message.reasoning_content = state.reasoningText;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: state.id,
    object: "chat.completion",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: state.finishReason || (toolCalls.length > 0 ? "tool_calls" : "stop")
      }
    ],
    usage: state.usage
  };
}

function finalizeStreamState(state: ChatStreamState): ChatCompletionsChunk[] {
  if (state.finalized) {
    return [];
  }

  state.finalized = true;
  state.finishReason = state.sawToolCall ? "tool_calls" : "stop";

  const chunks: ChatCompletionsChunk[] = [makeFinishChunk(state, state.finishReason)];
  if (state.includeUsage && state.usage) {
    chunks.push({
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [],
      usage: state.usage
    });
  }
  return chunks;
}

async function* iterateSseEvents(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<{ event: string; data: string }, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundaryIndex = buffer.indexOf("\n\n");
      while (boundaryIndex !== -1) {
        const rawEvent = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        const event = parseSseEvent(rawEvent);
        if (event) {
          yield event;
        }
        boundaryIndex = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, "\n");
    const event = parseSseEvent(buffer);
    if (event) {
      yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(rawEvent: string): { event: string; data: string } | null {
  if (!rawEvent.trim()) {
    return null;
  }

  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of rawEvent.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event: eventName,
    data: dataLines.join("\n")
  };
}

function parseResponsesStreamEvent(data: string): ResponsesStreamEvent | null {
  try {
    return JSON.parse(data) as ResponsesStreamEvent;
  } catch {
    return null;
  }
}

function encodeSseData(payload: ChatCompletionsChunk): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function mapUsage(usage: ResponsesUsage): ChatUsage {
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    prompt_tokens_details:
      usage.input_tokens_details?.cached_tokens !== undefined
        ? {
            cached_tokens: usage.input_tokens_details.cached_tokens
          }
        : undefined
  };
}

function responsesStatusToFinishReason(
  status: string,
  incompleteReason: string | undefined,
  sawToolCall: boolean
): string {
  if (status === "incomplete" && incompleteReason === "max_output_tokens") {
    return "length";
  }
  if (status === "completed" && sawToolCall) {
    return "tool_calls";
  }
  if (status === "failed") {
    return "stop";
  }
  return sawToolCall ? "tool_calls" : "stop";
}

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
      const message =
        typeof payload.error.message === "string" ? payload.error.message : fallbackMessage;
      const type =
        typeof payload.error.type === "string" ? payload.error.type : fallbackType;
      const code =
        typeof payload.error.code === "string" ? payload.error.code : undefined;
      return openAIErrorResponse(response.status, type, message, code);
    }

    const message = typeof payload.message === "string" ? payload.message : fallbackMessage;
    const code = typeof payload.code === "string" ? payload.code : undefined;
    return openAIErrorResponse(response.status, fallbackType, message, code);
  }

  const text = await response.text();
  return openAIErrorResponse(response.status, fallbackType, text || fallbackMessage);
}

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

  if (authorization) {
    headers.set("authorization", authorization);
  }
  if (xApiKey) {
    headers.set("x-api-key", xApiKey);
  }
  if (xGoogApiKey) {
    headers.set("x-goog-api-key", xGoogApiKey);
  }

  headers.set("user-agent", request.headers.get("user-agent") || "hypergryph-openai-compat-proxy/0.1.0");
  return headers;
}

function coerceAssistantText(message: ChatMessage): string {
  const parts: string[] = [];

  if (message.reasoning_content) {
    parts.push(`<thinking>${message.reasoning_content}</thinking>`);
  }

  if (typeof message.content === "string") {
    parts.push(message.content);
    return parts.join("");
  }

  if (!Array.isArray(message.content)) {
    if (message.content !== undefined && message.content !== null) {
      parts.push(coerceText(message.content));
    }
    return parts.join("");
  }

  for (const rawPart of message.content as ChatContentPart[]) {
    if (!isRecord(rawPart) || typeof rawPart.type !== "string") {
      continue;
    }

    if (
      (rawPart.type === "text" ||
        rawPart.type === "input_text" ||
        rawPart.type === "output_text") &&
      typeof rawPart.text === "string"
    ) {
      parts.push(rawPart.text);
      continue;
    }

    if (rawPart.type === "thinking" || rawPart.type === "reasoning") {
      const thinkingText =
        typeof rawPart.thinking === "string"
          ? rawPart.thinking
          : typeof rawPart.text === "string"
            ? rawPart.text
            : "";
      if (thinkingText) {
        parts.push(`<thinking>${thinkingText}</thinking>`);
      }
    }
  }

  return parts.join("");
}

function coerceText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const item of content as ChatContentPart[]) {
      if (!isRecord(item) || typeof item.type !== "string") {
        continue;
      }
      const recordItem = item as Record<string, unknown>;
      const thinking =
        typeof recordItem.thinking === "string" ? recordItem.thinking : undefined;
      if (
        (item.type === "text" ||
          item.type === "input_text" ||
          item.type === "output_text" ||
          item.type === "reasoning" ||
          item.type === "thinking") &&
        (typeof item.text === "string" || typeof thinking === "string")
      ) {
        textParts.push(
          typeof item.text === "string"
            ? item.text
            : typeof thinking === "string"
              ? thinking
              : ""
        );
      }
    }
    return textParts.join("");
  }

  if (content === null || content === undefined) {
    return "";
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function extractImageUrl(imageUrl: unknown): string | null {
  if (typeof imageUrl === "string" && imageUrl) {
    return imageUrl;
  }
  if (isRecord(imageUrl) && typeof imageUrl.url === "string" && imageUrl.url) {
    return imageUrl.url;
  }
  return null;
}

function buildOptionsResponse(request: Request, env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request, env)
  });
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
    const allowedOrigins = configured
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
    const origin =
      requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function openAIErrorResponse(
  status: number,
  type: string,
  message: string,
  code?: string
): Response {
  return jsonResponse(
    {
      error: {
        message,
        type,
        param: null,
        code: code ?? null
      }
    },
    status
  );
}

function mapStatusToOpenAIErrorType(status: number): string {
  if (status === 400) {
    return "invalid_request_error";
  }
  if (status === 401 || status === 403) {
    return "authentication_error";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  return "api_error";
}

function generateChatCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
}

function isTrue(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "TRUE";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
