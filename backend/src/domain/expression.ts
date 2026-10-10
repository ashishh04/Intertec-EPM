import { message, msg, type Message } from '../lib/i18n.js';
import { DayCounter, dayOf, isoOf, type WorkingCalendar } from './critical-path.js';

/**
 * The formula language of calculated fields (BR-406 to BR-408).
 *
 * A formula is a small expression over one work package: its own fields, its
 * custom fields, other calculated fields, and its children. Written once by
 * whoever holds `fields:configure`, it is parsed and type-checked when it is
 * saved — so a mistake is refused there, with its position, rather than
 * producing wrong figures later — and evaluated by EPM on every change.
 *
 *   ROUND(estimatedHours - spentHours, 1)
 *   IF(dueDate < TODAY() and percentDone < 100, 'Late', 'On time')
 *   COALESCE(SUM_CHILDREN(cost), 0) + estimatedHours * 120
 *
 * Values are numbers, dates, text and true-or-false. Any of them can be
 * missing ("no value"): a field nobody filled in, a division by nought. The
 * rules for a missing value are SQL's: arithmetic or a comparison with one has
 * none either; `and`/`or` follow three-valued logic; aggregations skip it;
 * `COALESCE` and `IF` are how a formula decides otherwise. A value that is
 * missing carries the reason, so a person can be told why a cell is empty.
 *
 * Children: `SUM_CHILDREN(x)` evaluates `x` on each direct child and sums the
 * results; `x` may itself aggregate, reaching grandchildren. A field may roll
 * itself up — `estimatedHours + COALESCE(SUM_CHILDREN(total), 0)` inside
 * `total` — because a child's value is always worked out before its parent's.
 * A reference outside an aggregation is to the same work package, and those
 * must not go round in a circle: that is refused when the field is saved, with
 * the circle named.
 *
 * Pure: no database and no OpenProject. `calculated-fields.ts` reads the
 * inputs and stores what this returns.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type ValueType = 'number' | 'date' | 'text' | 'boolean';
export const VALUE_TYPES: readonly ValueType[] = ['number', 'date', 'text', 'boolean'];
/** A literal `null` has no type of its own: it fits wherever a value does. */
type StaticType = ValueType | 'null';

/**
 * A value as the evaluator holds it. A date is a day number (days since
 * 1970-01-01, as Module 5's calendar counts them); the static type says which a
 * number is, so nothing at run time has to guess.
 */
export type Value = number | string | boolean | null;

/** A value, and — when there is none — why. */
export interface Outcome {
  value: Value;
  reason?: Message;
}

/** What a formula may be, at most (BR-408). */
export const LIMITS = {
  /** Characters. */
  length: 2_000,
  /** Values, operators and calls. */
  nodes: 200,
  /** Levels of nesting. */
  depth: 20,
  /** Child aggregations inside one another. */
  aggregations: 5,
} as const;

/** Built-in fields of a work package, as a formula names them. */
export const ATTRIBUTES = {
  estimatedHours: 'number',
  remainingHours: 'number',
  spentHours: 'number',
  percentDone: 'number',
  startDate: 'date',
  dueDate: 'date',
  storyPoints: 'number',
} as const satisfies Record<string, ValueType>;

export type Attribute = keyof typeof ATTRIBUTES;

const isAttribute = (name: string): name is Attribute => Object.hasOwn(ATTRIBUTES, name);

/** What each built-in field is, for the reference beside the editor. */
export const ATTRIBUTE_HELP: Record<Attribute, string> = {
  estimatedHours: msg('Work: the hours estimated for the work package itself.'),
  remainingHours: msg('Remaining work, in hours.'),
  spentHours: msg('Spent time: the hours logged on the work package and everything under it, as OpenProject shows it.'),
  percentDone: msg('% complete, from 0 to 100.'),
  startDate: msg('Its start date.'),
  dueDate: msg('Its finish date.'),
  storyPoints: msg('Its story points.'),
};

type FunctionName =
  | 'IF'
  | 'COALESCE'
  | 'ROUND'
  | 'MIN'
  | 'MAX'
  | 'ABS'
  | 'TODAY'
  | 'DAYS_BETWEEN'
  | 'ADD_DAYS'
  | 'WORKING_DAYS_BETWEEN'
  | 'DATE'
  | 'CONCAT'
  | 'SUM_CHILDREN'
  | 'AVG_CHILDREN'
  | 'MIN_CHILDREN'
  | 'MAX_CHILDREN'
  | 'COUNT_CHILDREN';

interface FunctionSpec {
  min: number;
  max: number;
  /** How it is written, for the reference. */
  signature: string;
  help: string;
  /** Evaluates its argument on each child. */
  aggregate?: boolean;
}

export const FUNCTIONS: Record<FunctionName, FunctionSpec> = {
  IF: {
    min: 3,
    max: 3,
    signature: 'IF(condition, then, otherwise)',
    help: msg('The second argument when the condition holds, otherwise the third. A condition with no value counts as not holding.'),
  },
  COALESCE: { min: 1, max: 20, signature: 'COALESCE(a, b, …)', help: msg('The first argument that has a value.') },
  ROUND: {
    min: 1,
    max: 2,
    signature: 'ROUND(x, places)',
    help: msg('x rounded to a number of decimal places, 0 when left out. Halves round away from nought.'),
  },
  MIN: { min: 1, max: 20, signature: 'MIN(a, b, …)', help: msg('The smallest of the numbers or dates given, skipping any with no value.') },
  MAX: { min: 1, max: 20, signature: 'MAX(a, b, …)', help: msg('The largest of the numbers or dates given, skipping any with no value.') },
  ABS: { min: 1, max: 1, signature: 'ABS(x)', help: msg('x without its sign.') },
  TODAY: {
    min: 0,
    max: 0,
    signature: 'TODAY()',
    help: msg('Today’s date. A field that uses it is recalculated when the day changes.'),
  },
  DAYS_BETWEEN: {
    min: 2,
    max: 2,
    signature: 'DAYS_BETWEEN(a, b)',
    help: msg('Calendar days from date a to date b; negative when b is earlier.'),
  },
  ADD_DAYS: {
    min: 2,
    max: 2,
    signature: 'ADD_DAYS(date, n)',
    help: msg('The date n calendar days later, or earlier when n is negative. A fraction of a day is dropped.'),
  },
  WORKING_DAYS_BETWEEN: {
    min: 2,
    max: 2,
    signature: 'WORKING_DAYS_BETWEEN(a, b)',
    help: msg('Working days from date a to date b on the instance’s working calendar, counting a but not b; negative when b is earlier.'),
  },
  DATE: { min: 1, max: 1, signature: "DATE('2026-12-31')", help: msg('A date written as year-month-day.') },
  CONCAT: { min: 1, max: 20, signature: 'CONCAT(a, b, …)', help: msg('The arguments joined as text, skipping any with no value.') },
  SUM_CHILDREN: {
    min: 1,
    max: 1,
    aggregate: true,
    signature: 'SUM_CHILDREN(x)',
    help: msg('x worked out on each child of the work package, and added up. Children with no value are skipped.'),
  },
  AVG_CHILDREN: {
    min: 1,
    max: 1,
    aggregate: true,
    signature: 'AVG_CHILDREN(x)',
    help: msg('The average of x over the children that have a value.'),
  },
  MIN_CHILDREN: {
    min: 1,
    max: 1,
    aggregate: true,
    signature: 'MIN_CHILDREN(x)',
    help: msg('The smallest value of x among the children: a number or a date.'),
  },
  MAX_CHILDREN: {
    min: 1,
    max: 1,
    aggregate: true,
    signature: 'MAX_CHILDREN(x)',
    help: msg('The largest value of x among the children: a number or a date.'),
  },
  COUNT_CHILDREN: {
    min: 0,
    max: 0,
    aggregate: true,
    signature: 'COUNT_CHILDREN()',
    help: msg('How many children the work package has.'),
  },
};

const isFunction = (name: string): name is FunctionName => Object.hasOwn(FUNCTIONS, name);

/** Words a formula reserves; none may be a calculated field's key. */
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null']);

/** A type, as a sentence names it. */
export function typePhrase(type: StaticType): string {
  switch (type) {
    case 'number':
      return msg('a number');
    case 'date':
      return msg('a date');
    case 'text':
      return msg('text');
    case 'boolean':
      return msg('true or false');
    default:
      return msg('no value');
  }
}

/* -------------------------------------------------------------------------- */
/* Problems                                                                   */
/* -------------------------------------------------------------------------- */

/** What is wrong with a formula, and where: character offsets into it. */
export interface FormulaError {
  message: Message;
  start: number;
  end: number;
}

export class FormulaProblem extends Error {
  constructor(readonly problem: FormulaError) {
    super(problem.message.template);
    this.name = 'FormulaProblem';
  }
}

const problem = (text: Message, start: number, end: number) => new FormulaProblem({ message: text, start, end });

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

type TokenKind = 'number' | 'text' | 'name' | 'op' | 'open' | 'close' | 'comma' | 'end';

interface Token {
  kind: TokenKind;
  /** As written. */
  text: string;
  /** A number's or a text's value. */
  value?: number | string;
  start: number;
  end: number;
}

const OPERATORS = ['<=', '>=', '<>', '!=', '==', '=', '<', '>', '+', '-', '*', '/'];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at]!;
    if (/\s/.test(ch)) {
      at += 1;
      continue;
    }
    const start = at;
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[at + 1] ?? ''))) {
      const match = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)/.exec(source.slice(at))!;
      at += match[0].length;
      if (/^[A-Za-z_.]/.test(source.slice(at))) {
        const tail = /^[A-Za-z0-9_.]*/.exec(source.slice(at))![0];
        throw problem(message('{text} is not a number.', { text: match[0] + tail }), start, at + tail.length);
      }
      tokens.push({ kind: 'number', text: match[0], value: Number(match[0]), start, end: at });
      continue;
    }
    if (ch === "'" || ch === '"') {
      let value = '';
      at += 1;
      let closed = false;
      while (at < source.length) {
        const next = source[at]!;
        if (next === '\\' && at + 1 < source.length) {
          value += source[at + 1]!;
          at += 2;
          continue;
        }
        if (next === ch) {
          closed = true;
          at += 1;
          break;
        }
        value += next;
        at += 1;
      }
      if (!closed) throw problem(message('This text has no closing quote.'), start, source.length);
      tokens.push({ kind: 'text', text: source.slice(start, at), value, start, end: at });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at))![0];
      at += name.length;
      tokens.push({ kind: 'name', text: name, start, end: at });
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      at += 1;
      tokens.push({ kind: ch === '(' ? 'open' : ch === ')' ? 'close' : 'comma', text: ch, start, end: at });
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, at));
    if (operator) {
      at += operator.length;
      tokens.push({ kind: 'op', text: operator, start, end: at });
      continue;
    }
    throw problem(message('{character} cannot be used in a formula.', { character: ch }), start, start + 1);
  }
  tokens.push({ kind: 'end', text: '', start: source.length, end: source.length });
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* Syntax                                                                     */
/* -------------------------------------------------------------------------- */

type BinaryOp = '+' | '-' | '*' | '/' | '=' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';
type UnaryOp = '-' | '+' | 'not';

export type Reference = { kind: 'attribute'; name: Attribute } | { kind: 'custom'; id: number } | { kind: 'calculated'; key: string };

interface Base {
  start: number;
  end: number;
  /** Written in brackets: a comparison inside may be compared again. */
  grouped?: boolean;
  /** Set by the type checker. */
  type?: StaticType;
}

export type Node =
  | (Base & { kind: 'literal'; value: Value; literal: StaticType })
  | (Base & { kind: 'field'; name: string; ref?: Reference })
  | (Base & { kind: 'unary'; op: UnaryOp; operand: Node })
  | (Base & { kind: 'binary'; op: BinaryOp; left: Node; right: Node })
  | (Base & { kind: 'call'; name: FunctionName; args: Node[] });

const INFIX: Record<string, { op: BinaryOp; power: number }> = {
  or: { op: 'or', power: 10 },
  and: { op: 'and', power: 20 },
  '=': { op: '=', power: 30 },
  '==': { op: '=', power: 30 },
  '!=': { op: '!=', power: 30 },
  '<>': { op: '!=', power: 30 },
  '<': { op: '<', power: 30 },
  '<=': { op: '<=', power: 30 },
  '>': { op: '>', power: 30 },
  '>=': { op: '>=', power: 30 },
  '+': { op: '+', power: 40 },
  '-': { op: '-', power: 40 },
  '*': { op: '*', power: 50 },
  '/': { op: '/', power: 50 },
};
/** `not` binds looser than a comparison: `not a = b` is `not (a = b)`. */
const NOT_POWER = 25;
const SIGN_POWER = 60;
const COMPARISONS = new Set<BinaryOp>(['=', '!=', '<', '<=', '>', '>=']);

/** Guards the call stack; the real bound on nesting is LIMITS.depth, measured on the tree. */
const MAX_PARSE_NESTING = 200;

/** How a token reads in a message. */
const shown = (token: Token): string => (token.kind === 'end' ? '' : token.text);

class Parser {
  private readonly tokens: Token[];
  private at = 0;
  private nesting = 0;

  constructor(private readonly source: string) {
    this.tokens = tokenize(source);
  }

  parse(): Node {
    if (this.peek().kind === 'end') throw problem(message('The formula is empty.'), 0, 0);
    const node = this.expression(0);
    const next = this.peek();
    if (next.kind !== 'end') {
      throw problem(message('Expected an operator or the end of the formula before {token}.', { token: shown(next) }), next.start, next.end);
    }
    return node;
  }

  private peek(): Token {
    return this.tokens[this.at]!;
  }

  private take(): Token {
    const token = this.tokens[this.at]!;
    if (token.kind !== 'end') this.at += 1;
    return token;
  }

  private infix(token: Token): { op: BinaryOp; power: number } | undefined {
    if (token.kind === 'op') return INFIX[token.text];
    if (token.kind === 'name') {
      const word = token.text.toLowerCase();
      if (word === 'and' || word === 'or') return INFIX[word];
    }
    return undefined;
  }

  private expression(minPower: number): Node {
    this.nesting += 1;
    if (this.nesting > MAX_PARSE_NESTING) {
      const token = this.peek();
      throw problem(message('The formula nests too deeply: at most {max} levels.', { max: LIMITS.depth }), token.start, token.end);
    }
    try {
      let left = this.prefix();
      for (;;) {
        const token = this.peek();
        const infix = this.infix(token);
        if (!infix || infix.power <= minPower) break;
        this.take();
        if (COMPARISONS.has(infix.op) && left.kind === 'binary' && COMPARISONS.has(left.op) && !left.grouped) {
          throw problem(message('Comparisons cannot be chained: join them with and.'), left.start, token.end);
        }
        const right = this.expression(infix.power);
        left = { kind: 'binary', op: infix.op, left, right, start: left.start, end: right.end };
      }
      return left;
    } finally {
      this.nesting -= 1;
    }
  }

  private prefix(): Node {
    const token = this.take();
    switch (token.kind) {
      case 'number':
        return { kind: 'literal', value: token.value as number, literal: 'number', start: token.start, end: token.end };
      case 'text':
        return { kind: 'literal', value: token.value as string, literal: 'text', start: token.start, end: token.end };
      case 'open': {
        const inner = this.expression(0);
        const close = this.take();
        if (close.kind !== 'close') {
          throw close.kind === 'end'
            ? problem(message('A closing bracket is missing.'), token.start, close.start)
            : problem(message('Expected a closing bracket, found {token}.', { token: shown(close) }), close.start, close.end);
        }
        return { ...inner, grouped: true };
      }
      case 'op': {
        if (token.text === '-' || token.text === '+') {
          const operand = this.expression(SIGN_POWER);
          return { kind: 'unary', op: token.text, operand, start: token.start, end: operand.end };
        }
        throw problem(message('Expected a value, found {token}.', { token: token.text }), token.start, token.end);
      }
      case 'name':
        return this.named(token);
      case 'end':
        throw problem(message('The formula ends where a value was expected.'), token.start, token.end);
      default:
        throw problem(message('Expected a value, found {token}.', { token: token.text }), token.start, token.end);
    }
  }

  private named(token: Token): Node {
    const word = token.text.toLowerCase();
    if (word === 'true' || word === 'false') {
      return { kind: 'literal', value: word === 'true', literal: 'boolean', start: token.start, end: token.end };
    }
    if (word === 'null') return { kind: 'literal', value: null, literal: 'null', start: token.start, end: token.end };
    if (word === 'not') {
      const operand = this.expression(NOT_POWER);
      return { kind: 'unary', op: 'not', operand, start: token.start, end: operand.end };
    }
    if (word === 'and' || word === 'or') {
      throw problem(message('Expected a value before {token}.', { token: token.text }), token.start, token.end);
    }
    if (this.peek().kind !== 'open') return { kind: 'field', name: token.text, start: token.start, end: token.end };

    const name = token.text.toUpperCase();
    if (!isFunction(name)) {
      const near = nearest(name, Object.keys(FUNCTIONS));
      throw problem(
        near
          ? message('There is no function {name}. Did you mean {suggestion}?', { name: token.text, suggestion: near })
          : message('There is no function {name}.', { name: token.text }),
        token.start,
        token.end,
      );
    }
    this.take();
    const args: Node[] = [];
    if (this.peek().kind === 'close') {
      this.take();
    } else {
      for (;;) {
        args.push(this.expression(0));
        const next = this.take();
        if (next.kind === 'comma') continue;
        if (next.kind === 'close') break;
        throw next.kind === 'end'
          ? problem(message('A closing bracket is missing.'), token.start, next.start)
          : problem(message('Expected a comma or a closing bracket, found {token}.', { token: shown(next) }), next.start, next.end);
      }
    }
    const end = this.tokens[this.at - 1]!.end;
    const spec = FUNCTIONS[name];
    if (args.length < spec.min || args.length > spec.max) {
      throw problem(
        spec.min === spec.max
          ? message('{name} takes {count, plural, =0 {no arguments} one {# argument} other {# arguments}}.', { name, count: spec.min })
          : message('{name} takes from {min} to {max} arguments.', { name, min: spec.min, max: spec.max }),
        token.start,
        end,
      );
    }
    return { kind: 'call', name, args, start: token.start, end };
  }
}

/** Parses a formula into its tree. Throws a FormulaProblem. */
export function parseFormula(source: string): Node {
  if (source.length > LIMITS.length) {
    throw problem(message('The formula is too long: at most {max} characters.', { max: LIMITS.length }), LIMITS.length, source.length);
  }
  return new Parser(source).parse();
}

/** The closest of `options` to `name`, when one is close enough to be a typo. */
function nearest(name: string, options: Iterable<string>): string | undefined {
  const lower = name.toLowerCase();
  let best: { option: string; distance: number } | undefined;
  for (const option of options) {
    const distance = editDistance(lower, option.toLowerCase());
    if (!best || distance < best.distance) best = { option, distance };
  }
  return best && best.distance <= Math.max(1, Math.round(name.length / 3)) ? best.option : undefined;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/* -------------------------------------------------------------------------- */
/* Size (BR-408)                                                              */
/* -------------------------------------------------------------------------- */

export interface Complexity {
  nodes: number;
  depth: number;
  /** Child aggregations inside one another, at the deepest. */
  aggregations: number;
}

function children(node: Node): Node[] {
  switch (node.kind) {
    case 'unary':
      return [node.operand];
    case 'binary':
      return [node.left, node.right];
    case 'call':
      return node.args;
    default:
      return [];
  }
}

/** How big a formula is; refuses one over the limits, naming the part that is. */
export function measure(root: Node): Complexity {
  let nodes = 0;
  let depth = 0;
  let aggregations = 0;
  const walk = (node: Node, level: number, nested: number) => {
    nodes += 1;
    const isAggregate = node.kind === 'call' && FUNCTIONS[node.name].aggregate === true;
    const inside = nested + (isAggregate ? 1 : 0);
    if (level > LIMITS.depth) {
      throw problem(message('The formula nests too deeply: at most {max} levels.', { max: LIMITS.depth }), node.start, node.end);
    }
    if (inside > LIMITS.aggregations) {
      throw problem(
        message('Too many child aggregations inside one another: at most {max}.', { max: LIMITS.aggregations }),
        node.start,
        node.end,
      );
    }
    depth = Math.max(depth, level);
    aggregations = Math.max(aggregations, inside);
    for (const child of children(node)) walk(child, level + 1, inside);
  };
  walk(root, 1, 0);
  if (nodes > LIMITS.nodes) {
    throw problem(
      message('The formula is too complex: {count} parts, at most {max}.', { count: nodes, max: LIMITS.nodes }),
      root.start,
      root.end,
    );
  }
  return { nodes, depth, aggregations };
}

/* -------------------------------------------------------------------------- */
/* Types and references                                                       */
/* -------------------------------------------------------------------------- */

/** What a formula can refer to on this instance. */
export interface FormulaEnvironment {
  /** OpenProject's work package custom fields, by id. */
  customFields: ReadonlyMap<
    number,
    {
      name: string;
      format: string;
      /** How a formula reads it; null when a formula cannot. */
      type: ValueType | null;
      /** Set when the field is a calculated field's own. */
      calculatedKey?: string;
    }
  >;
  /** Calculated fields, by key. */
  calculated: ReadonlyMap<string, { name: string; type: ValueType; active: boolean }>;
}

/** What a formula reads, worked out when it is checked. */
export interface References {
  attributes: Attribute[];
  customFields: number[];
  /** Calculated fields read on the same work package: the edges a circle is made of. */
  calculated: string[];
  /** Calculated fields read on its children. */
  childCalculated: string[];
  children: boolean;
  today: boolean;
  calendar: boolean;
}

/** How each custom field format reads in a formula. */
export function customFieldType(format: string): ValueType | null {
  switch (format) {
    case 'int':
    case 'float':
      return 'number';
    case 'date':
      return 'date';
    case 'bool':
      return 'boolean';
    case 'string':
    case 'text':
    case 'list':
      return 'text';
    default:
      return null;
  }
}

/** The custom field format a result type is held in. */
export const FORMAT_OF: Record<ValueType, string> = { number: 'float', date: 'date', text: 'string', boolean: 'bool' };

class Checker {
  readonly refs: References = {
    attributes: [],
    customFields: [],
    calculated: [],
    childCalculated: [],
    children: false,
    today: false,
    calendar: false,
  };

  constructor(private readonly env: FormulaEnvironment) {}

  private add<T>(list: T[], value: T): void {
    if (!list.includes(value)) list.push(value);
  }

  check(node: Node, aggregationDepth = 0): StaticType {
    const type = this.typeOf(node, aggregationDepth);
    node.type = type;
    return type;
  }

  private typeOf(node: Node, inside: number): StaticType {
    switch (node.kind) {
      case 'literal':
        return node.literal;
      case 'field':
        return this.field(node, inside);
      case 'unary': {
        const operand = this.check(node.operand, inside);
        if (node.op === 'not') {
          if (operand !== 'boolean' && operand !== 'null') {
            throw problem(message('not needs true or false, not {type}.', { type: typePhrase(operand) }), node.start, node.end);
          }
          return 'boolean';
        }
        if (operand !== 'number' && operand !== 'null') {
          throw problem(message('A sign needs a number, not {type}.', { type: typePhrase(operand) }), node.start, node.end);
        }
        return 'number';
      }
      case 'binary':
        return this.binary(node, inside);
      case 'call':
        return this.call(node, inside);
    }
  }

  private field(node: Extract<Node, { kind: 'field' }>, inside: number): StaticType {
    const name = node.name;
    if (isAttribute(name)) {
      node.ref = { kind: 'attribute', name };
      this.add(this.refs.attributes, name);
      return ATTRIBUTES[name];
    }
    const custom = /^cf_(\d+)$/.exec(name);
    if (custom) {
      const id = Number(custom[1]);
      const field = this.env.customFields.get(id);
      if (!field) throw problem(message('There is no custom field {name}.', { name }), node.start, node.end);
      if (field.calculatedKey) {
        throw problem(
          message('{name} is the calculated field {field}: refer to it by its key, {key}.', {
            name,
            field: field.name,
            key: field.calculatedKey,
          }),
          node.start,
          node.end,
        );
      }
      if (!field.type) {
        throw problem(
          message('{field} ({name}) is a {format} field, which a formula cannot read.', { field: field.name, name, format: field.format }),
          node.start,
          node.end,
        );
      }
      node.ref = { kind: 'custom', id };
      this.add(this.refs.customFields, id);
      return field.type;
    }
    const calculated = this.env.calculated.get(name);
    if (calculated) {
      if (!calculated.active) {
        throw problem(message('{name} is switched off, so it has no values to read.', { name }), node.start, node.end);
      }
      node.ref = { kind: 'calculated', key: name };
      this.add(inside > 0 ? this.refs.childCalculated : this.refs.calculated, name);
      return calculated.type;
    }
    const near = nearest(name, [...Object.keys(ATTRIBUTES), ...this.env.calculated.keys()]);
    throw problem(
      near
        ? message('There is no field {name}. Did you mean {suggestion}?', { name, suggestion: near })
        : message('There is no field {name}.', { name }),
      node.start,
      node.end,
    );
  }

  private binary(node: Extract<Node, { kind: 'binary' }>, inside: number): StaticType {
    const left = this.check(node.left, inside);
    const right = this.check(node.right, inside);
    const fail = (text: Message): never => {
      throw problem(text, node.start, node.end);
    };
    const pair = { left: typePhrase(left), right: typePhrase(right) };
    switch (node.op) {
      case 'and':
      case 'or':
        if ((left !== 'boolean' && left !== 'null') || (right !== 'boolean' && right !== 'null')) {
          fail(message('{op} needs true or false on both sides, not {left} and {right}.', { op: node.op, ...pair }));
        }
        return 'boolean';
      case '=':
      case '!=':
        if (left !== 'null' && right !== 'null' && left !== right) fail(message('Cannot compare {left} with {right}.', pair));
        return 'boolean';
      case '<':
      case '<=':
      case '>':
      case '>=': {
        if (left !== 'null' && right !== 'null' && left !== right) fail(message('Cannot compare {left} with {right}.', pair));
        const type = left === 'null' ? right : left;
        if (type === 'boolean') fail(message('True and false cannot be put in order; compare them with = or !=.'));
        return 'boolean';
      }
      case '+': {
        const kinds = `${left}+${right}`;
        if (kinds === 'number+number') return 'number';
        if (kinds === 'date+number' || kinds === 'number+date') return 'date';
        if (left === 'null' && (right === 'number' || right === 'date')) return right;
        if (right === 'null' && (left === 'number' || left === 'date')) return left;
        if (left === 'null' && right === 'null') return 'null';
        return fail(message('Cannot add {left} and {right}.', pair));
      }
      case '-': {
        const kinds = `${left}-${right}`;
        if (kinds === 'number-number') return 'number';
        if (kinds === 'date-number') return 'date';
        if (kinds === 'date-date') return 'number';
        if (left === 'null' && right === 'number') return 'number';
        if (left === 'date' && right === 'null') return 'date';
        if (left === 'number' && right === 'null') return 'number';
        if (left === 'null' && right === 'null') return 'null';
        return fail(message('Cannot subtract {right} from {left}.', pair));
      }
      case '*':
      case '/':
        if ((left !== 'number' && left !== 'null') || (right !== 'number' && right !== 'null')) {
          fail(
            node.op === '*'
              ? message('Cannot multiply {left} by {right}.', pair)
              : message('Cannot divide {left} by {right}.', pair),
          );
        }
        return 'number';
    }
  }

  /** Requires argument `index` (0-based) to be one of `allowed`; answers what it is. */
  private argument(node: Extract<Node, { kind: 'call' }>, index: number, allowed: ValueType[], inside: number): StaticType {
    const arg = node.args[index]!;
    const type = this.check(arg, inside);
    if (type !== 'null' && !allowed.includes(type)) {
      throw problem(
        message('{name}: argument {index} must be {expected}, not {actual}.', {
          name: node.name,
          index: index + 1,
          expected: allowed.length === 1 ? typePhrase(allowed[0]!) : msg('a number or a date'),
          actual: typePhrase(type),
        }),
        arg.start,
        arg.end,
      );
    }
    return type;
  }

  /** Every argument the same type, or no value; answers that type. */
  private alike(node: Extract<Node, { kind: 'call' }>, args: Node[], allowed: readonly ValueType[], inside: number): StaticType {
    let found: StaticType = 'null';
    for (const arg of args) {
      const type = this.check(arg, inside);
      if (type === 'null') continue;
      if (!allowed.includes(type)) {
        throw problem(
          message('{name} cannot take {type}.', { name: node.name, type: typePhrase(type) }),
          arg.start,
          arg.end,
        );
      }
      if (found !== 'null' && type !== found) {
        throw problem(
          message('{name}: the values must all be the same type, but {first} and {second} are mixed.', {
            name: node.name,
            first: typePhrase(found),
            second: typePhrase(type),
          }),
          arg.start,
          arg.end,
        );
      }
      found = type;
    }
    return found;
  }

  private call(node: Extract<Node, { kind: 'call' }>, inside: number): StaticType {
    const spec = FUNCTIONS[node.name];
    if (spec.aggregate) this.refs.children = true;
    switch (node.name) {
      case 'IF':
        this.argument(node, 0, ['boolean'], inside);
        return this.alike(node, node.args.slice(1), VALUE_TYPES, inside);
      case 'COALESCE':
        return this.alike(node, node.args, VALUE_TYPES, inside);
      case 'ROUND': {
        this.argument(node, 0, ['number'], inside);
        if (node.args[1]) {
          this.argument(node, 1, ['number'], inside);
          const places = node.args[1];
          if (places.kind === 'literal' && typeof places.value === 'number' && !validPlaces(places.value)) {
            throw problem(message('ROUND takes from 0 to 10 decimal places, as a whole number.'), places.start, places.end);
          }
        }
        return 'number';
      }
      case 'MIN':
      case 'MAX':
        return this.alike(node, node.args, ['number', 'date'], inside);
      case 'ABS':
        this.argument(node, 0, ['number'], inside);
        return 'number';
      case 'TODAY':
        this.refs.today = true;
        return 'date';
      case 'DAYS_BETWEEN':
        this.argument(node, 0, ['date'], inside);
        this.argument(node, 1, ['date'], inside);
        return 'number';
      case 'WORKING_DAYS_BETWEEN':
        this.refs.calendar = true;
        this.argument(node, 0, ['date'], inside);
        this.argument(node, 1, ['date'], inside);
        return 'number';
      case 'ADD_DAYS':
        this.argument(node, 0, ['date'], inside);
        this.argument(node, 1, ['number'], inside);
        return 'date';
      case 'DATE': {
        this.argument(node, 0, ['text'], inside);
        const text = node.args[0]!;
        if (text.kind === 'literal' && typeof text.value === 'string' && parseDay(text.value) === null) {
          throw problem(message('{text} is not a date written as year-month-day.', { text: text.value }), text.start, text.end);
        }
        return 'date';
      }
      case 'CONCAT':
        for (const arg of node.args) this.check(arg, inside);
        return 'text';
      case 'SUM_CHILDREN':
      case 'AVG_CHILDREN':
        this.argument(node, 0, ['number'], inside + 1);
        return 'number';
      case 'MIN_CHILDREN':
      case 'MAX_CHILDREN': {
        const type = this.argument(node, 0, ['number', 'date'], inside + 1);
        return type === 'null' ? 'number' : type;
      }
      case 'COUNT_CHILDREN':
        return 'number';
    }
  }
}

const validPlaces = (places: number) => Number.isInteger(places) && places >= 0 && places <= 10;

/* -------------------------------------------------------------------------- */
/* Compiling                                                                  */
/* -------------------------------------------------------------------------- */

export interface Compiled {
  source: string;
  ast: Node;
  type: ValueType;
  references: References;
  complexity: Complexity;
}

export type CompileResult = { ok: true; compiled: Compiled } | { ok: false; error: FormulaError };

/**
 * Parses, measures and type-checks a formula against what this instance has.
 * With `expected`, the formula must give that type.
 */
export function compileFormula(source: string, env: FormulaEnvironment, expected?: ValueType): CompileResult {
  try {
    const ast = parseFormula(source);
    const complexity = measure(ast);
    const checker = new Checker(env);
    const type = checker.check(ast);
    if (type === 'null') throw problem(message('The formula always gives no value.'), ast.start, ast.end);
    if (expected && type !== expected) {
      throw problem(
        message('The formula gives {actual}, but the field holds {expected}.', { actual: typePhrase(type), expected: typePhrase(expected) }),
        ast.start,
        ast.end,
      );
    }
    return { ok: true, compiled: { source, ast, type, references: checker.refs, complexity } };
  } catch (error) {
    if (error instanceof FormulaProblem) return { ok: false, error: error.problem };
    throw error;
  }
}

/** Why a key cannot name a calculated field, or null when it can. */
export function keyProblem(key: string): Message | null {
  if (!/^[a-z][A-Za-z0-9_]{1,39}$/.test(key)) {
    return message('A key starts with a lower-case letter and has 2 to 40 letters, digits or underscores.');
  }
  if (KEYWORDS.has(key.toLowerCase())) return message('{key} is a word formulas reserve.', { key });
  if (isAttribute(key)) return message('{key} is a built-in field.', { key });
  if (/^cf_\d+$/.test(key)) return message('{key} is how formulas name custom fields.', { key });
  if (isFunction(key.toUpperCase())) return message('{key} is the name of a function.', { key });
  return null;
}

/**
 * A circle of same-work-package references through `start`, as the keys along
 * it — `['margin', 'cost', 'margin']` — or null. References inside a child
 * aggregation are not edges: a child is always worked out before its parent.
 */
export function findCycle(start: string, edgesOf: (key: string) => readonly string[]): string[] | null {
  const path: string[] = [start];
  const seen = new Set<string>();
  const walk = (key: string): boolean => {
    for (const next of edgesOf(key)) {
      if (next === start) {
        path.push(next);
        return true;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      path.push(next);
      if (walk(next)) return true;
      path.pop();
    }
    return false;
  };
  return walk(start) ? path : null;
}

/* -------------------------------------------------------------------------- */
/* Values in and out                                                          */
/* -------------------------------------------------------------------------- */

const MIN_DAY = dayOf('0001-01-01');
const MAX_DAY = dayOf('9999-12-31');
/** Beyond this a number is no longer exact, and is not a figure anybody tracks. */
const MAX_NUMBER = 1e15;
const MAX_TEXT = 1_000;

/** A `YYYY-MM-DD` date as a day number, or null when it is not one. */
export function parseDay(text: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const day = dayOf(text);
  return Number.isFinite(day) && isoOf(day) === text ? day : null;
}

/**
 * A custom field's stored value as a formula reads it: OpenProject keeps every
 * value as text, a list option as its id, and a multi-value field as several
 * rows, which read as one text joined by commas.
 */
export function readCustomValue(type: ValueType, raws: readonly (string | null)[], options?: ReadonlyMap<string, string>): Value {
  const present = raws.filter((raw): raw is string => raw !== null && raw !== '');
  if (present.length === 0) return null;
  const first = present[0]!;
  switch (type) {
    case 'number': {
      const number = Number(first);
      return Number.isFinite(number) ? number : null;
    }
    case 'date':
      return parseDay(first.slice(0, 10));
    case 'boolean':
      return first === 't' || first === 'true' || first === '1';
    case 'text':
      return present.map((raw) => options?.get(raw) ?? raw).join(', ');
  }
}

/** A value for the API: a date as `YYYY-MM-DD`. */
export function outputValue(type: ValueType, value: Value): number | string | boolean | null {
  if (value === null) return null;
  return type === 'date' ? isoOf(value as number) : value;
}

/**
 * Rounds half away from nought, exactly for decimal input (1.005 → 1.01): the
 * shift is done on the decimal text, not by multiplying a binary fraction.
 */
export function roundTo(value: number, places: number): number {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  const text = String(magnitude);
  // Written with an exponent (below a millionth, or huge): no decimal text to shift.
  const rounded = text.includes('e')
    ? Math.round(magnitude * 10 ** places) / 10 ** places
    : Number(`${Math.round(Number(`${text}e${places}`))}e-${places}`);
  return rounded === 0 ? 0 : sign * rounded;
}

/** Decimal places a number field is shown and mirrored with, when its format sets none. */
export const DEFAULT_DECIMALS = 2;

/**
 * A value as OpenProject stores it in its custom field: a number rounded to the
 * field's places and written without an exponent, a date as `YYYY-MM-DD`,
 * true and false as OpenProject's `t` and `f`.
 */
export function encodeValue(type: ValueType, value: Value, decimals = DEFAULT_DECIMALS): string | null {
  if (value === null) return null;
  switch (type) {
    case 'number': {
      const rounded = roundTo(value as number, decimals);
      return String(rounded);
    }
    case 'date':
      return isoOf(value as number);
    case 'boolean':
      return value ? 't' : 'f';
    case 'text':
      return String(value);
  }
}

/** A number or date written as text, for CONCAT. */
function asText(type: StaticType, value: Value): string {
  if (type === 'date') return isoOf(value as number);
  if (type === 'number') return String(roundTo(value as number, 10));
  return String(value);
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/** One work package, as formulas read it. */
export interface WorkItem {
  id: number;
  projectId: number;
  typeId: number;
  parentId: number | null;
  estimatedHours: number | null;
  remainingHours: number | null;
  spentHours: number | null;
  percentDone: number | null;
  /** ISO dates. */
  startDate: string | null;
  dueDate: string | null;
  storyPoints: number | null;
  /** Custom field values already read (`readCustomValue`), by field id. */
  custom: ReadonlyMap<number, Value>;
}

/** A field to evaluate: its compiled formula, or why it has none, and where it applies. */
export interface FieldPlan {
  id: string;
  key: string;
  type: ValueType;
  compiled?: Compiled;
  /** Why the formula cannot be evaluated: every value is missing, for this reason. */
  broken?: Message;
  /** Projects and types it applies to; null for all. */
  projectIds: ReadonlySet<number> | null;
  typeIds: ReadonlySet<number> | null;
}

export interface EvaluationOptions {
  /** ISO date `TODAY()` answers. */
  today: string;
  calendar: WorkingCalendar;
}

export function inScope(field: Pick<FieldPlan, 'projectIds' | 'typeIds'>, item: Pick<WorkItem, 'projectId' | 'typeId'>): boolean {
  return (field.projectIds === null || field.projectIds.has(item.projectId)) && (field.typeIds === null || field.typeIds.has(item.typeId));
}

const none = (reason?: Message): Outcome => (reason ? { value: null, reason } : { value: null });

function checkedNumber(value: number): Outcome {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_NUMBER) return none(message('The result is too large to hold.'));
  return { value };
}

function checkedDay(day: number): Outcome {
  if (!Number.isFinite(day) || day < MIN_DAY || day > MAX_DAY) return none(message('The date falls outside the calendar.'));
  return { value: day };
}

/** Two numbers equal to within rounding: 0.1 + 0.2 = 0.3. */
const nearlyEqual = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** The values every formula of one pass reads, shared. */
interface Run {
  items: ReadonlyMap<number, WorkItem>;
  childrenOf: ReadonlyMap<number, readonly WorkItem[]>;
  /** Values computed so far: field key → work package → outcome. */
  results: Map<string, Map<number, Outcome>>;
  today: number;
  days: DayCounter;
}

function evaluateNode(node: Node, item: WorkItem, run: Run): Outcome {
  switch (node.kind) {
    case 'literal':
      return { value: node.value };
    case 'field':
      return readField(node, item, run);
    case 'unary': {
      const operand = evaluateNode(node.operand, item, run);
      if (operand.value === null) return operand;
      if (node.op === 'not') return { value: !operand.value };
      return node.op === '-' ? checkedNumber(-(operand.value as number)) : operand;
    }
    case 'binary':
      return binary(node, item, run);
    case 'call':
      return call(node, item, run);
  }
}

function readField(node: Extract<Node, { kind: 'field' }>, item: WorkItem, run: Run): Outcome {
  const ref = node.ref!;
  const missing = () => none(message('{field} has no value.', { field: node.name }));
  if (ref.kind === 'attribute') {
    const value = item[ref.name];
    if (value === null || value === undefined) return missing();
    if (ATTRIBUTES[ref.name] === 'date') return { value: dayOf(value as string) };
    return { value: value as number };
  }
  if (ref.kind === 'custom') {
    const value = item.custom.get(ref.id);
    return value === null || value === undefined ? missing() : { value };
  }
  const outcome = run.results.get(ref.key)?.get(item.id);
  if (!outcome) return none(message('{field} does not apply to this work package.', { field: ref.key }));
  if (outcome.value === null) return outcome.reason ? outcome : missing();
  return outcome;
}

function binary(node: Extract<Node, { kind: 'binary' }>, item: WorkItem, run: Run): Outcome {
  if (node.op === 'and' || node.op === 'or') {
    // Three-valued: false and anything is false; true or anything is true.
    const left = evaluateNode(node.left, item, run);
    const decisive = node.op === 'or';
    if (left.value === decisive) return left;
    const right = evaluateNode(node.right, item, run);
    if (right.value === decisive) return right;
    if (left.value === null) return left;
    if (right.value === null) return right;
    return { value: !decisive };
  }

  const left = evaluateNode(node.left, item, run);
  if (left.value === null) return left;
  const right = evaluateNode(node.right, item, run);
  if (right.value === null) return right;
  const a = left.value;
  const b = right.value;
  const leftType = node.left.type;
  const rightType = node.right.type;

  switch (node.op) {
    case '=':
      return { value: typeof a === 'number' ? nearlyEqual(a, b as number) : a === b };
    case '!=':
      return { value: typeof a === 'number' ? !nearlyEqual(a, b as number) : a !== b };
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const equal = typeof a === 'number' ? nearlyEqual(a, b as number) : a === b;
      const less = !equal && (a as number | string) < (b as number | string);
      const result = node.op === '<' ? less : node.op === '<=' ? less || equal : node.op === '>' ? !less && !equal : !less;
      return { value: result };
    }
    case '+':
      if (leftType === 'date' || rightType === 'date') return checkedDay(Math.trunc((a as number) + (b as number)));
      return checkedNumber((a as number) + (b as number));
    case '-':
      if (leftType === 'date' && rightType === 'date') return { value: (a as number) - (b as number) };
      if (leftType === 'date') return checkedDay(Math.trunc((a as number) - (b as number)));
      return checkedNumber((a as number) - (b as number));
    case '*':
      return checkedNumber((a as number) * (b as number));
    case '/':
      if (b === 0) return none(message('Division by nought.'));
      return checkedNumber((a as number) / (b as number));
  }
}

function call(node: Extract<Node, { kind: 'call' }>, item: WorkItem, run: Run): Outcome {
  const arg = (index: number) => evaluateNode(node.args[index]!, item, run);
  switch (node.name) {
    case 'IF': {
      const condition = arg(0);
      return condition.value === true ? arg(1) : arg(2);
    }
    case 'COALESCE': {
      let first: Outcome | undefined;
      for (let index = 0; index < node.args.length; index += 1) {
        const outcome = arg(index);
        if (outcome.value !== null) return outcome;
        first ??= outcome;
      }
      return first ?? none();
    }
    case 'ROUND': {
      const value = arg(0);
      if (value.value === null) return value;
      let places = 0;
      if (node.args[1]) {
        const given = arg(1);
        if (given.value === null) return given;
        if (!validPlaces(given.value as number)) return none(message('ROUND takes from 0 to 10 decimal places, as a whole number.'));
        places = given.value as number;
      }
      return checkedNumber(roundTo(value.value as number, places));
    }
    case 'MIN':
    case 'MAX': {
      let best: number | null = null;
      let first: Outcome | undefined;
      for (let index = 0; index < node.args.length; index += 1) {
        const outcome = arg(index);
        if (outcome.value === null) {
          first ??= outcome;
          continue;
        }
        const value = outcome.value as number;
        if (best === null || (node.name === 'MIN' ? value < best : value > best)) best = value;
      }
      return best === null ? (first ?? none()) : { value: best };
    }
    case 'ABS': {
      const value = arg(0);
      return value.value === null ? value : { value: Math.abs(value.value as number) };
    }
    case 'TODAY':
      return { value: run.today };
    case 'DAYS_BETWEEN': {
      const from = arg(0);
      if (from.value === null) return from;
      const to = arg(1);
      if (to.value === null) return to;
      return { value: (to.value as number) - (from.value as number) };
    }
    case 'WORKING_DAYS_BETWEEN': {
      const from = arg(0);
      if (from.value === null) return from;
      const to = arg(1);
      if (to.value === null) return to;
      if (Math.abs((to.value as number) - (from.value as number)) > 36_600) {
        return none(message('Those dates are more than a hundred years apart.'));
      }
      return { value: run.days.between(from.value as number, to.value as number) };
    }
    case 'ADD_DAYS': {
      const date = arg(0);
      if (date.value === null) return date;
      const days = arg(1);
      if (days.value === null) return days;
      return checkedDay((date.value as number) + Math.trunc(days.value as number));
    }
    case 'DATE': {
      const text = arg(0);
      if (text.value === null) return text;
      const day = parseDay(String(text.value).trim());
      return day === null ? none(message('{text} is not a date written as year-month-day.', { text: String(text.value) })) : { value: day };
    }
    case 'CONCAT': {
      let text = '';
      for (let index = 0; index < node.args.length; index += 1) {
        const outcome = arg(index);
        if (outcome.value !== null) text += asText(node.args[index]!.type ?? 'text', outcome.value);
      }
      return { value: text.slice(0, MAX_TEXT) };
    }
    case 'COUNT_CHILDREN':
      return { value: (run.childrenOf.get(item.id) ?? []).length };
    case 'SUM_CHILDREN':
    case 'AVG_CHILDREN':
    case 'MIN_CHILDREN':
    case 'MAX_CHILDREN':
      return aggregate(node, item, run);
  }
}

function aggregate(node: Extract<Node, { kind: 'call' }>, item: WorkItem, run: Run): Outcome {
  const kids = run.childrenOf.get(item.id) ?? [];
  if (kids.length === 0) return none(message('It has no children.'));
  const values: number[] = [];
  for (const child of kids) {
    const outcome = evaluateNode(node.args[0]!, child, run);
    if (outcome.value !== null) values.push(outcome.value as number);
  }
  if (values.length === 0) return none(message('None of its children has a value.'));
  switch (node.name) {
    case 'SUM_CHILDREN':
      return checkedNumber(values.reduce((sum, value) => sum + value, 0));
    case 'AVG_CHILDREN':
      return checkedNumber(values.reduce((sum, value) => sum + value, 0) / values.length);
    case 'MIN_CHILDREN':
      return { value: Math.min(...values) };
    default:
      return { value: Math.max(...values) };
  }
}

/**
 * The order fields are worked out in on one work package: a field after every
 * field it reads there. A circle can only be here if two servers saved its
 * halves at once; its fields are reported rather than looped over.
 */
function fieldOrder(fields: readonly FieldPlan[]): { order: FieldPlan[]; circular: Map<string, Message> } {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const state = new Map<string, 'visiting' | 'done'>();
  const order: FieldPlan[] = [];
  const circular = new Map<string, Message>();
  const visit = (field: FieldPlan, trail: string[]) => {
    const now = state.get(field.key);
    if (now === 'done') return;
    if (now === 'visiting') {
      const loop = [...trail.slice(trail.indexOf(field.key)), field.key];
      for (const key of loop) circular.set(key, message('Circular reference: {path}.', { path: loop.join(' → ') }));
      return;
    }
    state.set(field.key, 'visiting');
    for (const key of field.compiled?.references.calculated ?? []) {
      const next = byKey.get(key);
      if (next) visit(next, [...trail, field.key]);
    }
    state.set(field.key, 'done');
    order.push(field);
  };
  for (const field of fields) visit(field, []);
  return { order, circular };
}

/** Children before parents, iteratively: a deep tree does not overflow the stack. */
function postOrder(items: readonly WorkItem[], childrenOf: ReadonlyMap<number, readonly WorkItem[]>, byId: ReadonlyMap<number, WorkItem>): WorkItem[] {
  const out: WorkItem[] = [];
  const done = new Set<number>();
  const roots = items.filter((item) => item.parentId === null || !byId.has(item.parentId));
  const visit = (root: WorkItem) => {
    const stack: { item: WorkItem; next: number }[] = [{ item: root, next: 0 }];
    done.add(root.id);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const kids = childrenOf.get(frame.item.id) ?? [];
      if (frame.next < kids.length) {
        const child = kids[frame.next]!;
        frame.next += 1;
        if (!done.has(child.id)) {
          done.add(child.id);
          stack.push({ item: child, next: 0 });
        }
        continue;
      }
      stack.pop();
      out.push(frame.item);
    }
  };
  for (const root of roots) visit(root);
  // A parent link that goes round in a circle has no root; such items are
  // still evaluated, in id order.
  for (const item of items) if (!done.has(item.id)) visit(item);
  return out;
}

/**
 * Works out every field on every work package it applies to: children before
 * parents, and on each work package a field after the fields it reads. Answers
 * field id → work package id → outcome; a work package a field does not apply
 * to has no entry.
 */
export function evaluateFields(
  fields: readonly FieldPlan[],
  items: readonly WorkItem[],
  options: EvaluationOptions,
): Map<string, Map<number, Outcome>> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const childrenOf = new Map<number, WorkItem[]>();
  for (const item of items) {
    if (item.parentId === null || !byId.has(item.parentId)) continue;
    const list = childrenOf.get(item.parentId) ?? [];
    list.push(item);
    childrenOf.set(item.parentId, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.id - b.id);

  const run: Run = {
    items: byId,
    childrenOf,
    results: new Map(fields.map((field) => [field.key, new Map<number, Outcome>()])),
    today: dayOf(options.today),
    days: new DayCounter(options.calendar, false),
  };
  const { order, circular } = fieldOrder(fields);

  for (const item of postOrder(items, childrenOf, byId)) {
    for (const field of order) {
      if (!inScope(field, item)) continue;
      const results = run.results.get(field.key)!;
      const broken = circular.get(field.key) ?? field.broken;
      if (broken || !field.compiled) {
        results.set(item.id, none(broken ?? message('The formula could not be read.')));
        continue;
      }
      results.set(item.id, evaluateNode(field.compiled.ast, item, run));
    }
  }

  return new Map(fields.map((field) => [field.id, run.results.get(field.key)!]));
}
