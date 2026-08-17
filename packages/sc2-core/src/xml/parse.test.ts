import { describe, expect, it } from 'vitest';

import { SC2Error } from '../errors.js';
import { attributeValue, childElements, decodeEntities, escapeAttribute, escapeText, parseXml, textContent } from './parse.js';

describe('parseXml', () => {
  it('parses elements, attributes, and text', () => {
    const document = parseXml('<root a="1" b="two">hello</root>');

    expect(document.root?.name).toBe('root');
    expect(attributeValue(document.root!, 'a')).toBe('1');
    expect(attributeValue(document.root!, 'b')).toBe('two');
    expect(textContent(document.root!)).toBe('hello');
  });

  it('keeps the XML declaration as a node rather than discarding it', () => {
    const document = parseXml('<?xml version="1.0" encoding="utf-8"?>\n<root/>');
    const declaration = document.nodes.find((node) => node.kind === 'pi');

    expect(declaration).toBeDefined();
    expect(declaration?.kind === 'pi' ? declaration.target : '').toBe('xml');
  });

  it('preserves comments, which a lossless rewrite must reproduce', () => {
    const document = parseXml('<root><!-- keep me --><child/></root>');
    const comment = document.root!.children.find((node) => node.kind === 'comment');

    expect(comment?.kind === 'comment' ? comment.value : '').toBe(' keep me ');
  });

  it('records spans that map back to the exact source text', () => {
    const source = '<root>\n    <child id="x">value</child>\n</root>';
    const document = parseXml(source);
    const child = childElements(document.root!, 'child')[0]!;

    // The spans are what make in-place, minimal-diff edits possible (PLAN.md §12).
    expect(source.slice(child.span.start, child.span.end)).toBe('<child id="x">value</child>');
    expect(source.slice(child.contentSpan!.start, child.contentSpan!.end)).toBe('value');

    const idAttribute = child.attributes[0]!;
    expect(source.slice(idAttribute.span.start, idAttribute.span.end)).toBe('id="x"');
    expect(source.slice(idAttribute.valueSpan.start, idAttribute.valueSpan.end)).toBe('x');
  });

  it('marks self-closing elements and gives them no content span', () => {
    const document = parseXml('<root><child/></root>');
    const child = childElements(document.root!, 'child')[0]!;

    expect(child.selfClosing).toBe(true);
    expect(child.contentSpan).toBeNull();
  });

  it('records the quote character an author used', () => {
    const document = parseXml(`<root a='single' b="double"/>`);
    expect(document.root!.attributes[0]?.quote).toBe("'");
    expect(document.root!.attributes[1]?.quote).toBe('"');
  });

  it('handles CDATA without interpreting its contents', () => {
    const document = parseXml('<root><![CDATA[<not> & markup]]></root>');
    expect(textContent(document.root!)).toBe('<not> & markup');
  });

  it('strips a UTF-8 BOM so it does not become part of the first node', () => {
    const document = parseXml('﻿<root/>');
    expect(document.root?.name).toBe('root');
  });

  it('reports a mismatched closing tag with a line and column', () => {
    let thrown: unknown;
    try {
      parseXml('<root>\n  <a></b>\n</root>');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SC2Error);
    expect((thrown as SC2Error).code).toBe('SC2_PARSE_ERROR');
    // An offset would be useless to someone opening the file in an editor.
    expect((thrown as SC2Error).message).toMatch(/line 2/);
  });

  it('reports an unclosed element rather than silently accepting it', () => {
    expect(() => parseXml('<root><child></root>')).toThrow(SC2Error);
  });

  it('requires attribute values to be quoted', () => {
    expect(() => parseXml('<root a=1/>')).toThrow(SC2Error);
  });
});

describe('entity handling', () => {
  it('decodes the five predefined entities', () => {
    expect(decodeEntities('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;')).toBe(`<a> & "b" 'c'`);
  });

  it('decodes decimal and hexadecimal character references', () => {
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
  });

  it('leaves an unknown entity alone rather than deleting it', () => {
    // SC2 text tables contain literal ampersands; dropping `&foo;` would corrupt them.
    expect(decodeEntities('a &foo; b')).toBe('a &foo; b');
  });

  it('round-trips through the escapers', () => {
    const original = `Tom & Jerry <"quoted">`;
    expect(decodeEntities(escapeText(original))).toBe(original);
    expect(decodeEntities(escapeAttribute(original))).toBe(original);
  });
});
