import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

// Type-only: erased at compile time, so the module is still first loaded
// below, after the environment it reads has been set.
import type { ChatStreamEvent } from '../bedrock.js';

/**
 * Proves that a streamed turn reaches EPM whole.
 *
 * The wire is the SDK's business now, so this does not re-test SSE framing.
 * What it does test is the contract `service.ts` is written against: text
 * arrives as it is produced, a tool call whose arguments were split across
 * frames comes back as one parsed object, and an upstream refusal becomes a
 * sentence safe to show with the detail kept for the log.
 *
 * The frames below are split mid-JSON deliberately — a single fragment
 * (`{"bucket":`) is not parseable on its own, which is the case that used to
 * need reassembling by hand.
 *
 * Needs no AWS account and makes no outbound call — the model is a local stub.
 * It does need a `.env` that parses, because the config is validated whole on
 * import. Run with
 * `env -u PORT npx tsx --env-file-if-exists=.env src/assistant/__checks__/stream.check.ts`.
 */

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

const TURN = sse([
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'anthropic.claude-sonnet-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 0 },
      },
    },
  ],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_tasks', input: {} },
    },
  ],
  // Arguments arrive in pieces; neither half is valid JSON alone.
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"bucket":' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"overdue","limit":5}' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 24 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
]);

/** Answers the next request with `TURN`, or with a refusal when told to. */
let refuse = false;
const server: Server = createServer((request, response) => {
  request.resume();
  if (refuse) {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'User is not authorized to perform bedrock-mantle:CreateInference' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(TURN);
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;

// Set before the module loads: the config is read once, at import.
process.env.ANTHROPIC_BEDROCK_MANTLE_BASE_URL = `http://127.0.0.1:${port}/anthropic`;
process.env.AWS_REGION = 'us-east-1';
process.env.BEDROCK_MODEL_ID = 'anthropic.claude-sonnet-5';
process.env.AWS_ACCESS_KEY_ID ??= 'AKIAEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY ??= 'secret';

const { streamChat, status, isAbort } = await import('../bedrock.js');
const { EpmError } = await import('../../lib/errors.js');

try {
  assert.deepEqual(
    status(),
    { available: true, model: 'anthropic.claude-sonnet-5' },
    'a region and a model is enough to report available',
  );

  const text: string[] = [];
  let end: Extract<ChatStreamEvent, { type: 'end' }> | undefined;
  for await (const event of streamChat({
    system: 'You are Pragnya.',
    messages: [{ role: 'user', content: 'what is overdue?' }],
    tools: [
      {
        name: 'list_tasks',
        description: 'List tasks.',
        input_schema: { type: 'object', properties: { bucket: { type: 'string' } } },
      },
    ],
  })) {
    if (event.type === 'text') text.push(event.text);
    else end = event;
  }

  assert.deepEqual(text, ['Let me ', 'check.'], 'text arrives in the order it was produced');
  assert.ok(end, 'the turn finishes with an end event');
  assert.equal(end.stopReason, 'tool_use');
  assert.deepEqual(end.usage, { promptTokens: 11, completionTokens: 24 }, 'usage is carried through');
  assert.deepEqual(
    end.toolCalls,
    [{ id: 'toolu_1', name: 'list_tasks', input: { bucket: 'overdue', limit: 5 } }],
    'a tool call split across frames comes back as one parsed object',
  );
  // What service.ts replays as the assistant turn.
  assert.deepEqual(
    end.content.map((block) => block.type),
    ['text', 'tool_use'],
    'the whole turn is returned for replay, not just its text',
  );
  console.log('ok  streamed turn:', JSON.stringify({ text: text.join(''), calls: end.toolCalls }));

  refuse = true;
  const failure = await streamChat({ system: 's', messages: [{ role: 'user', content: 'hi' }] })
    .next()
    .then(() => undefined)
    .catch((error: unknown) => error);

  assert.ok(failure instanceof EpmError, 'a refusal surfaces as an EpmError');
  assert.equal(failure.status, 502);
  assert.match(failure.message, /bedrock-mantle:CreateInference/, 'the message names the missing action');
  assert.ok(!/authorized to perform/.test(JSON.stringify(failure.message)), 'the upstream body is not in the message');
  assert.match(JSON.stringify(failure.upstream), /authorized to perform/, 'the upstream body is kept for the log');
  console.log('ok  refusal mapped:', failure.message);

  assert.equal(isAbort(Object.assign(new Error('gone'), { name: 'AbortError' })), true, 'a plain abort is an abort');
  assert.equal(isAbort(new Error('nope')), false);
  console.log('ok  aborts are told apart from failures');
} finally {
  server.close();
}
