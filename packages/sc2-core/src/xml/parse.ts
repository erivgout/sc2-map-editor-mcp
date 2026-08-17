/**
 * A small, span-tracking XML reader (PLAN.md §12).
 *
 * Why not a library: this parser exists to serve *lossless editing*, not just reading.
 * Every node records the exact character range it occupies in the source, so a later
 * mutation can splice bytes in place and leave everything it does not understand
 * byte-for-byte identical — comments, attribute order, indentation, the presence or
 * absence of a trailing newline. Generic XML libraries throw that information away, and
 * reserialising a GameData file through one is how a tool silently rewrites 200 KB of
 * someone's map to change one number.
 *
 * Scope: SC2's XML is simple and machine-written. This handles declarations, elements,
 * attributes, text, CDATA, comments, and processing instructions. It does **not**
 * implement DTDs, entity declarations, or namespace resolution, and it does not validate.
 * Malformed input is reported, never silently repaired.
 */

import { SC2Error } from '../errors.js';

export interface XmlSpan {
  /** Inclusive start offset, in UTF-16 code units, into the source string. */
  readonly start: number;
  /** Exclusive end offset. */
  readonly end: number;
}

export interface XmlAttribute {
  readonly name: string;
  /** Entity-decoded value. */
  readonly value: string;
  /** Span of the whole `name="value"` pair. */
  readonly span: XmlSpan;
  /** Span of the value's contents, excluding the quotes. For targeted edits. */
  readonly valueSpan: XmlSpan;
  /** The quote character used, so an edit can preserve the author's choice. */
  readonly quote: '"' | "'";
}

export interface XmlElement {
  readonly kind: 'element';
  readonly name: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: readonly XmlNode[];
  /** Span of the entire element, from `<` through the closing `>`. */
  readonly span: XmlSpan;
  /**
   * Span of the content between the open and close tags, or `null` for a self-closing
   * element. This is what a "replace the contents" edit targets.
   */
  readonly contentSpan: XmlSpan | null;
  readonly selfClosing: boolean;
}

export interface XmlText {
  readonly kind: 'text';
  /** Entity-decoded text. */
  readonly value: string;
  /** Raw source text, undecoded. Use this when re-emitting. */
  readonly raw: string;
  readonly span: XmlSpan;
}

export interface XmlComment {
  readonly kind: 'comment';
  readonly value: string;
  readonly span: XmlSpan;
}

export interface XmlCdata {
  readonly kind: 'cdata';
  readonly value: string;
  readonly span: XmlSpan;
}

export interface XmlProcessingInstruction {
  readonly kind: 'pi';
  readonly target: string;
  readonly value: string;
  readonly span: XmlSpan;
}

export type XmlNode = XmlElement | XmlText | XmlComment | XmlCdata | XmlProcessingInstruction;

export interface XmlDocument {
  /** Everything before, between, and after the root element, in source order. */
  readonly nodes: readonly XmlNode[];
  readonly root: XmlElement | null;
  /** The original source, retained so spans stay meaningful. */
  readonly source: string;
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.-]/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decodes the five predefined entities plus numeric character references.
 *
 * An unrecognised entity is left as-is rather than dropped: SC2 text tables contain
 * literal ampersands, and silently deleting `&foo;` would corrupt user content.
 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** Escapes text for use as element content. */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes text for use inside a double-quoted attribute value. */
export function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

class Parser {
  #position = 0;

  constructor(
    private readonly source: string,
    private readonly path: string | undefined,
  ) {}

  #fail(message: string): never {
    // Line/column, not raw offset: an offset is useless to someone opening the file.
    const upTo = this.source.slice(0, this.#position);
    const line = upTo.split('\n').length;
    const column = this.#position - (upTo.lastIndexOf('\n') + 1) + 1;
    throw new SC2Error('SC2_PARSE_ERROR', `${message} (line ${line}, column ${column})`, {
      ...(this.path !== undefined ? { path: this.path } : {}),
      recoverable: false,
      context: { line, column, offset: this.#position },
    });
  }

  #peek(offset = 0): string {
    return this.source[this.#position + offset] ?? '';
  }

  #startsWith(text: string): boolean {
    return this.source.startsWith(text, this.#position);
  }

  #expect(text: string): void {
    if (!this.#startsWith(text)) this.#fail(`Expected ${JSON.stringify(text)}`);
    this.#position += text.length;
  }

  #skipWhitespace(): void {
    while (this.#position < this.source.length && /\s/.test(this.#peek())) this.#position += 1;
  }

  #readName(): string {
    const start = this.#position;
    if (!NAME_START.test(this.#peek())) this.#fail('Expected a name');
    this.#position += 1;
    while (this.#position < this.source.length && NAME_CHAR.test(this.#peek())) this.#position += 1;
    return this.source.slice(start, this.#position);
  }

  parseDocument(): XmlDocument {
    const nodes: XmlNode[] = [];
    let root: XmlElement | null = null;

    while (this.#position < this.source.length) {
      const node = this.#parseNode();
      if (node === null) break;
      if (node.kind === 'element' && root === null) root = node;
      nodes.push(node);
    }

    return { nodes, root, source: this.source };
  }

  #parseNode(): XmlNode | null {
    if (this.#position >= this.source.length) return null;

    if (this.#startsWith('<!--')) return this.#parseComment();
    if (this.#startsWith('<![CDATA[')) return this.#parseCdata();
    if (this.#startsWith('<?')) return this.#parseProcessingInstruction();
    if (this.#startsWith('<!')) return this.#parseDoctypeAsComment();
    if (this.#startsWith('</')) return null; // Caller handles the close tag.
    if (this.#peek() === '<') return this.#parseElement();
    return this.#parseText();
  }

  #parseComment(): XmlComment {
    const start = this.#position;
    this.#expect('<!--');
    const end = this.source.indexOf('-->', this.#position);
    if (end === -1) this.#fail('Unterminated comment');
    const value = this.source.slice(this.#position, end);
    this.#position = end + 3;
    return { kind: 'comment', value, span: { start, end: this.#position } };
  }

  #parseCdata(): XmlCdata {
    const start = this.#position;
    this.#expect('<![CDATA[');
    const end = this.source.indexOf(']]>', this.#position);
    if (end === -1) this.#fail('Unterminated CDATA section');
    const value = this.source.slice(this.#position, end);
    this.#position = end + 3;
    return { kind: 'cdata', value, span: { start, end: this.#position } };
  }

  #parseProcessingInstruction(): XmlProcessingInstruction {
    const start = this.#position;
    this.#expect('<?');
    const target = this.#readName();
    const end = this.source.indexOf('?>', this.#position);
    if (end === -1) this.#fail('Unterminated processing instruction');
    const value = this.source.slice(this.#position, end).trim();
    this.#position = end + 2;
    return { kind: 'pi', target, value, span: { start, end: this.#position } };
  }

  /**
   * DOCTYPE and other `<!...>` declarations are preserved verbatim as comment nodes.
   *
   * We do not interpret them, but PLAN.md §47 forbids discarding what we do not
   * understand, and keeping the span means a rewrite can reproduce them exactly.
   */
  #parseDoctypeAsComment(): XmlComment {
    const start = this.#position;
    const end = this.source.indexOf('>', this.#position);
    if (end === -1) this.#fail('Unterminated declaration');
    const value = this.source.slice(start, end + 1);
    this.#position = end + 1;
    return { kind: 'comment', value, span: { start, end: this.#position } };
  }

  #parseText(): XmlText {
    const start = this.#position;
    const next = this.source.indexOf('<', this.#position);
    this.#position = next === -1 ? this.source.length : next;
    const raw = this.source.slice(start, this.#position);
    return { kind: 'text', value: decodeEntities(raw), raw, span: { start, end: this.#position } };
  }

  #parseElement(): XmlElement {
    const start = this.#position;
    this.#expect('<');
    const name = this.#readName();

    const attributes: XmlAttribute[] = [];
    for (;;) {
      this.#skipWhitespace();
      if (this.#peek() === '>' || this.#startsWith('/>') || this.#position >= this.source.length) break;
      attributes.push(this.#parseAttribute());
    }

    if (this.#startsWith('/>')) {
      this.#position += 2;
      return {
        kind: 'element',
        name,
        attributes,
        children: [],
        span: { start, end: this.#position },
        contentSpan: null,
        selfClosing: true,
      };
    }

    this.#expect('>');
    const contentStart = this.#position;

    const children: XmlNode[] = [];
    for (;;) {
      if (this.#position >= this.source.length) this.#fail(`Unclosed element <${name}>`);
      if (this.#startsWith('</')) break;
      const child = this.#parseNode();
      if (child === null) break;
      children.push(child);
    }

    const contentEnd = this.#position;
    this.#expect('</');
    const closingName = this.#readName();
    if (closingName !== name) this.#fail(`Closing tag </${closingName}> does not match <${name}>`);
    this.#skipWhitespace();
    this.#expect('>');

    return {
      kind: 'element',
      name,
      attributes,
      children,
      span: { start, end: this.#position },
      contentSpan: { start: contentStart, end: contentEnd },
      selfClosing: false,
    };
  }

  #parseAttribute(): XmlAttribute {
    const start = this.#position;
    const name = this.#readName();
    this.#skipWhitespace();
    this.#expect('=');
    this.#skipWhitespace();

    const quote = this.#peek();
    if (quote !== '"' && quote !== "'") this.#fail(`Attribute ${name} value must be quoted`);
    this.#position += 1;

    const valueStart = this.#position;
    const closing = this.source.indexOf(quote, this.#position);
    if (closing === -1) this.#fail(`Unterminated value for attribute ${name}`);
    const raw = this.source.slice(valueStart, closing);
    this.#position = closing + 1;

    return {
      name,
      value: decodeEntities(raw),
      span: { start, end: this.#position },
      valueSpan: { start: valueStart, end: closing },
      quote,
    };
  }
}

export interface ParseXmlOptions {
  /** Included in error messages so a failure names the file. */
  readonly path?: string | undefined;
}

export function parseXml(source: string, options: ParseXmlOptions = {}): XmlDocument {
  // A UTF-8 BOM is legal and appears in some SC2 text data. Strip it for parsing but
  // note that callers re-emitting the file must put it back.
  const withoutBom = source.startsWith('﻿') ? source.slice(1) : source;
  return new Parser(withoutBom, options.path).parseDocument();
}

/** Direct element children of `element` with the given name. */
export function childElements(element: XmlElement, name?: string): XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement => child.kind === 'element' && (name === undefined || child.name === name),
  );
}

/** First direct child element with the given name, or `null`. */
export function firstChild(element: XmlElement, name: string): XmlElement | null {
  return childElements(element, name)[0] ?? null;
}

export function attributeValue(element: XmlElement, name: string): string | undefined {
  return element.attributes.find((attribute) => attribute.name === name)?.value;
}

/** Concatenated, entity-decoded text of an element's direct text and CDATA children. */
export function textContent(element: XmlElement): string {
  let result = '';
  for (const child of element.children) {
    if (child.kind === 'text') result += child.value;
    else if (child.kind === 'cdata') result += child.value;
  }
  return result;
}

/**
 * Text of an element and all its descendants, with whitespace collapsed.
 *
 * Used to summarise structures a parser does not model, where the point is to show that
 * *something* is there rather than to reproduce it faithfully (PLAN.md §47).
 */
export function deepTextContent(element: XmlElement): string {
  let result = '';
  for (const child of element.children) {
    if (child.kind === 'text' || child.kind === 'cdata') result += child.value;
    else if (child.kind === 'element') result += deepTextContent(child);
  }
  return result.replace(/\s+/g, ' ').trim();
}
