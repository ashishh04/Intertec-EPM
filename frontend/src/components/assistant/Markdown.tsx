import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { isAppPath } from '@/lib/navigation';
import { cn } from '@/lib/utils';

/**
 * Just enough Markdown for an assistant reply: paragraphs, bullet and numbered
 * lists, **bold**, `code` and links into EPM, as [links](/path) or simply a path
 * like /tasks/81 in the text. Deliberately not a full parser — anything else is
 * shown as the text it was, never dropped.
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

/** The pages of EPM a path written straight into an answer can name. */
const APP_PAGES =
  'agile|analytics|approvals|boards|calendar|dashboard|departments|documents|employees|expenses|finance|forecasts|gantt|insights|journal|meetings|my-time|my-work|news|notifications|portfolio-views|portfolios|profile|projects|reports|resources|scenarios|settings|sprints|tasks|teams|time-and-costs|timesheets|wiki';

const APP_PATH = String.raw`\/(?:${APP_PAGES})(?:\/[\p{L}\p{N}_~%-]+)*\/?(?:\?[\p{L}\p{N}_=&%+~.-]*[\p{L}\p{N}_=&%+~-])?(?:#[\p{L}\p{N}_-]+)?`;

/**
 * A path standing on its own in running text.
 *
 * What comes before and after is what makes it one: never the tail of an outside
 * address (evil.example/tasks/81, //tasks/81, ?next=/tasks/81), and not the start
 * of something longer. Named pages only, so "/etc/hosts" stays the text it is.
 * The character before is matched rather than looked behind at: this loads with
 * the whole app, and a Safari older than 16.4 cannot even parse a lookbehind.
 */
const BARE_PATH = new RegExp(String.raw`(^|[^\p{L}\p{N}_/\\:.@?=&%#~+-])(${APP_PATH})(?![\p{L}\p{N}_/\\-])`, 'gu');

/** Inline code holding nothing but a path: the model is told to set keys in code, and sets paths in it too. */
const WHOLE_PATH = new RegExp(String.raw`^${APP_PATH}$`, 'u');

/**
 * Where a path leads. Earlier answers name a sprint as /sprints/{id}, a page that
 * never existed: a sprint opens in the workspace.
 */
const routeOf = (path: string) => path.replace(/^\/sprints\/(\d+)\/?$/, '/agile?sprint=$1');

function appLink(key: string, path: string, children: ReactNode) {
  return (
    <Link
      key={key}
      to={routeOf(path)}
      // A path reads left to right whatever surrounds it: in Arabic its slashes would swap ends.
      dir={typeof children === 'string' ? 'ltr' : undefined}
      className="font-medium text-primary underline-offset-2 hover:underline"
    >
      {children}
    </Link>
  );
}

/** Plain text, with any path standing in it as a link. */
function linkBarePaths(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(BARE_PATH)) {
    const path = match[2]!;
    const at = (match.index ?? 0) + match[1]!.length;
    if (!isAppPath(path)) continue;
    nodes.push(<Fragment key={`${keyPrefix}-${from}`}>{text.slice(from, at)}</Fragment>);
    nodes.push(appLink(`${keyPrefix}-${at}-link`, path, path));
    from = at + path.length;
  }
  nodes.push(<Fragment key={`${keyPrefix}-${from}`}>{text.slice(from)}</Fragment>);
  return nodes;
}

function renderInline(text: string, keyPrefix: string, insideLink = false): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (!part) return null;

    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={key} className="font-semibold text-foreground">
          {renderInline(part.slice(2, -2), key, insideLink)}
        </strong>
      );
    }

    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const value = part.slice(1, -1);
      const code = (
        <code
          key={key}
          dir={WHOLE_PATH.test(value) ? 'ltr' : undefined}
          className="rounded bg-muted px-1 py-px font-mono text-[0.85em] text-foreground"
        >
          {value}
        </code>
      );
      return !insideLink && WHOLE_PATH.test(value) && isAppPath(value) ? appLink(key, value, code) : code;
    }

    // Only links into EPM itself are clickable. An answer is written from task
    // text, comments and wiki pages, which anyone with access can fill — so a
    // planted instruction could ask for a link that carries data elsewhere or
    // runs script. Anything that is not an app path shows as the text it was.
    const link = LINK.exec(part);
    if (link) {
      const [, label, href] = link;
      return isAppPath(href) ? appLink(key, href, renderInline(label, key, true)) : <Fragment key={key}>{part}</Fragment>;
    }

    return insideLink ? <Fragment key={key}>{part}</Fragment> : <Fragment key={key}>{linkBarePaths(part, key)}</Fragment>;
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
                'space-y-1 ps-5 marker:text-muted-foreground',
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
