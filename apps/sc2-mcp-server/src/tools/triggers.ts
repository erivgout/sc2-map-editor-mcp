/**
 * Trigger tools (PLAN.md §21, §42 Phase 11).
 *
 * **Read-only, plus renaming.** PLAN.md §21 stages trigger mutation deliberately and says
 * not to generate trigger XML by guessing undocumented ids. This build does neither: it
 * reads the structure, and the one thing it writes is a display name — which lives in
 * `TriggerStrings.txt`, not in the trigger data at all, so renaming cannot corrupt the
 * trigger graph.
 */

import { readFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/server';
import {
  SC2Error,
  TRIGGERS_FILENAME,
  applyTextEdits,
  buildTriggerTree,
  parseTriggerData,
  triggerNameKey,
  type ChangeResult,
  type TriggerTreeNode,
} from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');

const READ_ONLY_NOTE =
  'Trigger structure is read-only in this build. Renaming works because names live in TriggerStrings.txt rather than in the trigger data.';

const TreeNodeSchema: z.ZodType = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.string(),
    name: z.string().nullable(),
    line: z.number().int(),
    repeated: z.boolean(),
    children: z.array(TreeNodeSchema),
  }),
);

function renderTree(nodes: readonly TriggerTreeNode[], indent = ''): string[] {
  return nodes.flatMap((node) => [
    `${indent}${node.type} ${node.name ?? '(unnamed)'} [${node.id}]${node.repeated ? ' — already shown above' : ''}`,
    ...renderTree(node.children, `${indent}  `),
  ]);
}

export function registerTriggerTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger, config } = context;

  /** Reads and parses the trigger component, with the name table joined in. */
  async function loadTriggers(workspaceId: string): Promise<{
    data: ReturnType<typeof parseTriggerData>;
    names: Map<string, string>;
    tablePath: string | null;
  }> {
    let source: string;
    try {
      source = await readFile(await workspaces.resolveWorkingPath(workspaceId, TRIGGERS_FILENAME), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SC2Error('SC2_NOT_FOUND', 'This document has no Triggers component.', {
          workspaceId,
          recoverable: false,
          suggestedAction: 'Use sc2_list_components to see what it does contain.',
        });
      }
      throw error;
    }

    const data = parseTriggerData(source);

    // Names come from TriggerStrings; without them every element is just a hex id.
    const tables = await workspaces.listTextTables(workspaceId);
    const table = tables.find(
      (candidate) =>
        candidate.locale.toLowerCase() === config.defaultLocale.toLowerCase() && candidate.table === 'TriggerStrings',
    );

    const names = new Map<string, string>();
    if (table !== undefined) {
      const parsed = await workspaces.getTextTable(workspaceId, table.path);
      for (const [key, entry] of parsed.byKey) names.set(key, entry.value);
    }

    return { data, names, tablePath: table?.path ?? null };
  }

  server.registerTool(
    'sc2_list_triggers',
    {
      title: 'List the trigger hierarchy',
      description:
        'Reads the Triggers component and returns its tree — categories, triggers, variables, function definitions — with names resolved from TriggerStrings. Trigger elements are referenced by id rather than nested, so an element can appear in more than one place; repeats are marked rather than expanded twice. Depth is bounded because real trigger trees are large.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        max_depth: z.number().int().min(1).max(12).optional().describe('Defaults to 3.'),
      }),
      outputSchema: z.object({
        tree: z.array(TreeNodeSchema),
        countsByType: z.record(z.string(), z.number().int()),
        elementCount: z.number().int(),
        danglingIds: z.array(z.string()),
        namesResolved: z.boolean(),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_list_triggers', logger }, async (args) => {
      const { data, names, tablePath } = await loadTriggers(args.workspace_id);
      const tree = buildTriggerTree(data, { names, maxDepth: args.max_depth ?? 3 });

      const lines = [
        `${data.elements.size} trigger element(s): ${[...data.countsByType].map(([type, count]) => `${type} ${count}`).join(', ')}`,
        ...renderTree(tree),
        data.danglingIds.length === 0
          ? ''
          : `${data.danglingIds.length} referenced id(s) have no element: ${data.danglingIds.slice(0, 10).join(', ')}`,
        tablePath === null ? `No TriggerStrings table for ${config.defaultLocale}, so elements show ids only.` : '',
        READ_ONLY_NOTE,
      ].filter((line) => line !== '');

      return ok(lines.join('\n'), {
        tree,
        countsByType: Object.fromEntries(data.countsByType),
        elementCount: data.elements.size,
        danglingIds: [...data.danglingIds],
        namesResolved: tablePath !== null,
        note: READ_ONLY_NOTE,
      });
    }),
  );

  server.registerTool(
    'sc2_get_trigger',
    {
      title: 'Inspect one trigger element',
      description:
        'Returns one trigger element by id: its type, resolved name, the ids it contains, and which other elements reference it. Also returns its raw XML, which is the only way to see the parts of the trigger format this build does not model.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        id: z.string().min(1).describe('Element id, e.g. "717EE832".'),
        include_raw_xml: z.boolean().optional().describe('Defaults to true.'),
      }),
      outputSchema: z.object({
        id: z.string(),
        type: z.string(),
        name: z.string().nullable(),
        line: z.number().int(),
        childIds: z.array(z.string()),
        detailFields: z.array(z.string()),
        referencedBy: z.array(z.string()),
        rawXml: z.string().nullable(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_trigger', logger }, async (args) => {
      const { data, names } = await loadTriggers(args.workspace_id);
      const element = data.elements.get(args.id);

      if (element === undefined) {
        throw new SC2Error('SC2_NOT_FOUND', `No trigger element with id "${args.id}".`, {
          workspaceId: args.workspace_id,
          recoverable: true,
          suggestedAction: 'Use sc2_list_triggers or sc2_search_triggers to find the right id.',
        });
      }

      const referencedBy = [...data.elements.values()]
        .filter((candidate) => candidate.childIds.includes(args.id))
        .map((candidate) => `${candidate.type}/${candidate.id}`);

      let rawXml: string | null = null;
      if (args.include_raw_xml !== false) {
        const source = await readFile(await workspaces.resolveWorkingPath(args.workspace_id, TRIGGERS_FILENAME), 'utf8');
        rawXml = source.slice(element.span.start, element.span.end);
      }

      const name = names.get(triggerNameKey(element.type, element.id)) ?? null;

      return ok(
        [
          `${element.type} ${name ?? '(unnamed)'} [${element.id}] at ${TRIGGERS_FILENAME}:${element.line}`,
          `contains ${element.childIds.length} element(s)`,
          element.detailFields.length === 0 ? '' : `detail fields: ${element.detailFields.join(', ')}`,
          referencedBy.length === 0 ? 'not referenced by any other element' : `referenced by: ${referencedBy.join(', ')}`,
        ]
          .filter((line) => line !== '')
          .join('\n'),
        {
          id: element.id,
          type: element.type,
          name,
          line: element.line,
          childIds: [...element.childIds],
          detailFields: [...element.detailFields],
          referencedBy,
          rawXml,
        },
      );
    }),
  );

  server.registerTool(
    'sc2_search_triggers',
    {
      title: 'Search triggers by name',
      description:
        'Finds trigger elements whose resolved name matches a substring, optionally filtered by type (Trigger, Category, Variable, FunctionDef, …). Elements with no name entry cannot be matched by name and are reported separately.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        query: z.string().min(1),
        types: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      outputSchema: z.object({
        matches: z.array(z.object({ id: z.string(), type: z.string(), name: z.string(), line: z.number().int() })),
        total: z.number().int(),
        unnamedCount: z.number().int(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_search_triggers', logger }, async (args) => {
      const { data, names } = await loadTriggers(args.workspace_id);
      const needle = args.query.toLowerCase();
      const typeFilter = args.types === undefined ? null : new Set(args.types);

      const matches: { id: string; type: string; name: string; line: number }[] = [];
      let unnamedCount = 0;

      for (const element of data.elements.values()) {
        if (typeFilter !== null && !typeFilter.has(element.type)) continue;
        const name = names.get(triggerNameKey(element.type, element.id));
        if (name === undefined) {
          unnamedCount += 1;
          continue;
        }
        if (!name.toLowerCase().includes(needle)) continue;
        matches.push({ id: element.id, type: element.type, name, line: element.line });
      }

      matches.sort((left, right) => left.name.localeCompare(right.name));
      const limited = matches.slice(0, args.limit ?? 50);

      return ok(
        [
          `${matches.length} match(es); ${unnamedCount} element(s) have no name and could not be matched.`,
          ...limited.map((match) => `  ${match.type} "${match.name}" [${match.id}]`),
        ].join('\n'),
        { matches: limited, total: matches.length, unnamedCount },
      );
    }),
  );

  server.registerTool(
    'sc2_rename_trigger',
    {
      title: 'Rename a trigger element',
      description:
        'Changes an element\'s display name. This edits TriggerStrings.txt only — the trigger data itself is untouched, which is why it is safe while structural trigger editing is not implemented. Defaults to a dry run.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        expected_revision: z.number().int().nonnegative().optional(),
        dry_run: z.boolean().optional().describe('Defaults to TRUE.'),
        id: z.string().min(1),
        new_name: z.string().min(1),
      }),
      outputSchema: z.object({
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
        key: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_rename_trigger', logger }, async (args) => {
      const { data, tablePath } = await loadTriggers(args.workspace_id);
      const element = data.elements.get(args.id);

      if (element === undefined) {
        throw new SC2Error('SC2_NOT_FOUND', `No trigger element with id "${args.id}".`, {
          workspaceId: args.workspace_id,
          recoverable: true,
        });
      }
      if (tablePath === null) {
        throw new SC2Error('SC2_NOT_FOUND', `This document has no TriggerStrings table for ${config.defaultLocale}.`, {
          workspaceId: args.workspace_id,
          recoverable: false,
          suggestedAction: 'Trigger names are stored there; without it there is nothing to rename.',
        });
      }

      const key = triggerNameKey(element.type, element.id);
      const table = await workspaces.getTextTable(args.workspace_id, tablePath);
      const outcome = applyTextEdits(table, [{ op: 'set', key, value: args.new_name }]);

      const result: ChangeResult = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_rename_trigger',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: [...outcome.summary, ...outcome.noOps.map((line) => `no-op: ${line}`)],
        files: [{ kind: 'write', path: tablePath, content: outcome.content }],
      });

      return ok(
        [
          result.dryRun ? 'DRY RUN — nothing was written.' : `Applied as ${result.changeId}.`,
          `${element.type} [${element.id}] -> "${args.new_name}" via ${key}`,
          ...result.filesChanged.map((file) => file.diff ?? file.path),
        ].join('\n'),
        {
          changeId: result.changeId,
          revisionBefore: result.revisionBefore,
          revisionAfter: result.revisionAfter,
          dryRun: result.dryRun,
          filesChanged: [...result.filesChanged],
          summary: [...result.summary],
          diagnostics: [...result.diagnostics],
          requiresRepack: result.requiresRepack,
          snapshotId: result.snapshotId,
          key,
        },
      );
    }),
  );
}
