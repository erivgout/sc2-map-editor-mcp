/**
 * Localized text tables (PLAN.md §22).
 *
 * Verified against `enUS.SC2Data/LocalizedData/GameStrings.txt` in the editor-produced map
 * that ships with StarCraft II. The format is one `Key=Value` per line, and the details
 * that matter are the ones a naive reader gets wrong:
 *
 * - **A UTF-8 BOM is present.** Dropping it changes the file's first three bytes and can
 *   change how the editor reads it back.
 * - **CRLF line endings**, with a trailing CRLF at end of file.
 * - **Values contain `=`.** They hold markup like
 *   `<IMG path="…" alignment="absolutemiddle"/>`, so the split is on the FIRST `=` only.
 * - Keys are `Category/Field/ObjectId`, e.g. `Unit/Name/Marine`.
 *
 * Editing preserves everything it does not deliberately change: BOM, line endings, key
 * order, blank lines, and any line that is not a key/value pair (PLAN.md §12, §47).
 */

import { SC2Error } from '../errors.js';

export const UTF8_BOM = '﻿';

export interface TextEntry {
  readonly key: string;
  readonly value: string;
  /** 1-based line number in the file. */
  readonly line: number;
  /** Character offset of the whole line, excluding its terminator. */
  readonly start: number;
  readonly end: number;
  /** Offset range of just the value, for a minimal in-place edit. */
  readonly valueStart: number;
  readonly valueEnd: number;
}

export interface TextTable {
  /** Archive-style path of the file. */
  readonly path: string;
  readonly entries: readonly TextEntry[];
  /** Entries by key. On a duplicate key the last definition wins, matching SC2. */
  readonly byKey: ReadonlyMap<string, TextEntry>;
  /** Keys defined more than once; a real authoring error worth surfacing. */
  readonly duplicateKeys: readonly string[];
  /** Lines that are neither blank nor `key=value`. Preserved verbatim. */
  readonly unparsedLines: readonly { line: number; text: string }[];
  readonly hasBom: boolean;
  readonly newline: '\r\n' | '\n';
  /** Whether the file ends with a line terminator. */
  readonly endsWithNewline: boolean;
  /** The original text, retained so offsets stay meaningful. */
  readonly source: string;
}

/**
 * Parses a text table.
 *
 * Never throws on content: an unrecognised line is recorded rather than rejected, because
 * refusing to read a whole table over one odd line would be worse than reporting it.
 */
export function parseTextTable(source: string, path: string): TextTable {
  const hasBom = source.startsWith(UTF8_BOM);
  const body = hasBom ? source.slice(UTF8_BOM.length) : source;
  const offsetBase = hasBom ? UTF8_BOM.length : 0;

  const newline: '\r\n' | '\n' = body.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = body.endsWith('\n');

  const entries: TextEntry[] = [];
  const byKey = new Map<string, TextEntry>();
  const duplicateKeys: string[] = [];
  const unparsedLines: { line: number; text: string }[] = [];

  let offset = offsetBase;
  let lineNumber = 0;

  for (const rawLine of body.split('\n')) {
    lineNumber += 1;
    // `split('\n')` leaves the CR on CRLF files; strip it for content but keep the offset
    // arithmetic based on the raw length.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const lineStart = offset;
    offset += rawLine.length + 1; // +1 for the '\n' that split consumed.

    if (line === '') continue;

    const separator = line.indexOf('=');
    if (separator <= 0) {
      // No '=', or a line starting with one: not a key/value pair. Keep it verbatim.
      unparsedLines.push({ line: lineNumber, text: line });
      continue;
    }

    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);

    const entry: TextEntry = {
      key,
      value,
      line: lineNumber,
      start: lineStart,
      end: lineStart + line.length,
      valueStart: lineStart + separator + 1,
      valueEnd: lineStart + line.length,
    };

    entries.push(entry);
    if (byKey.has(key)) duplicateKeys.push(key);
    // Last definition wins, matching SC2's own load order.
    byKey.set(key, entry);
  }

  return {
    path,
    entries,
    byKey,
    duplicateKeys: [...new Set(duplicateKeys)],
    unparsedLines,
    hasBom,
    newline,
    endsWithNewline,
    source,
  };
}

export type TextTableEdit =
  | { readonly op: 'set'; readonly key: string; readonly value: string }
  | { readonly op: 'delete'; readonly key: string };

export interface TextEditOutcome {
  readonly content: string;
  readonly summary: string[];
  readonly noOps: string[];
}

/**
 * Applies edits to a text table, splicing exact ranges.
 *
 * Existing keys are updated in place, so their position in the file does not move. New
 * keys are appended at the end, which is where the editor puts them and keeps the diff to
 * one added line.
 */
export function applyTextEdits(table: TextTable, edits: readonly TextTableEdit[]): TextEditOutcome {
  const summary: string[] = [];
  const noOps: string[] = [];

  // Collect replacements first, then splice back-to-front so offsets stay valid.
  const replacements: { start: number; end: number; text: string }[] = [];
  const appended: string[] = [];
  const appendedKeys = new Set<string>();

  for (const edit of edits) {
    if (edit.op === 'set' && (edit.key === '' || edit.key.includes('=') || edit.key.includes('\n'))) {
      throw new SC2Error('SC2_INVALID_ARGUMENT', `Not a valid text key: ${JSON.stringify(edit.key)}`, {
        recoverable: true,
        suggestedAction: 'Keys are of the form Category/Field/ObjectId and cannot contain "=" or a newline.',
      });
    }
    if (edit.op === 'set' && edit.value.includes('\n')) {
      // SC2 text tables are line-oriented; an embedded newline would split one entry into
      // two and silently corrupt the table.
      throw new SC2Error('SC2_INVALID_ARGUMENT', `Text values cannot contain a newline (key ${edit.key}).`, {
        recoverable: true,
        suggestedAction: 'Use SC2\'s <n/> markup for a line break inside a string.',
      });
    }

    const existing = table.byKey.get(edit.key);

    if (edit.op === 'delete') {
      if (existing === undefined) {
        noOps.push(`${edit.key} is not in ${table.path}; nothing to delete`);
        continue;
      }
      // Take the line terminator with the line, so no blank line is left behind.
      let end = existing.end;
      if (table.source.startsWith('\r\n', end)) end += 2;
      else if (table.source[end] === '\n') end += 1;
      replacements.push({ start: existing.start, end, text: '' });
      summary.push(`deleted ${edit.key} from ${table.path}`);
      continue;
    }

    if (existing !== undefined) {
      if (existing.value === edit.value) {
        noOps.push(`${edit.key} is already "${edit.value}"`);
        continue;
      }
      replacements.push({ start: existing.valueStart, end: existing.valueEnd, text: edit.value });
      summary.push(`set ${edit.key}: "${existing.value}" -> "${edit.value}"`);
      continue;
    }

    if (appendedKeys.has(edit.key)) {
      throw new SC2Error('SC2_CONFLICT', `Key ${edit.key} is set twice in one request.`, { recoverable: true });
    }
    appendedKeys.add(edit.key);
    appended.push(`${edit.key}=${edit.value}`);
    summary.push(`added ${edit.key}="${edit.value}" to ${table.path}`);
  }

  let content = table.source;

  replacements.sort((left, right) => left.start - right.start);
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    if (replacement === undefined) continue;
    content = content.slice(0, replacement.start) + replacement.text + content.slice(replacement.end);
  }

  if (appended.length > 0) {
    // Match the file's own convention: if it already ends with a newline, append after it;
    // otherwise add one first so the new entry is not glued onto the last line.
    const separator = content.endsWith('\n') ? '' : table.newline;
    content += separator + appended.join(table.newline) + (table.endsWithNewline ? table.newline : '');
  }

  return { content, summary, noOps };
}

/** Splits `Unit/Name/Marine` into its parts, when it has that shape. */
export function parseTextKey(key: string): { category: string; field: string; objectId: string } | null {
  const parts = key.split('/');
  if (parts.length < 3) return null;
  return {
    category: parts[0] ?? '',
    field: parts[1] ?? '',
    // Ids do not contain '/', but rejoining is safer than assuming.
    objectId: parts.slice(2).join('/'),
  };
}

/** Builds the conventional key for a catalog object's display name. */
export function displayNameKey(domain: string, objectId: string): string {
  return `${domain}/Name/${objectId}`;
}
