import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * Just enough Markdown for an assistant reply: paragraphs, bullet and numbered
 * lists, **bold**, `code` and [links](/path). Deliberately not a full parser —
 * anything else is shown as the text it was, never dropped.
 */

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: 'heading', text: heading[1] });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet?.[1] ?? numbered?.[1];
    if (item !== undefined) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'list' && last.ordered === ordered) {
        last.items.push(item);
      } else {
        blocks.push({ kind: 'list', ordered, items: [item] });
      }
      continue;
    }

    // An indented line directly under a list item continues that item.
    const last = blocks[blocks.length - 1];
    if (/^\s{2,}/.test(rawLine) && last?.kind === 'list' && paragraph.length === 0) {
      last.items[last.items.length - 1] += ` ${line.trim()}`;
      continue;
    }

    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (!part) return null;

    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={key} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }

    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={key}
          className="rounded bg-muted px-1 py-px font-mono text-[0.85em] text-foreground"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    const link = LINK.exec(part);
    if (link) {
      const [, label, href] = link;
      const className = 'font-medium text-primary underline-offset-2 hover:underline';
      if (href.startsWith('/')) {
        return (
          <Link key={key} to={href} className={className}>
            {label}
          </Link>
        );
      }
      return (
        <a key={key} href={href} target="_blank" rel="noreferrer" className={className}>
          {label}
        </a>
      );
    }

    return <Fragment key={key}>{part}</Fragment>;
  });
}

interface MarkdownProps {
  content: string;
  /** Rendered after the last block — the streaming caret lives here. */
  trailing?: ReactNode;
  className?: string;
}

export function Markdown({ content, trailing, className }: MarkdownProps) {
  const blocks = parseBlocks(content);
  const lastIndex = blocks.length - 1;

  return (
    <div className={cn('space-y-2 text-sm leading-relaxed text-foreground', className)}>
      {blocks.map((block, index) => {
        const isLast = index === lastIndex;
        const key = `block-${index}`;

        if (block.kind === 'heading') {
          return (
            <p key={key} className="font-semibold tracking-tight">
              {renderInline(block.text, key)}
              {isLast ? trailing : null}
            </p>
          );
        }

        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          const lastItem = block.items.length - 1;
          return (
            <List
              key={key}
              className={cn(
                'space-y-1 pl-5 marker:text-muted-foreground',
                block.ordered ? 'list-decimal' : 'list-disc',
              )}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>
                  {renderInline(item, `${key}-${itemIndex}`)}
                  {isLast && itemIndex === lastItem ? trailing : null}
                </li>
              ))}
            </List>
          );
        }

        return (
          <p key={key}>
            {renderInline(block.text, key)}
            {isLast ? trailing : null}
          </p>
        );
      })}
      {blocks.length === 0 ? trailing : null}
    </div>
  );
}
