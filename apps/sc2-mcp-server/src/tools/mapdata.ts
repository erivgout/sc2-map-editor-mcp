/**
 * Placed objects, regions, and terrain tools (PLAN.md §27, §28, §42 Phases 15–16).
 *
 * Regions and Objects are XML, and both are now writable: edits go through the same
 * span-splicing editor as GameData, so only the addressed bytes change. The round-trip
 * PLAN.md asks for has been run — a map edited here repacks and opens in the Galaxy
 * Editor with the changes intact.
 *
 * Terrain remains read-only. Its bulk data is a binary format whose layout has not been
 * established, and nothing here decodes it.
 */

import { readFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/server';
import {
  BINARY_TERRAIN_FILES,
  DOCUMENT_INFO_FILENAME,
  OBJECTS_FILENAME,
  REGIONS_FILENAME,
  SC2Error,
  TERRAIN_FILENAME,
  addDependency,
  createRegion,
  deleteObject,
  deleteRegion,
  parsePlacedObjects,
  parseRegions,
  parseTerrainSummary,
  placeObject,
  readBinaryHeader,
  removeDependency,
  setDocumentInfoField,
  updateObject,
  updateRegion,
  type ChangeResult,
} from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');

const READ_ONLY_NOTE =
  'Regions and placed objects are writable; terrain bulk data is not decoded by this build.';

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
    ...result.diagnostics.map((entry) => `[${entry.severity}] ${entry.message}`),
    ...result.filesChanged.map((file) => file.diff ?? `${file.path} (+${file.addedLines}/-${file.removedLines})`),
    result.snapshotId === null ? '' : `Revert with sc2_revert_change, or restore snapshot ${result.snapshotId}.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

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

  // ------------------------------------------------------------------ writes

  /** Runs a component rewrite through the transaction engine, like every other write. */
  async function commitComponent(
    args: { workspace_id: string; expected_revision?: number | undefined; dry_run?: boolean | undefined },
    operation: string,
    fileName: string,
    mutate: (source: string) => { content: string; summary: readonly string[] },
  ): Promise<ReturnType<typeof ok>> {
    const source = await readComponent(args.workspace_id, fileName);
    const outcome = mutate(source);

    const result = await workspaces.transactions.run({
      workspaceId: args.workspace_id,
      operation,
      expectedRevision: args.expected_revision,
      dryRun: args.dry_run ?? true,
      summary: [...outcome.summary],
      diagnostics: [],
      files: [{ kind: 'write', path: fileName, content: outcome.content }],
    });

    return ok(describeChange(result), toStructured(result));
  }

  const ShapeSchema = z.object({
    type: z.string().min(1).describe('"circle" or "rect", as the editor writes them.'),
    values: z
      .record(z.string(), z.string())
      .describe('Shape parameters as text, e.g. {"center":"10,20","radius":"5"} for a circle.'),
  });

  server.registerTool(
    'sc2_create_region',
    {
      title: 'Create a map region',
      description:
        'Adds a region to the Regions component with the next free id. Shape parameters are written exactly as given, because the file own precision is meaningful. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        name: z.string().min(1),
        shape: ShapeSchema,
        markers: z.array(z.string()).optional().describe('Childless markers to carry, e.g. ["invisible"].'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_create_region', logger }, async (args) =>
      commitComponent(args, 'sc2_create_region', REGIONS_FILENAME, (source) =>
        createRegion(source, { name: args.name, shape: args.shape, markers: args.markers }),
      ),
    ),
  );

  server.registerTool(
    'sc2_update_region',
    {
      title: 'Move or rename a region',
      description:
        'Changes a region name or its shape parameters. Only the fields you name are touched; a radius you do not mention keeps its value. Changing a region to a different shape kind is refused, because the parameter children differ — delete and recreate instead. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        region_id: z.string().min(1),
        name: z.string().optional(),
        shape: ShapeSchema.optional(),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_update_region', logger }, async (args) =>
      commitComponent(args, 'sc2_update_region', REGIONS_FILENAME, (source) =>
        updateRegion(source, args.region_id, { name: args.name, shape: args.shape }),
      ),
    ),
  );

  server.registerTool(
    'sc2_delete_region',
    {
      title: 'Delete a map region',
      description:
        'Removes a region. Triggers and scripts that reference it by id will break, and nothing here can see those references, so check before deleting. Defaults to a dry run.',
      inputSchema: z.object({ ...MutationArgsShape, region_id: z.string().min(1) }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_delete_region', logger }, async (args) =>
      commitComponent(args, 'sc2_delete_region', REGIONS_FILENAME, (source) => deleteRegion(source, args.region_id)),
    ),
  );

  server.registerTool(
    'sc2_place_object',
    {
      title: 'Place a unit, doodad, or point',
      description:
        'Adds an object to the Objects component with the next free Id. Position is "x,y,z" and is written verbatim. This does NOT consult terrain height — a z that does not match the ground will look wrong in the editor; read a nearby object position with sc2_list_placed_objects to find a sane value. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        kind: z.string().min(1).describe('ObjectUnit, ObjectDoodad, or ObjectPoint.'),
        type: z.string().optional().describe('Catalog or doodad type. Points may omit it.'),
        position: z.string().min(1).describe('"x,y,z".'),
        rotation: z.string().optional(),
        scale: z.string().optional(),
        variation: z.string().optional(),
        flags: z.record(z.string(), z.string()).optional().describe('e.g. {"HeightAbsolute":"1"}.'),
        attributes: z.record(z.string(), z.string()).optional().describe('Anything else, e.g. {"Player":"1"}.'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_place_object', logger }, async (args) =>
      commitComponent(args, 'sc2_place_object', OBJECTS_FILENAME, (source) =>
        placeObject(source, {
          kind: args.kind,
          type: args.type,
          position: args.position,
          rotation: args.rotation,
          scale: args.scale,
          variation: args.variation,
          flags: args.flags,
          attributes: args.attributes,
        }),
      ),
    ),
  );

  server.registerTool(
    'sc2_update_object',
    {
      title: 'Move, rotate, or rescale a placed object',
      description:
        'Changes a placed object position, rotation, or scale. Setting a value it already has is reported as no change rather than manufacturing a diff. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        object_id: z.string().min(1),
        position: z.string().optional().describe('"x,y,z".'),
        rotation: z.string().optional(),
        scale: z.string().optional(),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_update_object', logger }, async (args) =>
      commitComponent(args, 'sc2_update_object', OBJECTS_FILENAME, (source) =>
        updateObject(source, args.object_id, { position: args.position, rotation: args.rotation, scale: args.scale }),
      ),
    ),
  );

  server.registerTool(
    'sc2_delete_object',
    {
      title: 'Delete a placed object',
      description:
        'Removes a placed unit, doodad, or point. Triggers referencing it by id will break, and nothing here can see those references. Defaults to a dry run.',
      inputSchema: z.object({ ...MutationArgsShape, object_id: z.string().min(1) }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_delete_object', logger }, async (args) =>
      commitComponent(args, 'sc2_delete_object', OBJECTS_FILENAME, (source) => deleteObject(source, args.object_id)),
    ),
  );

  server.registerTool(
    'sc2_add_dependency',
    {
      title: 'Add a dependency',
      description:
        'Appends a dependency to DocumentInfo. Order is load order and later wins, so a new entry goes last and overrides the ones above it. Duplicates are refused by their "file:" half, so the same mod cannot be added twice under a different display name. This build still cannot READ Blizzard stock mods — they live in CASC — so adding one does not make its objects visible to the catalog tools. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        dependency: z
          .string()
          .min(1)
          .describe('Full string, e.g. "bnet:Void (Mod)/0.0/999,file:Mods/Void.SC2Mod".'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_add_dependency', logger }, async (args) =>
      commitComponent(args, 'sc2_add_dependency', DOCUMENT_INFO_FILENAME, (source) =>
        addDependency(source, args.dependency),
      ),
    ),
  );

  server.registerTool(
    'sc2_remove_dependency',
    {
      title: 'Remove a dependency',
      description:
        'Removes a dependency from DocumentInfo, matched by its "file:" half so you can pass either the full string or just "Mods/Void.SC2Mod". Anything in the map that relied on it will break. Defaults to a dry run.',
      inputSchema: z.object({ ...MutationArgsShape, dependency: z.string().min(1) }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_remove_dependency', logger }, async (args) =>
      commitComponent(args, 'sc2_remove_dependency', DOCUMENT_INFO_FILENAME, (source) =>
        removeDependency(source, args.dependency),
      ),
    ),
  );

  server.registerTool(
    'sc2_set_document_info',
    {
      title: 'Set a DocumentInfo field',
      description:
        'Sets a single-valued DocInfo field such as ModType or Icon. Dependencies are a list and are refused here — use sc2_add_dependency. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        field: z.string().min(1).describe('e.g. "ModType", "Icon".'),
        value: z.string(),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_set_document_info', logger }, async (args) =>
      commitComponent(args, 'sc2_set_document_info', DOCUMENT_INFO_FILENAME, (source) =>
        setDocumentInfoField(source, args.field, args.value),
      ),
    ),
  );
}
