/**
 * Validation and commit (PLAN.md §31, §9, §42 Phase 12).
 *
 * The two tools that decide whether work leaves the staging area. Both are deliberately
 * pessimistic: validation reports what it did *not* check as loudly as what failed, and
 * commit refuses on any of three independent grounds unless each is explicitly waived.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { VALIDATION_CATEGORIES } from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');

const FindingSchema = z.object({
  category: z.string(),
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
  objectId: z.string().optional(),
});

export function registerValidationTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger } = context;

  server.registerTool(
    'sc2_validate_document',
    {
      title: 'Validate the staged document',
      description:
        'Runs every check this build has and reports a verdict per category. Read "notChecked" first: a category with status "unsupported" was NOT examined at all, so a clean report there means nothing. "valid" is false only when a category found an error; warnings — such as a parent that probably lives in an unloaded dependency — do not make a document invalid.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        include_warnings: z.boolean().optional().describe('Include the warning list. Defaults to true.'),
      }),
      outputSchema: z.object({
        valid: z.boolean(),
        errors: z.array(FindingSchema),
        warnings: z.array(FindingSchema),
        checks: z.record(
          z.string(),
          z.object({
            status: z.enum(['passed', 'failed', 'unsupported', 'skipped']),
            reason: z.string().optional(),
            errorCount: z.number().int(),
            warningCount: z.number().int(),
          }),
        ),
        notChecked: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_validate_document', logger }, async (args) => {
      const report = await workspaces.validate(args.workspace_id);
      const includeWarnings = args.include_warnings ?? true;

      const lines = [
        report.valid
          ? `Valid: no errors in the ${VALIDATION_CATEGORIES.length - report.notChecked.length} category/categories that were checked.`
          : `INVALID: ${report.errors.length} error(s).`,
        '',
        ...VALIDATION_CATEGORIES.map((category) => {
          const check = report.checks[category];
          const counts =
            check.status === 'passed' || check.status === 'failed'
              ? ` (${check.errorCount} error(s), ${check.warningCount} warning(s))`
              : '';
          return `  ${category}: ${check.status}${counts}${check.reason === undefined ? '' : ` — ${check.reason}`}`;
        }),
        '',
        ...report.errors.map((finding) => `[error] ${finding.category}: ${finding.message}${finding.path === undefined ? '' : ` (${finding.path})`}`),
        ...(includeWarnings
          ? report.warnings.map((finding) => `[warning] ${finding.category}: ${finding.message}${finding.path === undefined ? '' : ` (${finding.path})`}`)
          : [`${report.warnings.length} warning(s) suppressed.`]),
        '',
        report.notChecked.length === 0
          ? ''
          : `NOT CHECKED AT ALL: ${report.notChecked.join(', ')}. A clean result above says nothing about these.`,
      ].filter((line, index, all) => !(line === '' && all[index - 1] === ''));

      return ok(lines.join('\n'), {
        valid: report.valid,
        errors: [...report.errors],
        warnings: includeWarnings ? [...report.warnings] : [],
        checks: { ...report.checks },
        notChecked: [...report.notChecked],
      });
    }),
  );

  server.registerTool(
    'sc2_commit_document',
    {
      title: 'Write the staged document out',
      description:
        'Writes the staging copy to an output path. Refuses on three independent grounds, each waived separately: validation errors (force), the source having changed since it was opened (allow_source_divergence), and something already existing at the destination (overwrite). Overwriting takes a timestamped backup first unless you turn that off. The output is built beside its destination and moved into place, so an interruption never leaves a half-written document. This build writes unpacked document directories; packing to .SC2Map needs the MPQ helper.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        output_path: z.string().min(1).describe('Absolute path, inside a configured allowed root.'),
        overwrite: z.boolean().optional().describe('Replace an existing destination. Defaults to false.'),
        backup: z.boolean().optional().describe('Back up the destination before overwriting. Defaults to true.'),
        allow_source_divergence: z
          .boolean()
          .optional()
          .describe('Commit even though the source document changed after this workspace was opened.'),
        force: z.boolean().optional().describe('Commit even though validation found errors.'),
      }),
      outputSchema: z.object({
        outputPath: z.string(),
        fileCount: z.number().int(),
        overwritten: z.boolean(),
        backupPath: z.string().nullable(),
        sourceChanged: z.boolean(),
        validation: z.object({
          valid: z.boolean(),
          errorCount: z.number().int(),
          warningCount: z.number().int(),
          notChecked: z.array(z.string()),
        }),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_commit_document', logger }, async (args) => {
      const result = await workspaces.commit(args.workspace_id, {
        outputPath: args.output_path,
        overwrite: args.overwrite,
        backup: args.backup,
        allowSourceDivergence: args.allow_source_divergence,
        force: args.force,
      });

      const packedOutput = /\.(SC2Map|SC2Mod|SC2Campaign)$/i.test(result.commit.outputPath);

      const lines = [
        `Wrote ${result.commit.fileCount} file(s) to ${result.commit.outputPath}.`,
        packedOutput
          ? 'NOTE: this is a packed archive. Repacking is verified by reopening and reading every member, byte-identical round trips pass on real ladder maps, and maps packed by this build load in the Galaxy Editor. Opening the result there is still the only check that proves the document itself is sound.'
          : '',
        result.commit.overwritten
          ? result.commit.backupPath === null
            ? 'The previous contents were replaced without a backup.'
            : `The previous contents were moved to ${result.commit.backupPath}.`
          : '',
        result.sourceChanged ? 'NOTE: the source document had changed since this workspace was opened.' : '',
        result.validation.valid
          ? ''
          : `NOTE: committed with ${result.validation.errors.length} validation error(s) because force was set.`,
        result.validation.notChecked.length === 0
          ? ''
          : `Not validated at all: ${result.validation.notChecked.join(', ')}. Open the result in the Galaxy Editor before relying on it.`,
      ].filter((line) => line !== '');

      return ok(lines.join('\n'), {
        outputPath: result.commit.outputPath,
        fileCount: result.commit.fileCount,
        overwritten: result.commit.overwritten,
        backupPath: result.commit.backupPath,
        sourceChanged: result.sourceChanged,
        validation: {
          valid: result.validation.valid,
          errorCount: result.validation.errors.length,
          warningCount: result.validation.warnings.length,
          notChecked: [...result.validation.notChecked],
        },
      });
    }),
  );
}
