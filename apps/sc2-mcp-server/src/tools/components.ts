/**
 * Component inventory and document metadata (PLAN.md §11, §24, §25, §42 Phase 4).
 *
 * These answer the question a model should ask before touching anything: *what is
 * actually in this document, and which parts can this server work with?*
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { KNOWN_COMPONENT_TYPES, SC2Error } from '@sc2mcp/core';
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

const DependencySchema = z.object({
  raw: z.string(),
  bnet: z.string().nullable(),
  file: z.string().nullable(),
  name: z.string().nullable(),
});

export function registerComponentTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger } = context;

  server.registerTool(
    'sc2_list_components',
    {
      title: 'List document components',
      description:
        'Parses ComponentList.SC2Components and reports every declared component: its four-character type code, the logical path it names, the files it resolves to in the staged document, and whether this server can read or write it. "writable: false" on everything is accurate — no component can be written yet. A component with "exists: false" is declared but has no matching files.',
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
          return `- ${component.typeCode}${locale} ${component.path} — ${label} — ${status} — ${support}, not writable`;
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
