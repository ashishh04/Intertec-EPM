import { z } from 'zod';

import { withAudit } from '../domain/audit.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import type { AssistantPolicyView, AssistantUsageRow } from '../types/epm.js';

/**
 * Administrators' guardrails for Pragnya (BR-501 to BR-503).
 *
 * These are enforced in code, before and after the model — not left to its
 * instructions: whether it answers at all, how many questions a person may ask
 * a day, the topics it declines without asking the model, which kinds of
 * figures it may look up (finance, people), and secrets masked in every answer.
 * None of them can widen what a person sees: every lookup still runs through
 * EPM's API as the person asking.
 */

export const DEFAULT_POLICY: AssistantPolicyView = {
  enabled: true,
  allowFinance: true,
  allowPeople: true,
  dailyLimit: 100,
  blockedTopics: [],
  guidance: null,
  updatedBy: null,
  updatedAt: null,
};

let cache: { at: number; value: AssistantPolicyView } | undefined;

export async function getPolicy(): Promise<AssistantPolicyView> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const row = await prisma.assistantPolicy.findUnique({ where: { id: 1 } }).catch(() => null);
  const value: AssistantPolicyView = row
    ? {
        enabled: row.enabled,
        allowFinance: row.allowFinance,
        allowPeople: row.allowPeople,
        dailyLimit: row.dailyLimit,
        blockedTopics: row.blockedTopics,
        guidance: row.guidance,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt.toISOString(),
      }
    : DEFAULT_POLICY;
  cache = { at: Date.now(), value };
  return value;
}

const policySchema = z.object({
  enabled: z.boolean(),
  allowFinance: z.boolean(),
  allowPeople: z.boolean(),
  dailyLimit: z.number().int().min(0).max(10_000),
  blockedTopics: z.array(z.string().trim().min(2).max(80)).max(100),
  guidance: z.string().trim().max(4000).nullable(),
});

export async function savePolicy(input: unknown, actorId: string): Promise<AssistantPolicyView> {
  const parsed = policySchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('The assistant settings are not complete.', parsed.error.issues);
  const before = await getPolicy();
  const data = { ...parsed.data, blockedTopics: [...new Set(parsed.data.blockedTopics.map((topic) => topic.toLowerCase()))], guidance: parsed.data.guidance || null, updatedBy: actorId };
  await withAudit(
    (tx) => tx.assistantPolicy.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data }),
    () => ({
      actorId,
      entityType: 'assistant-policy',
      entityId: '1',
      action: 'assistant.policy.updated',
      summary: message('Pragnya settings changed.'),
      before: { ...before },
      after: { ...data },
    }),
  );
  cache = undefined;
  return getPolicy();
}

/** A topic the administrators have asked Pragnya to decline, if the question touches one. */
export function blockedTopicIn(question: string, policy: AssistantPolicyView): string | null {
  const text = question.toLowerCase();
  return policy.blockedTopics.find((topic) => text.includes(topic)) ?? null;
}

/** Questions this person has asked today (UTC). */
export async function questionsToday(userId: string): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return prisma.assistantMessage.count({ where: { role: 'user', createdAt: { gte: start }, conversation: { userId } } });
}

/**
 * Masks anything shaped like a secret before it reaches the person or is
 * stored: bearer tokens, API keys, private keys, connection strings with a
 * password, "password: …" pairs. The tools never return such things; this is
 * the net under that, should a task description or a document carry one.
 */
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
  /\b(password|passwd|pwd|secret|api[_ -]?key|access[_ -]?token|client[_ -]?secret)\b(\s*[:=]\s*)(\S+)/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRETS) {
    out = out.replace(pattern, (...match: string[]) =>
      // Keep the label of a "password: …" pair, so the sentence still reads.
      match.length > 4 && /password|passwd|pwd|secret|key|token/i.test(match[1] ?? '') ? `${match[1]}${match[2]}[hidden]` : '[hidden]',
    );
  }
  return out;
}

/** Who asked Pragnya how much, with which lookups, over the last days — never what they asked. */
export async function usage(days: number): Promise<Omit<AssistantUsageRow, 'userName'>[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.assistantMessage.findMany({
    where: { createdAt: { gte: since } },
    select: { role: true, toolCalls: true, promptTokens: true, outputTokens: true, createdAt: true, conversation: { select: { userId: true } } },
  });
  const byUser = new Map<string, Omit<AssistantUsageRow, 'userName'>>();
  for (const row of rows) {
    const userId = row.conversation.userId;
    const entry = byUser.get(userId) ?? { userId, questions: 0, tools: {}, tokens: 0, refused: 0, lastAt: row.createdAt.toISOString() };
    if (row.role === 'user') entry.questions += 1;
    entry.tokens += row.promptTokens + row.outputTokens;
    for (const call of (row.toolCalls as { name?: string }[] | null) ?? []) {
      if (!call.name) continue;
      if (call.name === 'guardrail') entry.refused += 1;
      else entry.tools[call.name] = (entry.tools[call.name] ?? 0) + 1;
    }
    if (row.createdAt.toISOString() > entry.lastAt) entry.lastAt = row.createdAt.toISOString();
    byUser.set(userId, entry);
  }
  return [...byUser.values()].sort((a, b) => b.questions - a.questions);
}
