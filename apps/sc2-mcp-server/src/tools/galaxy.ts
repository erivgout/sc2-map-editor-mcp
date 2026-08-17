/**
 * Galaxy script tools (PLAN.md §20, §42 Phase 9).
 *
 * Reading is backed by the vendored `sc2-galaxy-lang` parser through the adapter, so
 * diagnostics are real parser output rather than a regex approximation.
 *
 * Two limits stated in every relevant description, because both change how results should
 * be read:
 *
 *  - **Syntax only.** No type checking. A useful checker needs the game's native
 *    declarations, which live in the SC2 installation and not in a map; without them every
 *    call to a built-in would be flagged. A clean result here means the file parses, not
 *    that it compiles.
 *  - **`MapScript.galaxy` is generated.** The editor overwrites it from trigger data on
 *    every save, so editing it is pointless. It is listed and labelled, never hidden.
 */

import { readFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/server';
import { SC2Error, findGalaxyFiles, parseGalaxy, probeGalaxyToolkit, type ChangeResult } from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');

const SYNTAX_ONLY_NOTE =
  'Syntax only — this build does not type-check Galaxy, because that needs the game\'s native declarations, which are not in a map. A clean result means the file parses.';

const ChangeResultSchema = z.object({
  changeId: z.string(),
  revisionBefore: z.number().int(),
  revisionAfter: z.number().int(),
  dryRun: z.boolean(),
  filesChanged: z.array(
    z.object({
      path: z.string(),
      beforeHash: z.string().nullable(),
      afterHash: z.string().nullable(),
      addedLines: z.number().int(),
      removedLines: z.number().int(),
      diff: z.string().nullable(),
    }),
  ),
  summary: z.array(z.string()),
  diagnostics: z.array(
    z.object({ severity: z.enum(['error', 'warning', 'info']), code: z.string(), message: z.string(), path: z.string().optional() }),
  ),
  requiresRepack: z.boolean(),
  snapshotId: z.string().nullable(),
});

function toStructured(result: ChangeResult): Record<string, unknown> {
  return {
    changeId: result.changeId,
    revisionBefore: result.revisionBefore,
    revisionAfter: result.revisionAfter,
    dryRun: result.dryRun,
    filesChanged: [...result.filesChanged],
    summary: [...result.summary],
    diagnostics: [...result.diagnostics],
    requiresRepack: result.requiresRepack,
    snapshotId: result.snapshotId,
  };
}

export function registerGalaxyTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger } = context;

  /** Fails with a usable message when the vendored toolkit is not built. */
  async function requireToolkit(): Promise<void> {
    const probe = await probeGalaxyToolkit();
    if (probe.available) return;
    throw new SC2Error('SC2_UNSUPPORTED_OPERATION', probe.reason ?? 'The Galaxy toolkit is not available.', {
      recoverable: false,
      suggestedAction: 'Run scripts/bootstrap.ps1 and build the vendored toolkit; see docs/galaxy.md.',
    });
  }

  async function readGalaxy(workspaceId: string, filePath: string): Promise<string> {
    if (!filePath.toLowerCase().endsWith('.galaxy')) {
      throw new SC2Error('SC2_INVALID_ARGUMENT', `Not a Galaxy file: ${filePath}`, { path: filePath, recoverable: true });
    }
    const absolutePath = await workspaces.resolveWorkingPath(workspaceId, filePath);
    try {
      return await readFile(absolutePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SC2Error('SC2_NOT_FOUND', `No such Galaxy file: ${filePath}`, {
          workspaceId,
          path: filePath,
          recoverable: true,
          suggestedAction: 'Use sc2_list_galaxy_files to see what the document contains.',
        });
      }
      throw error;
    }
  }

  server.registerTool(
    'sc2_list_galaxy_files',
    {
      title: 'List Galaxy scripts',
      description:
        'Lists the document\'s Galaxy files. MapScript.galaxy is flagged "generated": the editor rewrites it from trigger data on every save, so editing it accomplishes nothing. Authored libraries live under *.SC2Data.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        files: z.array(z.object({ path: z.string(), sizeBytes: z.number().int(), generated: z.boolean() })),
        toolkitAvailable: z.boolean(),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_list_galaxy_files', logger }, async (args) => {
      const staged = await workspaces.listFiles(args.workspace_id);
      const files = findGalaxyFiles(staged.map((file) => ({ relativePath: file.relativePath, size: file.size })));
      const probe = await probeGalaxyToolkit();

      const note = probe.available
        ? SYNTAX_ONLY_NOTE
        : `Parsing is unavailable: ${probe.reason ?? 'the toolkit is not built'}. Files can still be read as text.`;

      return ok(
        [
          files.length === 0 ? 'This document has no Galaxy scripts.' : `${files.length} Galaxy file(s):`,
          ...files.map((file) => `  ${file.path} (${file.sizeBytes} bytes)${file.generated ? ' — GENERATED from trigger data; do not edit' : ''}`),
          note,
        ].join('\n'),
        { files, toolkitAvailable: probe.available, note },
      );
    }),
  );

  server.registerTool(
    'sc2_get_galaxy_file',
    {
      title: 'Read a Galaxy script',
      description: 'Returns a Galaxy file\'s text, optionally limited to a line range so a large script does not flood the response.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        path: z.string().min(1),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      }),
      outputSchema: z.object({
        path: z.string(),
        content: z.string(),
        totalLines: z.number().int(),
        startLine: z.number().int(),
        endLine: z.number().int(),
        generated: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_galaxy_file', logger }, async (args) => {
      const source = await readGalaxy(args.workspace_id, args.path);
      const lines = source.split(/\r?\n/);

      const startLine = args.start_line ?? 1;
      const endLine = Math.min(args.end_line ?? lines.length, lines.length);
      if (startLine > endLine) {
        throw new SC2Error('SC2_INVALID_ARGUMENT', `start_line ${startLine} is after end_line ${endLine}.`, {
          recoverable: true,
        });
      }

      const slice = lines.slice(startLine - 1, endLine).join('\n');
      const generated = args.path.toLowerCase() === 'mapscript.galaxy';

      return ok(generated ? `(GENERATED FILE — the editor rewrites this from trigger data)\n${slice}` : slice, {
        path: args.path,
        content: slice,
        totalLines: lines.length,
        startLine,
        endLine,
        generated,
      });
    }),
  );

  server.registerTool(
    'sc2_get_galaxy_symbols',
    {
      title: 'List declarations in a Galaxy script',
      description:
        'Parses a Galaxy file and lists its top-level declarations — functions, variables, structs, typedefs — with line numbers, plus the files it includes. Symbol extraction is syntactic; it does not resolve what an identifier refers to.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema, path: z.string().min(1) }),
      outputSchema: z.object({
        path: z.string(),
        symbols: z.array(
          z.object({ name: z.string(), kind: z.string(), line: z.number().int(), start: z.number().int(), end: z.number().int() }),
        ),
        includes: z.array(z.string()),
        errorCount: z.number().int(),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_galaxy_symbols', logger }, async (args) => {
      await requireToolkit();
      const source = await readGalaxy(args.workspace_id, args.path);
      const parsed = await parseGalaxy(args.path, source);
      const errorCount = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;

      return ok(
        [
          `${parsed.symbols.length} declaration(s) in ${args.path}${errorCount > 0 ? ` (${errorCount} parse error(s) — the list may be incomplete)` : ''}:`,
          ...parsed.symbols.map((symbol) => `  ${symbol.kind} ${symbol.name} — line ${symbol.line}`),
          parsed.includes.length === 0 ? '' : `includes: ${parsed.includes.join(', ')}`,
          SYNTAX_ONLY_NOTE,
        ]
          .filter((line) => line !== '')
          .join('\n'),
        {
          path: args.path,
          symbols: [...parsed.symbols],
          includes: [...parsed.includes],
          errorCount,
          note: SYNTAX_ONLY_NOTE,
        },
      );
    }),
  );

  server.registerTool(
    'sc2_get_galaxy_diagnostics',
    {
      title: 'Check Galaxy scripts for syntax errors',
      description:
        'Parses one Galaxy file, or every authored script in the document, and reports syntax errors with line and column. Does NOT type-check: unresolved identifiers, wrong argument types, and missing natives are not detected. Generated MapScript.galaxy is skipped unless named explicitly.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        path: z.string().optional().describe('One file. Omit to check every authored script.'),
      }),
      outputSchema: z.object({
        files: z.array(
          z.object({
            path: z.string(),
            diagnostics: z.array(
              z.object({
                severity: z.enum(['error', 'warning', 'info']),
                message: z.string(),
                line: z.number().int(),
                column: z.number().int(),
                code: z.number().int(),
              }),
            ),
          }),
        ),
        errorCount: z.number().int(),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_galaxy_diagnostics', logger }, async (args) => {
      await requireToolkit();

      let targets: string[];
      if (args.path !== undefined) {
        targets = [args.path];
      } else {
        const staged = await workspaces.listFiles(args.workspace_id);
        targets = findGalaxyFiles(staged.map((file) => ({ relativePath: file.relativePath, size: file.size })))
          .filter((file) => !file.generated)
          .map((file) => file.path);
      }

      const files = [];
      let errorCount = 0;
      for (const target of targets) {
        const parsed = await parseGalaxy(target, await readGalaxy(args.workspace_id, target));
        errorCount += parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
        files.push({ path: target, diagnostics: [...parsed.diagnostics] });
      }

      const lines = [
        errorCount === 0
          ? `No syntax errors in ${files.length} file(s).`
          : `${errorCount} syntax error(s) across ${files.length} file(s):`,
        ...files.flatMap((file) =>
          file.diagnostics.map((diagnostic) => `  ${file.path}:${diagnostic.line}:${diagnostic.column} [${diagnostic.severity}] ${diagnostic.message}`),
        ),
        SYNTAX_ONLY_NOTE,
      ];

      return ok(lines.join('\n'), { files, errorCount, note: SYNTAX_ONLY_NOTE });
    }),
  );

  server.registerTool(
    'sc2_apply_galaxy_patch',
    {
      title: 'Edit a Galaxy script',
      description:
        'Replaces an exact snippet of text in a Galaxy file. The old text must appear exactly once unless you say which occurrence, so a patch cannot silently land in the wrong place. Afterwards the file is reparsed: if the edit introduces syntax errors the change is refused unless force=true. Editing generated MapScript.galaxy is refused outright — the editor would overwrite it. Defaults to a dry run.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        expected_revision: z.number().int().nonnegative().optional(),
        dry_run: z.boolean().optional().describe('Defaults to TRUE. Pass false to actually write.'),
        path: z.string().min(1),
        old_text: z.string().min(1).describe('Exact text to replace, including indentation.'),
        new_text: z.string().describe('Replacement. Empty string deletes the old text.'),
        occurrence: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Which occurrence to replace, 1-based. Required when old_text appears more than once.'),
        force: z.boolean().optional().describe('Apply even if the result has new syntax errors.'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_apply_galaxy_patch', logger }, async (args) => {
      if (args.path.toLowerCase() === 'mapscript.galaxy') {
        throw new SC2Error('SC2_UNSUPPORTED_OPERATION', 'MapScript.galaxy is generated from the trigger data and would be overwritten.', {
          path: args.path,
          recoverable: false,
          suggestedAction: 'Edit an authored library under *.SC2Data, or change the triggers themselves.',
        });
      }

      const source = await readGalaxy(args.workspace_id, args.path);

      // Count occurrences before touching anything: an ambiguous patch is a refusal, not
      // a coin flip.
      const occurrences: number[] = [];
      let searchFrom = 0;
      for (;;) {
        const found = source.indexOf(args.old_text, searchFrom);
        if (found === -1) break;
        occurrences.push(found);
        searchFrom = found + 1;
      }

      if (occurrences.length === 0) {
        throw new SC2Error('SC2_NOT_FOUND', `The text to replace does not appear in ${args.path}.`, {
          path: args.path,
          recoverable: true,
          suggestedAction: 'Read the file with sc2_get_galaxy_file and copy the snippet exactly, including indentation.',
        });
      }
      if (occurrences.length > 1 && args.occurrence === undefined) {
        throw new SC2Error(
          'SC2_CONFLICT',
          `The text to replace appears ${occurrences.length} times in ${args.path}; the patch would be ambiguous.`,
          {
            path: args.path,
            recoverable: true,
            suggestedAction: 'Pass "occurrence" (1-based), or include more surrounding context in old_text.',
          },
        );
      }

      const index = (args.occurrence ?? 1) - 1;
      const start = occurrences[index];
      if (start === undefined) {
        throw new SC2Error('SC2_INVALID_ARGUMENT', `Occurrence ${args.occurrence ?? 1} does not exist; there are ${occurrences.length}.`, {
          path: args.path,
          recoverable: true,
        });
      }

      const updated = source.slice(0, start) + args.new_text + source.slice(start + args.old_text.length);

      // Reparse and compare: new errors block the change, pre-existing ones do not.
      const diagnostics: { severity: 'error' | 'warning'; code: string; message: string; path?: string }[] = [];
      const probe = await probeGalaxyToolkit();
      if (probe.available) {
        const before = await parseGalaxy(args.path, source);
        const after = await parseGalaxy(args.path, updated);
        const beforeErrors = before.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
        const afterErrors = after.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;

        if (afterErrors > beforeErrors) {
          const introduced = after.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
          if (args.force !== true) {
            throw new SC2Error(
              'SC2_VALIDATION_FAILED',
              `This edit introduces ${afterErrors - beforeErrors} syntax error(s) in ${args.path}.`,
              {
                path: args.path,
                recoverable: true,
                suggestedAction: 'Fix the snippet, or pass force=true to write a file that does not parse.',
                context: {
                  errors: introduced.slice(0, 5).map((diagnostic) => `${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`),
                },
              },
            );
          }
          diagnostics.push({
            severity: 'error',
            code: 'SC2_VALIDATION_FAILED',
            message: `force was set: the file now has ${afterErrors} syntax error(s).`,
            path: args.path,
          });
        }
      } else {
        diagnostics.push({
          severity: 'warning',
          code: 'SC2_UNSUPPORTED_OPERATION',
          message: `The edit was not syntax-checked: ${probe.reason ?? 'the Galaxy toolkit is not built'}.`,
          path: args.path,
        });
      }

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_apply_galaxy_patch',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: [`replaced ${args.old_text.length} character(s) at offset ${start} in ${args.path}`],
        diagnostics,
        files: [{ kind: 'write', path: args.path, content: updated }],
      });

      return ok(
        [
          result.dryRun
            ? 'DRY RUN — nothing was written. Pass dry_run=false to apply.'
            : `Applied as ${result.changeId}; workspace is now at revision ${result.revisionAfter}.`,
          ...result.diagnostics.map((entry) => `[${entry.severity}] ${entry.message}`),
          ...result.filesChanged.map((file) => file.diff ?? `${file.path} (+${file.addedLines}/-${file.removedLines})`),
        ]
          .filter((line) => line !== '')
          .join('\n'),
        toStructured(result),
      );
    }),
  );

  server.registerTool(
    'sc2_create_galaxy_file',
    {
      title: 'Create a Galaxy script',
      description:
        'Adds a new Galaxy library to the document. The content is syntax-checked before it is written unless force=true. Note that creating the file does not make the map use it — something has to include it, and this server cannot wire that up for you.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        expected_revision: z.number().int().nonnegative().optional(),
        dry_run: z.boolean().optional(),
        path: z.string().min(1).describe('e.g. "Base.SC2Data/LibMine.galaxy".'),
        content: z.string(),
        force: z.boolean().optional().describe('Create even if the content has syntax errors.'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_create_galaxy_file', logger }, async (args) => {
      if (!args.path.toLowerCase().endsWith('.galaxy')) {
        throw new SC2Error('SC2_INVALID_ARGUMENT', 'A Galaxy file must end in .galaxy.', { path: args.path, recoverable: true });
      }

      const diagnostics: { severity: 'error' | 'warning'; code: string; message: string; path?: string }[] = [];
      const probe = await probeGalaxyToolkit();
      if (probe.available) {
        const parsed = await parseGalaxy(args.path, args.content);
        const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
        if (errors.length > 0 && args.force !== true) {
          throw new SC2Error('SC2_VALIDATION_FAILED', `The content has ${errors.length} syntax error(s).`, {
            path: args.path,
            recoverable: true,
            suggestedAction: 'Fix them, or pass force=true.',
            context: { errors: errors.slice(0, 5).map((error) => `${error.line}:${error.column} ${error.message}`) },
          });
        }
      } else {
        diagnostics.push({
          severity: 'warning',
          code: 'SC2_UNSUPPORTED_OPERATION',
          message: `The content was not syntax-checked: ${probe.reason ?? 'the Galaxy toolkit is not built'}.`,
        });
      }

      diagnostics.push({
        severity: 'warning',
        code: 'SC2_UNSUPPORTED_OPERATION',
        message: 'Creating the file does not make the map use it; something must include it.',
        path: args.path,
      });

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_create_galaxy_file',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: [`created ${args.path} (${args.content.length} characters)`],
        diagnostics,
        files: [{ kind: 'write', path: args.path, content: args.content }],
      });

      return ok(
        [
          result.dryRun ? 'DRY RUN — nothing was written.' : `Applied as ${result.changeId}.`,
          ...result.diagnostics.map((entry) => `[${entry.severity}] ${entry.message}`),
        ].join('\n'),
        toStructured(result),
      );
    }),
  );
}
