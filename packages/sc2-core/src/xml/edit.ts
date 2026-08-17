/**
 * Lossless XML editing (PLAN.md §12).
 *
 * The rule this file exists to enforce: **text we did not deliberately change comes out
 * byte-for-byte identical**. Not "semantically equivalent", not "reformatted the same
 * way" — identical. Comments, attribute order, indentation style, CRLF versus LF, the
 * presence or absence of a trailing newline, and any construct this codebase does not
 * understand all survive untouched.
 *
 * The only way to get that is to never reserialise. Every operation is recorded as a
 * replacement of an exact source range (from the spans {@link parseXml} captured) and the
 * ranges are spliced into the original string at the end. A generic
 * parse-mutate-serialise cycle cannot do this, and reserialising a 220 KB `UnitData.xml`
 * to change one number produces a diff nobody can review.
 */

import { SC2Error } from '../errors.js';
import { escapeAttribute, type XmlElement, type XmlSpan } from './parse.js';

export interface TextEdit {
  /** Inclusive start offset in the original source. */
  readonly start: number;
  /** Exclusive end offset. `start === end` is an insertion. */
  readonly end: number;
  readonly replacement: string;
  /** Human-readable summary, used to build the change record (PLAN.md §13). */
  readonly description: string;
}

/**
 * Accumulates non-overlapping replacements against one source string.
 *
 * Edits are collected in any order and applied back-to-front, so earlier offsets stay
 * valid while later ones are being rewritten.
 */
export class TextEditBuffer {
  readonly #source: string;
  readonly #edits: TextEdit[] = [];

  constructor(source: string) {
    this.#source = source;
  }

  get source(): string {
    return this.#source;
  }

  get edits(): readonly TextEdit[] {
    return this.#edits;
  }

  get isEmpty(): boolean {
    return this.#edits.length === 0;
  }

  replace(span: XmlSpan, replacement: string, description: string): void {
    if (span.start < 0 || span.end > this.#source.length || span.start > span.end) {
      throw new SC2Error('SC2_INTERNAL_ERROR', `Edit span [${span.start}, ${span.end}) is outside the source.`, {
        recoverable: false,
        context: { sourceLength: this.#source.length },
      });
    }
    this.#edits.push({ start: span.start, end: span.end, replacement, description });
  }

  insert(offset: number, text: string, description: string): void {
    this.replace({ start: offset, end: offset }, text, description);
  }

  /**
   * Produces the edited text.
   *
   * Overlapping edits are a programming error, not a merge to resolve: two operations
   * that both rewrite the same bytes have contradictory intent, and picking one silently
   * would corrupt the document. They are rejected.
   */
  apply(): string {
    if (this.#edits.length === 0) return this.#source;

    // Sort by start; for equal starts, insertions (end === start) come first so several
    // insertions at one point keep their relative order after the reverse walk.
    const ordered = [...this.#edits].sort((left, right) => left.start - right.start || left.end - right.end);

    let previous: TextEdit | undefined;
    for (const current of ordered) {
      // Touching is fine (previous.end === current.start); genuinely overlapping is not.
      if (previous !== undefined && current.start < previous.end) {
        throw new SC2Error(
          'SC2_CONFLICT',
          `Two edits overlap: "${previous.description}" covers [${previous.start}, ${previous.end}) and "${current.description}" covers [${current.start}, ${current.end}).`,
          { recoverable: false },
        );
      }
      previous = current;
    }

    // Back to front, so offsets earlier in the string stay valid as later ones change.
    let result = this.#source;
    for (const edit of [...ordered].reverse()) {
      result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    }
    return result;
  }

  /** One-line summaries of the pending edits, for a change record. */
  summarize(): string[] {
    return this.#edits.map((edit) => edit.description);
  }
}

/** Detects the newline convention actually used, so inserted lines match it. */
export function detectNewline(source: string): '\r\n' | '\n' {
  const firstLf = source.indexOf('\n');
  if (firstLf <= 0) return '\n';
  return source[firstLf - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * The whitespace run immediately before `offset` on its own line — i.e. the indentation of
 * the line `offset` sits on. Used so inserted elements line up with their siblings instead
 * of imposing a style the file does not use.
 */
export function indentationBefore(source: string, offset: number): string {
  let index = offset - 1;
  let indent = '';
  while (index >= 0) {
    const character = source[index];
    if (character === '\n' || character === '\r') break;
    if (character !== ' ' && character !== '\t') return ''; // Not at the start of a line.
    indent = character + indent;
    index -= 1;
  }
  return indent;
}

/**
 * Element-aware editing on top of {@link TextEditBuffer}.
 *
 * Operations take the {@link XmlElement} nodes produced by `parseXml` on the *same*
 * source string. Mixing nodes from a different parse would splice at meaningless offsets,
 * so callers must reparse after applying.
 */
export class XmlEditor {
  readonly #buffer: TextEditBuffer;

  constructor(source: string) {
    this.#buffer = new TextEditBuffer(source);
  }

  get source(): string {
    return this.#buffer.source;
  }

  get isEmpty(): boolean {
    return this.#buffer.isEmpty;
  }

  /** The file's own newline convention, for callers rendering multi-line insertions. */
  get newline(): '\r\n' | '\n' {
    return detectNewline(this.source);
  }

  get edits(): readonly TextEdit[] {
    return this.#buffer.edits;
  }

  apply(): string {
    return this.#buffer.apply();
  }

  summarize(): string[] {
    return this.#buffer.summarize();
  }

  /**
   * Changes an existing attribute's value in place.
   *
   * Only the text between the quotes is replaced, so the author's quote character,
   * spacing around `=`, and the position of the attribute in the tag are all preserved.
   */
  setAttributeValue(element: XmlElement, name: string, value: string): void {
    const attribute = element.attributes.find((candidate) => candidate.name === name);
    if (attribute === undefined) {
      throw new SC2Error('SC2_NOT_FOUND', `<${element.name}> has no attribute "${name}".`, {
        recoverable: true,
        suggestedAction: 'Use addAttribute to create it.',
      });
    }

    // Escape for the quote style actually in use, so a value containing the other quote
    // character does not need escaping it does not require.
    const escaped =
      attribute.quote === '"' ? escapeAttribute(value) : escapeAttribute(value).replace(/&quot;/g, '"').replace(/'/g, '&apos;');

    this.#buffer.replace(attribute.valueSpan, escaped, `set ${element.name}/@${name} = ${value}`);
  }

  /** Adds an attribute at the end of the opening tag. */
  addAttribute(element: XmlElement, name: string, value: string): void {
    if (element.attributes.some((candidate) => candidate.name === name)) {
      throw new SC2Error('SC2_CONFLICT', `<${element.name}> already has attribute "${name}".`, { recoverable: true });
    }

    // Insert just before the tag terminator: `/>` for self-closing, `>` otherwise.
    const openTagEnd = element.selfClosing
      ? this.#findSelfClosingMarker(element)
      : this.#findOpenTagEnd(element);

    this.#buffer.insert(openTagEnd, ` ${name}="${escapeAttribute(value)}"`, `add ${element.name}/@${name} = ${value}`);
  }

  removeAttribute(element: XmlElement, name: string): void {
    const attribute = element.attributes.find((candidate) => candidate.name === name);
    if (attribute === undefined) {
      throw new SC2Error('SC2_NOT_FOUND', `<${element.name}> has no attribute "${name}".`, { recoverable: true });
    }

    // Take the whitespace that precedes the attribute with it, so removal does not leave
    // a double space behind.
    let start = attribute.span.start;
    while (start > 0 && /[ \t]/.test(this.source[start - 1] ?? '')) start -= 1;

    this.#buffer.replace({ start, end: attribute.span.end }, '', `remove ${element.name}/@${name}`);
  }

  /** Replaces an element's entire source text. */
  replaceElement(element: XmlElement, replacement: string, description?: string): void {
    this.#buffer.replace(element.span, replacement, description ?? `replace <${element.name}>`);
  }

  /**
   * Removes an element.
   *
   * When the element is alone on its line, the whole line goes with it. Otherwise only the
   * element's own bytes are removed. Leaving a blank indented line behind would turn a
   * one-object deletion into something that also looks like a formatting change.
   */
  removeElement(element: XmlElement, description?: string): void {
    const span = this.#lineSpanIfAlone(element.span) ?? element.span;
    this.#buffer.replace(span, '', description ?? `remove <${element.name}>`);
  }

  /**
   * The full-line span around `span`, or `null` when the line holds anything else.
   */
  #lineSpanIfAlone(span: XmlSpan): XmlSpan | null {
    let start = span.start;
    while (start > 0 && /[ \t]/.test(this.source[start - 1] ?? '')) start -= 1;
    // Only whitespace may precede it on the line.
    if (start > 0 && this.source[start - 1] !== '\n') return null;

    let end = span.end;
    while (end < this.source.length && /[ \t]/.test(this.source[end] ?? '')) end += 1;

    if (this.source.startsWith('\r\n', end)) return { start, end: end + 2 };
    if (this.source[end] === '\n') return { start, end: end + 1 };
    // End of file with no trailing newline: take the preceding one instead, so the
    // previous line does not gain a dangling blank line after it.
    if (end === this.source.length) {
      let withPrecedingNewline = start;
      if (withPrecedingNewline > 0 && this.source[withPrecedingNewline - 1] === '\n') {
        withPrecedingNewline -= 1;
        if (withPrecedingNewline > 0 && this.source[withPrecedingNewline - 1] === '\r') withPrecedingNewline -= 1;
      }
      return { start: withPrecedingNewline, end };
    }
    return null;
  }

  /**
   * Inserts text as the last child of `parent`, matching sibling indentation.
   *
   * Throws for a self-closing parent: turning `<X/>` into `<X>…</X>` is a structural
   * rewrite, and doing it implicitly would surprise a caller who only meant to add a field.
   */
  appendChild(parent: XmlElement, text: string, description?: string): void {
    if (parent.contentSpan === null) {
      throw new SC2Error('SC2_UNSUPPORTED_OPERATION', `<${parent.name}> is self-closing and has no content to append to.`, {
        recoverable: true,
        suggestedAction: 'Replace the whole element instead, so the open/close form is explicit.',
      });
    }

    const newline = detectNewline(this.source);
    const lastChild = [...parent.children].reverse().find((child) => child.kind === 'element');

    // Match an existing sibling's indentation where there is one; otherwise indent one
    // level in from the parent, using the parent's own indent as the unit.
    const indent =
      lastChild === undefined
        ? indentationBefore(this.source, parent.span.start) + '    '
        : indentationBefore(this.source, lastChild.span.start);

    const insertionPoint = lastChild === undefined ? parent.contentSpan.start : lastChild.span.end;

    this.#buffer.insert(
      insertionPoint,
      `${newline}${indent}${text}`,
      description ?? `append child to <${parent.name}>`,
    );
  }

  /** Inserts text on its own line immediately after `element`, at the same indentation. */
  insertAfter(element: XmlElement, text: string, description?: string): void {
    const newline = detectNewline(this.source);
    const indent = indentationBefore(this.source, element.span.start);
    this.#buffer.insert(element.span.end, `${newline}${indent}${text}`, description ?? `insert after <${element.name}>`);
  }

  /** Replaces an element's children while keeping its tags. */
  replaceContent(element: XmlElement, replacement: string, description?: string): void {
    if (element.contentSpan === null) {
      throw new SC2Error('SC2_UNSUPPORTED_OPERATION', `<${element.name}> is self-closing and has no content to replace.`, {
        recoverable: true,
      });
    }
    this.#buffer.replace(element.contentSpan, replacement, description ?? `replace contents of <${element.name}>`);
  }

  /** Offset of the `>` that ends a non-self-closing open tag. */
  #findOpenTagEnd(element: XmlElement): number {
    const lastAttribute = element.attributes.at(-1);
    const searchFrom = lastAttribute === undefined ? element.span.start + 1 : lastAttribute.span.end;
    const index = this.source.indexOf('>', searchFrom);
    if (index === -1 || index >= element.span.end) {
      throw new SC2Error('SC2_INTERNAL_ERROR', `Could not locate the end of the <${element.name}> opening tag.`, {
        recoverable: false,
      });
    }
    return index;
  }

  /** Offset of the `/` in a self-closing tag's `/>`. */
  #findSelfClosingMarker(element: XmlElement): number {
    const index = this.source.lastIndexOf('/>', element.span.end);
    if (index === -1 || index < element.span.start) {
      throw new SC2Error('SC2_INTERNAL_ERROR', `Could not locate the "/>" of <${element.name}>.`, { recoverable: false });
    }
    return index;
  }
}

/**
 * Rewrites `<X a="1"/>` as `<X a="1">` + newline + `</X>` so children can be appended.
 *
 * {@link XmlEditor.appendChild} deliberately refuses a self-closing parent, because turning
 * one form into the other is a structural rewrite rather than a field edit. This makes that
 * rewrite explicit and separate: a caller that genuinely needs to add a first child does it
 * here, in its own edit, and then works against the reparsed result.
 *
 * Returns the source unchanged when the element already has an open/close form.
 */
export function expandSelfClosingElement(source: string, element: XmlElement): string {
  if (!element.selfClosing) return source;

  const marker = source.lastIndexOf('/>', element.span.end);
  if (marker === -1 || marker < element.span.start) {
    throw new SC2Error('SC2_INTERNAL_ERROR', `Could not locate the "/>" of <${element.name}>.`, { recoverable: false });
  }

  const newline = detectNewline(source);
  const indent = indentationBefore(source, element.span.start);
  // Drop the whitespace that separated the last attribute from the marker, so `<X />`
  // closes as `<X>` rather than `<X >`.
  const head = source.slice(0, marker).replace(/[ \t]+$/, '');

  return `${head}>${newline}${indent}</${element.name}>${source.slice(element.span.end)}`;
}
