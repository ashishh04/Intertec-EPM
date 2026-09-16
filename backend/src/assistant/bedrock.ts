import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  type Anthropic,
} from '@anthropic-ai/sdk';

import { env } from '../config/env.js';
import { EpmError } from '../lib/errors.js';
import type { AssistantStatus } from '../types/epm.js';

/**
 * Claude in Amazon Bedrock, streamed.
 *
 * The Mantle endpoint serves the Messages API at `/anthropic/v1/messages` over
 * ordinary SSE, so the SDK handles the wire: it reassembles a tool call whose
 * arguments arrived in fragments and hands back a whole message. That
 * stitching used to live here by hand; it is the SDK's job now, and the part
 * worth owning is what the rest of EPM sees — text as it arrives, then one
 * `end` event carrying the turn.
 *
 * Credentials never appear in this module. The SDK resolves them through the
 * usual AWS chain (environment, shared profile, assumed role, instance
 * metadata), which is what lets the same code run against a developer's access
 * key and a deployed task role without a branch. Errors from upstream are
 * mapped to a safe sentence; the raw body is kept on `upstream` for the log and
 * nowhere else.
 */

export type ChatMessage = Anthropic.MessageParam;
export type ChatTool = Anthropic.Tool;

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

/** A tool call, once the SDK has assembled every fragment of it. */
export interface CompletedToolCall {
  id: string;
  name: string;
  /**
   * Already an object. The legacy chat-completions shape delivered arguments
   * as JSON text for the caller to parse; the Messages API parses it upstream,
   * so there is no half-written JSON to defend against here.
   */
  input: Record<string, unknown>;
}

export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | {
      type: 'end';
      /**
       * The assistant turn verbatim, to be pushed back into `messages` as-is.
       * Replaying the blocks rather than rebuilding them from text keeps
       * thinking blocks intact, which the model requires when it continues a
       * turn it has already reasoned through.
       */
      content: Anthropic.ContentBlock[];
      toolCalls: CompletedToolCall[];
      usage: ChatUsage;
      stopReason: string | null;
    };

const NOT_CONFIGURED =
  'Pragnya is not configured. Add the AWS Bedrock settings to the backend environment.';

/**
 * Room for the answer *and* the reasoning behind it. Thinking tokens are drawn
 * from the same allowance, so a ceiling sized for the visible reply alone
 * truncates mid-sentence once the model starts thinking.
 */
const MAX_TOKENS = 8_192;

/**
 * How hard the model works before answering. Pragnya looks things up and
 * summarises them, over as many as six rounds of tools — `high` (the default)
 * buys depth this rarely needs and charges for it on every round. Raise it if
 * answers start arriving thin.
 */
const EFFORT = 'medium' as const;

/**
 * The region, under either name AWS accepts. The SDK reads these itself; they
 * are read here too so `status()` can answer without making a call.
 */
function configuredRegion(): string | undefined {
  return env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
}

/**
 * Whether a request is worth attempting.
 *
 * Region and model only. Credentials are deliberately not checked: on a
 * deployed task role there is nothing in the environment to look at, and
 * demanding an access key here would report a correctly configured server as
 * unavailable. A credential that turns out to be missing or refused surfaces
 * as an upstream failure on first use, which says more than a blanket
 * "not configured" would.
 */
export function isConfigured(): boolean {
  return Boolean(configuredRegion() && env.BEDROCK_MODEL_ID);
}

export function status(): AssistantStatus {
  return isConfigured()
    ? { available: true, model: env.BEDROCK_MODEL_ID as string }
    : { available: false, reason: NOT_CONFIGURED };
}

let client: AnthropicBedrockMantle | undefined;

/**
 * Built once and kept. Construction resolves the AWS credential chain, which
 * can reach out to instance metadata — not something to repeat per turn.
 */
function bedrock(): AnthropicBedrockMantle {
  client ??= new AnthropicBedrockMantle({ awsRegion: configuredRegion() });
  return client;
}

export interface StreamChatOptions {
  /** Standing instructions. Top-level, not a message — the Messages API keeps them apart. */
  system: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  /** `'none'` on the last round, so the model has to answer with what it has. */
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
}

/**
 * One streamed turn.
 *
 * Yields text as it arrives and finishes with an `end` event carrying the
 * assembled tool calls, the whole assistant turn and the token usage. Throws
 * `EpmError` for anything upstream refuses; an abort from the caller's signal
 * propagates as-is so the caller can tell "the user left" from "the model
 * failed".
 */
export async function* streamChat(
  options: StreamChatOptions,
): AsyncGenerator<ChatStreamEvent, void, undefined> {
  if (!isConfigured()) throw EpmError.unavailable(NOT_CONFIGURED);

  const request: Anthropic.MessageStreamParams = {
    model: env.BEDROCK_MODEL_ID as string,
    max_tokens: MAX_TOKENS,
    system: options.system,
    messages: options.messages,
    output_config: { effort: EFFORT },
  };
  if (options.tools && options.tools.length > 0) {
    request.tools = options.tools;
    request.tool_choice = { type: options.toolChoice ?? 'auto' };
  }

  let final: Anthropic.Message;
  const stream = bedrock().messages.stream(request, { signal: options.signal });
  try {
    for await (const event of stream) {
      // Thinking deltas arrive on this same event under a different delta
      // type. They are not forwarded: the reasoning is the model's working,
      // not the answer, and it still reaches the next round intact via
      // `content` below.
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }
    final = await stream.finalMessage();
  } catch (error) {
    throw mapUpstreamFailure(error);
  }

  yield {
    type: 'end',
    content: final.content,
    toolCalls: final.content.filter(isToolUse).map((block) => ({
      id: block.id,
      name: block.name,
      input: asArguments(block.input),
    })),
    usage: {
      promptTokens: final.usage.input_tokens,
      completionTokens: final.usage.output_tokens,
    },
    stopReason: final.stop_reason,
  };
}

function isToolUse(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === 'tool_use';
}

/**
 * The call's arguments, narrowed to what a tool can actually be handed.
 *
 * Each tool's schema says an object, and the API validates against it, so this
 * only fires if that guarantee breaks. An empty object is the right answer
 * then: the tool reports its own missing arguments far more usefully than a
 * cast that lets an array through as a record would.
 */
function asArguments(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

/**
 * Upstream failure to something safe to show, most specific first.
 *
 * An abort is returned unchanged rather than wrapped: the caller distinguishes
 * it from a real failure, and a wrapped one would read as the assistant
 * breaking when in fact the person closed the tab.
 */
function mapUpstreamFailure(error: unknown): unknown {
  if (isAbort(error)) return error;

  if (error instanceof APIConnectionError) {
    return EpmError.unavailable('The assistant could not be reached.', error);
  }

  if (!(error instanceof APIError)) {
    return EpmError.unavailable('The assistant could not be reached.', error);
  }

  // Read for the log only. The body can quote the request back, so it is
  // never part of what the browser sees.
  const upstream = { status: error.status ?? 0, body: safeBody(error) };

  if (error instanceof RateLimitError) {
    return new EpmError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'The assistant is busy, try again in a moment.',
      { upstream },
    );
  }
  if (error instanceof PermissionDeniedError) {
    // Bedrock answers 403 when the calling principal may not invoke the
    // endpoint at all. Naming the action saves the reader from hunting
    // through IAM for a permission nobody thought to grant.
    return new EpmError(
      502,
      'UPSTREAM_ERROR',
      'The assistant was refused by AWS. Check the caller has bedrock-mantle:CreateInference.',
      { upstream },
    );
  }
  if (error instanceof AuthenticationError) {
    // Rejected credentials are this deployment's problem, not the caller's session.
    return new EpmError(502, 'UPSTREAM_ERROR', 'The assistant is not configured correctly.', {
      upstream,
    });
  }
  if (error instanceof NotFoundError) {
    // A wrong model id and a region that does not serve it look identical
    // from here, so both are named.
    return new EpmError(
      502,
      'UPSTREAM_ERROR',
      'The assistant could not reach that Bedrock model. Check the model ID and the region.',
      { upstream },
    );
  }
  if (error.status !== undefined && error.status >= 500) {
    return new EpmError(503, 'UPSTREAM_UNAVAILABLE', 'The assistant is unavailable right now.', {
      upstream,
    });
  }
  // 400 covers a malformed request and a prompt the model declined alike;
  // neither is something to retry.
  return new EpmError(502, 'UPSTREAM_ERROR', 'The assistant could not answer.', { upstream });
}

function safeBody(error: APIError): string {
  const body = typeof error.error === 'string' ? error.error : JSON.stringify(error.error ?? {});
  return body.slice(0, 2_000);
}

/**
 * Whether this is the caller walking away.
 *
 * Two shapes reach here: the SDK's own abort type from a cancelled stream, and
 * a plain `AbortError` from the tool calls, which run through fetch and
 * Fastify's injector rather than the SDK.
 */
export function isAbort(error: unknown): boolean {
  if (error instanceof APIUserAbortError) return true;
  return error instanceof Error && error.name === 'AbortError';
}
