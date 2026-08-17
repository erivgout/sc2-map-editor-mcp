/**
 * Localization tools (PLAN.md §22, §42 Phase 10).
 *
 * Text tables are the lowest-risk writable component in an SC2 document — line-oriented,
 * plain, with no cross-references to break. They are also what makes an authored object
 * actually usable: a cloned unit with no display name is a unit called `Unit/Name/RailMarine`
 * on screen.
 *
 * Edits preserve the file's BOM, line endings, key order, and every line that is not a
 * key/value pair.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { SC2Error, applyTextEdits, localesFrom, type ChangeResult } from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');
const MAX_RESULTS = 500;

const MutationArgsShape = {
  workspace_id: WorkspaceIdSchema,
  expected_revision: z.number().int().nonnegative().optional(),
  dry_run: z.boolean().optional().describe('Defaults to TRUE. Pass false to actually write.'),
};

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

function describeChange(result: ChangeResult): string {
  return [
    result.dryRun
      ? 'DRY RUN — nothing was written. Pass dry_run=false to apply.'
      : `Applied as ${result.changeId}; workspace is now at revision ${result.revisionAfter}.`,
    ...result.summary.map((line) => `- ${line}`),
    ...result.filesChanged.map((file) => file.diff ?? `${file.path} (+${file.addedLines}/-${file.removedLines})`),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function registerTextTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger, config } = context;

  /** Resolves the table a request means, defaulting to GameStrings in the given locale. */
  async function resolveTablePath(workspaceId: string, locale: string | undefined, table: string | undefined): Promise<string> {
    const tables = await workspaces.listTextTables(workspaceId);
    const wantedLocale = (locale ?? config.defaultLocale).toLowerCase();
    const wantedTable = (table ?? 'GameStrings').toLowerCase();

    const match = tables.find(
      (candidate) => candidate.locale.toLowerCase() === wantedLocale && candidate.table.toLowerCase() === wantedTable,
    );
    if (match !== undefined) return match.path;

    throw new SC2Error(
      'SC2_NOT_FOUND',
      `This document has no ${table ?? 'GameStrings'} table for locale ${locale ?? config.defaultLocale}.`,
      {
        workspaceId,
        recoverable: true,
        suggestedAction:
          tables.length === 0
            ? 'The document has no localized text at all.'
            : `Available: ${tables.map((candidate) => `${candidate.locale}/${candidate.table}`).join(', ')}`,
      },
    );
  }

  server.registerTool(
    'sc2_list_locales',
    {
      title: 'List locales and text tables',
      description:
        'Lists the localized text tables in the document, grouped by locale. Text lives at <locale>.SC2Data/LocalizedData/<Table>.txt; the locale comes from the directory name.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        locales: z.array(z.string()),
        defaultLocale: z.string(),
        tables: z.array(
          z.object({ path: z.string(), locale: z.string(), table: z.string(), sizeBytes: z.number().int() }),
        ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_list_locales', logger }, async (args) => {
      const tables = await workspaces.listTextTables(args.workspace_id);
      const locales = localesFrom(tables);

      const text =
        tables.length === 0
          ? 'This document has no localized text tables.'
          : [
              `Locales: ${locales.join(', ')} (server default: ${config.defaultLocale})`,
              ...tables.map((table) => `  ${table.path} (${table.sizeBytes} bytes)`),
            ].join('\n');

      return ok(text, { locales, defaultLocale: config.defaultLocale, tables });
    }),
  );

  server.registerTool(
    'sc2_search_text_keys',
    {
      title: 'Search localized text',
      description:
        'Searches a text table by key and/or value, case-insensitively. Keys are Category/Field/ObjectId, e.g. "Unit/Name/Marine". Defaults to the GameStrings table in the server\'s default locale.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        query: z.string().optional().describe('Substring to find. Omit to list the whole table.'),
        search_values: z.boolean().optional().describe('Also match against values, not just keys. Defaults to true.'),
        locale: z.string().optional(),
        table: z.string().optional().describe('Table name without extension, e.g. "GameStrings" or "ObjectStrings".'),
        limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
      }),
      outputSchema: z.object({
        path: z.string(),
        total: z.number().int(),
        entries: z.array(z.object({ key: z.string(), value: z.string(), line: z.number().int() })),
        truncated: z.boolean(),
        duplicateKeys: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_search_text_keys', logger }, async (args) => {
      const tablePath = await resolveTablePath(args.workspace_id, args.locale, args.table);
      const table = await workspaces.getTextTable(args.workspace_id, tablePath);

      const needle = args.query?.toLowerCase();
      const searchValues = args.search_values ?? true;
      const matched = table.entries.filter((entry) => {
        if (needle === undefined) return true;
        if (entry.key.toLowerCase().includes(needle)) return true;
        return searchValues && entry.value.toLowerCase().includes(needle);
      });

      const limit = args.limit ?? 100;
      const page = matched.slice(0, limit);

      const text = [
        `${matched.length} entry/entries in ${tablePath}; showing ${page.length}.`,
        ...page.map((entry) => `  ${entry.key} = ${entry.value}`),
        table.duplicateKeys.length > 0 ? `Duplicate keys (last wins): ${table.duplicateKeys.join(', ')}` : '',
      ].filter((line) => line !== '');

      return ok(text.join('\n'), {
        path: tablePath,
        total: matched.length,
        entries: page.map((entry) => ({ key: entry.key, value: entry.value, line: entry.line })),
        truncated: matched.length > page.length,
        duplicateKeys: [...table.duplicateKeys],
      });
    }),
  );

  server.registerTool(
    'sc2_get_text_value',
    {
      title: 'Get a localized string',
      description: 'Reads one key from a text table. Reports absence as not-found rather than as an empty string.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        key: z.string().min(1).describe('e.g. "Unit/Name/Marine".'),
        locale: z.string().optional(),
        table: z.string().optional(),
      }),
      outputSchema: z.object({ key: z.string(), value: z.string(), path: z.string(), line: z.number().int() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_text_value', logger }, async (args) => {
      const tablePath = await resolveTablePath(args.workspace_id, args.locale, args.table);
      const table = await workspaces.getTextTable(args.workspace_id, tablePath);
      const entry = table.byKey.get(args.key);

      if (entry === undefined) {
        throw new SC2Error('SC2_NOT_FOUND', `${tablePath} has no key "${args.key}".`, {
          workspaceId: args.workspace_id,
          path: tablePath,
          recoverable: true,
          suggestedAction: 'Use sc2_search_text_keys to find the right key.',
        });
      }

      return ok(`${entry.key} = ${entry.value}`, {
        key: entry.key,
        value: entry.value,
        path: tablePath,
        line: entry.line,
      });
    }),
  );

  server.registerTool(
    'sc2_set_text_value',
    {
      title: 'Set localized strings',
      description:
        'Creates or updates keys in a text table. Existing keys are edited in place so they keep their position; new keys are appended. The file\'s BOM, CRLF endings, and every unrelated line are preserved. Values cannot contain a newline — use SC2\'s <n/> markup. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        entries: z.array(z.object({ key: z.string().min(1), value: z.string() })).min(1),
        locale: z.string().optional(),
        table: z.string().optional(),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_set_text_value', logger }, async (args) => {
      const tablePath = await resolveTablePath(args.workspace_id, args.locale, args.table);
      const table = await workspaces.getTextTable(args.workspace_id, tablePath);
      const outcome = applyTextEdits(
        table,
        args.entries.map((entry) => ({ op: 'set' as const, key: entry.key, value: entry.value })),
      );

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_set_text_value',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: [...outcome.summary, ...outcome.noOps.map((line) => `no-op: ${line}`)],
        files: [{ kind: 'write', path: tablePath, content: outcome.content }],
      });

      return ok(describeChange(result), toStructured(result));
    }),
  );

  server.registerTool(
    'sc2_delete_text_key',
    {
      title: 'Delete localized strings',
      description:
        'Removes keys from a text table, taking the whole line so no blank line is left behind. Deleting a key that something still displays leaves that text blank in game; this server cannot see those uses, so check first. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        keys: z.array(z.string().min(1)).min(1),
        locale: z.string().optional(),
        table: z.string().optional(),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_delete_text_key', logger }, async (args) => {
      const tablePath = await resolveTablePath(args.workspace_id, args.locale, args.table);
      const table = await workspaces.getTextTable(args.workspace_id, tablePath);
      const outcome = applyTextEdits(
        table,
        args.keys.map((key) => ({ op: 'delete' as const, key })),
      );

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_delete_text_key',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: [...outcome.summary, ...outcome.noOps.map((line) => `no-op: ${line}`)],
        files: [{ kind: 'write', path: tablePath, content: outcome.content }],
      });

      return ok(describeChange(result), toStructured(result));
    }),
  );

  server.registerTool(
    'sc2_copy_text_key',
    {
      title: 'Copy localized strings between keys or locales',
      description:
        'Copies values from one key to another, optionally into a different locale. Useful right after cloning a catalog object: copy the original\'s display name and tooltip onto the new id, then edit them. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        copies: z
          .array(z.object({ from_key: z.string().min(1), to_key: z.string().min(1) }))
          .min(1),
        from_locale: z.string().optional(),
        to_locale: z.string().optional().describe('Defaults to from_locale.'),
        table: z.string().optional(),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_copy_text_key', logger }, async (args) => {
      const fromPath = await resolveTablePath(args.workspace_id, args.from_locale, args.table);
      const toPath = await resolveTablePath(args.workspace_id, args.to_locale ?? args.from_locale, args.table);

      const fromTable = await workspaces.getTextTable(args.workspace_id, fromPath);
      const missing = args.copies.filter((copy) => !fromTable.byKey.has(copy.from_key));
      if (missing.length > 0) {
        throw new SC2Error('SC2_NOT_FOUND', `${fromPath} has no key(s): ${missing.map((copy) => copy.from_key).join(', ')}`, {
          workspaceId: args.workspace_id,
          path: fromPath,
          recoverable: true,
        });
      }

      const toTable = fromPath === toPath ? fromTable : await workspaces.getTextTable(args.workspace_id, toPath);
      const outcome = applyTextEdits(
        toTable,
        args.copies.map((copy) => ({
          op: 'set' as const,
          key: copy.to_key,
          value: fromTable.byKey.get(copy.from_key)?.value ?? '',
        })),
      );

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_copy_text_key',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: [...outcome.summary, ...outcome.noOps.map((line) => `no-op: ${line}`)],
        files: [{ kind: 'write', path: toPath, content: outcome.content }],
      });

      return ok(describeChange(result), toStructured(result));
    }),
  );

  server.registerTool(
    'sc2_find_missing_localization',
    {
      title: 'Find catalog objects with no display name',
      description:
        'Cross-references the catalog against a text table and reports objects with no <Domain>/Name/<Id> entry. A newly cloned or created object almost always lands here, and an object with no name shows its raw key in game. Objects legitimately have no name (effects, validators), so filter by domain when that matters.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        domains: z.array(z.string()).optional().describe('Restrict to these domains, e.g. ["Unit", "Abil", "Button"].'),
        locale: z.string().optional(),
        table: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
      }),
      outputSchema: z.object({
        path: z.string(),
        missing: z.array(z.object({ domain: z.string(), id: z.string(), expectedKey: z.string() })),
        total: z.number().int(),
        truncated: z.boolean(),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_find_missing_localization', logger }, async (args) => {
      const tablePath = await resolveTablePath(args.workspace_id, args.locale, args.table);
      const table = await workspaces.getTextTable(args.workspace_id, tablePath);
      const index = await workspaces.getCatalogIndex(args.workspace_id);

      const domains = args.domains ?? index.domains().map((entry) => entry.domain);
      const missing: { domain: string; id: string; expectedKey: string }[] = [];

      for (const domain of domains) {
        for (const summary of index.search({ domains: [domain], limit: 100_000 }).results) {
          const expectedKey = `${domain}/Name/${summary.id}`;
          if (!table.byKey.has(expectedKey)) missing.push({ domain, id: summary.id, expectedKey });
        }
      }

      const limit = args.limit ?? 100;
      const page = missing.slice(0, limit);
      const note =
        'Many object kinds have no display name by design (effects, validators, requirements). Treat this as a checklist, not a defect list.';

      return ok(
        [
          `${missing.length} catalog object(s) have no name in ${tablePath}; showing ${page.length}.`,
          ...page.map((entry) => `  ${entry.domain}/${entry.id} -> ${entry.expectedKey}`),
          note,
        ].join('\n'),
        { path: tablePath, missing: page, total: missing.length, truncated: missing.length > page.length, note },
      );
    }),
  );
}
