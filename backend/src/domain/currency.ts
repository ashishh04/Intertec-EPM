import { z } from 'zod';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { today as todayIso } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { dateOf, message, msg } from '../lib/i18n.js';
import type { CurrencyList, ExchangeRateView } from '../types/epm.js';
import { withAudit } from './audit.js';
import { money } from './finance.js';

/**
 * Currencies and exchange rates (BR-320, BR-321).
 *
 * OpenProject's costs module has one currency for the whole instance and no
 * exchange rates, so both are EPM's. Every figure EPM reports is in the
 * reporting currency (`EPM_CURRENCY`); a project, a rate card and an expense
 * claim may be in another, and keep their own amount beside the converted one.
 *
 * What happened converts at the rate in force on its day; plans and forecasts
 * at the planning rate. The rate a currency is converted at for a day is fixed
 * the first time anything dated that day is converted — `exchange_rate_fixings`
 * — so a past period reports the same figure whenever it is asked for, however
 * the rate table is corrected afterwards. Rates are never edited: a correction
 * is a new row, which applies to days not yet converted.
 */

export const reportingCurrency = (): string => env.EPM_CURRENCY.toUpperCase();

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const code = z
  .string()
  .regex(/^[A-Za-z]{3}$/, msg('A currency is its three-letter code, e.g. USD.'))
  .transform((value) => value.toUpperCase());

const isoDay = (value: Date) => value.toISOString().slice(0, 10);

function view(row: {
  id: string;
  currency: string;
  rate: unknown;
  effectiveFrom: Date;
  kind: string;
  createdBy: string;
  createdAt: Date;
}): ExchangeRateView {
  return {
    id: row.id,
    currency: row.currency,
    rate: Number(row.rate),
    effectiveFrom: isoDay(row.effectiveFrom),
    kind: row.kind === 'planning' ? 'planning' : 'actual',
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listRates(): Promise<ExchangeRateView[]> {
  const rows = await prisma.exchangeRate.findMany({ orderBy: [{ currency: 'asc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }] });
  return rows.map(view);
}

/** The reporting currency and every currency with a rate. */
export async function currencies(): Promise<CurrencyList> {
  const rows = await prisma.exchangeRate.findMany({ distinct: ['currency'], select: { currency: true } });
  const reporting = reportingCurrency();
  return { reporting, currencies: [reporting, ...rows.map((row) => row.currency).filter((one) => one !== reporting).sort()] };
}

const rateSchema = z.object({
  currency: code,
  rate: z.number().positive().max(1_000_000),
  effectiveFrom: z.string().regex(DAY, msg('effectiveFrom must be a date, e.g. 2026-10-01.')),
  kind: z.enum(['actual', 'planning']).default('actual'),
});

/** Adds a rate. Rates are never changed: a correction is a new row, for the days not yet converted. */
export async function addRate(input: unknown, actorId: string): Promise<ExchangeRateView> {
  const parsed = rateSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation('The exchange rate is not complete.', parsed.error.issues);
  const { currency, rate, effectiveFrom, kind } = parsed.data;
  if (currency === reportingCurrency()) {
    throw EpmError.validation(message('{currency} is the reporting currency: it has no rate to itself.', { currency }));
  }
  const row = await withAudit(
    (tx) => tx.exchangeRate.create({ data: { currency, rate, effectiveFrom: new Date(effectiveFrom), kind, createdBy: actorId } }),
    (created) => ({
      actorId,
      entityType: 'exchange-rate',
      entityId: created.id,
      action: 'finance.rate.added',
      summary: message('{kind, select, planning {Planning rate} other {Exchange rate}} for {currency} from {day}: {rate}.', {
        kind,
        currency,
        day: dateOf(effectiveFrom),
        rate,
      }),
      after: { currency, rate, effectiveFrom, kind },
    }),
  );
  return view(row);
}

/** The rate in the table for a day: the latest to have taken effect by then, the latest entered on a tie. */
async function tableRate(currency: string, day: string, kind: 'actual' | 'planning') {
  return prisma.exchangeRate.findFirst({
    where: { currency, kind, effectiveFrom: { lte: new Date(day) } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });
}

/**
 * The rate `currency` converts at for `day`, into the reporting currency:
 * fixed the first time that day is converted, and the same ever after.
 */
export async function rateOn(currency: string, day: string): Promise<number> {
  const upper = currency.toUpperCase();
  if (upper === reportingCurrency()) return 1;
  const key = { currency_day: { currency: upper, day: new Date(day) } };
  const fixed = await prisma.exchangeRateFixing.findUnique({ where: key });
  if (fixed) return Number(fixed.rate);
  const found = await tableRate(upper, day, 'actual');
  if (!found) throw EpmError.validation(message('There is no exchange rate for {currency} on {day}.', { currency: upper, day: dateOf(day) }));
  // Two requests fixing the same day at once: the first row wins, and both read it.
  await prisma.exchangeRateFixing.createMany({
    data: [{ currency: upper, day: new Date(day), rate: found.rate, rateId: found.id }],
    skipDuplicates: true,
  });
  return Number((await prisma.exchangeRateFixing.findUnique({ where: key }))!.rate);
}

/** The rate for plans and forecasts: the planning rate in force today, else today's actual rate. */
export async function planningRate(currency: string): Promise<number> {
  const upper = currency.toUpperCase();
  if (upper === reportingCurrency()) return 1;
  const today = todayIso();
  const found = (await tableRate(upper, today, 'planning')) ?? (await tableRate(upper, today, 'actual'));
  if (!found) throw EpmError.validation(message('There is no exchange rate for {currency} on {day}.', { currency: upper, day: dateOf(today) }));
  return Number(found.rate);
}

/** Whether a currency can be used: the reporting currency, or one with a rate. */
export async function assertKnownCurrency(currency: string): Promise<string> {
  const upper = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) throw EpmError.validation('A currency is its three-letter code, e.g. USD.');
  if (upper === reportingCurrency()) return upper;
  const any = await prisma.exchangeRate.findFirst({ where: { currency: upper }, select: { id: true } });
  if (!any) throw EpmError.validation(message('{currency} has no exchange rate yet: add one under Administration first.', { currency: upper }));
  return upper;
}

/**
 * Converts many amounts in one request, each rate read once. `on` converts at a
 * day's fixed rate, `planned` at the planning rate; from one currency to
 * another through the reporting currency.
 */
export class Converter {
  private readonly fixed = new Map<string, Promise<number>>();
  private readonly planning = new Map<string, Promise<number>>();

  rate(currency: string, day: string): Promise<number> {
    const key = `${currency.toUpperCase()}|${day}`;
    let rate = this.fixed.get(key);
    if (!rate) {
      rate = rateOn(currency, day);
      this.fixed.set(key, rate);
    }
    return rate;
  }

  planningRate(currency: string): Promise<number> {
    const key = currency.toUpperCase();
    let rate = this.planning.get(key);
    if (!rate) {
      rate = planningRate(currency);
      this.planning.set(key, rate);
    }
    return rate;
  }

  /** `amount` in `from`, in `to`, at the rates for `day`. */
  async on(amount: number, from: string, to: string, day: string): Promise<{ amount: number; rate: number }> {
    if (from.toUpperCase() === to.toUpperCase()) return { amount: money(amount), rate: 1 };
    const rate = (await this.rate(from, day)) / (await this.rate(to, day));
    return { amount: money(amount * rate), rate: Math.round(rate * 1e8) / 1e8 };
  }

  /** `amount` in `from`, in `to`, at the planning rates. */
  async planned(amount: number, from: string, to: string): Promise<{ amount: number; rate: number }> {
    if (from.toUpperCase() === to.toUpperCase()) return { amount: money(amount), rate: 1 };
    const rate = (await this.planningRate(from)) / (await this.planningRate(to));
    return { amount: money(amount * rate), rate: Math.round(rate * 1e8) / 1e8 };
  }
}
