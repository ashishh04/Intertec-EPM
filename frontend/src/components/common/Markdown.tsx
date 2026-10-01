import { Fragment, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Markdown, rendered as React elements.
 *
 * Written rather than installed, and the reason is the important part: the text
 * being rendered is written by users — wiki pages, meeting minutes, news posts —
 * so the renderer is a security boundary. Every library route to rendering
 * markdown ends at `dangerouslySetInnerHTML`, which then needs a sanitiser
 * configured correctly and kept correct. This builds React elements instead, so
 * there is no HTML string at any point and nothing to sanitise: a `<script>` in
 * the source is text, because text is the only thing this can produce.
 *
 * The grammar is deliberately the common subset — headings, emphasis, code,
 * links, lists, quotes, fenced blocks, rules, tables are not included. Anything
 * unrecognised renders as the characters that were typed, which is the right
 * failure for a document: the reader sees what the author wrote rather than
 * nothing at all.
 *
 * Links are the one place the input reaches a browser attribute, so the scheme is
 * checked. `javascript:` and `data:` are dropped to plain text — a URL that
 * executes is not a link — and anything external opens in a new tab with
 * `noopener`.
 */

interface MarkdownProps {
  children?: string;
  className?: string;
  /** Rendered when the text is empty, e.g. "No agenda yet". */
  empty?: ReactNode;
}

export function Markdown({ children, className, empty }: MarkdownProps) {
  const source = (children ?? '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return <>{empty ?? null}</>;

  return (
    <div className={cn('space-y-3 text-xs leading-relaxed text-foreground', className)}>
      {renderBlocks(source)}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

const HEADING_CLASS = [
  'font-display text-base font-bold tracking-[-0.02em]',
  'font-display text-sm font-bold tracking-[-0.02em]',
  'font-display text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground',
];

/**
 * One pass over the lines, consuming a whole block at a time.
 *
 * A line-based loop rather than a recursive grammar: markdown blocks are defined
 * by their first characters and end at a blank line or a change of kind, which is
 * exactly what a cursor over lines expresses. A parser tree would be more general
 * and would not render anything this does not already.
 */
function renderBlocks(source: string): ReactNode[] {
  const lines = source.split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  const push = (node: ReactNode) => blocks.push(<Fragment key={blocks.length}>{node}</Fragment>);

  while (index < lines.length) {
    const line = lines[index]!;

    // Blank lines separate blocks and carry no meaning of their own.
    if (!line.trim()) {
      index += 1;
      continue;
    }

    // Fenced code. Everything up to the closing fence is literal, including
    // anything that would otherwise look like markup — which is the whole point
    // of a fence, and why this is checked before everything else.
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      // Skip the closing fence when there is one. An unclosed fence runs to the
      // end of the document rather than being abandoned.
      index += 1;

      push(
        <pre className="epm-scroll overflow-x-auto rounded-lg border border-border bg-muted/60 p-3">
          <code className="font-mono text-2xs leading-relaxed">{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const Tag = (`h${Math.min(level + 1, 6)}`) as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      push(
        <Tag className={HEADING_CLASS[Math.min(level, HEADING_CLASS.length) - 1]}>
          {renderInline(heading[2]!)}
        </Tag>,
      );
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      push(<hr className="border-border" />);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) {
        quoted.push(lines[index]!.replace(/^>\s?/, ''));
        index += 1;
      }
      push(
        <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
          {renderBlocks(quoted.join('\n'))}
        </blockquote>,
      );
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: string[] = [];

      while (index < lines.length) {
        const current = lines[index]!;
        const match = ordered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(current)
          : /^\s*[-*+]\s+(.*)$/.exec(current);
        if (match) {
          items.push(match[1]!);
          index += 1;
          continue;
        }
        // An indented continuation belongs to the item above it.
        if (/^\s{2,}\S/.test(current) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]} ${current.trim()}`;
          index += 1;
          continue;
        }
        break;
      }

      const List = ordered ? 'ol' : 'ul';
      push(
        <List
          className={cn(
            'space-y-1 pl-5',
            ordered ? 'list-decimal' : 'list-disc',
            'marker:text-muted-foreground',
          )}
        >
          {items.map((item, position) => (
            <li key={position}>{renderInline(item)}</li>
          ))}
        </List>,
      );
      continue;
    }

    // Anything else is a paragraph, running until a blank line or the start of
    // another block.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index]!;
      if (
        !current.trim() ||
        /^#{1,6}\s/.test(current) ||
        /^```/.test(current) ||
        /^>\s?/.test(current) ||
        /^\s*[-*+]\s+/.test(current) ||
        /^\s*\d+[.)]\s+/.test(current) ||
        /^(-{3,}|\*{3,}|_{3,})\s*$/.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }

    push(<p>{renderInline(paragraph.join('\n'))}</p>);
  }

  return blocks;
}

/* -------------------------------------------------------------------------- */
/* Inline                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Inline markup, in one regular expression.
 *
 * Order within the alternation is the precedence: code first, so `` `**not
 * bold**` `` stays literal, then links, then the emphasis forms with the
 * two-character openers before the one-character ones.
 */
const INLINE = new RegExp(
  [
    '(`[^`]+`)', // code
    '(!?\\[[^\\]]*\\]\\([^\\s)]+\\))', // link or image, both rendered as a link
    '(\\*\\*[^*]+\\*\\*)', // bold
    '(__[^_]+__)', // bold
    '(~~[^~]+~~)', // strikethrough
    '(\\*[^*\\n]+\\*)', // italic
    '(_[^_\\n]+_)', // italic
    '(https?://[^\\s<>()]+)', // bare URL
  ].join('|'),
  'g',
);

/**
 * Only schemes that cannot execute.
 *
 * A relative path is allowed — internal wiki links are written that way — but
 * anything with a scheme has to be http or https. `javascript:` is the obvious
 * one; `data:` is the less obvious one, and both render as plain text rather than
 * as a link somebody might click.
 */
function safeHref(href: string): string | undefined {
  const value = href.trim();
  if (value.startsWith('/') || value.startsWith('#')) return value;
  return /^https?:\/\//i.test(value) ? value : undefined;
}

function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  // A newline inside a paragraph is a line break, not a new block.
  const pushText = (value: string) => {
    if (!value) return;
    const segments = value.split('\n');
    segments.forEach((segment, position) => {
      if (position > 0) parts.push(<br key={`br-${key++}`} />);
      if (segment) parts.push(<Fragment key={`t-${key++}`}>{segment}</Fragment>);
    });
  };

  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const at = match.index ?? 0;
    pushText(text.slice(cursor, at));
    cursor = at + token.length;

    if (token.startsWith('`')) {
      parts.push(
        <code key={`c-${key++}`} className="rounded bg-muted px-1 py-0.5 font-mono text-2xs">
          {token.slice(1, -1)}
        </code>,
      );
      continue;
    }

    const link = /^!?\[([^\]]*)\]\(([^\s)]+)\)$/.exec(token);
    if (link) {
      const href = safeHref(link[2]!);
      const label = link[1] || link[2]!;
      if (!href) {
        // A refused scheme renders as what was typed, so nothing is silently
        // swallowed and the reader can see why it is not a link.
        pushText(token);
        continue;
      }
      const external = /^https?:/i.test(href);
      parts.push(
        <a
          key={`a-${key++}`}
          href={href}
          className="text-primary underline underline-offset-2 hover:no-underline"
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {label}
        </a>,
      );
      continue;
    }

    if (token.startsWith('**') || token.startsWith('__')) {
      parts.push(
        <strong key={`b-${key++}`} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
      continue;
    }

    if (token.startsWith('~~')) {
      parts.push(<del key={`s-${key++}`}>{token.slice(2, -2)}</del>);
      continue;
    }

    if (token.startsWith('*') || token.startsWith('_')) {
      parts.push(<em key={`i-${key++}`}>{token.slice(1, -1)}</em>);
      continue;
    }

    // A bare URL, matched last in the alternation.
    parts.push(
      <a
        key={`u-${key++}`}
        href={token}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2 hover:no-underline"
      >
        {token}
      </a>,
    );
  }

  pushText(text.slice(cursor));
  return parts;
}
