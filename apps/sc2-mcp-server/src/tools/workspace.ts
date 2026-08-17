/**
 * Workspace and raw-inspection tools (PLAN.md §16.B, §42 Phase 2/4).
 *
 * Every path the caller supplies is guarded twice: once by {@link PathGuard} against
 * the configured allowed roots (for the source), and once by the archive-path
 * normaliser (for anything addressed inside a workspace). Nothing here can read or
 * write outside a workspace's `working/` tree except `sc2_open_document`, which reads
 * the user-nominated source and copies it.
 */

import { readFile, stat } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/server';
import { SC2Error, hashFile } from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

/** Cap on any single paginated response, regardless of what the caller asks for. */
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;

/** `sc2_read_file` refuses text above this; the caller should read a range instead. */
const MAX_TEXT_READ_BYTES = 4 * 1024 * 1024;
/** Binary reads are base64-encoded into the response, so the ceiling is much lower. */
const MAX_BINARY_READ_BYTES = 1 * 1024 * 1024;

const WorkspaceIdSchema = z
  .string()
  .min(1)
  .describe('Workspace id returned by sc2_open_document.');

const WorkspaceDescriptorSchema = z.object({
  id: z.string(),
  sourcePath: z.string(),
  sourceKind: z.enum(['directory', 'mpq']),
  documentKind: z.enum(['map', 'mod', 'campaign', 'unknown']),
  stagingPath: z.string(),
  sourceHash: z.string(),
  revision: z.number().int(),
  dirty: z.boolean(),
  readOnly: z.boolean(),
  createdAt: z.string(),
  lastAccessedAt: z.string(),
});

/** Decodes an opaque pagination cursor. Invalid cursors are a caller error, not a crash. */
function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Not a valid cursor: ${cursor}`, {
      recoverable: true,
      suggestedAction: 'Omit the cursor to start from the beginning, or pass the next_cursor from a previous response.',
    });
  }
  return parsed;
}

export function registerWorkspaceTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger } = context;

  server.registerTool(
    'sc2_open_document',
    {
      title: 'Open an SC2 document',
      description:
        'Stages a StarCraft II map, mod, or campaign into a server-owned working copy and returns a workspace id used by every other tool. The source is never modified: all edits target the staging copy until sc2_commit_document writes a new file. Currently only unpacked document directories are supported; packed .SC2Map/.SC2Mod archives require the MPQ helper, which this build does not have.',
      inputSchema: z.object({
        source_path: z
          .string()
          .min(1)
          .describe('Absolute path to an unpacked SC2 document directory. Must be inside a configured allowed root.'),
        document_kind: z
          .enum(['map', 'mod', 'campaign', 'unknown'])
          .optional()
          .describe('Overrides kind inference from the path extension. Omit unless the extension is misleading.'),
        read_only: z
          .boolean()
          .optional()
          .describe('When true, every mutating tool refuses on this workspace. Use for inspection of documents you must not change.'),
      }),
      outputSchema: z.object({
        workspace: WorkspaceDescriptorSchema,
        stagedFileCount: z.number().int(),
        stagedBytes: z.number().int(),
      }),
      // Creates server-owned files, so this is NOT read-only (PLAN.md §14).
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_open_document', logger }, async (args) => {
      const result = await workspaces.openDocument({
        sourcePath: args.source_path,
        documentKind: args.document_kind,
        readOnly: args.read_only,
      });

      const summary = [
        `Opened ${result.workspace.documentKind} as workspace ${result.workspace.id}`,
        `source: ${result.workspace.sourcePath} (${result.workspace.sourceKind}, unmodified)`,
        `staging: ${result.workspace.stagingPath}`,
        `staged ${result.stagedFileCount} files, ${result.stagedBytes} bytes`,
        result.workspace.readOnly ? 'opened read-only' : 'edits will apply to the staging copy only',
      ].join('\n');

      return ok(summary, {
        workspace: result.workspace,
        stagedFileCount: result.stagedFileCount,
        stagedBytes: result.stagedBytes,
      });
    }),
  );

  server.registerTool(
    'sc2_get_document_summary',
    {
      title: 'Summarise an open SC2 document',
      description:
        'Returns the workspace descriptor, staged file/byte counts, and the top-level entries of the staged tree. "notYetImplemented" lists the subsystems (components, dependencies, catalogs, Galaxy) this build cannot report on yet — treat their absence as unknown, not as empty.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        workspace: WorkspaceDescriptorSchema,
        fileCount: z.number().int(),
        totalBytes: z.number().int(),
        topLevelEntries: z.array(z.string()),
        notYetImplemented: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_document_summary', logger }, async (args) => {
      const summary = await workspaces.getSummary(args.workspace_id);
      const text = [
        `Workspace ${summary.workspace.id} — ${summary.workspace.documentKind} (revision ${summary.workspace.revision}${summary.workspace.dirty ? ', dirty' : ''})`,
        `source: ${summary.workspace.sourcePath}`,
        `staged: ${summary.fileCount} files, ${summary.totalBytes} bytes`,
        `top level: ${summary.topLevelEntries.length === 0 ? '(empty)' : summary.topLevelEntries.join(', ')}`,
        `not yet inspectable: ${summary.notYetImplemented.join(', ')}`,
      ].join('\n');

      return ok(text, {
        workspace: summary.workspace,
        fileCount: summary.fileCount,
        totalBytes: summary.totalBytes,
        topLevelEntries: [...summary.topLevelEntries],
        notYetImplemented: [...summary.notYetImplemented],
      });
    }),
  );

  server.registerTool(
    'sc2_list_workspaces',
    {
      title: 'List open workspaces',
      description:
        'Lists every workspace this server currently holds on disk. Workspaces survive client reconnects, so this is how to recover a workspace id lost between sessions.',
      inputSchema: z.object({}),
      outputSchema: z.object({ workspaces: z.array(WorkspaceDescriptorSchema) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_list_workspaces', logger }, async () => {
      const list = await workspaces.listWorkspaces();
      const text =
        list.length === 0
          ? 'No open workspaces.'
          : list.map((entry) => `${entry.id} — ${entry.documentKind} — ${entry.sourcePath}${entry.dirty ? ' (dirty)' : ''}`).join('\n');
      return ok(text, { workspaces: list });
    }),
  );

  server.registerTool(
    'sc2_list_files',
    {
      title: 'List files in a workspace',
      description:
        'Lists files in the staged working copy, sorted by path, with optional prefix and glob-free substring filtering. Paginated: pass next_cursor back to continue.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        path_prefix: z
          .string()
          .optional()
          .describe('Only return files whose path starts with this prefix, e.g. "Base.SC2Data/GameData".'),
        contains: z.string().optional().describe('Only return files whose path contains this substring (case-insensitive).'),
        limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
        cursor: z.string().optional(),
      }),
      outputSchema: z.object({
        files: z.array(z.object({ path: z.string(), size: z.number().int() })),
        totalMatched: z.number().int(),
        nextCursor: z.string().nullable(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_list_files', logger }, async (args) => {
      const all = await workspaces.listFiles(args.workspace_id);
      const prefix = args.path_prefix?.toLowerCase();
      const contains = args.contains?.toLowerCase();

      const matched = all.filter((file) => {
        const lower = file.relativePath.toLowerCase();
        if (prefix !== undefined && !lower.startsWith(prefix)) return false;
        if (contains !== undefined && !lower.includes(contains)) return false;
        return true;
      });

      const offset = decodeCursor(args.cursor);
      const limit = args.limit ?? DEFAULT_PAGE_SIZE;
      const page = matched.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const nextCursor = nextOffset < matched.length ? String(nextOffset) : null;

      const text = [
        `${matched.length} file(s) matched; showing ${page.length} starting at ${offset}.`,
        ...page.map((file) => `${file.relativePath} (${file.size} bytes)`),
        nextCursor === null ? '' : `More results: pass cursor="${nextCursor}".`,
      ]
        .filter((line) => line !== '')
        .join('\n');

      return ok(text, {
        files: page.map((file) => ({ path: file.relativePath, size: file.size })),
        totalMatched: matched.length,
        nextCursor,
      });
    }),
  );

  server.registerTool(
    'sc2_read_file',
    {
      title: 'Read a file from a workspace',
      description:
        'Reads one file from the staged working copy. Text is returned as-is; binary content must be requested explicitly and is base64-encoded with a much smaller size limit. Paths are relative to the document root and cannot escape the workspace.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        path: z.string().min(1).describe('Path relative to the document root, e.g. "DocumentInfo" or "Base.SC2Data/GameData/UnitData.xml".'),
        encoding: z
          .enum(['utf8', 'base64'])
          .optional()
          .describe('Defaults to utf8. Use base64 for binary components; the size limit is 1 MiB in that mode.'),
      }),
      outputSchema: z.object({
        path: z.string(),
        size: z.number().int(),
        encoding: z.enum(['utf8', 'base64']),
        content: z.string(),
        hash: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_read_file', logger }, async (args) => {
      const absolutePath = await workspaces.resolveWorkingPath(args.workspace_id, args.path);
      const encoding = args.encoding ?? 'utf8';

      let info;
      try {
        info = await stat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new SC2Error('SC2_NOT_FOUND', `No such file in workspace: ${args.path}`, {
            workspaceId: args.workspace_id,
            path: args.path,
            recoverable: true,
            suggestedAction: 'Use sc2_list_files to see what the document contains.',
          });
        }
        throw error;
      }

      if (!info.isFile()) {
        throw new SC2Error('SC2_INVALID_ARGUMENT', `Not a file: ${args.path}`, {
          workspaceId: args.workspace_id,
          path: args.path,
          recoverable: true,
        });
      }

      const limit = encoding === 'utf8' ? MAX_TEXT_READ_BYTES : MAX_BINARY_READ_BYTES;
      if (info.size > limit) {
        throw new SC2Error('SC2_LIMIT_EXCEEDED', `File is ${info.size} bytes, above the ${limit}-byte limit for ${encoding} reads.`, {
          workspaceId: args.workspace_id,
          path: args.path,
          recoverable: false,
          suggestedAction: 'Use sc2_search_files to locate the region you need instead of reading the whole file.',
        });
      }

      const buffer = await readFile(absolutePath);
      return ok(`Read ${args.path} (${info.size} bytes, ${encoding}).`, {
        path: args.path,
        size: info.size,
        encoding,
        content: buffer.toString(encoding),
        hash: await hashFile(absolutePath),
      });
    }),
  );

  server.registerTool(
    'sc2_search_files',
    {
      title: 'Search file contents in a workspace',
      description:
        'Plain-substring search across text files in the staged working copy, returning matching lines with their file and line number. This is a raw text search with no knowledge of GameData or Galaxy semantics; it is the fallback until the semantic search tools exist.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        query: z.string().min(1).describe('Literal substring to find. Not a regular expression.'),
        case_sensitive: z.boolean().optional(),
        path_prefix: z.string().optional().describe('Restrict the search to files under this path prefix.'),
        limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
      }),
      outputSchema: z.object({
        matches: z.array(z.object({ path: z.string(), line: z.number().int(), text: z.string() })),
        filesSearched: z.number().int(),
        filesSkipped: z.number().int(),
        truncated: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_search_files', logger }, async (args) => {
      const files = await workspaces.listFiles(args.workspace_id);
      const prefix = args.path_prefix?.toLowerCase();
      const caseSensitive = args.case_sensitive ?? false;
      const needle = caseSensitive ? args.query : args.query.toLowerCase();
      const limit = args.limit ?? DEFAULT_PAGE_SIZE;

      const matches: { path: string; line: number; text: string }[] = [];
      let filesSearched = 0;
      let filesSkipped = 0;
      let truncated = false;

      for (const file of files) {
        if (prefix !== undefined && !file.relativePath.toLowerCase().startsWith(prefix)) continue;
        // Skip anything too large to treat as text; searching a 200 MB asset by line
        // would stall the call for no plausible benefit.
        if (file.size > MAX_TEXT_READ_BYTES) {
          filesSkipped += 1;
          continue;
        }

        const buffer = await readFile(file.absolutePath);
        // A NUL byte in the first block is the cheap, reliable binary test that grep
        // itself uses; SC2 text components are UTF-8/UTF-16 without embedded NULs in
        // their first bytes only when they are genuinely text.
        if (buffer.subarray(0, 8192).includes(0)) {
          filesSkipped += 1;
          continue;
        }

        filesSearched += 1;
        const lines = buffer.toString('utf8').split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const raw = lines[index] ?? '';
          const haystack = caseSensitive ? raw : raw.toLowerCase();
          if (!haystack.includes(needle)) continue;
          if (matches.length >= limit) {
            truncated = true;
            break;
          }
          matches.push({ path: file.relativePath, line: index + 1, text: raw.trim().slice(0, 500) });
        }
        if (truncated) break;
      }

      const text = [
        `${matches.length} match(es) in ${filesSearched} text file(s); ${filesSkipped} binary/oversized file(s) skipped.`,
        ...matches.map((match) => `${match.path}:${match.line}: ${match.text}`),
        truncated ? `Result limit of ${limit} reached — narrow the query or raise "limit".` : '',
      ]
        .filter((line) => line !== '')
        .join('\n');

      return ok(text, { matches, filesSearched, filesSkipped, truncated });
    }),
  );

  server.registerTool(
    'sc2_discard_workspace',
    {
      title: 'Discard a workspace',
      description:
        'Deletes the staging copy and all its snapshots and change history. The original source document is never touched. Any uncommitted edits are lost permanently.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({ discarded: z.boolean(), stagingPath: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_discard_workspace', logger }, async (args) => {
      const result = await workspaces.discard(args.workspace_id);
      return ok(
        result.discarded
          ? `Discarded workspace ${args.workspace_id}. The source document was not modified.`
          : `Workspace ${args.workspace_id} did not exist; nothing to discard.`,
        { discarded: result.discarded, stagingPath: result.stagingPath },
      );
    }),
  );
}
