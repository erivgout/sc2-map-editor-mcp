/**
 * Unified text diff (PLAN.md §13).
 *
 * Written rather than taken from a library because the output goes to a language model as
 * the primary evidence of what a mutation did. That means it must be exact, deterministic,
 * and bounded — a diff that silently truncates, or that reorders equally-good edit scripts
 * between runs, is worse than no diff.
 *
 * The algorithm is Myers' O(ND) shortest edit script over lines, with a fallback to a
 * whole-file replacement when the two versions are too dissimilar for it to be worth the
 * work. Line-level is the right granularity: SC2 XML is one field per line.
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion --
 * Myers' algorithm walks arrays by computed index inside bounds the algorithm itself
 * establishes (`d <= max`, `k` within `[-d, d]`, `x < beforeLength`). With
 * `noUncheckedIndexedAccess` every such access is `T | undefined`, and the checker cannot
 * see those invariants. Adding runtime guards to the inner loop of a diff would cost
 * clarity and speed to defend against states the algorithm cannot reach. The assertions
 * are confined to this file, and the tests cover the boundary cases (empty inputs,
 * pure insertion, pure deletion, single-line change in a long file).
 */

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Lines prefixed with ' ', '-', or '+'. */
  readonly lines: readonly string[];
}

export interface FileDiff {
  readonly path: string;
  readonly hunks: readonly DiffHunk[];
  readonly addedLines: number;
  readonly removedLines: number;
  /** True when the diff was cut short by {@link DiffOptions.maxHunks}. */
  readonly truncated: boolean;
  /** Set when a side is binary; no hunks are produced. */
  readonly binary: boolean;
}

export interface DiffOptions {
  /** Context lines around each change. */
  readonly context?: number;
  /** Cap on hunks emitted. Exceeding it sets `truncated` rather than silently stopping. */
  readonly maxHunks?: number;
  /**
   * Above this many lines on either side, the O(ND) search is skipped and the file is
   * reported as wholly replaced. Prevents a pathological diff from stalling a tool call.
   */
  readonly maxLines?: number;
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_HUNKS = 100;
const DEFAULT_MAX_LINES = 20_000;

interface EditOperation {
  kind: 'equal' | 'delete' | 'insert';
  line: string;
}

/** Splits into lines without inventing or dropping a trailing empty line. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\n/);
  // A trailing newline yields a final empty element; that is an artefact of splitting, not
  // a real line, so it is removed. Its presence is still visible in the byte comparison.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Myers' shortest edit script.
 *
 * Returns operations in source order. Ties are broken consistently (deletes before
 * inserts), so the same inputs always produce the same script.
 */
function myersDiff(before: readonly string[], after: readonly string[]): EditOperation[] {
  const beforeLength = before.length;
  const afterLength = after.length;
  const max = beforeLength + afterLength;

  if (max === 0) return [];

  // v[k] = furthest x reached on diagonal k. Offset by `max` since k can be negative.
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  let reachedD = -1;
  outer: for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const index = k + max;
      let x: number;
      // Move down when that reaches further; otherwise move right.
      if (k === -d || (k !== d && (v[index - 1] ?? 0) < (v[index + 1] ?? 0))) {
        x = v[index + 1] ?? 0;
      } else {
        x = (v[index - 1] ?? 0) + 1;
      }
      let y = x - k;

      while (x < beforeLength && y < afterLength && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      v[index] = x;

      if (x >= beforeLength && y >= afterLength) {
        reachedD = d;
        break outer;
      }
    }
  }

  if (reachedD === -1) {
    // Unreachable for well-formed input, but falling back beats throwing in a diff.
    return [
      ...before.map((line): EditOperation => ({ kind: 'delete', line })),
      ...after.map((line): EditOperation => ({ kind: 'insert', line })),
    ];
  }

  // Walk the trace backwards to recover the script.
  const operations: EditOperation[] = [];
  let x = beforeLength;
  let y = afterLength;

  for (let d = reachedD; d > 0; d -= 1) {
    const previous = trace[d]!;
    const k = x - y;
    const index = k + max;

    const previousK =
      k === -d || (k !== d && (previous[index - 1] ?? 0) < (previous[index + 1] ?? 0)) ? k + 1 : k - 1;
    const previousX = previous[previousK + max] ?? 0;
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      operations.push({ kind: 'equal', line: before[x]! });
    }

    if (d > 0) {
      if (x > previousX) {
        x -= 1;
        operations.push({ kind: 'delete', line: before[x]! });
      } else {
        y -= 1;
        operations.push({ kind: 'insert', line: after[y]! });
      }
    }
  }

  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    operations.push({ kind: 'equal', line: before[x]! });
  }
  while (x > 0) {
    x -= 1;
    operations.push({ kind: 'delete', line: before[x]! });
  }
  while (y > 0) {
    y -= 1;
    operations.push({ kind: 'insert', line: after[y]! });
  }

  return operations.reverse();
}

/** Groups an edit script into hunks with surrounding context. */
function toHunks(operations: readonly EditOperation[], context: number, maxHunks: number): { hunks: DiffHunk[]; truncated: boolean } {
  const hunks: DiffHunk[] = [];
  let truncated = false;

  let oldLine = 1;
  let newLine = 1;
  let index = 0;

  while (index < operations.length) {
    if (operations[index]!.kind === 'equal') {
      oldLine += 1;
      newLine += 1;
      index += 1;
      continue;
    }

    if (hunks.length >= maxHunks) {
      truncated = true;
      break;
    }

    // Back up over the leading context.
    let start = index;
    let leading = 0;
    while (start > 0 && leading < context && operations[start - 1]!.kind === 'equal') {
      start -= 1;
      leading += 1;
    }

    // Extend forward, absorbing runs of equals shorter than 2*context so adjacent changes
    // land in one hunk rather than two that visually overlap.
    let end = index;
    let trailingEquals = 0;
    while (end < operations.length) {
      const operation = operations[end]!;
      if (operation.kind === 'equal') {
        trailingEquals += 1;
        if (trailingEquals > context * 2) break;
      } else {
        trailingEquals = 0;
      }
      end += 1;
    }
    // Trim back to at most `context` trailing equals.
    while (end > index && trailingEquals > context) {
      end -= 1;
      trailingEquals -= 1;
    }

    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let cursor = start; cursor < end; cursor += 1) {
      const operation = operations[cursor]!;
      if (operation.kind === 'equal') {
        lines.push(` ${operation.line}`);
        oldCount += 1;
        newCount += 1;
      } else if (operation.kind === 'delete') {
        lines.push(`-${operation.line}`);
        oldCount += 1;
      } else {
        lines.push(`+${operation.line}`);
        newCount += 1;
      }
    }

    hunks.push({
      oldStart: oldLine - leading,
      oldLines: oldCount,
      newStart: newLine - leading,
      newLines: newCount,
      lines,
    });

    // Advance the line counters over everything this hunk consumed.
    for (let cursor = index; cursor < end; cursor += 1) {
      const operation = operations[cursor]!;
      if (operation.kind !== 'insert') oldLine += 1;
      if (operation.kind !== 'delete') newLine += 1;
    }
    index = end;
  }

  return { hunks, truncated };
}

/** True when the content looks binary, using the same NUL-byte heuristic grep uses. */
export function looksBinary(content: string): boolean {
  return content.slice(0, 8192).includes('\u0000');
}

export function diffText(path: string, before: string, after: string, options: DiffOptions = {}): FileDiff {
  const context = options.context ?? DEFAULT_CONTEXT;
  const maxHunks = options.maxHunks ?? DEFAULT_MAX_HUNKS;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;

  if (before === after) {
    return { path, hunks: [], addedLines: 0, removedLines: 0, truncated: false, binary: false };
  }

  if (looksBinary(before) || looksBinary(after)) {
    return { path, hunks: [], addedLines: 0, removedLines: 0, truncated: false, binary: true };
  }

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  if (beforeLines.length > maxLines || afterLines.length > maxLines) {
    // Say so rather than spending unbounded time or emitting a misleading partial diff.
    return {
      path,
      hunks: [],
      addedLines: afterLines.length,
      removedLines: beforeLines.length,
      truncated: true,
      binary: false,
    };
  }

  const operations = myersDiff(beforeLines, afterLines);
  const { hunks, truncated } = toHunks(operations, context, maxHunks);

  return {
    path,
    hunks,
    addedLines: operations.filter((operation) => operation.kind === 'insert').length,
    removedLines: operations.filter((operation) => operation.kind === 'delete').length,
    truncated,
    binary: false,
  };
}

/** Renders a {@link FileDiff} in unified-diff format. */
export function formatUnifiedDiff(diff: FileDiff): string {
  if (diff.binary) return `--- a/${diff.path}\n+++ b/${diff.path}\nBinary files differ.`;
  if (diff.hunks.length === 0) {
    return diff.truncated
      ? `--- a/${diff.path}\n+++ b/${diff.path}\nFile is too large to diff line by line (${diff.removedLines} -> ${diff.addedLines} lines).`
      : '';
  }

  const lines = [`--- a/${diff.path}`, `+++ b/${diff.path}`];
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    lines.push(...hunk.lines);
  }
  if (diff.truncated) lines.push(`... diff truncated after ${diff.hunks.length} hunks.`);
  return lines.join('\n');
}
