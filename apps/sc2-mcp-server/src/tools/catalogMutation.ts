/**
 * GameData mutation tools (PLAN.md §18, §42 Phase 8).
 *
 * All four run through the transaction engine, so each gets a snapshot, a dry run, a
 * diff, all-or-nothing application, and a revert. They share the mutation argument shape:
 * `workspace_id`, optional `expected_revision`, optional `dry_run`.
 *
 * `dry_run` defaults to **true**. A caller must ask for a write explicitly; the cost of an
 * unintended preview is nothing, and the cost of an unintended edit is someone's map.
 */

import { readFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/server';
import {
  SC2Error,
  applyCatalogPatches,
  catalogKey,
  cloneCatalogEntry,
  createCatalogEntry,
  deleteCatalogEntry,
  domainFromElementName,
  type ChangeResult,
} from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');

/** What a brand-new catalog file contains, in the editor's own encoding and line endings. */
const EMPTY_CATALOG = '<?xml version="1.0" encoding="utf-8"?>\r\n<Catalog>\r\n</Catalog>\r\n';

/**
 * Reads the catalog file an object is being added to, creating it when the document does
 * not have one yet.
 *
 * A missing file used to surface as an unhandled ENOENT wrapped in SC2_INTERNAL_ERROR,
 * which read as a server bug rather than "this document has no UpgradeData.xml". Creating
 * it is only offered inside a GameData directory, because that is where the game looks;
 * anywhere else the file would be written and then silently ignored.
 */
async function readCatalogFileForCreation(absolutePath: string, relativePath: string): Promise<string> {
  try {
    return await readFile(absolutePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;

    if (!/(^|\/)GameData\/[^/]+\.xml$/i.test(relativePath)) {
      throw new SC2Error('SC2_NOT_FOUND', `No catalog file at ${relativePath}, and it is not a place the game would load one from.`, {
        path: relativePath,
        recoverable: true,
        suggestedAction: 'Catalog files live in a GameData directory, e.g. "Base.SC2Data/GameData/UpgradeData.xml".',
      });
    }
    return EMPTY_CATALOG;
  }
}

const MutationArgsShape = {
  workspace_id: WorkspaceIdSchema,
  expected_revision: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Fail with SC2_CONFLICT unless the workspace is still at this revision.'),
  dry_run: z
    .boolean()
    .optional()
    .describe('Defaults to TRUE. Pass false to actually write. A dry run returns the same diff without touching anything.'),
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

/** Widens a {@link ChangeResult}'s readonly arrays for the structured payload. */
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

/** Renders a change result the way a reviewer wants to read it. */
function describeChange(result: ChangeResult): string {
  const header = result.dryRun
    ? `DRY RUN — nothing was written. Pass dry_run=false to apply.`
    : `Applied as ${result.changeId}; workspace is now at revision ${result.revisionAfter}.`;

  return [
    header,
    ...result.summary.map((line) => `- ${line}`),
    ...result.diagnostics.map((entry) => `[${entry.severity}] ${entry.message}`),
    ...result.filesChanged.map((file) => file.diff ?? `${file.path} (+${file.addedLines}/-${file.removedLines})`),
    result.dryRun || result.snapshotId === null ? '' : `Revert with sc2_revert_change, or restore snapshot ${result.snapshotId}.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function registerCatalogMutationTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger } = context;

  /** Reads the file that declares an object, or explains why it cannot be found. */
  async function readDeclaringFile(workspaceId: string, domain: string, id: string): Promise<{ path: string; content: string }> {
    const index = await workspaces.getCatalogIndex(workspaceId);
    const entry = index.get(domain, id);
    if (entry === null) {
      throw new SC2Error('SC2_NOT_FOUND', `No catalog object ${catalogKey(domain, id)} in this document.`, {
        workspaceId,
        objectId: catalogKey(domain, id),
        recoverable: true,
        suggestedAction:
          'Objects defined only in a dependency archive are not editable here — clone them into this document first. Use sc2_search_catalog to check the id.',
      });
    }

    if (entry.layer === 'dependency') {
      // The object is visible because a dependency was loaded, but it lives outside the
      // workspace. Editing it would mean modifying another archive, which PLAN.md §25
      // forbids outright.
      throw new SC2Error(
        'SC2_UNSUPPORTED_OPERATION',
        `${catalogKey(domain, id)} is defined in the dependency "${entry.origin ?? 'unknown'}", not in this document.`,
        {
          workspaceId,
          objectId: catalogKey(domain, id),
          recoverable: true,
          suggestedAction:
            'Clone it into this document with sc2_clone_catalog_object and edit the copy. This server never modifies dependency archives.',
        },
      );
    }

    const absolutePath = await workspaces.resolveWorkingPath(workspaceId, entry.sourcePath);
    return { path: entry.sourcePath, content: await readFile(absolutePath, 'utf8') };
  }

  server.registerTool(
    'sc2_patch_catalog_object',
    {
      title: 'Patch a GameData object',
      description:
        'Applies field-level changes to one catalog object. Fields are addressed by path: "LifeMax", "FlagArray[ArmySelect]", "WeaponArray[0]", "CardLayouts[0].LayoutButtons[1]". Operations: set (the value attribute), set_link (a reference to another object), set_attribute (any other attribute), remove, append_array. Defaults to a dry run — pass dry_run=false to write. Only the addressed bytes change; comments, formatting, and line endings are preserved exactly.',
      inputSchema: z.object({
        ...MutationArgsShape,
        domain: z.string().min(1).describe('Catalog domain, e.g. "Unit".'),
        id: z.string().min(1).describe('Object id, e.g. "Marine".'),
        patches: z
          .array(
            z.discriminatedUnion('op', [
              z.object({ op: z.literal('set'), path: z.string().min(1), value: z.string() }),
              z.object({ op: z.literal('set_link'), path: z.string().min(1), value: z.string() }),
              z.object({
                op: z.literal('set_attribute'),
                path: z.string().min(1),
                attribute: z.string().min(1),
                value: z.string(),
              }),
              z.object({ op: z.literal('remove'), path: z.string().min(1) }),
              z.object({
                op: z.literal('append_array'),
                path: z.string().min(1).describe('The array field name without an index, e.g. "WeaponArray".'),
                value: z.string().optional(),
                link: z.string().optional(),
              }),
            ]),
          )
          .min(1),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_patch_catalog_object', logger }, async (args) => {
      const file = await readDeclaringFile(args.workspace_id, args.domain, args.id);
      const outcome = applyCatalogPatches(file.content, args.domain, args.id, args.patches, file.path);

      // Warn when the object is shared, so an edit that reaches other units is visible in
      // the preview rather than discovered later (PLAN.md §45).
      const index = await workspaces.getCatalogIndex(args.workspace_id);
      const referrers = new Set(index.findReferences(args.domain, args.id).map((reference) => reference.from));
      const diagnostics =
        referrers.size > 1
          ? [
              {
                severity: 'warning' as const,
                code: 'SC2_BROKEN_REFERENCE',
                message: `${catalogKey(args.domain, args.id)} is referenced by ${referrers.size} objects; this edit changes behaviour for all of them. Clone it first if you meant to affect only one.`,
              },
            ]
          : [];

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_patch_catalog_object',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: [...outcome.summary, ...outcome.noOps.map((line) => `no-op: ${line}`)],
        diagnostics,
        files: [{ kind: 'write', path: file.path, content: outcome.content }],
      });

      return ok(describeChange(result), toStructured(result));
    }),
  );

  server.registerTool(
    'sc2_clone_catalog_object',
    {
      title: 'Clone a GameData object',
      description:
        'Copies a catalog object under a new id, placed immediately after the original in the same file. The copy is byte-for-byte, so fields this server does not understand come along intact. Cloning is the safe way to change something shared: clone, then edit the clone, then repoint the one thing that should use it. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        domain: z.string().min(1),
        source_id: z.string().min(1),
        new_id: z.string().min(1).describe('Must not already exist in this domain.'),
        new_parent: z.string().optional().describe('Override the clone\'s parent attribute.'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_clone_catalog_object', logger }, async (args) => {
      const index = await workspaces.getCatalogIndex(args.workspace_id);
      const entry = index.get(args.domain, args.source_id);

      if (entry !== null && entry.layer === 'dependency') {
        // Cloning FROM a dependency is exactly the supported way to make one of its
        // objects editable, but the copy has to land in this document, not in the
        // dependency's own file.
        throw new SC2Error(
          'SC2_UNSUPPORTED_OPERATION',
          `${catalogKey(args.domain, args.source_id)} lives in the dependency "${entry.origin ?? 'unknown'}"; copying it into this document is not implemented yet.`,
          {
            workspaceId: args.workspace_id,
            objectId: catalogKey(args.domain, args.source_id),
            recoverable: true,
            suggestedAction:
              'Create a new object with sc2_create_catalog_object using the dependency object as its parent, then patch only what differs.',
          },
        );
      }

      const file = await readDeclaringFile(args.workspace_id, args.domain, args.source_id);
      const outcome = cloneCatalogEntry(file.content, args.domain, args.source_id, args.new_id, file.path, {
        newParent: args.new_parent,
      });

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_clone_catalog_object',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: outcome.summary,
        files: [{ kind: 'write', path: file.path, content: outcome.content }],
      });

      return ok(describeChange(result), toStructured(result));
    }),
  );

  server.registerTool(
    'sc2_create_catalog_object',
    {
      title: 'Create a GameData object',
      description:
        'Adds a new catalog entry to a GameData file. Give the concrete type (CUnit, CAbilEffectInstant, CWeaponLegacy) and an id. Prefer setting a parent and then patching only what differs — that is what the editor does, and it keeps the object small and the diff reviewable. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        ctype: z.string().min(1).describe('Concrete catalog type, e.g. "CUnit". Determines the domain.'),
        id: z.string().min(1),
        parent: z.string().optional().describe('Id of the object to inherit from, within the same domain.'),
        attributes: z
          .record(z.string(), z.string())
          .optional()
          .describe('Additional attributes on the catalog entry itself, such as {"unitName":"MCPHeroVanguard"} for CActorUnit.'),
        file: z
          .string()
          .optional()
          .describe('Catalog file to add it to, e.g. "Base.SC2Data/GameData/UnitData.xml". Defaults to the file where the parent lives, or the domain\'s conventional file.'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_create_catalog_object', logger }, async (args) => {
      const domain = domainFromElementName(args.ctype);
      if (domain === null) {
        throw new SC2Error('SC2_INVALID_ARGUMENT', `"${args.ctype}" does not resolve to a known catalog domain.`, {
          recoverable: true,
          suggestedAction: 'Use sc2_list_catalog_domains to see the domains, and copy a concrete type from an existing object.',
        });
      }

      const index = await workspaces.getCatalogIndex(args.workspace_id);

      // Put it where its parent lives when we can; that is where a human would look.
      // Only the DOCUMENT's own files are candidates. A dependency entry's sourcePath is
      // a pseudo-path into another archive, and writing there would both fail and be
      // forbidden (PLAN.md §25).
      let targetPath = args.file;
      if (args.parent !== undefined) {
        const parentEntry = index.get(domain, args.parent);
        if (parentEntry?.layer === 'document') targetPath ??= parentEntry.sourcePath;
      }
      targetPath ??= index
        .search({ domains: [domain], limit: 1000 })
        .results.find((candidate) => candidate.layer === 'document')?.sourcePath;
      if (targetPath === undefined) {
        throw new SC2Error(
          'SC2_INVALID_ARGUMENT',
          `This document has no ${domain} catalog file, so there is nowhere obvious to put ${args.id}.`,
          {
            recoverable: true,
            suggestedAction: `Pass "file" explicitly, e.g. "Base.SC2Data/GameData/${domain}Data.xml".`,
          },
        );
      }

      const absolutePath = await workspaces.resolveWorkingPath(args.workspace_id, targetPath);
      const content = await readCatalogFileForCreation(absolutePath, targetPath);
      const createdFile = content === EMPTY_CATALOG;
      const outcome = createCatalogEntry(content, args.ctype, args.id, targetPath, {
        parent: args.parent,
        attributes: args.attributes,
      });

      const diagnostics = [
        ...(args.parent !== undefined && index.get(domain, args.parent) === null
          ? [
              {
                severity: 'warning' as const,
                code: 'SC2_BROKEN_REFERENCE',
                message: `Parent ${catalogKey(domain, args.parent)} is not in this document. That is fine if it lives in a dependency, but nothing here can verify it.`,
              },
            ]
          : []),
        ...(createdFile
          ? [
              {
                severity: 'warning' as const,
                code: 'SC2_UNSUPPORTED_OPERATION',
                message: `${targetPath} did not exist and was created as an empty catalog.`,
                path: targetPath,
              },
            ]
          : []),
      ];

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_create_catalog_object',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: outcome.summary,
        diagnostics,
        files: [{ kind: 'write', path: targetPath, content: outcome.content }],
      });

      return ok(describeChange(result), toStructured(result));
    }),
  );

  server.registerTool(
    'sc2_delete_catalog_object',
    {
      title: 'Delete a GameData object',
      description:
        'Removes a catalog object. Refuses when anything still refers to it, listing every referrer, unless force=true. Deleting a referenced object is how a map starts failing to load, so the refusal is the point — fix the referrers first. Defaults to a dry run.',
      inputSchema: z.object({
        ...MutationArgsShape,
        domain: z.string().min(1),
        id: z.string().min(1),
        force: z.boolean().optional().describe('Delete even though references remain. They will break.'),
      }),
      outputSchema: ChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_delete_catalog_object', logger }, async (args) => {
      const file = await readDeclaringFile(args.workspace_id, args.domain, args.id);
      const index = await workspaces.getCatalogIndex(args.workspace_id);
      const references = index.findReferences(args.domain, args.id);

      if (references.length > 0 && args.force !== true) {
        throw new SC2Error(
          'SC2_BROKEN_REFERENCE',
          `${catalogKey(args.domain, args.id)} is still referenced by ${references.length} field(s); deleting it would break them.`,
          {
            workspaceId: args.workspace_id,
            objectId: catalogKey(args.domain, args.id),
            recoverable: true,
            suggestedAction: 'Repoint or remove the referrers first, or pass force=true to delete anyway.',
            context: {
              references: references.slice(0, 20).map((reference) => `${reference.from}.${reference.fieldPath}`),
            },
          },
        );
      }

      const outcome = deleteCatalogEntry(file.content, args.domain, args.id, file.path);

      const result = await workspaces.transactions.run({
        workspaceId: args.workspace_id,
        operation: 'sc2_delete_catalog_object',
        expectedRevision: args.expected_revision,
        dryRun: args.dry_run ?? true,
        summary: outcome.summary,
        diagnostics: references.map((reference) => ({
          severity: 'error' as const,
          code: 'SC2_BROKEN_REFERENCE',
          message: `${reference.from}.${reference.fieldPath} now points at a deleted object.`,
          path: reference.sourcePath,
        })),
        files: [{ kind: 'write', path: file.path, content: outcome.content }],
      });

      return ok(describeChange(result), toStructured(result));
    }),
  );
}
