/**
 * Component inventory and document metadata (PLAN.md §11, §24, §25, §42 Phase 4).
 *
 * These answer the question a model should ask before touching anything: *what is
 * actually in this document, and which parts can this server work with?*
 */

import { readFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/server';
import {
  COMPONENT_LIST_FILENAME,
  KNOWN_COMPONENT_TYPES,
  SC2Error,
  addComponent,
  parseComponentList,
  removeComponent,
  updateComponent,
  type ChangeDiagnostic,
  type ChangeResult,
  type ComponentDescriptor,
  type ComponentListEntry,
} from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');

const ComponentSchema = z.object({
  typeCode: z.string(),
  description: z.string().nullable(),
  path: z.string(),
  locale: z.string().nullable(),
  exists: z.boolean(),
  resolvedPaths: z.array(z.string()),
  writable: z.boolean(),
  parser: z.string().nullable(),
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
    z.object({
      severity: z.enum(['error', 'warning', 'info']),
      code: z.string(),
      message: z.string(),
      path: z.string().optional(),
    }),
  ),
  requiresRepack: z.boolean(),
  snapshotId: z.string().nullable(),
});

const ComponentChangeSchema = ChangeResultSchema.extend({ component: ComponentSchema });

const DependencySchema = z.object({
  raw: z.string(),
  bnet: z.string().nullable(),
  file: z.string().nullable(),
  name: z.string().nullable(),
});

export function registerComponentTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger } = context;

  async function loadComponentList(workspaceId: string): Promise<{ source: string; stagedPaths: string[] }> {
    try {
      const [source, files] = await Promise.all([
        readFile(await workspaces.resolveWorkingPath(workspaceId, COMPONENT_LIST_FILENAME), 'utf8'),
        workspaces.listFiles(workspaceId),
      ]);
      return { source, stagedPaths: files.map((file) => file.relativePath) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SC2Error('SC2_NOT_FOUND', `This document has no ${COMPONENT_LIST_FILENAME}.`, {
          workspaceId,
          path: COMPONENT_LIST_FILENAME,
          recoverable: false,
        });
      }
      throw error;
    }
  }

  function findComponent(
    content: string,
    stagedPaths: readonly string[],
    entry: ComponentListEntry,
  ): ComponentDescriptor {
    const component = parseComponentList(content, stagedPaths).components.find(
      (candidate) =>
        candidate.typeCode.toLowerCase() === entry.typeCode.toLowerCase() &&
        (candidate.locale ?? '').toLowerCase() === (entry.locale ?? '').toLowerCase(),
    );
    if (component === undefined) {
      throw new SC2Error('SC2_INTERNAL_ERROR', 'The mutated component entry could not be reparsed.', {
        path: COMPONENT_LIST_FILENAME,
        recoverable: false,
      });
    }
    return component;
  }

  function missingDiagnostics(component: ComponentDescriptor, allowMissing: boolean): ChangeDiagnostic[] {
    if (component.exists) return [];
    if (!allowMissing) {
      throw new SC2Error(
        'SC2_INVALID_ARGUMENT',
        `Component ${component.typeCode} points to ${component.path}, but that logical path resolves to no staged files.`,
        {
          path: component.path,
          recoverable: true,
          suggestedAction: 'Create the component files first, or pass allow_missing=true for an intentional forward declaration.',
        },
      );
    }
    return [
      {
        severity: 'warning',
        code: 'SC2_COMPONENT_MISSING',
        message: `Component ${component.typeCode} was declared, but ${component.path} resolves to no staged files.`,
        path: component.path,
      },
    ];
  }

  function changePayload(result: ChangeResult, component: ComponentDescriptor): Record<string, unknown> {
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
      component,
    };
  }

  server.registerTool(
    'sc2_list_components',
    {
      title: 'List document components',
      description:
        'Parses ComponentList.SC2Components and reports every declared component: its four-character type code, the logical path it names, the files it resolves to in the staged document, and whether this server has a content writer for it. The component inventory itself can be changed with sc2_add_component, sc2_update_component, and sc2_remove_component.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        components: z.array(ComponentSchema),
        locales: z.array(z.string()),
        missingCount: z.number().int(),
        /** Null when the document has no component list at all. */
        hasComponentList: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_list_components', logger }, async (args) => {
      const summary = await workspaces.getSummary(args.workspace_id);
      const components = summary.components;

      if (components === null) {
        return ok(
          `This document has no ComponentList.SC2Components, so its components cannot be enumerated. Use sc2_list_files to inspect it directly.`,
          { components: [], locales: [], missingCount: 0, hasComponentList: false },
        );
      }

      const lines = [
        `${components.components.length} component(s) declared${components.locales.length > 0 ? `, locales: ${components.locales.join(', ')}` : ''}:`,
        ...components.components.map((component) => {
          const label = component.description ?? `unrecognised type "${component.typeCode}"`;
          const locale = component.locale === null ? '' : ` [${component.locale}]`;
          const status = component.exists ? `${component.resolvedPaths.length} file(s)` : 'MISSING';
          const support = component.parser === null ? 'no reader' : `reader: ${component.parser}`;
          return `- ${component.typeCode}${locale} ${component.path} | ${label} | ${status} | ${support}, ${component.writable ? 'content writer available' : 'content read-only'}`;
        }),
      ];

      return ok(lines.join('\n'), {
        components: components.components,
        locales: [...components.locales],
        missingCount: components.missing.length,
        hasComponentList: true,
      });
    }),
  );

  server.registerTool(
    'sc2_add_component',
    {
      title: 'Add a component declaration',
      description:
        'Appends one lossless DataComponent entry to ComponentList.SC2Components. The type and locale identity must be unique. By default the logical path must already resolve to staged files. Defaults to a dry run.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        expected_revision: z.number().int().nonnegative().optional(),
        dry_run: z.boolean().optional().describe('Defaults to TRUE.'),
        type_code: z.string().min(1),
        path: z.string().min(1),
        locale: z.string().optional(),
        allow_missing: z.boolean().optional().describe('Defaults to false.'),
      }),
      outputSchema: ComponentChangeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_add_component', logger }, async (args) => {
      const { source, stagedPaths } = await loadComponentList(args.workspace_id);
      const outcome = addComponent(source, { typeCode: args.type_code, path: args.path, locale: args.locale });
      const component = findComponent(outcome.content, stagedPaths, outcome.component);
      const diagnostics = missingDiagnostics(component, args.allow_missing ?? false);
      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_add_component',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: outcome.summary,
        diagnostics,
        files: [{ kind: 'write', path: COMPONENT_LIST_FILENAME, content: outcome.content }],
      });
      return ok(
        [
          result.dryRun ? 'DRY RUN, nothing was written.' : `Applied as ${result.changeId}.`,
          ...result.summary,
          ...result.filesChanged.map((file) => file.diff ?? file.path),
        ].join('\n'),
        changePayload(result, component),
      );
    }),
  );

  server.registerTool(
    'sc2_update_component',
    {
      title: 'Update a component declaration',
      description:
        'Changes the type code, logical path, or locale of one DataComponent entry without reserializing the rest of ComponentList.SC2Components. Select by type and, when needed, locale. Defaults to a dry run.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        expected_revision: z.number().int().nonnegative().optional(),
        dry_run: z.boolean().optional().describe('Defaults to TRUE.'),
        type_code: z.string().min(1),
        locale: z.string().nullable().optional(),
        new_type_code: z.string().min(1).optional(),
        new_path: z.string().min(1).optional(),
        new_locale: z.string().nullable().optional(),
        allow_missing: z.boolean().optional().describe('Defaults to false.'),
      }),
      outputSchema: ComponentChangeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_update_component', logger }, async (args) => {
      if (args.new_type_code === undefined && args.new_path === undefined && args.new_locale === undefined) {
        throw new SC2Error('SC2_INVALID_ARGUMENT', 'Pass at least one of new_type_code, new_path, or new_locale.', {
          workspaceId: args.workspace_id,
          recoverable: true,
        });
      }
      const { source, stagedPaths } = await loadComponentList(args.workspace_id);
      const outcome = updateComponent(
        source,
        { typeCode: args.type_code, locale: args.locale },
        { newTypeCode: args.new_type_code, newPath: args.new_path, newLocale: args.new_locale },
      );
      const component = findComponent(outcome.content, stagedPaths, outcome.component);
      const diagnostics = missingDiagnostics(component, args.allow_missing ?? false);
      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_update_component',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: outcome.summary,
        diagnostics,
        files: [{ kind: 'write', path: COMPONENT_LIST_FILENAME, content: outcome.content }],
      });
      return ok(
        [
          result.dryRun ? 'DRY RUN, nothing was written.' : `Applied as ${result.changeId}.`,
          ...result.summary,
          ...result.filesChanged.map((file) => file.diff ?? file.path),
        ].join('\n'),
        changePayload(result, component),
      );
    }),
  );

  server.registerTool(
    'sc2_remove_component',
    {
      title: 'Remove a component declaration',
      description:
        'Removes one DataComponent entry from ComponentList.SC2Components. The component files remain staged and can be restored by adding the declaration again. Defaults to a dry run.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        expected_revision: z.number().int().nonnegative().optional(),
        dry_run: z.boolean().optional().describe('Defaults to TRUE.'),
        type_code: z.string().min(1),
        locale: z.string().nullable().optional(),
      }),
      outputSchema: ComponentChangeSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_remove_component', logger }, async (args) => {
      const { source, stagedPaths } = await loadComponentList(args.workspace_id);
      const outcome = removeComponent(source, { typeCode: args.type_code, locale: args.locale });
      const component = findComponent(source, stagedPaths, outcome.component);
      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_remove_component',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: outcome.summary,
        files: [{ kind: 'write', path: COMPONENT_LIST_FILENAME, content: outcome.content }],
      });
      return ok(
        [
          result.dryRun ? 'DRY RUN, nothing was written.' : `Applied as ${result.changeId}.`,
          ...result.summary,
          ...result.filesChanged.map((file) => file.diff ?? file.path),
        ].join('\n'),
        changePayload(result, component),
      );
    }),
  );

  server.registerTool(
    'sc2_get_document_info',
    {
      title: 'Read DocumentInfo',
      description:
        'Parses the DocumentInfo component: name, author, mod type, icon, description, dependencies, and screenshots. Fields absent from the file are returned as null, which is different from an empty string. "unrecognizedFields" lists top-level elements this parser does not model, so you can see there is more in the file than is reported here.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        name: z.string().nullable(),
        author: z.string().nullable(),
        modType: z.string().nullable(),
        icon: z.string().nullable(),
        description: z.string().nullable(),
        dependencies: z.array(DependencySchema),
        screenshot: z
          .object({ file: z.string().nullable(), captionId: z.string().nullable(), flags: z.string().nullable() })
          .nullable(),
        screenshotHowToPlay: z
          .object({ file: z.string().nullable(), captionId: z.string().nullable(), flags: z.string().nullable() })
          .nullable(),
        unrecognizedFields: z.record(z.string(), z.string()),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_document_info', logger }, async (args) => {
      const info = await workspaces.getDocumentInfo(args.workspace_id);
      if (info === null) {
        throw new SC2Error('SC2_NOT_FOUND', 'This document has no DocumentInfo component.', {
          workspaceId: args.workspace_id,
          recoverable: false,
          suggestedAction: 'Use sc2_list_components to see what the document does contain.',
        });
      }

      const lines = [
        `Name: ${info.name ?? '(not set)'}`,
        `Author: ${info.author ?? '(not set)'}`,
        `Mod type: ${info.modType ?? '(not set)'}`,
        `Dependencies (${info.dependencies.length}, in resolution order):`,
        ...info.dependencies.map((dependency, index) => `  ${index + 1}. ${dependency.name ?? dependency.raw}`),
      ];
      const unrecognized = Object.keys(info.unrecognizedFields);
      if (unrecognized.length > 0) lines.push(`Fields not modelled by this parser: ${unrecognized.join(', ')}`);

      return ok(lines.join('\n'), { ...info });
    }),
  );

  server.registerTool(
    'sc2_get_dependencies',
    {
      title: 'List document dependencies',
      description:
        'Returns the document\'s dependency chain in declaration order, which is also the order SC2 resolves them in: later entries override earlier ones. Each entry has a Battle.net identity and a local file path. This server never modifies installed Blizzard dependency archives — only the open document.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        dependencies: z.array(
          DependencySchema.extend({
            resolution: z.enum(['resolved', 'in-casc', 'not-found']),
            path: z.string().nullable(),
            isDirectory: z.boolean(),
            loaded: z.boolean(),
            reason: z.string().nullable(),
          }),
        ),
        loadedCount: z.number().int(),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_dependencies', logger }, async (args) => {
      const resolvedDependencies = await workspaces.resolveDependencies(args.workspace_id);

      const dependencies = resolvedDependencies.map((entry) => ({
        ...entry.declaration,
        resolution: entry.resolution,
        path: entry.path,
        isDirectory: entry.isDirectory,
        // Only unpacked directories are actually indexed; a packed .SC2Mod needs the MPQ
        // helper, which this build does not have.
        loaded: entry.resolution === 'resolved' && entry.isDirectory,
        reason: entry.reason,
      }));

      const loadedCount = dependencies.filter((entry) => entry.loaded).length;
      const note =
        dependencies.length > 0 && loadedCount === dependencies.length
          ? 'Every dependency was loaded, so catalog results include their objects.'
          : 'Objects from dependencies that were not loaded are invisible to the catalog tools. There, "not found" means "not in what was loaded" rather than "does not exist".';

      const lines =
        dependencies.length === 0
          ? ['This document declares no dependencies.']
          : [
              `${dependencies.length} dependency/dependencies, in resolution order (later entries win); ${loadedCount} loaded:`,
              ...dependencies.map(
                (dependency, index) =>
                  `  ${index + 1}. ${dependency.name ?? '(unnamed)'} — ${dependency.resolution.toUpperCase()}${dependency.path === null ? '' : ` — ${dependency.path}`}${dependency.reason === null ? '' : `\n       ${dependency.reason}`}`,
              ),
              '',
              note,
            ];

      return ok(lines.join('\n'), { dependencies, loadedCount, note });
    }),
  );

  server.registerTool(
    'sc2_list_component_types',
    {
      title: 'List known component type codes',
      description:
        'Reference table mapping the four-character component type codes used in ComponentList.SC2Components to what they mean. Not exhaustive: documents may declare codes not listed here, and those are reported as-is rather than dropped.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        types: z.array(z.object({ code: z.string(), description: z.string() })),
        exhaustive: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_list_component_types', logger }, () => {
      const types = Object.entries(KNOWN_COMPONENT_TYPES).map(([code, description]) => ({ code, description }));
      return ok(
        types.map((entry) => `${entry.code} — ${entry.description}`).join('\n'),
        { types, exhaustive: false },
      );
    }),
  );
}
