import { createHmac } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { env } from '../config/env.js';
import { message, msg, render, type Message } from './i18n.js';

/**
 * A rule's call to an outside endpoint (BR-217): POST JSON to a URL somebody
 * typed into a rule.
 *
 * The danger is the address, not the payload. Unchecked, a rule could be
 * pointed at the cloud metadata service, the database, OpenProject's own port —
 * anything this server can reach and the rule's author cannot. So: https only,
 * no redirects followed, and the address actually connected to must be public.
 * That last check runs in the connection's DNS lookup, on the resolved
 * address, so a public-looking name that resolves somewhere private is refused
 * rather than trusted. Hosts listed in EPM_RULES_OUTBOUND_ALLOWLIST are exempt,
 * for an internal receiver an operator vouches for.
 *
 * With EPM_RULES_WEBHOOK_SECRET set, every call carries
 * `X-EPM-Signature: sha256=<HMAC-SHA256 of the body>` for the receiver to check.
 */

/** Loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('ff')
    );
  }
  // Not an address at all: nothing to connect to safely.
  return true;
}

const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
const allowlisted = (host: string) => env.EPM_RULES_OUTBOUND_ALLOWLIST.includes(host);

/** Why a URL cannot be called, or undefined. Checked when a rule is saved and again when it fires. */
export function endpointProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return msg('That is not a URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return msg('Endpoints are called over https.');
  if (url.username || url.password) return msg('Keep credentials out of the URL; have the receiver check the signature.');
  const host = hostOf(url);
  if (allowlisted(host)) return undefined;
  if (url.protocol === 'http:') return msg('Endpoints are called over https.');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (net.isIP(host) !== 0 && isPrivateAddress(host))
  ) {
    return msg('That address is inside the network. Rules can only call public endpoints.');
  }
  return undefined;
}

export interface OutboundResult {
  ok: boolean;
  status?: number;
  /** Why it failed, in English: EPM's words, or the network's own. */
  error?: string;
  /** EPM's words as a message, so a log can show them in its reader's language (BR-605). */
  errorMessage?: Message;
  durationMs: number;
}

/** A failure in EPM's own words, carrying its message through Node's error events. */
class OutboundProblem extends Error {
  constructor(readonly source: Message) {
    super(render('en', source));
  }
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** POSTs `payload` as JSON. Never throws: the result says what happened. */
export function postJson(raw: string, payload: unknown, timeoutMs = 5000): Promise<OutboundResult> {
  const started = Date.now();
  const problem = endpointProblem(raw);
  if (problem) return Promise.resolve({ ok: false, error: problem, durationMs: 0 });

  const url = new URL(raw);
  const trusted = allowlisted(hostOf(url));
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    'User-Agent': 'EPM-Rules/1',
  };
  if (env.EPM_RULES_WEBHOOK_SECRET) {
    headers['X-EPM-Signature'] = `sha256=${createHmac('sha256', env.EPM_RULES_WEBHOOK_SECRET).update(body).digest('hex')}`;
  }

  // The address actually connected to, checked after DNS has answered.
  const lookup = (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    dns.lookup(hostname, options as dns.LookupAllOptions, ((error, address, family) => {
      if (error) return callback(error, address, family);
      const addresses = Array.isArray(address) ? address.map((one) => one.address) : [String(address)];
      if (!trusted && addresses.some(isPrivateAddress)) {
        return callback(
          new OutboundProblem(message('{host} resolves to an address inside the network.', { host: hostname })),
          address,
          family,
        );
      }
      callback(null, address, family);
    }) as LookupCallback);
  };

  return new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      { method: 'POST', headers, lookup: lookup as unknown as net.LookupFunction, timeout: timeoutMs },
      (response) => {
        // The answer's body is not read: the status is the outcome.
        response.resume();
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          const problem = ok ? undefined : message('The endpoint answered {status}.', { status });
          resolve({
            ok,
            status,
            ...(problem ? { error: render('en', problem), errorMessage: problem } : {}),
            durationMs: Date.now() - started,
          });
        });
      },
    );
    request.on('timeout', () =>
      request.destroy(new OutboundProblem(message('No answer within {seconds} seconds.', { seconds: Math.round(timeoutMs / 1000) }))),
    );
    request.on('error', (error) =>
      resolve({
        ok: false,
        error: error.message,
        ...(error instanceof OutboundProblem ? { errorMessage: error.source } : {}),
        durationMs: Date.now() - started,
      }),
    );
    request.end(body);
  });
}
