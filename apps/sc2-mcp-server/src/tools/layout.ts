import { readFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/server';
import {
  SC2Error,
  applyLayoutPatch,
  createLayout,
  isLayoutPath,
  parseLayout,
  searchLayout,
  type ChangeResult,
} from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');
const LayoutPathSchema = z.string().min(1).refine(isLayoutPath, 'Path must end in .SC2Layout.');
const MutationArgsShape = {
  workspace_id: WorkspaceIdSchema,
  expected_revision: z.number().int().nonnegative().optional(),
  dry_run: z.boolean().optional().describe('Defaults to TRUE. Pass false to actually write.'),
};

const DiagnosticSchema = z.object({
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  path: z.string(),
  line: z.number().int(),
  column: z.number().int(),
});

const ElementSchema = z.object({
  element: z.string(),
  name: z.string().nullable(),
  type: z.string().nullable(),
  file: z.string().nullable(),
  template: z.string().nullable(),
  line: z.number().int(),
  column: z.number().int(),
});

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

const SelectorSchema = z.object({
  element: z.string().min(1).describe('Element name, for example Frame, Text, Anchor, or Include.'),
  attributes: z.record(z.string(), z.string()).optional().describe('Exact attribute matches used to identify the element.'),
  occurrence: z.number().int().nonnegative().optional().describe('Zero-based match number. Defaults to 0.'),
});

const PatchSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_attribute'), name: z.string().min(1), value: z.string() }),
  z.object({ op: z.literal('remove_attribute'), name: z.string().min(1) }),
  z.object({ op: z.literal('replace_content'), xml: z.string() }),
  z.object({ op: z.literal('replace_element'), xml: z.string().min(1) }),
  z.object({ op: z.literal('append_child'), xml: z.string().min(1) }),
  z.object({ op: z.literal('delete_element') }),
]);

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
      ? 'DRY RUN. Nothing was written. Pass dry_run=false to apply.'
      : `Applied as ${result.changeId}; workspace is now at revision ${result.revisionAfter}.`,
    ...result.summary.map((line) => `- ${line}`),
    ...result.filesChanged.map((file) => file.diff ?? `${file.path} changed`),
  ].join('\n');
}

export function registerLayoutTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger } = context;

  async function layoutPaths(workspaceId: string): Promise<string[]> {
    const files = await workspaces.listFiles(workspaceId);
    return files.filter((file) => isLayoutPath(file.relativePath)).map((file) => file.relativePath).sort();
  }

  async function resolveLayoutPath(workspaceId: string, requested: string): Promise<string> {
    const paths = await layoutPaths(workspaceId);
    const match = paths.find((candidate) => candidate.toLowerCase() === requested.toLowerCase());
    if (match !== undefined) return match;
    throw new SC2Error('SC2_NOT_FOUND', `This document has no layout at ${requested}.`, {
      workspaceId,
      path: requested,
      recoverable: true,
      suggestedAction: paths.length === 0 ? 'Create one with sc2_create_layout.' : `Available layouts: ${paths.join(', ')}`,
    });
  }

  async function readLayout(workspaceId: string, requested: string): Promise<{ path: string; source: string }> {
    const path = await resolveLayoutPath(workspaceId, requested);
    return { path, source: await readFile(await workspaces.resolveWorkingPath(workspaceId, path), 'utf8') };
  }

  server.registerTool(
    'sc2_list_layouts',
    {
      title: 'List SC2Layout files',
      description: 'Lists every .SC2Layout file in the staged document and reports its frame count and diagnostics.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        layouts: z.array(
          z.object({ path: z.string(), sizeBytes: z.number().int(), frameCount: z.number().int(), errorCount: z.number().int(), warningCount: z.number().int() }),
        ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_list_layouts', logger }, async (args) => {
      const files = await workspaces.listFiles(args.workspace_id);
      const layouts = [];
      for (const file of files.filter((candidate) => isLayoutPath(candidate.relativePath))) {
        const source = await readFile(file.absolutePath, 'utf8');
        const parsed = parseLayout(source, file.relativePath);
        layouts.push({
          path: file.relativePath,
          sizeBytes: file.size,
          frameCount: parsed.elements.filter((element) => element.element === 'Frame').length,
          errorCount: parsed.diagnostics.filter((entry) => entry.severity === 'error').length,
          warningCount: parsed.diagnostics.filter((entry) => entry.severity === 'warning').length,
        });
      }
      layouts.sort((left, right) => left.path.localeCompare(right.path));
      return ok(
        layouts.length === 0
          ? 'This document has no SC2Layout files.'
          : layouts.map((layout) => `${layout.path}: ${layout.frameCount} frame(s), ${layout.errorCount} error(s), ${layout.warningCount} warning(s)`).join('\n'),
        { layouts },
      );
    }),
  );

  server.registerTool(
    'sc2_get_layout',
    {
      title: 'Read an SC2Layout file',
      description: 'Returns the exact layout source plus an index of its frame, template, and include elements.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema, path: LayoutPathSchema }),
      outputSchema: z.object({ path: z.string(), content: z.string(), elements: z.array(ElementSchema), diagnostics: z.array(DiagnosticSchema) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_layout', logger }, async (args) => {
      const layout = await readLayout(args.workspace_id, args.path);
      const parsed = parseLayout(layout.source, layout.path);
      return ok(layout.source, { path: layout.path, content: layout.source, elements: [...parsed.elements], diagnostics: [...parsed.diagnostics] });
    }),
  );

  server.registerTool(
    'sc2_get_layout_diagnostics',
    {
      title: 'Check an SC2Layout file',
      description: 'Parses one SC2Layout file and reports malformed XML, invalid roots, and incomplete Frame declarations.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema, path: LayoutPathSchema }),
      outputSchema: z.object({ path: z.string(), diagnostics: z.array(DiagnosticSchema), valid: z.boolean() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_layout_diagnostics', logger }, async (args) => {
      const layout = await readLayout(args.workspace_id, args.path);
      const diagnostics = [...parseLayout(layout.source, layout.path).diagnostics];
      const valid = diagnostics.every((entry) => entry.severity !== 'error');
      return ok(valid ? `${layout.path}: no structural errors.` : `${layout.path}: structural errors found.`, {
        path: layout.path,
        diagnostics,
        valid,
      });
    }),
  );

  server.registerTool(
    'sc2_search_layouts',
    {
      title: 'Search SC2Layout declarations',
      description: 'Searches element names and the name, type, file, and template attributes across every SC2Layout file.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema, query: z.string().min(1), limit: z.number().int().min(1).max(1000).optional() }),
      outputSchema: z.object({ matches: z.array(ElementSchema.extend({ path: z.string() })), total: z.number().int(), truncated: z.boolean() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_search_layouts', logger }, async (args) => {
      const matches = [];
      for (const layoutPath of await layoutPaths(args.workspace_id)) {
        const source = await readFile(await workspaces.resolveWorkingPath(args.workspace_id, layoutPath), 'utf8');
        matches.push(...searchLayout(source, layoutPath, args.query).map((entry) => ({ path: layoutPath, ...entry })));
      }
      const limit = args.limit ?? 100;
      const page = matches.slice(0, limit);
      return ok(`${matches.length} layout declaration(s) matched; showing ${page.length}.`, {
        matches: page,
        total: matches.length,
        truncated: matches.length > page.length,
      });
    }),
  );

  server.registerTool(
    'sc2_create_layout',
    {
      title: 'Create an SC2Layout file',
      description: 'Creates a new valid SC2Layout file. Defaults to an empty <Desc> document. Existing files are refused.',
      inputSchema: z.object({ ...MutationArgsShape, path: LayoutPathSchema, content: z.string().optional() }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_create_layout', logger }, async (args) => {
      const existing = await layoutPaths(args.workspace_id);
      if (existing.some((candidate) => candidate.toLowerCase() === args.path.toLowerCase())) {
        throw new SC2Error('SC2_CONFLICT', `${args.path} already exists.`, { path: args.path, workspaceId: args.workspace_id, recoverable: true });
      }
      const outcome = createLayout(args.content, args.path);
      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_create_layout',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: [...outcome.summary],
        files: [{ kind: 'write', path: args.path, content: outcome.content }],
      });
      return ok(describeChange(result), toStructured(result));
    }),
  );

  server.registerTool(
    'sc2_apply_layout_patch',
    {
      title: 'Patch an SC2Layout element',
      description: 'Applies one targeted XML edit without reserializing the file. The edited layout is parsed again before the transaction can write it.',
      inputSchema: z.object({ ...MutationArgsShape, path: LayoutPathSchema, selector: SelectorSchema, patch: PatchSchema }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_apply_layout_patch', logger }, async (args) => {
      const layout = await readLayout(args.workspace_id, args.path);
      const outcome = applyLayoutPatch(layout.source, layout.path, args.selector, args.patch);
      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_apply_layout_patch',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: [...outcome.summary],
        files: [{ kind: 'write', path: layout.path, content: outcome.content }],
      });
      return ok(describeChange(result), toStructured(result));
    }),
  );
}
