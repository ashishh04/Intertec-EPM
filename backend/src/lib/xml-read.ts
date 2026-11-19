/**
 * Reads an XML document into a tree of elements, for files people upload:
 * Microsoft Project's XML (domain/ms-project.ts).
 *
 * Deliberately small. Element names lose their namespace prefix, attributes
 * are kept as written, and text is decoded from the five predefined entities
 * and numeric character references. A document type declaration is skipped
 * and nothing it declares is expanded: an uploaded file never gets to define
 * entities, so no entity can pull in another file or swell into gigabytes.
 */

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** The element's own text, its children's left out. */
  text: string;
}

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return PREDEFINED[name] ?? whole;
  });
}

const localName = (name: string) => name.slice(name.indexOf(':') + 1);

export class XmlError extends Error {}

/** The document's root element. Throws `XmlError` for anything that is not well formed. */
export function parseXml(source: string): XmlElement {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const root: XmlElement = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('<', at);
    const top = stack[stack.length - 1]!;
    if (open < 0) {
      top.text += decode(text.slice(at));
      break;
    }
    if (open > at) top.text += decode(text.slice(at, open));
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end < 0) throw new XmlError('A comment is not closed.');
      at = end + 3;
    } else if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      if (end < 0) throw new XmlError('A CDATA section is not closed.');
      top.text += text.slice(open + 9, end);
      at = end + 3;
    } else if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      if (end < 0) throw new XmlError('A processing instruction is not closed.');
      at = end + 2;
    } else if (text.startsWith('<!', open)) {
      // A document type declaration, internal subset and all: skipped, never expanded.
      let depth = 0;
      let end = open + 2;
      for (; end < text.length; end += 1) {
        const char = text[end];
        if (char === '[') depth += 1;
        else if (char === ']') depth -= 1;
        else if (char === '>' && depth <= 0) break;
      }
      at = end + 1;
    } else if (text[open + 1] === '/') {
      const end = text.indexOf('>', open);
      if (end < 0) throw new XmlError('A closing tag is not finished.');
      const name = localName(text.slice(open + 2, end).trim());
      const closing = stack.pop();
      if (!closing || closing === root || closing.name !== name) throw new XmlError(`</${name}> does not close the element that is open.`);
      at = end + 1;
    } else {
      // A start tag: its name, its attributes (values may hold '>'), and whether it closes itself.
      const tag = /^<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(text.slice(open, open + 65_536));
      if (!tag) throw new XmlError('A tag is not well formed.');
      const element: XmlElement = { name: localName(tag[1]!), attributes: {}, children: [], text: '' };
      for (const attribute of tag[2]!.matchAll(/([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        element.attributes[attribute[1]!] = decode(attribute[3] ?? attribute[4] ?? '');
      }
      top.children.push(element);
      if (!tag[3]) stack.push(element);
      at = open + tag[0].length;
    }
  }
  if (stack.length > 1) throw new XmlError(`<${stack[stack.length - 1]!.name}> is not closed.`);
  const [element] = root.children;
  if (!element) throw new XmlError('The document has no root element.');
  return element;
}

/** The first child of that name. */
export const childOf = (element: XmlElement | undefined, name: string): XmlElement | undefined =>
  element?.children.find((child) => child.name === name);

/** Every child of that name. */
export const childrenOf = (element: XmlElement | undefined, name: string): XmlElement[] =>
  element?.children.filter((child) => child.name === name) ?? [];

/** A child's text, trimmed; undefined when there is no such child. */
export const textOf = (element: XmlElement | undefined, name: string): string | undefined => {
  const child = childOf(element, name);
  return child ? child.text.trim() : undefined;
};

/** Text for an XML document: the five characters that must be escaped, escaped. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Characters XML 1.0 does not allow at all, control characters among them.
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '');
}
