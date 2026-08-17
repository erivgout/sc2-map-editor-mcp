/**
 * Placed objects, regions, and terrain tools (PLAN.md §27, §28, §42 Phases 15–16).
 *
 * All read-only. PLAN.md is explicit that writes here wait on codecs that have passed
 * editor round-trip tests, and none have been run. Parsing a file is not authoring one:
 * placing a unit involves id allocation, flags, and terrain-height interactions this code
 * does not model.
 */

import { readFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/server';
import {
  BINARY_TERRAIN_FILES,
  OBJECTS_FILENAME,
  REGIONS_FILENAME,
  SC2Error,
  TERRAIN_FILENAME,
  parsePlacedObjects,
  parseRegions,
  parseTerrainSummary,
  readBinaryHeader,
} from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');

const READ_ONLY_NOTE =
  'Read-only. Placing, moving, or deleting map objects is not implemented: that needs a codec proven by editor round-trip tests, and none has been run.';

export function registerMapDataTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger } = context;

  async function readComponent(workspaceId: string, fileName: string): Promise<string> {
    try {
      return await readFile(await workspaces.resolveWorkingPath(workspaceId, fileName), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SC2Error('SC2_NOT_FOUND', `This document has no ${fileName} component.`, {
          workspaceId,
          path: fileName,
          recoverable: false,
          suggestedAction: 'Use sc2_list_components to see what it does contain.',
        });
      }
      throw error;
    }
  }

  server.registerTool(
    'sc2_list_placed_objects',
    {
      title: 'List placed units, doodads, and points',
      description:
        'Reads the Objects component: every unit, doodad, and point placed on the map, with position, rotation, scale, and flags. Filter by kind (ObjectUnit, ObjectDoodad, ObjectPoint) or by type. Positions are returned exactly as written, because the file\'s precision is meaningful.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        kinds: z.array(z.string()).optional().describe('e.g. ["ObjectUnit"]. Omit for all.'),
        type: z.string().optional().describe('Only objects of this type, case-insensitive substring.'),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      outputSchema: z.object({
        version: z.string().nullable(),
        countsByKind: z.record(z.string(), z.number().int()),
        total: z.number().int(),
        objects: z.array(
          z.object({
            kind: z.string(),
            id: z.string().nullable(),
            type: z.string().nullable(),
            position: z.string().nullable(),
            rotation: z.string().nullable(),
            scale: z.string().nullable(),
            variation: z.string().nullable(),
            flags: z.record(z.string(), z.string()),
            otherAttributes: z.record(z.string(), z.string()),
          }),
        ),
        truncated: z.boolean(),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_list_placed_objects', logger }, async (args) => {
      const document = parsePlacedObjects(await readComponent(args.workspace_id, OBJECTS_FILENAME));

      const kindFilter = args.kinds === undefined ? null : new Set(args.kinds);
      const typeNeedle = args.type?.toLowerCase();

      const matched = document.objects.filter((object) => {
        if (kindFilter !== null && !kindFilter.has(object.kind)) return false;
        if (typeNeedle !== undefined && !(object.type ?? '').toLowerCase().includes(typeNeedle)) return false;
        return true;
      });

      const limit = args.limit ?? 100;
      const page = matched.slice(0, limit);

      return ok(
        [
          `PlacedObjects version ${document.version ?? 'unknown'}: ${[...document.countsByKind].map(([kind, count]) => `${kind} ${count}`).join(', ')}`,
          `${matched.length} matched; showing ${page.length}.`,
          ...page.map((object) => `  ${object.kind} ${object.type ?? '(untyped)'} [${object.id ?? '?'}] at ${object.position ?? '?'}`),
          READ_ONLY_NOTE,
        ].join('\n'),
        {
          version: document.version,
          countsByKind: Object.fromEntries(document.countsByKind),
          total: matched.length,
          objects: page,
          truncated: matched.length > page.length,
          note: READ_ONLY_NOTE,
        },
      );
    }),
  );

  server.registerTool(
    'sc2_list_regions',
    {
      title: 'List map regions',
      description:
        'Reads the Regions component: each region\'s id, name, and shape. Shape parameters are returned as written — circles have a center and radius, other shapes have their own fields, and any child element this parser does not model still appears.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        regions: z.array(
          z.object({
            id: z.string().nullable(),
            name: z.string().nullable(),
            shapeType: z.string().nullable(),
            shape: z.record(z.string(), z.string()),
            markers: z.array(z.string()),
          }),
        ),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_list_regions', logger }, async (args) => {
      const document = parseRegions(await readComponent(args.workspace_id, REGIONS_FILENAME));

      return ok(
        [
          `${document.regions.length} region(s):`,
          ...document.regions.map(
            (region) =>
              `  [${region.id ?? '?'}] ${region.name ?? '(unnamed)'} — ${region.shapeType ?? 'unknown shape'} ${Object.entries(region.shape)
                .map(([key, value]) => `${key}=${value}`)
                .join(' ')}`,
          ),
          READ_ONLY_NOTE,
        ].join('\n'),
        { regions: [...document.regions], note: READ_ONLY_NOTE },
      );
    }),
  );

  server.registerTool(
    'sc2_get_terrain_summary',
    {
      title: 'Summarise the terrain',
      description:
        'Reads t3Terrain.xml — the terrain descriptor — for tile set, dimensions, scale, and cliff sets, and reports the header of each binary terrain file alongside it. The bulk data (heights, texture masks, cell flags) is NOT decoded: only its four-character code, version, and size are reported, which is what can be established without guessing. Dimensions are vertex counts, one more than the cell count in each direction.',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        descriptor: z.object({
          version: z.string().nullable(),
          tileSet: z.string().nullable(),
          dimensions: z.string().nullable(),
          offset: z.string().nullable(),
          scale: z.string().nullable(),
          cliffSets: z.array(z.string()),
          sections: z.array(z.string()),
        }),
        binaryComponents: z.array(
          z.object({
            path: z.string(),
            sizeBytes: z.number().int(),
            magic: z.string().nullable(),
            magicReversed: z.string().nullable(),
            version: z.number().int().nullable(),
            known: z.boolean(),
            description: z.string().nullable(),
          }),
        ),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_terrain_summary', logger }, async (args) => {
      const descriptor = parseTerrainSummary(await readComponent(args.workspace_id, TERRAIN_FILENAME));

      const staged = await workspaces.listFiles(args.workspace_id);
      const binaryComponents = [];
      for (const file of staged) {
        const fileName = file.relativePath.split('/').pop() ?? '';
        if (!(fileName in BINARY_TERRAIN_FILES)) continue;
        const bytes = await readFile(file.absolutePath);
        binaryComponents.push(readBinaryHeader(file.relativePath, bytes));
      }
      binaryComponents.sort((left, right) => left.path.localeCompare(right.path));

      const note =
        'Terrain bulk data is not decoded by this build. Heights, texture masks, and cell flags are reported only by four-character code, version, and size; nothing reads or writes their contents.';

      return ok(
        [
          `Terrain descriptor version ${descriptor.version ?? 'unknown'}`,
          `  tile set: ${descriptor.tileSet ?? 'unknown'}`,
          `  dimensions (vertices): ${descriptor.dimensions ?? 'unknown'}`,
          `  scale: ${descriptor.scale ?? 'unknown'}`,
          descriptor.cliffSets.length === 0 ? '' : `  cliff sets: ${descriptor.cliffSets.join(', ')}`,
          `  sections present: ${descriptor.sections.join(', ')}`,
          '',
          'Binary terrain components (headers only):',
          ...binaryComponents.map(
            (component) =>
              `  ${component.path} — ${component.magic ?? '????'} (reversed ${component.magicReversed ?? '????'}) v${component.version ?? '?'} — ${component.sizeBytes} bytes${component.description === null ? '' : ` — ${component.description}`}`,
          ),
          '',
          note,
        ]
          .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
          .join('\n'),
        { descriptor, binaryComponents, note },
      );
    }),
  );
}
