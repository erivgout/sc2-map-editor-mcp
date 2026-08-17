/**
 * High-level authoring tools (PLAN.md §19, §45, §42 Phase 14).
 *
 * These compose the Phase 8 primitives into the operations a person actually asks for —
 * "clone the Marine, give it more health and its own weapon" — while enforcing the
 * shared-object rule that makes such a request dangerous to take literally.
 *
 * Two properties every tool here keeps (PLAN.md §19):
 *   - **Nothing is hidden.** Every object created or modified is listed by id.
 *   - **Nothing shared is edited silently.** When isolation was needed it says so; when
 *     it was not needed it says that too.
 */

import { readFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/server';
import {
  CatalogEditSession,
  EFFECT_AMOUNT_FIELD,
  SC2Error,
  applyTextEdits,
  catalogKey,
  derivedId,
  describeSharing,
  displayNameKey,
  findWeaponChain,
  isolateSharedObject,
  type ChangeResult,
  type CreatedObject,
} from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const MutationArgsShape = {
  workspace_id: z.string().min(1),
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
  createdObjects: z.array(
    z.object({ domain: z.string(), id: z.string(), ctype: z.string(), path: z.string(), clonedFrom: z.string().optional() }),
  ),
});

function toStructured(result: ChangeResult, created: readonly CreatedObject[]): Record<string, unknown> {
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
    createdObjects: [...created],
  };
}

function describe(result: ChangeResult, created: readonly CreatedObject[]): string {
  return [
    result.dryRun
      ? 'DRY RUN — nothing was written. Pass dry_run=false to apply.'
      : `Applied as ${result.changeId}; workspace is now at revision ${result.revisionAfter}.`,
    created.length === 0
      ? ''
      : ['Objects created:', ...created.map((object) => `  ${object.domain}/${object.id} <${object.ctype}> in ${object.path}${object.clonedFrom === undefined ? '' : ` (from ${object.clonedFrom})`}`)].join('\n'),
    ...result.summary.map((line) => `- ${line}`),
    ...result.diagnostics.map((entry) => `[${entry.severity}] ${entry.message}`),
    ...result.filesChanged.map((file) => file.diff ?? `${file.path} (+${file.addedLines}/-${file.removedLines})`),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function registerAuthoringTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger, config } = context;

  /** Reads a staged file by its archive-style path. */
  const readerFor =
    (workspaceId: string) =>
    async (relativePath: string): Promise<string> =>
      readFile(await workspaces.resolveWorkingPath(workspaceId, relativePath), 'utf8');

  server.registerTool(
    'sc2_create_unit_from_template',
    {
      title: 'Create a unit from an existing one',
      description:
        'Clones a unit under a new id, optionally sets its display name and stat overrides, and optionally gives it a private copy of its weapon so changing that weapon later cannot affect other units. Reports every object it created. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        base_unit_id: z.string().min(1).describe('The unit to copy. Must be in this document, not only in a dependency.'),
        new_id: z.string().min(1),
        display_name: z.string().optional().describe('Sets Unit/Name/<new_id> in the default locale.'),
        stat_overrides: z
          .array(z.object({ path: z.string().min(1), value: z.string() }))
          .optional()
          .describe('Field paths on the new unit, e.g. [{"path":"LifeMax","value":"125"}].'),
        isolate_weapon: z
          .boolean()
          .optional()
          .describe('Give the new unit its own copy of the base unit\'s weapon. Defaults to false.'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_create_unit_from_template', logger }, async (args) => {
      const index = await workspaces.getCatalogIndex(args.workspace_id);
      const session = new CatalogEditSession(index, readerFor(args.workspace_id));

      await session.clone('Unit', args.base_unit_id, args.new_id);

      if (args.stat_overrides !== undefined && args.stat_overrides.length > 0) {
        await session.patch(
          'Unit',
          args.new_id,
          args.stat_overrides.map((override) => ({ op: 'set' as const, path: override.path, value: override.value })),
        );
      }

      const diagnostics: { severity: 'warning' | 'info'; code: string; message: string }[] = [];

      if (args.isolate_weapon === true) {
        try {
          // Resolve against the BASE unit: the clone exists only in this in-flight session,
          // so the catalog index cannot see it yet.
          const chain = findWeaponChain(index, args.base_unit_id);
          const privateWeaponId = derivedId(args.new_id, chain.weaponId);

          await session.clone('Weapon', chain.weaponId, privateWeaponId);
          await session.patch('Unit', args.new_id, [
            { op: 'set_link', path: chain.weaponFieldPath, value: privateWeaponId },
          ]);

          diagnostics.push({
            severity: 'info',
            code: 'SC2_OK',
            message: `Unit/${args.new_id} uses its own ${catalogKey('Weapon', privateWeaponId)}; ${catalogKey('Weapon', chain.weaponId)} is unchanged for everything else.`,
          });
        } catch (error) {
          // A unit that inherits its weapon rather than declaring one is common. Report it
          // rather than failing the whole creation.
          diagnostics.push({
            severity: 'warning',
            code: 'SC2_NOT_FOUND',
            message: `Could not give it a private weapon: ${error instanceof Error ? error.message : 'unknown reason'}`,
          });
        }
      }

      const files = session.writes.map((write) => ({ kind: 'write' as const, path: write.path, content: write.content }));

      if (args.display_name !== undefined) {
        const tables = await workspaces.listTextTables(args.workspace_id);
        const table = tables.find(
          (candidate) => candidate.locale.toLowerCase() === config.defaultLocale.toLowerCase() && candidate.table === 'GameStrings',
        );
        if (table === undefined) {
          diagnostics.push({
            severity: 'warning',
            code: 'SC2_NOT_FOUND',
            message: `No GameStrings table for ${config.defaultLocale}, so the display name was not set. The unit will show its raw key in game.`,
          });
        } else {
          const parsed = await workspaces.getTextTable(args.workspace_id, table.path);
          const outcome = applyTextEdits(parsed, [
            { op: 'set', key: displayNameKey('Unit', args.new_id), value: args.display_name },
          ]);
          files.push({ kind: 'write', path: table.path, content: outcome.content });
          for (const line of outcome.summary) session.note(line);
        }
      }

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_create_unit_from_template',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: [...session.summary],
        diagnostics,
        files,
      });

      return ok(describe(result, session.created), toStructured(result, session.created));
    }),
  );

  server.registerTool(
    'sc2_isolate_shared_object',
    {
      title: 'Give one object its own copy of something shared',
      description:
        'Clones a catalog object that several objects reference, and repoints ONE owner at the copy. Everything else keeps the original. This is the safe way to answer "change this unit\'s X" when X is shared. If nothing else references the object, no copy is made and the tool says so — cloning an unshared object just adds a duplicate.',
      inputSchema: z.object({
        ...MutationArgsShape,
        domain: z.string().min(1).describe('Domain of the shared object, e.g. "Weapon".'),
        id: z.string().min(1).describe('Id of the shared object.'),
        owner_domain: z.string().min(1).describe('Domain of the object that should get its own copy, e.g. "Unit".'),
        owner_id: z.string().min(1),
        new_id: z.string().optional().describe('Id for the copy. Defaults to <owner_id><id>.'),
        always: z.boolean().optional().describe('Copy even when nothing else references it.'),
      }),
      outputSchema: ChangeResultSchema.extend({
        isolated: z.boolean(),
        effectiveId: z.string(),
        otherReferrers: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_isolate_shared_object', logger }, async (args) => {
      const index = await workspaces.getCatalogIndex(args.workspace_id);
      const session = new CatalogEditSession(index, readerFor(args.workspace_id));

      const isolated = await isolateSharedObject(session, index, args.domain, args.id, {
        ownerDomain: args.owner_domain,
        ownerId: args.owner_id,
        newId: args.new_id,
        always: args.always,
      });

      const otherReferrers = isolated.sharing.referrers.filter(
        (referrer) => referrer !== catalogKey(args.owner_domain, args.owner_id),
      );

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_isolate_shared_object',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary:
          isolated.cloned === null
            ? [`${catalogKey(args.domain, args.id)} is not shared; no copy was made.`]
            : [...session.summary],
        files: session.writes.map((write) => ({ kind: 'write' as const, path: write.path, content: write.content })),
      });

      return ok(
        [
          describe(result, session.created),
          isolated.cloned === null
            ? `Nothing else references ${catalogKey(args.domain, args.id)}, so editing it in place is already safe.`
            : `Other referrers keeping the original: ${otherReferrers.join(', ') || '(none)'}`,
        ].join('\n'),
        {
          ...toStructured(result, session.created),
          isolated: isolated.cloned !== null,
          effectiveId: isolated.effectiveId,
          otherReferrers,
        },
      );
    }),
  );

  server.registerTool(
    'sc2_set_unit_weapon_damage',
    {
      title: "Change a unit's weapon damage safely",
      description:
        'Sets the damage of the effect behind a unit\'s weapon. Weapons and their effects are usually shared between many units, so by default this clones whatever is shared, repoints only this unit, and reports every copy it made. Pass modify_shared=true to edit the originals instead and affect every unit that uses them. Follows WeaponArray -> Effect -> Amount only; a deeper effect tree (a CEffectSet fanning out to several damage effects) is reported rather than guessed at.',
      inputSchema: z.object({
        ...MutationArgsShape,
        unit_id: z.string().min(1),
        damage: z.string().min(1).describe('New Amount value on the damage effect.'),
        weapon_index: z.number().int().min(0).optional().describe('Which of the unit\'s weapons. Defaults to the first.'),
        modify_shared: z
          .boolean()
          .optional()
          .describe('Edit the shared weapon/effect in place, changing every unit that uses them. Defaults to false.'),
      }),
      outputSchema: ChangeResultSchema.extend({
        weaponId: z.string(),
        effectId: z.string().nullable(),
        clonedForIsolation: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_set_unit_weapon_damage', logger }, async (args) => {
      const index = await workspaces.getCatalogIndex(args.workspace_id);
      const session = new CatalogEditSession(index, readerFor(args.workspace_id));

      const chain = findWeaponChain(index, args.unit_id, args.weapon_index ?? 0);
      if (chain.effectId === null) {
        throw new SC2Error(
          'SC2_UNSUPPORTED_OPERATION',
          `Weapon/${chain.weaponId} does not name a simple Effect, so its damage cannot be located automatically.`,
          {
            objectId: catalogKey('Weapon', chain.weaponId),
            recoverable: true,
            suggestedAction:
              'Inspect the weapon with sc2_get_catalog_object and edit the effect chain with sc2_patch_catalog_object.',
          },
        );
      }

      const diagnostics: { severity: 'warning' | 'info'; code: string; message: string }[] = [];
      const clonedForIsolation: string[] = [];

      let weaponId = chain.weaponId;
      let effectId = chain.effectId;

      if (args.modify_shared === true) {
        const weaponSharing = describeSharing(index, 'Weapon', weaponId, catalogKey('Unit', args.unit_id));
        const effectSharing = describeSharing(index, 'Effect', effectId);
        if (weaponSharing.shared || effectSharing.shared) {
          diagnostics.push({
            severity: 'warning',
            code: 'SC2_BROKEN_REFERENCE',
            message: `modify_shared was set: this changes damage for every object using ${catalogKey('Effect', effectId)} (${effectSharing.referrers.length} referrer(s)).`,
          });
        }
      } else {
        // Isolate the weapon first, then the effect the (possibly new) weapon points at.
        const isolatedWeapon = await isolateSharedObject(session, index, 'Weapon', weaponId, {
          ownerDomain: 'Unit',
          ownerId: args.unit_id,
        });
        if (isolatedWeapon.cloned !== null) {
          weaponId = isolatedWeapon.effectiveId;
          clonedForIsolation.push(catalogKey('Weapon', weaponId));
        }

        const effectSharing = describeSharing(index, 'Effect', effectId, catalogKey('Weapon', chain.weaponId));
        if (effectSharing.shared || isolatedWeapon.cloned !== null) {
          const newEffectId = `${args.unit_id}${effectId}`;
          await session.clone('Effect', effectId, newEffectId);
          // Point the (now unit-specific) weapon at the new effect. `Effect` uses `value`,
          // not `Link`, which is why this is a plain set.
          await session.patch('Weapon', weaponId, [{ op: 'set', path: 'Effect', value: newEffectId }]);
          effectId = newEffectId;
          clonedForIsolation.push(catalogKey('Effect', newEffectId));
        }
      }

      await session.patch('Effect', effectId, [{ op: 'set', path: EFFECT_AMOUNT_FIELD, value: args.damage }]);

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_set_unit_weapon_damage',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: [...session.summary],
        diagnostics,
        files: session.writes.map((write) => ({ kind: 'write' as const, path: write.path, content: write.content })),
      });

      return ok(
        [
          describe(result, session.created),
          clonedForIsolation.length === 0
            ? 'Nothing needed cloning: the weapon and effect were not shared.'
            : `Cloned for isolation: ${clonedForIsolation.join(', ')}. Other units keep the originals.`,
        ].join('\n'),
        {
          ...toStructured(result, session.created),
          weaponId,
          effectId,
          clonedForIsolation,
        },
      );
    }),
  );

  server.registerTool(
    'sc2_check_shared_object',
    {
      title: 'Check whether editing an object would affect others',
      description:
        'Reports who references an object and whether editing it in place would reach beyond one owner. Read-only: use this before deciding between a direct patch and sc2_isolate_shared_object.',
      inputSchema: z.object({
        workspace_id: z.string().min(1),
        domain: z.string().min(1),
        id: z.string().min(1),
        owner_id: z.string().optional().describe('Ignore references from this object when judging sharing, e.g. "Unit/Marine".'),
      }),
      outputSchema: z.object({
        objectId: z.string(),
        referrers: z.array(z.string()),
        shared: z.boolean(),
        recommendation: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_check_shared_object', logger }, async (args) => {
      const index = await workspaces.getCatalogIndex(args.workspace_id);
      const sharing = describeSharing(index, args.domain, args.id, args.owner_id);

      const recommendation = sharing.shared
        ? `Shared by ${sharing.referrers.length} object(s). Editing it in place changes all of them; use sc2_isolate_shared_object to give one owner its own copy.`
        : 'Not shared. A direct sc2_patch_catalog_object is safe.';

      return ok([`${sharing.objectId}: ${sharing.referrers.join(', ') || '(no referrers in this document)'}`, recommendation].join('\n'), {
        objectId: sharing.objectId,
        referrers: [...sharing.referrers],
        shared: sharing.shared,
        recommendation,
      });
    }),
  );
}
