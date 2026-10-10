import assert from 'node:assert/strict';

import { render } from '../../lib/i18n.js';
import { dayOf, isoOf, type WorkingCalendar } from '../critical-path.js';
import {
  compileFormula,
  encodeValue,
  evaluateFields,
  findCycle,
  keyProblem,
  LIMITS,
  measure,
  outputValue,
  parseFormula,
  readCustomValue,
  roundTo,
  type FieldPlan,
  type FormulaEnvironment,
  type Outcome,
  type ValueType,
  type WorkItem,
} from '../expression.js';

/**
 * Worked examples for calculated fields' formulas (BR-406 to BR-408): the
 * parser and its precedence, every function, missing values, types, errors
 * with their positions, circles of references, the bounds on a formula, and a
 * representative set of fields over a small project — each value worked by
 * hand — including missing inputs and roll-ups over children. Last, the time
 * a thousand work packages take.
 *
 *   npx tsx src/domain/__checks__/expression.check.ts
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

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Monday to Friday, with one holiday: Wednesday 14 October 2026. */
const calendar: WorkingCalendar = { weekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set(['2026-10-14']) };
const TODAY = '2026-10-13';

const env: FormulaEnvironment = {
  customFields: new Map([
    [3, { name: 'Change value', format: 'float', type: 'number' as ValueType }],
    [8, { name: 'Severity', format: 'list', type: 'text' as ValueType }],
    [9, { name: 'Go-live', format: 'date', type: 'date' as ValueType }],
    [7, { name: 'Reviewer', format: 'user', type: null }],
    [41, { name: 'Margin', format: 'float', type: 'number' as ValueType, calculatedKey: 'margin' }],
  ]),
  calculated: new Map([
    ['margin', { name: 'Margin', type: 'number' as ValueType, active: true }],
    ['cost', { name: 'Cost', type: 'number' as ValueType, active: true }],
    ['retired', { name: 'Retired', type: 'number' as ValueType, active: false }],
    ['label', { name: 'Label', type: 'text' as ValueType, active: true }],
  ]),
};

const item = (id: number, extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  projectId: 1,
  typeId: 1,
  parentId: null,
  estimatedHours: null,
  remainingHours: null,
  spentHours: 0,
  percentDone: null,
  startDate: null,
  dueDate: null,
  storyPoints: null,
  custom: new Map(),
  ...extra,
});

/** The environment with more calculated fields in it. */
function envWith(keys: Record<string, ValueType>): FormulaEnvironment {
  const calculated = new Map(env.calculated);
  for (const [key, type] of Object.entries(keys)) calculated.set(key, { name: key, type, active: true });
  return { ...env, calculated };
}

/**
 * Compiles `source` as the field `key`, failing loudly when it does not
 * compile. As when a field is saved, the field itself is among those its
 * formula may read — which is how a field rolls itself up.
 */
function plan(
  key: string,
  source: string,
  type?: ValueType,
  extra: Partial<FieldPlan> = {},
  others: Record<string, ValueType> = {},
): FieldPlan {
  const result = compileFormula(source, envWith({ ...others, [key]: type ?? 'number' }), type);
  if (!result.ok) throw new Error(`${source}: ${render('en', result.error.message)}`);
  return { id: `id-${key}`, key, type: result.compiled.type, compiled: result.compiled, projectIds: null, typeIds: null, ...extra };
}

/** The type a formula gives. */
function typeOf(source: string): string | undefined {
  const result = compileFormula(source, env);
  return result.ok ? result.compiled.type : undefined;
}

/** One formula on one work package (with its children, when given). */
function value(source: string, target: WorkItem = item(1), others: WorkItem[] = []): Outcome {
  const field = plan('probe', source);
  const results = evaluateFields([field], [target, ...others], { today: TODAY, calendar });
  return results.get(field.id)!.get(target.id)!;
}

/** The value as the API gives it: dates as YYYY-MM-DD. */
function out(source: string, target?: WorkItem, others?: WorkItem[]): unknown {
  const field = plan('probe', source);
  return outputValue(field.type, value(source, target, others).value);
}

const reason = (outcome: Outcome) => (outcome.reason ? render('en', outcome.reason) : undefined);

function fails(source: string, type?: ValueType): { message: string; start: number; end: number } {
  const result = compileFormula(source, env, type);
  assert.equal(result.ok, false, `expected ${source} to be refused`);
  if (result.ok) throw new Error('unreachable');
  return { message: render('en', result.error.message), start: result.error.start, end: result.error.end };
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

console.log('Parsing and precedence');

await check('multiplication binds tighter than addition, brackets override it', () => {
  assert.equal(out('1 + 2 * 3'), 7);
  assert.equal(out('(1 + 2) * 3'), 9);
  assert.equal(out('2 * 3 / 4'), 1.5);
});

await check('operators of one level group from the left', () => {
  assert.equal(out('10 - 4 - 3'), 3);
  assert.equal(out('64 / 4 / 2'), 8);
});

await check('a sign binds tighter than anything else', () => {
  assert.equal(out('-2 * 3'), -6);
  assert.equal(out('- -2'), 2);
  assert.equal(out('-(1 + 2)'), -3);
});

await check('and binds tighter than or; not is looser than a comparison', () => {
  assert.equal(out('true or false and false'), true);
  assert.equal(out('(true or false) and false'), false);
  assert.equal(out('not 1 = 2'), true);
  assert.equal(out('not true and false'), false);
});

await check('words and function names are not case-sensitive; == and <> are = and !=', () => {
  assert.equal(out('TRUE AND not FALSE'), true);
  assert.equal(out('round(1.25, 1)'), 1.3);
  assert.equal(out('2 == 2'), true);
  assert.equal(out('2 <> 2'), false);
});

await check('text in single or double quotes, with a backslash escape', () => {
  assert.equal(out("CONCAT('it\\'s', \" fine\")"), "it's fine");
});

await check('decimals with and without a leading digit', () => {
  assert.equal(out('.5 + 0.25'), 0.75);
});

await check('comparisons are not chained, but a bracketed one can be compared', () => {
  const error = fails('1 < 2 = true');
  assert.match(error.message, /Comparisons cannot be chained/);
  assert.deepEqual([error.start, error.end], [0, 7]);
  assert.equal(out('(1 < 2) = true'), true);
});

/* -------------------------------------------------------------------------- */
/* Functions                                                                  */
/* -------------------------------------------------------------------------- */

console.log('Every function');

await check('IF picks its branch; a condition with no value picks the last', () => {
  assert.equal(out('IF(true, 1, 2)'), 1);
  assert.equal(out('IF(false, 1, 2)'), 2);
  assert.equal(out('IF(estimatedHours > 1, 1, 2)'), 2);
});

await check('COALESCE gives the first argument with a value', () => {
  assert.equal(out('COALESCE(null, estimatedHours, 2, 3)'), 2);
  assert.equal(out('COALESCE(estimatedHours, 0)', item(1, { estimatedHours: 6 })), 6);
});

await check('ROUND rounds half away from nought, to 0 places unless told', () => {
  assert.equal(out('ROUND(2.5)'), 3);
  assert.equal(out('ROUND(-2.5)'), -3);
  assert.equal(out('ROUND(1.005, 2)'), 1.01);
  assert.equal(out('ROUND(1234.5678, 2)'), 1234.57);
  assert.equal(roundTo(0.1 + 0.2, 10), 0.3);
});

await check('ROUND refuses places it cannot have, when it is saved or when it runs', () => {
  assert.match(fails('ROUND(1, 11)').message, /from 0 to 10 decimal places/);
  assert.match(fails('ROUND(1, 1.5)').message, /from 0 to 10 decimal places/);
  assert.match(reason(value('ROUND(1.5, storyPoints)', item(1, { storyPoints: 12 })))!, /from 0 to 10 decimal places/);
});

await check('MIN and MAX of numbers or dates, skipping those with no value', () => {
  assert.equal(out('MIN(3, 1, 2)'), 1);
  assert.equal(out('MAX(3, 1, 2)'), 3);
  assert.equal(out('MIN(estimatedHours, 4)'), 4);
  assert.equal(out("MAX(DATE('2026-01-05'), DATE('2026-03-01'))"), '2026-03-01');
  assert.equal(value('MAX(estimatedHours, remainingHours)').value, null);
});

await check('ABS drops the sign', () => {
  assert.equal(out('ABS(-3.5)'), 3.5);
  assert.equal(out('ABS(2)'), 2);
});

await check('TODAY is the day the values are computed for', () => {
  assert.equal(out('TODAY()'), TODAY);
});

await check('DAYS_BETWEEN counts calendar days, negative backwards', () => {
  assert.equal(out("DAYS_BETWEEN(DATE('2026-10-01'), DATE('2026-10-15'))"), 14);
  assert.equal(out("DAYS_BETWEEN(DATE('2026-10-15'), DATE('2026-10-01'))"), -14);
  assert.equal(out("DATE('2026-03-01') - DATE('2026-02-01')"), 28);
});

await check('ADD_DAYS and date arithmetic, a fraction of a day dropped', () => {
  assert.equal(out("ADD_DAYS(DATE('2026-10-30'), 3)"), '2026-11-02');
  assert.equal(out("ADD_DAYS(DATE('2026-03-01'), -1)"), '2026-02-28');
  assert.equal(out("ADD_DAYS(DATE('2028-02-28'), 1.9)"), '2028-02-29');
  assert.equal(out("DATE('2026-10-30') + 3"), '2026-11-02');
  assert.equal(out("2 + DATE('2026-10-30')"), '2026-11-01');
  assert.equal(out("DATE('2026-10-30') - 30"), '2026-09-30');
});

await check('WORKING_DAYS_BETWEEN counts the working calendar, from a and not b', () => {
  // Monday 12 to Monday 19 October: Mon, Tue, (Wed the holiday), Thu, Fri.
  assert.equal(out("WORKING_DAYS_BETWEEN(DATE('2026-10-12'), DATE('2026-10-19'))"), 4);
  assert.equal(out("WORKING_DAYS_BETWEEN(DATE('2026-10-19'), DATE('2026-10-12'))"), -4);
  assert.equal(out("WORKING_DAYS_BETWEEN(DATE('2026-10-12'), DATE('2026-10-12'))"), 0);
  assert.equal(out("WORKING_DAYS_BETWEEN(DATE('2026-10-17'), DATE('2026-10-19'))"), 0, 'a weekend');
});

await check('DATE reads year-month-day, and refuses a date that is not one', () => {
  assert.equal(out("DATE('2028-02-29')"), '2028-02-29');
  assert.match(fails("DATE('2026-02-30')").message, /is not a date written as year-month-day/);
  const label = item(1, { custom: new Map([[8, 'soon']]) });
  assert.match(reason(value('DATE(cf_8)', label))!, /soon is not a date/);
});

await check('CONCAT joins text, numbers, dates and true-or-false, skipping missing values', () => {
  assert.equal(out("CONCAT('a', 1.5, estimatedHours, true, ' ', DATE('2026-10-01'))"), 'a1.5true 2026-10-01');
});

/* -------------------------------------------------------------------------- */
/* Children                                                                   */
/* -------------------------------------------------------------------------- */

console.log('Children');

const parent = item(10, { estimatedHours: 1 });
const kids = [
  item(11, { parentId: 10, estimatedHours: 3, dueDate: '2026-10-20' }),
  item(12, { parentId: 10, estimatedHours: null, dueDate: '2026-11-02' }),
  item(13, { parentId: 10, estimatedHours: 5, dueDate: null }),
];

await check('aggregations over the children skip those with no value', () => {
  assert.equal(out('SUM_CHILDREN(estimatedHours)', parent, kids), 8);
  assert.equal(out('AVG_CHILDREN(estimatedHours)', parent, kids), 4);
  assert.equal(out('MIN_CHILDREN(estimatedHours)', parent, kids), 3);
  assert.equal(out('MAX_CHILDREN(estimatedHours)', parent, kids), 5);
  assert.equal(out('MAX_CHILDREN(dueDate)', parent, kids), '2026-11-02');
});

await check('COUNT_CHILDREN counts every child', () => {
  assert.equal(out('COUNT_CHILDREN()', parent, kids), 3);
  assert.equal(out('COUNT_CHILDREN()', kids[0]!, [parent, ...kids.slice(1)]), 0);
});

await check('an aggregation with nothing to aggregate has no value, and says why', () => {
  const leaf = value('SUM_CHILDREN(estimatedHours)', kids[0]!, [parent, kids[1]!, kids[2]!]);
  assert.equal(leaf.value, null);
  assert.equal(reason(leaf), 'It has no children.');
  const empty = value('SUM_CHILDREN(remainingHours)', parent, kids);
  assert.equal(empty.value, null);
  assert.equal(reason(empty), 'None of its children has a value.');
});

await check('an aggregated expression is worked out on each child', () => {
  assert.equal(out('SUM_CHILDREN(COALESCE(estimatedHours, 2) * 2)', parent, kids), 20);
  assert.equal(out('SUM_CHILDREN(IF(dueDate > TODAY(), 1, 0))', parent, kids), 2);
});

await check('nested aggregations reach grandchildren', () => {
  const root = item(20);
  const mid = [item(21, { parentId: 20 }), item(22, { parentId: 20 })];
  const leaves = [item(23, { parentId: 21, estimatedHours: 2 }), item(24, { parentId: 21, estimatedHours: 3 }), item(25, { parentId: 22, estimatedHours: 7 })];
  assert.equal(out('SUM_CHILDREN(SUM_CHILDREN(estimatedHours))', root, [...mid, ...leaves]), 12);
});

/* -------------------------------------------------------------------------- */
/* Missing values                                                             */
/* -------------------------------------------------------------------------- */

console.log('Missing values');

await check('arithmetic with a missing value has none, and names the field', () => {
  const outcome = value('estimatedHours * 2 + 1');
  assert.equal(outcome.value, null);
  assert.equal(reason(outcome), 'estimatedHours has no value.');
});

await check('a comparison with a missing value has none', () => {
  assert.equal(value('estimatedHours > 1').value, null);
  assert.equal(value('estimatedHours = estimatedHours').value, null);
});

await check('and/or follow three-valued logic', () => {
  assert.equal(out('estimatedHours > 1 and false'), false);
  assert.equal(out('estimatedHours > 1 or true'), true);
  assert.equal(value('estimatedHours > 1 and true').value, null);
  assert.equal(value('not (estimatedHours > 1)').value, null);
});

await check('division by nought has no value, and says so', () => {
  const outcome = value('estimatedHours / remainingHours', item(1, { estimatedHours: 4, remainingHours: 0 }));
  assert.equal(outcome.value, null);
  assert.equal(reason(outcome), 'Division by nought.');
});

await check('a result too large to hold has no value', () => {
  assert.equal(reason(value('1000000000 * 1000000000')), 'The result is too large to hold.');
  assert.equal(reason(value("ADD_DAYS(DATE('9999-12-30'), 5)")), 'The date falls outside the calendar.');
});

await check('a literal null fits anywhere, and gives no value', () => {
  assert.equal(value('1 + null').value, null);
  assert.equal(out('COALESCE(null, 5)'), 5);
  assert.match(fails('null').message, /always gives no value/);
});

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

console.log('Types');

await check('each part is type-checked when the formula is saved', () => {
  assert.equal(fails("'a' + 1").message, 'Cannot add text and a number.');
  assert.equal(fails('startDate * 2').message, 'Cannot multiply a date by a number.');
  assert.equal(fails('percentDone > dueDate').message, 'Cannot compare a number with a date.');
  assert.match(fails('true < false').message, /cannot be put in order/);
  assert.equal(fails('IF(1, 2, 3)').message, 'IF: argument 1 must be true or false, not a number.');
  assert.match(fails("IF(true, 1, 'a')").message, /must all be the same type/);
  assert.equal(fails('not 1').message, 'not needs true or false, not a number.');
  assert.equal(fails("-'a'").message, 'A sign needs a number, not text.');
  assert.match(fails('1 and true').message, /and needs true or false on both sides/);
  assert.equal(fails("DAYS_BETWEEN(1, DATE('2026-01-01'))").message, 'DAYS_BETWEEN: argument 1 must be a date, not a number.');
  assert.match(fails("SUM_CHILDREN('x')").message, /argument 1 must be a number/);
});

await check('dates and numbers combine as dates do', () => {
  assert.equal(typeOf('startDate + 1'), 'date');
  assert.equal(typeOf('dueDate - startDate'), 'number');
  assert.equal(typeOf('dueDate - 2'), 'date');
  assert.match(fails('1 - startDate').message, /Cannot subtract a date from a number/);
});

await check('the formula must give the type the field holds', () => {
  assert.equal(fails('1 + 1', 'date').message, 'The formula gives a number, but the field holds a date.');
  assert.equal(compileFormula("IF(dueDate < TODAY(), 'Late', 'On time')", env, 'text').ok, true);
});

await check('custom fields read as their format; a list as its option', () => {
  assert.equal(readCustomValue('number', ['12.5']), 12.5);
  assert.equal(readCustomValue('date', ['2026-10-01']), dayOf('2026-10-01'));
  assert.equal(readCustomValue('boolean', ['t']), true);
  assert.equal(readCustomValue('boolean', ['f']), false);
  assert.equal(readCustomValue('text', ['2', '3'], new Map([['2', 'High'], ['3', 'Low']])), 'High, Low');
  assert.equal(readCustomValue('number', [null]), null);
  assert.equal(readCustomValue('number', ['']), null);
  const valued = item(1, { custom: new Map<number, string | number | boolean | null>([[3, 1500], [9, dayOf('2026-12-01')], [8, 'High']]) });
  assert.equal(out("cf_3 * 2 + DAYS_BETWEEN(TODAY(), cf_9) + IF(cf_8 = 'High', 1, 0)", valued), 3000 + 49 + 1);
});

await check('values are written for OpenProject as it stores them', () => {
  assert.equal(encodeValue('number', 12.5), '12.5');
  assert.equal(encodeValue('number', 1 / 3), '0.33');
  assert.equal(encodeValue('number', 1 / 3, 4), '0.3333');
  assert.equal(encodeValue('number', -0.001), '0');
  assert.equal(encodeValue('number', 12), '12');
  assert.equal(encodeValue('date', dayOf('2026-10-01')), '2026-10-01');
  assert.equal(encodeValue('boolean', true), 't');
  assert.equal(encodeValue('boolean', false), 'f');
  assert.equal(encodeValue('text', 'Late'), 'Late');
  assert.equal(encodeValue('number', null), null);
});

/* -------------------------------------------------------------------------- */
/* Errors and positions                                                       */
/* -------------------------------------------------------------------------- */

console.log('Errors, with their positions');

await check('an unknown field is named, with the nearest one when it looks like a typo', () => {
  assert.deepEqual(fails('estimatedHourz * 2'), {
    message: 'There is no field estimatedHourz. Did you mean estimatedHours?',
    start: 0,
    end: 14,
  });
  assert.deepEqual(fails('1 + nothingLikeIt'), { message: 'There is no field nothingLikeIt.', start: 4, end: 17 });
});

await check('an unknown function is named', () => {
  assert.deepEqual(fails('2 * ROUNDUP(1)'), { message: 'There is no function ROUNDUP. Did you mean ROUND?', start: 4, end: 11 });
  assert.equal(fails('FROB(1)').message, 'There is no function FROB.');
});

await check('a function given the wrong number of arguments says how many it takes', () => {
  assert.deepEqual(fails('ABS(1, 2)'), { message: 'ABS takes 1 argument.', start: 0, end: 9 });
  assert.equal(fails('TODAY(1)').message, 'TODAY takes no arguments.');
  assert.equal(fails('ROUND(1, 2, 3)').message, 'ROUND takes from 1 to 2 arguments.');
});

await check('syntax errors point at where the formula goes wrong', () => {
  assert.deepEqual(fails('estimatedHours +'), { message: 'The formula ends where a value was expected.', start: 16, end: 16 });
  assert.deepEqual(fails('ROUND(1, 2'), { message: 'A closing bracket is missing.', start: 0, end: 10 });
  assert.deepEqual(fails('(1 + 2'), { message: 'A closing bracket is missing.', start: 0, end: 6 });
  assert.deepEqual(fails('1 @ 2'), { message: '@ cannot be used in a formula.', start: 2, end: 3 });
  assert.deepEqual(fails("'abc"), { message: 'This text has no closing quote.', start: 0, end: 4 });
  assert.deepEqual(fails('12abc'), { message: '12abc is not a number.', start: 0, end: 5 });
  assert.deepEqual(fails('estimatedHours 2'), {
    message: 'Expected an operator or the end of the formula before 2.',
    start: 15,
    end: 16,
  });
  assert.deepEqual(fails('* 2'), { message: 'Expected a value, found *.', start: 0, end: 1 });
  assert.deepEqual(fails(''), { message: 'The formula is empty.', start: 0, end: 0 });
  assert.equal(fails('MAX(1 2)').message, 'Expected a comma or a closing bracket, found 2.');
});

await check('custom fields that cannot be read are refused, and a calculated one is named by its key', () => {
  assert.deepEqual(fails('cf_99 + 1'), { message: 'There is no custom field cf_99.', start: 0, end: 5 });
  assert.equal(fails('cf_7').message, 'Reviewer (cf_7) is a user field, which a formula cannot read.');
  assert.equal(fails('cf_41 * 2').message, 'cf_41 is the calculated field Margin: refer to it by its key, margin.');
  assert.equal(fails('retired + 1').message, 'retired is switched off, so it has no values to read.');
});

await check('a key must be an identifier no formula reserves', () => {
  assert.equal(keyProblem('margin'), null);
  assert.equal(keyProblem('total_cost2'), null);
  assert.notEqual(keyProblem('Margin'), null);
  assert.notEqual(keyProblem('x'), null);
  assert.notEqual(keyProblem('and'), null);
  assert.notEqual(keyProblem('estimatedHours'), null);
  assert.notEqual(keyProblem('cf_12'), null);
  assert.notEqual(keyProblem('today'), null);
});

/* -------------------------------------------------------------------------- */
/* Circles (BR-408)                                                           */
/* -------------------------------------------------------------------------- */

console.log('Circular references (BR-408)');

const edges = (graph: Record<string, string[]>) => (key: string) => graph[key] ?? [];

await check('a circle is found, and named from the field being saved', () => {
  assert.deepEqual(findCycle('margin', edges({ margin: ['cost'], cost: ['margin'] })), ['margin', 'cost', 'margin']);
  assert.deepEqual(findCycle('a', edges({ a: ['b'], b: ['c'], c: ['a'] })), ['a', 'b', 'c', 'a']);
  assert.deepEqual(findCycle('total', edges({ total: ['total'] })), ['total', 'total']);
});

await check('references that do not come back are no circle, however they branch', () => {
  assert.equal(findCycle('a', edges({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] })), null);
  assert.equal(findCycle('a', edges({ a: ['b'], b: ['c'], c: ['b'] })), null, 'a circle that a does not belong to');
});

await check('a reference inside a child aggregation is not an edge: a field may roll itself up', () => {
  const compiled = compileFormula('estimatedHours + COALESCE(SUM_CHILDREN(margin), 0)', env, 'number');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  assert.deepEqual(compiled.compiled.references.calculated, []);
  assert.deepEqual(compiled.compiled.references.childCalculated, ['margin']);
  const same = compileFormula('estimatedHours + margin', env, 'number');
  assert.equal(same.ok && same.compiled.references.calculated.join(), 'margin');
});

await check('a field that rolls itself up adds up its whole tree, children first', () => {
  const total = plan('total', 'estimatedHours + COALESCE(SUM_CHILDREN(total), 0)', 'number');
  const tree = [
    item(1, { estimatedHours: 1 }),
    item(2, { parentId: 1, estimatedHours: 2 }),
    item(3, { parentId: 1, estimatedHours: 4 }),
    item(4, { parentId: 2, estimatedHours: 8 }),
    item(5, { parentId: 4, estimatedHours: 16 }),
  ];
  const results = evaluateFields([total], tree, { today: TODAY, calendar }).get(total.id)!;
  assert.deepEqual(tree.map((entry) => results.get(entry.id)?.value), [31, 26, 4, 24, 16]);
});

await check('fields reading each other on one work package are worked out in order', () => {
  const keys = { a: 'number', b: 'number', c: 'number' } as const;
  const fields = [plan('c', 'b * 2', 'number', {}, keys), plan('b', 'a + 1', 'number', {}, keys), plan('a', 'estimatedHours', 'number', {}, keys)];
  const results = evaluateFields(fields, [item(1, { estimatedHours: 3 })], { today: TODAY, calendar });
  assert.equal(results.get('id-c')!.get(1)!.value, 8);
  assert.equal(results.get('id-b')!.get(1)!.value, 4);
});

await check('a circle saved by two servers at once is reported on every field in it, never looped', () => {
  const margin = plan('margin', 'cost + 1', 'number');
  const cost = plan('cost', 'margin * 2', 'number');
  const results = evaluateFields([margin, cost], [item(1)], { today: TODAY, calendar });
  assert.equal(reason(results.get(margin.id)!.get(1)!), 'Circular reference: margin → cost → margin.');
  assert.equal(results.get(cost.id)!.get(1)!.value, null);
});

/* -------------------------------------------------------------------------- */
/* Bounds (BR-408)                                                            */
/* -------------------------------------------------------------------------- */

console.log('Bounds on a formula (BR-408)');

await check(`at most ${LIMITS.nodes} parts`, () => {
  const part = '(1 + 2) * (3 + 4) + (5 + 6) * (7 + 8)'; // 15 parts
  const within = `MAX(${Array.from({ length: 13 }, () => part).join(', ')})`;
  assert.equal(measure(parseFormula(within)).nodes, 13 * 15 + 1);
  assert.equal(compileFormula(within, env).ok, true);
  const over = `MAX(${Array.from({ length: 14 }, () => part).join(', ')})`;
  assert.equal(fails(over).message, `The formula is too complex: ${14 * 15 + 1} parts, at most ${LIMITS.nodes}.`);
});

await check(`at most ${LIMITS.depth} levels deep`, () => {
  const nest = (levels: number) => `${'ABS('.repeat(levels)}1${')'.repeat(levels)}`;
  assert.equal(measure(parseFormula(nest(LIMITS.depth - 1))).depth, LIMITS.depth);
  assert.equal(compileFormula(nest(LIMITS.depth - 1), env).ok, true);
  const error = fails(nest(LIMITS.depth));
  assert.equal(error.message, `The formula nests too deeply: at most ${LIMITS.depth} levels.`);
  assert.equal(error.start, 4 * LIMITS.depth, 'it points at the part too deep');
  assert.match(fails('('.repeat(400) + '1' + ')'.repeat(400)).message, /nests too deeply/, 'brackets alone cannot exhaust the parser');
});

await check(`at most ${LIMITS.aggregations} child aggregations inside one another`, () => {
  const nest = (levels: number) => `${'SUM_CHILDREN('.repeat(levels)}estimatedHours${')'.repeat(levels)}`;
  assert.equal(measure(parseFormula(nest(LIMITS.aggregations))).aggregations, LIMITS.aggregations);
  assert.equal(compileFormula(nest(LIMITS.aggregations), env).ok, true);
  assert.equal(
    fails(nest(LIMITS.aggregations + 1)).message,
    `Too many child aggregations inside one another: at most ${LIMITS.aggregations}.`,
  );
});

await check(`at most ${LIMITS.length} characters`, () => {
  const long = `1${' + 1'.repeat(LIMITS.length)}`;
  assert.equal(fails(long).message, `The formula is too long: at most ${LIMITS.length} characters.`);
});

/* -------------------------------------------------------------------------- */
/* A representative set (BR-406)                                              */
/* -------------------------------------------------------------------------- */

console.log('A representative set of fields over a small project (BR-406)');

/*
 * Today is Tuesday 13 October 2026; Wednesday 14 is a holiday.
 *
 *   P  Phase              (parent of A, B, C)         estimate 2    spent 9 (its own 2 + below)
 *   A  Design             est 8   spent 5  rem 3   60%  12 Oct – 16 Oct   3 points
 *   B  Build              est –   spent 2  rem –    0%  19 Oct – (none)   – points
 *   C  Test               est 4   spent 0  rem 4  100%  (none) – 9 Oct    5 points   (parent of D)
 *   D  Test data          est 2   spent 0  rem 2   50%  5 Oct – 8 Oct     1 point
 */
const P = item(100, { estimatedHours: 2, spentHours: 9, percentDone: 40 });
const A = item(101, { parentId: 100, estimatedHours: 8, spentHours: 5, remainingHours: 3, percentDone: 60, startDate: '2026-10-12', dueDate: '2026-10-16', storyPoints: 3 });
const B = item(102, { parentId: 100, estimatedHours: null, spentHours: 2, remainingHours: null, percentDone: 0, startDate: '2026-10-19', storyPoints: null });
const C = item(103, { parentId: 100, estimatedHours: 4, spentHours: 0, remainingHours: 4, percentDone: 100, dueDate: '2026-10-09', storyPoints: 5 });
const D = item(104, { parentId: 103, estimatedHours: 2, spentHours: 0, remainingHours: 2, percentDone: 50, startDate: '2026-10-05', dueDate: '2026-10-08', storyPoints: 1 });
const project = [P, A, B, C, D];

const representative: { key: string; source: string; type: ValueType; expected: Record<string, unknown>; reasons?: Record<string, string> }[] = [
  {
    key: 'variance',
    source: 'estimatedHours - spentHours',
    type: 'number',
    expected: { P: -7, A: 3, B: null, C: 4, D: 2 },
    reasons: { B: 'estimatedHours has no value.' },
  },
  {
    key: 'burn',
    source: 'ROUND(spentHours / estimatedHours * 100, 1)',
    type: 'number',
    expected: { P: 450, A: 62.5, B: null, C: 0, D: 0 },
  },
  {
    key: 'late',
    source: 'dueDate < TODAY() and percentDone < 100',
    type: 'boolean',
    expected: { P: null, A: false, B: null, C: false, D: true },
    reasons: { P: 'dueDate has no value.' },
  },
  {
    key: 'daysLeft',
    source: 'WORKING_DAYS_BETWEEN(TODAY(), dueDate)',
    type: 'number',
    // From Tuesday 13: A's Friday 16 is Tue, Thu = 2 (Wednesday is the holiday).
    expected: { P: null, A: 2, B: null, C: -2, D: -3 },
  },
  {
    key: 'finish',
    source: 'COALESCE(dueDate, ADD_DAYS(startDate, 10))',
    type: 'date',
    expected: { P: null, A: '2026-10-16', B: '2026-10-29', C: '2026-10-09', D: '2026-10-08' },
  },
  {
    key: 'stage',
    source: "IF(percentDone = 100, 'Done', IF(percentDone > 0, 'Started', 'Not started'))",
    type: 'text',
    expected: { P: 'Started', A: 'Started', B: 'Not started', C: 'Done', D: 'Started' },
  },
  {
    key: 'cost',
    source: 'COALESCE(estimatedHours, 0) * 120',
    type: 'number',
    expected: { P: 240, A: 960, B: 0, C: 480, D: 240 },
  },
  {
    key: 'rollup',
    source: 'SUM_CHILDREN(estimatedHours)',
    type: 'number',
    expected: { P: 12, A: null, B: null, C: 2, D: null },
    reasons: { A: 'It has no children.' },
  },
  {
    key: 'points',
    source: 'COALESCE(storyPoints, 0) + COALESCE(SUM_CHILDREN(points), 0)',
    type: 'number',
    expected: { P: 9, A: 3, B: 0, C: 6, D: 1 },
  },
  {
    key: 'margin',
    source: 'IF(cost > 0, ROUND((cost - spentHours * 120) / cost * 100, 0), null)',
    type: 'number',
    expected: { P: -350, A: 38, B: null, C: 100, D: 100 },
  },
  {
    key: 'lateChildren',
    source: 'SUM_CHILDREN(IF(late, 1, 0))',
    type: 'number',
    expected: { P: 0, A: null, B: null, C: 1, D: null },
  },
];

await check('every field gives the value worked by hand on every work package, missing inputs included', () => {
  const representativeEnv: FormulaEnvironment = {
    ...env,
    calculated: new Map(representative.map((field) => [field.key, { name: field.key, type: field.type, active: true }])),
  };
  const plans = representative.map((field) => {
    const result = compileFormula(field.source, representativeEnv, field.type);
    if (!result.ok) throw new Error(`${field.key}: ${render('en', result.error.message)}`);
    return { id: field.key, key: field.key, type: field.type, compiled: result.compiled, projectIds: null, typeIds: null } satisfies FieldPlan;
  });
  const results = evaluateFields(plans, project, { today: TODAY, calendar });
  const names: Record<number, string> = { 100: 'P', 101: 'A', 102: 'B', 103: 'C', 104: 'D' };
  const rows: string[] = [];
  for (const field of representative) {
    for (const entry of project) {
      const outcome = results.get(field.key)!.get(entry.id)!;
      const actual = outputValue(field.type, outcome.value);
      const name = names[entry.id]!;
      assert.deepEqual(actual, field.expected[name], `${field.key} on ${name}`);
      if (field.reasons?.[name]) assert.equal(reason(outcome), field.reasons[name], `${field.key} on ${name}: why it is empty`);
    }
    rows.push(`${field.key.padEnd(13)} ${field.source.padEnd(72)} ${project.map((entry) => `${names[entry.id]}=${JSON.stringify(outputValue(field.type, results.get(field.key)!.get(entry.id)!.value))}`).join(' ')}`);
  }
  for (const row of rows) console.log(`        ${row}`);
});

await check('a field applies only to its projects and types; elsewhere it has no value at all', () => {
  const scoped = plan('scoped', 'estimatedHours * 2', 'number', { projectIds: new Set([2]), typeIds: null });
  const reader = plan('reader', 'COALESCE(scoped, -1)', 'number', {}, { scoped: 'number' });
  assert.equal(
    reason(evaluateFields([scoped, plan('bare', 'scoped + 1', 'number', {}, { scoped: 'number' })], [item(1)], { today: TODAY, calendar }).get('id-bare')!.get(1)!),
    'scoped does not apply to this work package.',
  );
  const results = evaluateFields([scoped, reader], [item(1, { projectId: 1, estimatedHours: 3 }), item(2, { projectId: 2, estimatedHours: 3 })], {
    today: TODAY,
    calendar,
  });
  assert.equal(results.get(scoped.id)!.has(1), false);
  assert.equal(results.get(scoped.id)!.get(2)!.value, 6);
  assert.equal(results.get(reader.id)!.get(1)!.value, -1);
  const typed = plan('typed', '1', 'number', { projectIds: null, typeIds: new Set([7]) });
  const typedResults = evaluateFields([typed], [item(1, { typeId: 7 }), item(2, { typeId: 8 })], { today: TODAY, calendar }).get(typed.id)!;
  assert.deepEqual([...typedResults.keys()], [1]);
});

/* -------------------------------------------------------------------------- */
/* Cost (BR-408)                                                              */
/* -------------------------------------------------------------------------- */

console.log('Evaluation cost (BR-408)');

await check('a thousand work packages, five fields and a roll-up, well within a second', () => {
  const items: WorkItem[] = [];
  for (let parentAt = 0; parentAt < 100; parentAt += 1) {
    const parentId = 1_000 + parentAt * 10;
    items.push(item(parentId, { estimatedHours: 1 }));
    for (let child = 1; child < 10; child += 1) {
      items.push(
        item(parentId + child, {
          parentId,
          estimatedHours: child % 4 === 0 ? null : child,
          spentHours: child / 2,
          percentDone: child * 10,
          startDate: isoOf(dayOf('2026-10-01') + child),
          dueDate: isoOf(dayOf('2026-10-10') + child * 3),
        }),
      );
    }
  }
  const scaleEnv: FormulaEnvironment = {
    ...env,
    calculated: new Map([
      ['v', { name: 'v', type: 'number' as ValueType, active: true }],
      ['tot', { name: 'tot', type: 'number' as ValueType, active: true }],
    ]),
  };
  const fields = [
    ['v', 'COALESCE(estimatedHours, 0) - spentHours'],
    ['late', 'dueDate < TODAY() and percentDone < 100'],
    ['left', 'WORKING_DAYS_BETWEEN(TODAY(), dueDate)'],
    ['tot', 'COALESCE(estimatedHours, 0) + COALESCE(SUM_CHILDREN(tot), 0)'],
    ['share', 'IF(tot > 0, ROUND(v / tot * 100, 1), null)'],
  ].map(([key, source]) => {
    const result = compileFormula(source!, scaleEnv);
    if (!result.ok) throw new Error(render('en', result.error.message));
    return { id: key!, key: key!, type: result.compiled.type, compiled: result.compiled, projectIds: null, typeIds: null } satisfies FieldPlan;
  });
  const started = performance.now();
  const results = evaluateFields(fields, items, { today: TODAY, calendar });
  const took = performance.now() - started;
  assert.equal(results.get('tot')!.get(1_000)!.value, 1 + (1 + 2 + 3 + 5 + 6 + 7 + 9));
  assert.ok(took < 1_000, `took ${Math.round(took)} ms`);
  console.log(`        (${items.length} work packages × ${fields.length} fields: ${Math.round(took)} ms)`);
});

console.log(`\n${passed} passed`);
