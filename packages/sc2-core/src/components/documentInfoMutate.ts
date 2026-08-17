/**
 * Writing `DocumentInfo` — specifically the dependency chain (PLAN.md §25).
 *
 * Dependency order is load order: later entries win, which is why adding one appends by
 * default rather than inserting somewhere convenient. Entries are written in the editor's
 * own `bnet:Name/0.0/999,file:Mods/Whatever.SC2Mod` form, and existing ones are compared
 * by their `file:` half so the same mod is not added twice under a different display name.
 */

import { SC2Error } from '../errors.js';
import { XmlEditor } from '../xml/edit.js';
import { attributeValue, childElements, escapeText, parseXml, textContent, type XmlElement } from '../xml/parse.js';
import { DOCUMENT_INFO_FILENAME } from './documentInfo.js';

export interface DocumentInfoMutationOutcome {
  readonly content: string;
  readonly summary: string[];
}

function parseDocInfoRoot(source: string): XmlElement {
  const document = parseXml(source, { path: DOCUMENT_INFO_FILENAME });
  if (document.root?.name !== 'DocInfo') {
    throw new SC2Error('SC2_PARSE_ERROR', `${DOCUMENT_INFO_FILENAME} must have a <DocInfo> root element.`, {
      path: DOCUMENT_INFO_FILENAME,
      recoverable: false,
      context: { foundRoot: document.root?.name ?? null },
    });
  }
  return document.root;
}

/** The `file:` half of a dependency string, which is what actually identifies the mod. */
function filePart(raw: string): string {
  const match = /file:([^,]+)/i.exec(raw);
  return (match?.[1] ?? raw).trim().toLowerCase();
}

function dependencyValues(root: XmlElement): { container: XmlElement | null; values: XmlElement[] } {
  const container = childElements(root, 'Dependencies')[0] ?? null;
  return { container, values: container === null ? [] : [...childElements(container, 'Value')] };
}

export function addDependency(source: string, dependency: string): DocumentInfoMutationOutcome {
  const trimmed = dependency.trim();
  if (trimmed === '') {
    throw new SC2Error('SC2_INVALID_ARGUMENT', 'A dependency string cannot be empty.', { recoverable: true });
  }
  if (!/file:/i.test(trimmed)) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `A dependency must name a file, e.g. "bnet:Void (Mod)/0.0/999,file:Mods/Void.SC2Mod"; got "${trimmed}".`, {
      path: DOCUMENT_INFO_FILENAME,
      recoverable: true,
    });
  }

  const root = parseDocInfoRoot(source);
  const { container, values } = dependencyValues(root);

  const wanted = filePart(trimmed);
  for (const value of values) {
    if (filePart(textContent(value)) === wanted) {
      throw new SC2Error('SC2_CONFLICT', `This document already depends on ${textContent(value)}.`, {
        path: DOCUMENT_INFO_FILENAME,
        recoverable: true,
        suggestedAction: 'Remove it first if you meant to change its version or display name.',
      });
    }
  }

  const editor = new XmlEditor(source);
  const rendered = `<Value>${escapeText(trimmed)}</Value>`;

  if (container === null) {
    // A map with no dependencies at all has no <Dependencies> element to append to.
    editor.appendChild(root, `<Dependencies>${editor.newline}    <Value>${escapeText(trimmed)}</Value>${editor.newline}</Dependencies>`, 'add Dependencies');
  } else {
    editor.appendChild(container, rendered, `add dependency ${trimmed}`);
  }

  return {
    content: editor.apply(),
    // Appending puts it last, which in SC2's load order means it wins over the others.
    summary: [`added dependency ${trimmed} (last in load order, so it overrides the entries above it)`],
  };
}

export function removeDependency(source: string, dependency: string): DocumentInfoMutationOutcome {
  const root = parseDocInfoRoot(source);
  const { values } = dependencyValues(root);

  const wanted = filePart(dependency);
  const target = values.find((value) => filePart(textContent(value)) === wanted);
  if (target === undefined) {
    throw new SC2Error('SC2_NOT_FOUND', `This document does not depend on "${dependency}".`, {
      path: DOCUMENT_INFO_FILENAME,
      recoverable: true,
      suggestedAction: 'Call sc2_get_dependencies to see the chain as written.',
    });
  }

  const removed = textContent(target);
  const editor = new XmlEditor(source);
  editor.removeElement(target, `remove dependency ${removed}`);
  return { content: editor.apply(), summary: [`removed dependency ${removed}`] };
}

/**
 * Sets a single-valued `DocInfo` field, e.g. `ModType` or `Icon`.
 *
 * These are `<Field><Value>text</Value></Field>`, so the write targets the inner `Value`
 * and leaves the wrapper alone.
 */
export function setDocumentInfoField(source: string, field: string, value: string): DocumentInfoMutationOutcome {
  if (field === 'Dependencies') {
    throw new SC2Error('SC2_INVALID_ARGUMENT', 'Dependencies are a list; use the add and remove operations instead.', {
      path: DOCUMENT_INFO_FILENAME,
      recoverable: true,
    });
  }

  const root = parseDocInfoRoot(source);
  const editor = new XmlEditor(source);
  const existing = childElements(root, field)[0];

  if (existing === undefined) {
    editor.appendChild(root, `<${field}>${editor.newline}    <Value>${escapeText(value)}</Value>${editor.newline}</${field}>`, `set ${field}`);
    return { content: editor.apply(), summary: [`set ${field} = ${value}`] };
  }

  const valueElement = childElements(existing, 'Value')[0];
  if (valueElement === undefined) {
    editor.appendChild(existing, `<Value>${escapeText(value)}</Value>`, `set ${field}`);
    return { content: editor.apply(), summary: [`set ${field} = ${value}`] };
  }

  const previous = textContent(valueElement);
  if (previous === value) return { content: source, summary: [] };

  if (valueElement.contentSpan === null) {
    throw new SC2Error('SC2_UNSUPPORTED_OPERATION', `${field}'s <Value> is self-closing and cannot be given text.`, {
      path: DOCUMENT_INFO_FILENAME,
      recoverable: true,
    });
  }

  editor.replaceContent(valueElement, escapeText(value), `set ${field}`);
  return { content: editor.apply(), summary: [`set ${field}: ${previous} -> ${value}`] };
}

/** Reads the `id` attribute if present; kept for callers that address entries positionally. */
export function dependencyIdOf(element: XmlElement): string | null {
  return attributeValue(element, 'id') ?? null;
}
