/**
 * The message format EPM's translations are written in.
 *
 * A small subset of ICU MessageFormat — the part a translator actually needs —
 * written here rather than imported, because it is shared verbatim with the
 * backend (`backend/src/lib/messageformat.ts`, kept identical by
 * `npm run types:check`) and the whole of it is a page:
 *
 *   Save changes                                   plain text
 *   Delete {name}?                                 an argument
 *   {count, plural, one {# task} other {# tasks}}  a plural; # is the number
 *   {count, plural, =0 {No tasks} other {…}}       an exact case wins over a category
 *   {kind, select, project {…} other {…}}          a choice by value
 *   {hours, number}                                a number in the reader's format
 *
 * Plural categories come from the language through `Intl.PluralRules`, which is
 * what makes Arabic work: it has six (zero, one, two, few, many, other) where
 * English has two, and a translation simply lists the ones it needs.
 *
 * Not supported, deliberately: ICU's apostrophe quoting (English copy is full
 * of apostrophes, and treating them as syntax would mangle it), and literal
 * braces. A message that cannot be parsed is shown as written rather than
 * throwing, so a typo in one translation costs one string, not the page.
 */

export type MessageParams = Record<string, string | number | boolean | null | undefined>;

export interface MessageContext {
  /** BCP 47 locale for plural rules. */
  locale: string;
  /** Formats a number for `#` and `{x, number}`. */
  number: (value: number) => string;
  /** Applied to every interpolated string value — direction isolation, typically. */
  wrap: (value: string) => string;
}

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'arg'; name: string; number: boolean }
  | { kind: 'pound' }
  | { kind: 'plural'; name: string; offset: number; options: Record<string, Node[]> }
  | { kind: 'select'; name: string; options: Record<string, Node[]> };

class MessageSyntaxError extends Error {}

function parse(source: string): Node[] {
  let i = 0;

  const skipSpace = () => {
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
  };

  const readUntil = (stops: string): string => {
    const start = i;
    while (i < source.length && !stops.includes(source[i]!)) i += 1;
    return source.slice(start, i);
  };

  const nodes = (inPlural: boolean, nested: boolean): Node[] => {
    const out: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push({ kind: 'text', value: text });
      text = '';
    };

    while (i < source.length) {
      const ch = source[i]!;
      if (ch === '{') {
        flush();
        i += 1;
        out.push(argument(inPlural));
      } else if (ch === '}') {
        if (nested) break;
        text += ch;
        i += 1;
      } else if (ch === '#' && inPlural) {
        flush();
        out.push({ kind: 'pound' });
        i += 1;
      } else {
        text += ch;
        i += 1;
      }
    }
    flush();
    return out;
  };

  const argument = (inPlural: boolean): Node => {
    const name = readUntil(',}').trim();
    if (!name) throw new MessageSyntaxError('empty argument');
    if (source[i] === '}') {
      i += 1;
      return { kind: 'arg', name, number: false };
    }
    i += 1; // ','
    const type = readUntil(',}').trim();
    if (source[i] === '}') {
      i += 1;
      return { kind: 'arg', name, number: type === 'number' };
    }
    if (source[i] !== ',') throw new MessageSyntaxError('unterminated argument');
    i += 1;

    if (type !== 'plural' && type !== 'select') {
      // An unknown style: keep the argument, drop the style.
      readUntil('}');
      i += 1;
      return { kind: 'arg', name, number: type === 'number' };
    }

    const options: Record<string, Node[]> = {};
    let offset = 0;
    for (;;) {
      skipSpace();
      if (i >= source.length) throw new MessageSyntaxError('unterminated choice');
      if (source[i] === '}') {
        i += 1;
        break;
      }
      const key = readUntil('{ \t\r\n}').trim();
      if (key.startsWith('offset:')) {
        offset = Number(key.slice('offset:'.length)) || 0;
        continue;
      }
      skipSpace();
      if (!key || source[i] !== '{') throw new MessageSyntaxError(`option "${key}" has no message`);
      i += 1;
      options[key] = nodes(type === 'plural' || inPlural, true);
      if (source[i] !== '}') throw new MessageSyntaxError(`option "${key}" is not closed`);
      i += 1;
    }
    if (!options.other) throw new MessageSyntaxError('a choice needs an "other" option');

    return type === 'plural'
      ? { kind: 'plural', name, offset, options }
      : { kind: 'select', name, options };
  };

  return nodes(false, false);
}

const cache = new Map<string, Node[] | null>();
const pluralRules = new Map<string, Intl.PluralRules>();

function parsed(source: string): Node[] | null {
  let entry = cache.get(source);
  if (entry === undefined) {
    try {
      entry = parse(source);
    } catch {
      entry = null;
    }
    // Bounded: messages are a fixed vocabulary, but a caller that builds
    // message text at run time must not grow this forever.
    if (cache.size > 5000) cache.clear();
    cache.set(source, entry);
  }
  return entry;
}

function category(locale: string, value: number): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(value);
}

function render(nodes: Node[], params: MessageParams, context: MessageContext, count?: number): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.value;
        break;
      case 'pound':
        out += count === undefined ? '#' : context.number(count);
        break;
      case 'arg': {
        const value = params[node.name];
        if (value === undefined || value === null) break;
        if (node.number && typeof value === 'number') out += context.number(value);
        else out += context.wrap(String(value));
        break;
      }
      case 'plural': {
        const raw = Number(params[node.name] ?? 0);
        const value = Number.isFinite(raw) ? raw : 0;
        const branch =
          node.options[`=${value}`] ??
          node.options[category(context.locale, Math.abs(value - node.offset))] ??
          node.options.other!;
        out += render(branch, params, context, value - node.offset);
        break;
      }
      case 'select': {
        const value = String(params[node.name] ?? 'other');
        out += render(node.options[value] ?? node.options.other!, params, context, count);
        break;
      }
    }
  }
  return out;
}

/** Renders `source` with `params`. An unparseable message is returned as written. */
export function formatMessage(source: string, params: MessageParams | undefined, context: MessageContext): string {
  // The common case — no braces at all — never reaches the parser.
  if (!source.includes('{') && !source.includes('#')) return source;
  const tree = parsed(source);
  if (!tree) return source;
  return render(tree, params ?? {}, context);
}

/** Whether a message parses. For the catalogue check, not for rendering. */
export function isValidMessage(source: string): boolean {
  return parsed(source) !== null;
}

/** The argument names a message uses, so a check can compare source and translation. */
export function messageArguments(source: string): string[] {
  const names = new Set<string>();
  const walk = (list: Node[]) => {
    for (const node of list) {
      if (node.kind === 'arg') names.add(node.name);
      if (node.kind === 'plural' || node.kind === 'select') {
        names.add(node.name);
        Object.values(node.options).forEach(walk);
      }
    }
  };
  const tree = parsed(source);
  if (tree) walk(tree);
  return [...names].sort();
}
