import assert from 'node:assert/strict';

import { render } from '../../lib/i18n.js';
import type { RecurrenceRule } from '../../types/epm.js';
import type { WorkingCalendar } from '../critical-path.js';
import {
  describeRule,
  lastOccurrence,
  nextOccurrences,
  occurrenceTotal,
  occurrences,
  validateRule,
  weekdayOf,
} from '../recurrence.js';
import { dayOf } from '../critical-path.js';

/**
 * Worked examples for recurrence rules (BR-105): the BRM line — a weekly rule
 * counted to ten gives exactly ten dates, the right ones — then every
 * frequency and interval, month ends and the last day, 29 February, an end
 * date against a count, keeping to working days, the same dates whatever the
 * time zone, the rule in words, and the rules that are refused.
 *
 *   npx tsx src/domain/__checks__/recurrence.check.ts
 */

let passed = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    throw error;
  }
}

/** A rule `validateRule` accepts, as it stores it. */
function rule(input: Record<string, unknown>, calendar?: WorkingCalendar): RecurrenceRule {
  const result = validateRule(input, calendar);
  if (!result.ok) throw new Error(`refused: ${render('en', result.problem)}`);
  return result.rule;
}

/** Every occurrence of a rule that ends. */
const all = (one: RecurrenceRule, calendar?: WorkingCalendar) => occurrences(one, one.startDate, '2200-12-31', calendar);
const words = (one: RecurrenceRule) => render('en', describeRule(one));
const refusal = (input: Record<string, unknown>) => {
  const result = validateRule(input);
  return result.ok ? 'accepted' : render('en', result.problem);
};

/** Monday to Friday, with Wednesday 14 October and Friday 25 December 2026 off. */
const calendar: WorkingCalendar = { weekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set(['2026-10-14', '2026-12-25']) };

console.log('BR-105: a weekly rule with an occurrence count of 10');

await check('produces exactly ten dates, a week apart, on the right weekday', () => {
  const weekly = rule({ frequency: 'weekly', interval: 1, weekdays: [1], startDate: '2026-10-19', count: 10 });
  const dates = all(weekly);
  console.log(`        ${dates.join(', ')}`);
  assert.deepEqual(dates, [
    '2026-10-19',
    '2026-10-26',
    '2026-11-02',
    '2026-11-09',
    '2026-11-16',
    '2026-11-23',
    '2026-11-30',
    '2026-12-07',
    '2026-12-14',
    '2026-12-21',
  ]);
  assert.ok(dates.every((date) => weekdayOf(dayOf(date)) === 1), 'every one a Monday');
  assert.equal(occurrenceTotal(weekly), 10);
  assert.equal(lastOccurrence(weekly), '2026-12-21');
  assert.equal(words(weekly), 'Every week on Monday, from 19 Oct 2026, 10 times');
});

await check('and on two weekdays every other week, ten dates in five fortnights', () => {
  const fortnightly = rule({ frequency: 'weekly', interval: 2, weekdays: [4, 1], startDate: '2026-10-19', count: 10 });
  assert.deepEqual(fortnightly.weekdays, [1, 4], 'weekdays are kept in order');
  const dates = all(fortnightly);
  console.log(`        ${dates.join(', ')}`);
  assert.deepEqual(dates, [
    '2026-10-19',
    '2026-10-22',
    '2026-11-02',
    '2026-11-05',
    '2026-11-16',
    '2026-11-19',
    '2026-11-30',
    '2026-12-03',
    '2026-12-14',
    '2026-12-17',
  ]);
  assert.equal(words(fortnightly), 'Every 2 weeks on Monday and Thursday, from 19 Oct 2026, 10 times');
});

await check('a count is counted from the start, so any window sees the same dates', () => {
  const weekly = rule({ frequency: 'weekly', weekdays: [1], startDate: '2026-10-19', count: 10 });
  assert.deepEqual(occurrences(weekly, '2026-11-10', '2026-11-30'), ['2026-11-16', '2026-11-23', '2026-11-30']);
  assert.deepEqual(occurrences(weekly, '2026-12-15', '2027-06-30'), ['2026-12-21'], 'and none after the tenth');
  assert.deepEqual(nextOccurrences(weekly, '2026-12-01', 5), ['2026-12-07', '2026-12-14', '2026-12-21']);
});

await check('a week starts on its start date: an earlier weekday in that week is not an occurrence', () => {
  // Wednesday 14 October; Monday the 12th is before it.
  const fromWednesday = rule({ frequency: 'weekly', interval: 2, weekdays: [1, 4], startDate: '2026-10-14', count: 4 });
  assert.deepEqual(all(fromWednesday), ['2026-10-15', '2026-10-26', '2026-10-29', '2026-11-09']);
});

console.log('Every frequency and interval');

await check('daily, every day and every third day', () => {
  assert.deepEqual(all(rule({ frequency: 'daily', startDate: '2026-10-30', count: 4 })), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  const third = rule({ frequency: 'daily', interval: 3, startDate: '2026-10-30', endDate: '2026-11-10' });
  assert.deepEqual(all(third), ['2026-10-30', '2026-11-02', '2026-11-05', '2026-11-08']);
  assert.equal(words(third), 'Every 3 days, from 30 Oct 2026, until 10 Nov 2026');
});

await check('custom: every ten days', () => {
  const tenth = rule({ frequency: 'custom', interval: 10, startDate: '2026-12-25', count: 3 });
  assert.deepEqual(all(tenth), ['2026-12-25', '2027-01-04', '2027-01-14']);
  assert.equal(words(tenth), 'Every 10 days, from 25 Dec 2026, 3 times');
});

await check('weekly with no weekdays chosen repeats on its start date’s', () => {
  const plain = rule({ frequency: 'weekly', startDate: '2026-10-22', count: 3 });
  assert.deepEqual(plain.weekdays, [4]);
  assert.deepEqual(all(plain), ['2026-10-22', '2026-10-29', '2026-11-05']);
  const three = rule({ frequency: 'weekly', weekdays: [5, 1, 3, 3], startDate: '2026-10-19', count: 3 });
  assert.equal(words(three), 'Every week on Monday, Wednesday and Friday, from 19 Oct 2026, 3 times');
});

await check('monthly on a day, every month and every second month', () => {
  const monthly = rule({ frequency: 'monthly', dayOfMonth: 15, startDate: '2026-10-20', count: 4 });
  assert.deepEqual(all(monthly), ['2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15'], 'the 15th of October was before the start');
  const second = rule({ frequency: 'monthly', interval: 2, startDate: '2026-11-05', count: 4 });
  assert.equal(second.dayOfMonth, 5, 'the start date’s day when none is chosen');
  assert.deepEqual(all(second), ['2026-11-05', '2027-01-05', '2027-03-05', '2027-05-05']);
  assert.equal(words(second), 'Every 2 months on day 5, from 5 Nov 2026, 4 times');
});

await check('quarterly, anchored on its start month', () => {
  const quarterly = rule({ frequency: 'quarterly', dayOfMonth: 15, startDate: '2027-01-01', endDate: '2027-12-31' });
  assert.deepEqual(all(quarterly), ['2027-01-15', '2027-04-15', '2027-07-15', '2027-10-15']);
  assert.equal(words(quarterly), 'Every quarter on day 15 of the month, from 1 Jan 2027, until 31 Dec 2027');
  const halfYearly = rule({ frequency: 'quarterly', interval: 2, dayOfMonth: 'last', startDate: '2027-03-01', count: 3 });
  assert.deepEqual(all(halfYearly), ['2027-03-31', '2027-09-30', '2028-03-31']);
  assert.equal(words(halfYearly), 'Every 2 quarters on the last day of the month, from 1 Mar 2027, 3 times');
});

console.log('Month ends and 29 February');

await check('a day the month lacks falls on its last day', () => {
  const thirtyFirst = rule({ frequency: 'monthly', dayOfMonth: 31, startDate: '2027-01-01', count: 6 });
  assert.deepEqual(all(thirtyFirst), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30']);
  const thirtieth = rule({ frequency: 'quarterly', dayOfMonth: 30, startDate: '2027-11-01', count: 3 });
  assert.deepEqual(all(thirtieth), ['2027-11-30', '2028-02-29', '2028-05-30'], 'February in a leap year');
});

await check('"last" is each month’s own last day, through a leap year', () => {
  const last = rule({ frequency: 'monthly', dayOfMonth: 'last', startDate: '2027-12-01', count: 4 });
  assert.deepEqual(all(last), ['2027-12-31', '2028-01-31', '2028-02-29', '2028-03-31']);
  assert.equal(words(last), 'Every month on the last day, from 1 Dec 2027, 4 times');
});

await check('29 February: day 29 is the 28th in a common year and the 29th in a leap year', () => {
  const twentyNinth = rule({ frequency: 'monthly', dayOfMonth: 29, startDate: '2027-01-29', endDate: '2028-03-31' });
  const dates = all(twentyNinth);
  assert.ok(dates.includes('2027-02-28') && dates.includes('2028-02-29'));
  assert.equal(dates.length, 15);
  const fromLeapDay = rule({ frequency: 'quarterly', startDate: '2028-02-29', count: 5 });
  assert.deepEqual(all(fromLeapDay), ['2028-02-29', '2028-05-29', '2028-08-29', '2028-11-29', '2029-02-28']);
  assert.deepEqual(all(rule({ frequency: 'daily', startDate: '2028-02-27', count: 4 })), ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);
  assert.equal(refusal({ frequency: 'daily', startDate: '2027-02-29' }), 'The start date is not a valid date.', 'no 29 February in 2027');
});

console.log('An end date or a count');

await check('an end date is inclusive and a count stops at its number', () => {
  const until = rule({ frequency: 'weekly', weekdays: [1], startDate: '2026-10-19', endDate: '2026-11-09' });
  assert.deepEqual(all(until), ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'], 'the end date itself included');
  assert.equal(occurrenceTotal(until), 4);
  const counted = rule({ frequency: 'weekly', weekdays: [1], startDate: '2026-10-19', count: 4 });
  assert.deepEqual(all(counted), all(until), 'the same four either way');
  assert.equal(refusal({ frequency: 'weekly', startDate: '2026-10-19', endDate: '2026-11-09', count: 4 }), 'Choose an end date or a number of occurrences, not both.');
});

await check('with neither it does not end', () => {
  const forever = rule({ frequency: 'monthly', startDate: '2026-10-19' });
  assert.equal(occurrenceTotal(forever), null);
  assert.equal(lastOccurrence(forever), null);
  assert.deepEqual(nextOccurrences(forever, '2099-12-01', 2), ['2099-12-19', '2100-01-19']);
  assert.equal(words(forever), 'Every month on day 19, from 19 Oct 2026');
});

console.log('Working days only');

await check('"skip": ten working days, not ten days — weekends and the holiday left out', () => {
  const working = rule({ frequency: 'daily', startDate: '2026-10-09', count: 10, nonWorkingDays: 'skip' }, calendar);
  const dates = all(working, calendar);
  assert.deepEqual(dates, [
    '2026-10-09',
    '2026-10-12',
    '2026-10-13',
    '2026-10-15',
    '2026-10-16',
    '2026-10-19',
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
  ]);
  assert.equal(words(working), 'Every day, from 9 Oct 2026, 10 times, on working days only');
});

await check('"next": a day off moves to the next working day, and two that meet are one', () => {
  // 1 November 2026 is a Sunday, 1 May 2027 a Saturday.
  const firsts = rule({ frequency: 'monthly', dayOfMonth: 1, startDate: '2026-10-01', count: 8, nonWorkingDays: 'next' }, calendar);
  assert.deepEqual(all(firsts, calendar), ['2026-10-01', '2026-11-02', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01', '2027-05-03']);
  const daily = rule({ frequency: 'daily', startDate: '2026-10-09', endDate: '2026-10-15', nonWorkingDays: 'next' }, calendar);
  // Saturday and Sunday both move to Monday; the holiday on Wednesday to Thursday, which is already one.
  assert.deepEqual(all(daily, calendar), ['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-15']);
  const christmas = rule({ frequency: 'weekly', weekdays: [5], startDate: '2026-12-18', count: 2, nonWorkingDays: 'next' }, calendar);
  assert.deepEqual(all(christmas, calendar), ['2026-12-18', '2026-12-28'], 'Friday 25 December is a holiday; the weekend follows it');
  assert.equal(words(christmas), 'Every week on Friday, from 18 Dec 2026, 2 times, moved to the next working day when it falls on a day off');
});

await check('a rule that never falls on a working day is refused', () => {
  const result = validateRule({ frequency: 'weekly', weekdays: [6, 7], startDate: '2026-10-17', nonWorkingDays: 'skip' }, calendar);
  assert.equal(result.ok ? 'accepted' : render('en', result.problem), 'That rule never falls on a working day.');
  assert.throws(() => occurrences(rule({ frequency: 'daily', startDate: '2026-10-17', nonWorkingDays: 'skip' }, calendar), '2026-10-17', '2026-10-30'), /working calendar/);
});

console.log('No time zone, no daylight saving');

await check('the same dates in every time zone, across the clocks changing', () => {
  const across = { frequency: 'daily', startDate: '2026-10-23', endDate: '2026-11-03' } as const;
  const weekly = { frequency: 'weekly', weekdays: [7], startDate: '2026-03-01', count: 6 } as const;
  const results = new Set<string>();
  for (const zone of ['UTC', 'Europe/London', 'America/New_York', 'Asia/Dubai', 'Pacific/Auckland']) {
    process.env.TZ = zone;
    const dates = [...all(rule(across)), ...all(rule(weekly))];
    results.add(dates.join(','));
  }
  process.env.TZ = 'UTC';
  assert.equal(results.size, 1, 'one answer whatever the zone');
  const [dates] = [...results];
  const days = dates!.split(',').slice(0, 12);
  assert.equal(days.length, 12, 'twelve days from 23 October to 3 November: none lost or doubled when the clocks go back');
  assert.ok(days.every((day, index) => index === 0 || dayOf(day) - dayOf(days[index - 1]!) === 1));
  assert.deepEqual(dates!.split(',').slice(12), ['2026-03-01', '2026-03-08', '2026-03-15', '2026-03-22', '2026-03-29', '2026-04-05']);
});

console.log('Rules that are refused');

await check('each with its reason', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ frequency: 'hourly', startDate: '2026-10-19' }, 'Choose how often it repeats: daily, weekly, monthly, quarterly or every so many days.'],
    [{ frequency: 'daily', interval: 0, startDate: '2026-10-19' }, 'Repeat every 1 to 365 days.'],
    [{ frequency: 'weekly', interval: 53, startDate: '2026-10-19' }, 'Repeat every 1 to 52 weeks.'],
    [{ frequency: 'monthly', interval: 1.5, startDate: '2026-10-19' }, 'Repeat every 1 to 24 months.'],
    [{ frequency: 'quarterly', interval: 9, startDate: '2026-10-19' }, 'Repeat every 1 to 8 quarters.'],
    [{ frequency: 'daily' }, 'Choose a start date.'],
    [{ frequency: 'daily', startDate: '19/10/2026' }, 'The start date is not a valid date.'],
    [{ frequency: 'daily', startDate: '2026-02-30' }, 'The start date is not a valid date.'],
    [{ frequency: 'daily', startDate: '1999-12-31' }, 'The start date must be between 1 Jan 2000 and 31 Dec 2100.'],
    [{ frequency: 'weekly', weekdays: [], startDate: '2026-10-19' }, 'Choose at least one day of the week.'],
    [{ frequency: 'weekly', weekdays: [1, 8], startDate: '2026-10-19' }, 'Days of the week are numbered 1 (Monday) to 7 (Sunday).'],
    [{ frequency: 'monthly', dayOfMonth: 32, startDate: '2026-10-19' }, 'The day of the month is 1 to 31, or the last day.'],
    [{ frequency: 'monthly', dayOfMonth: 'first', startDate: '2026-10-19' }, 'The day of the month is 1 to 31, or the last day.'],
    [{ frequency: 'daily', startDate: '2026-10-19', endDate: '2026-10-18' }, 'The end date cannot be before the start date.'],
    [{ frequency: 'daily', startDate: '2026-10-19', endDate: '2026-13-01' }, 'The end date is not a valid date.'],
    [{ frequency: 'daily', startDate: '2026-10-19', count: 0 }, 'The number of occurrences is 1 to 1,000.'],
    [{ frequency: 'daily', startDate: '2026-10-19', count: 1001 }, 'The number of occurrences is 1 to 1,000.'],
    [{ frequency: 'monthly', dayOfMonth: 25, startDate: '2026-10-26', endDate: '2026-11-20' }, 'That rule has no occurrences: its end date comes before its first day.'],
    [{ frequency: 'quarterly', interval: 8, startDate: '2026-10-19', count: 200 }, 'That rule does not reach 200 occurrences before 31 Dec 2200.'],
    [{ frequency: 'daily', startDate: '2026-10-19', nonWorkingDays: 'sometimes' }, 'Choose what happens on a non-working day: keep it, leave it out, or move it to the next working day.'],
  ];
  for (const [input, reason] of cases) assert.equal(refusal(input), reason, JSON.stringify(input));
  assert.equal(refusal({ frequency: 'daily', startDate: '2026-10-19', interval: '2', count: '3' }), 'accepted', 'numbers sent as text are read');
  const stored = rule({ frequency: 'daily', startDate: '2026-10-19', weekdays: [1], dayOfMonth: 4, extra: true });
  assert.deepEqual(stored, { frequency: 'daily', interval: 1, startDate: '2026-10-19', nonWorkingDays: 'keep' }, 'only what the frequency uses is kept');
});

console.log('Quick enough to run on every request');

await check('a thousand occurrences, and a century of a rule that never ends, in well under a second', () => {
  const started = performance.now();
  const thousand = rule({ frequency: 'daily', startDate: '2026-10-19', count: 1000, nonWorkingDays: 'skip' }, calendar);
  assert.equal(all(thousand, calendar).length, 1000);
  assert.equal(nextOccurrences(rule({ frequency: 'weekly', weekdays: [1, 3, 5], startDate: '2000-01-03' }), '2099-12-01', 3).length, 3);
  const took = performance.now() - started;
  assert.ok(took < 1000, `took ${Math.round(took)} ms`);
});

console.log(`\n${passed} passed`);
