/**
 * GameData catalog read tools (PLAN.md §17, §42 Phase 6).
 *
 * These give a model a semantic Data Editor view instead of forcing it to guess at a
 * large XML graph. Everything here is read-only; mutation is Phase 8.
 *
 * One caveat is repeated in every tool description because it changes how results must be
 * read: **dependency archives are not loaded.** An object defined only in `VoidMulti.SC2Mod`
 * is not in the index, so "not found" means "not in this document", never "does not exist".
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { CATALOG_DOMAINS, SC2Error, catalogKey, isKnownDomain } from '@sc2mcp/core';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { ok, toolHandler } from '../mcp-errors.js';

const WorkspaceIdSchema = z.string().min(1).describe('Workspace id returned by sc2_open_document.');
const MAX_RESULTS = 200;

/**
 * What the index actually covers, stated per call rather than as a constant: local
 * dependency archives load, Blizzard's CASC-resident ones do not, so "absent" means
 * different things depending on which of those a document leans on.
 */
function dependencyCaveat(index: { stats(): { loadedDependencies: readonly string[] } }): string {
  const loaded = index.stats().loadedDependencies;
  const base =
    loaded.length === 0
      ? 'No dependency archives are loaded for this document, so only its own GameData is indexed.'
      : `Indexed alongside this document: ${loaded.join(', ')}.`;
  return `${base} Blizzard's stock dependencies live in the installation's CASC store, which this build cannot read — an absent object may simply be defined in one of those.`;
}

export function registerCatalogTools(server: McpServer, context: ServerContext): void {
  const { workspaces, logger } = context;

  server.registerTool(
    'sc2_list_catalog_domains',
    {
      title: 'List catalog domains',
      description:
        'Lists the GameData catalog domains present in this document with entry counts, alongside the full set of domain names this build knows about. A catalog entry\'s XML element is its concrete type (CAbilEffectInstant); the domain is the prefix it belongs to (Abil).',
      inputSchema: z.object({ workspace_id: WorkspaceIdSchema }),
      outputSchema: z.object({
        present: z.array(z.object({ domain: z.string(), count: z.number().int() })),
        knownDomains: z.array(z.string()),
        stats: z.object({
          fileCount: z.number().int(),
          entryCount: z.number().int(),
          domainCount: z.number().int(),
          unknownDomainCount: z.number().int(),
          documentEntryCount: z.number().int(),
          dependencyEntryCount: z.number().int(),
          loadedDependencies: z.array(z.string()),
        }),
        diagnostics: z.array(z.object({ severity: z.string(), code: z.string(), message: z.string(), path: z.string() })),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_list_catalog_domains', logger }, async (args) => {
      const index = await workspaces.getCatalogIndex(args.workspace_id);
      const present = index.domains();
      const stats = index.stats();

      const lines = [
        `${stats.entryCount} catalog entries across ${stats.domainCount} domain(s), from ${stats.fileCount} file(s).`,
        ...present.map((entry) => `  ${entry.domain}: ${entry.count}`),
        stats.dependencyEntryCount > 0
          ? `${stats.documentEntryCount} defined by the document itself, ${stats.dependencyEntryCount} by dependency archives.`
          : '',
        stats.unknownDomainCount > 0 ? `${stats.unknownDomainCount} entry/entries have a type whose domain is unrecognised.` : '',
        dependencyCaveat(index),
      ].filter((line) => line !== '');

      return ok(lines.join('\n'), {
        present,
        knownDomains: [...CATALOG_DOMAINS],
        stats,
        diagnostics: [...index.diagnostics],
      });
    }),
  );

  server.registerTool(
    'sc2_search_catalog',
    {
      title: 'Search GameData catalog objects',
      description:
        'Case-insensitive substring search over catalog object ids, optionally restricted to domains. Results are deterministic: exact-prefix matches first, then alphabetical by domain and id. Paginated via offset.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        query: z.string().optional().describe('Substring of the object id. Omit to list everything in the chosen domains.'),
        domains: z.array(z.string()).optional().describe('Restrict to these domains, e.g. ["Unit", "Actor"].'),
        limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      outputSchema: z.object({
        total: z.number().int(),
        results: z.array(
          z.object({
            domain: z.string().nullable(),
            id: z.string(),
            ctype: z.string(),
            parent: z.string().nullable(),
            sourcePath: z.string(),
            line: z.number().int(),
            fieldCount: z.number().int(),
            layer: z.enum(['document', 'dependency']),
            origin: z.string().nullable(),
          }),
        ),
        nextOffset: z.number().int().nullable(),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_search_catalog', logger }, async (args) => {
      const index = await workspaces.getCatalogIndex(args.workspace_id);

      // An unknown domain is almost always a typo, and silently returning zero results
      // would read as "this map has no units".
      for (const domain of args.domains ?? []) {
        if (!isKnownDomain(domain)) {
          throw new SC2Error('SC2_INVALID_ARGUMENT', `Unknown catalog domain: ${domain}`, {
            recoverable: true,
            suggestedAction: 'Call sc2_list_catalog_domains to see the valid domain names.',
          });
        }
      }

      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const { total, results } = index.search({ query: args.query, domains: args.domains, limit, offset });
      const nextOffset = offset + results.length < total ? offset + results.length : null;

      const lines = [
        `${total} match(es); showing ${results.length} from offset ${offset}.`,
        // The origin marker matters for more than provenance: a dependency-owned object
        // cannot be edited, so seeing it here saves a failed mutation.
        ...results.map((entry) => `  ${entry.domain}/${entry.id} <${entry.ctype}>${entry.parent === null ? '' : ` parent=${entry.parent}`}${entry.origin === null ? '' : ` [from ${entry.origin}, read-only]`} — ${entry.sourcePath}:${entry.line}`),
        nextOffset === null ? '' : `More results: pass offset=${nextOffset}.`,
        dependencyCaveat(index),
      ].filter((line) => line !== '');

      return ok(lines.join('\n'), { total, results, nextOffset, note: dependencyCaveat(index) });
    }),
  );

  server.registerTool(
    'sc2_get_catalog_object',
    {
      title: 'Get a catalog object',
      description:
        'Returns one catalog object as declared in this document: its concrete type, parent, own field values, and the exact XML text. This is the object\'s OWN declaration only — inherited values are not included. Use sc2_resolve_catalog_object for effective values.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        domain: z.string().min(1).describe('Catalog domain, e.g. "Unit".'),
        id: z.string().min(1).describe('Object id, e.g. "Marine".'),
        include_raw_xml: z.boolean().optional().describe('Include the object\'s verbatim XML. Defaults to true.'),
      }),
      outputSchema: z.object({
        domain: z.string().nullable(),
        id: z.string(),
        ctype: z.string(),
        parent: z.string().nullable(),
        sourcePath: z.string(),
        line: z.number().int(),
        fields: z.array(
          z.object({
            path: z.string(),
            value: z.string().nullable(),
            link: z.string().nullable(),
          }),
        ),
        rawXml: z.string().nullable(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_get_catalog_object', logger }, async (args) => {
      const index = await workspaces.getCatalogIndex(args.workspace_id);
      const entry = index.get(args.domain, args.id);

      if (entry === null) {
        const elsewhere = index.findById(args.id);
        throw new SC2Error('SC2_NOT_FOUND', `No catalog object ${catalogKey(args.domain, args.id)} in this document.`, {
          workspaceId: args.workspace_id,
          objectId: catalogKey(args.domain, args.id),
          recoverable: true,
          suggestedAction:
            elsewhere.length > 0
              ? `An object with that id exists in: ${elsewhere.map((other) => other.domain ?? '?').join(', ')}.`
              : `Use sc2_search_catalog to find the right id. ${dependencyCaveat(index)}`,
        });
      }

      let rawXml: string | null = null;
      if (args.include_raw_xml !== false) {
        const absolutePath = await workspaces.resolveWorkingPath(args.workspace_id, entry.sourcePath);
        const { readFile } = await import('node:fs/promises');
        const source = await readFile(absolutePath, 'utf8');
        // Spans are recorded at parse time, so this is the object's bytes exactly.
        rawXml = source.slice(entry.span.start, entry.span.end);
      }

      const fields = index.ownFields(entry).map(({ path, field }) => ({ path, value: field.value, link: field.link }));

      const lines = [
        `${entry.domain}/${entry.id ?? ''} <${entry.ctype}>${entry.parent === null ? '' : ` parent=${entry.parent}`}`,
        `defined at ${entry.sourcePath}:${entry.line}`,
        `${fields.length} field(s) declared on the object itself (inherited values not shown — use sc2_resolve_catalog_object).`,
      ];

      return ok(lines.join('\n'), {
        domain: entry.domain,
        id: entry.id ?? args.id,
        ctype: entry.ctype,
        parent: entry.parent,
        sourcePath: entry.sourcePath,
        line: entry.line,
        fields,
        rawXml,
      });
    }),
  );

  server.registerTool(
    'sc2_resolve_catalog_object',
    {
      title: 'Resolve a catalog object with inheritance',
      description:
        'Walks the object\'s parent chain and returns the effective value of every field, with "definedBy" naming the entry each value actually came from. That is what tells you whether editing a value changes only this object or an ancestor shared with others. Parents that live in an unloaded dependency are listed under "unresolvedParents" — their values are missing, not absent.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        domain: z.string().min(1),
        id: z.string().min(1),
      }),
      outputSchema: z.object({
        domain: z.string().nullable(),
        id: z.string(),
        ctype: z.string(),
        parentChain: z.array(z.string()),
        unresolvedParents: z.array(z.string()),
        fields: z.array(
          z.object({
            path: z.string(),
            value: z.string().nullable(),
            link: z.string().nullable(),
            definedBy: z.string(),
            sourcePath: z.string(),
            line: z.number().int(),
            layer: z.enum(['document', 'dependency']),
            origin: z.string().nullable(),
          }),
        ),
        complete: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_resolve_catalog_object', logger }, async (args) => {
      const index = await workspaces.getCatalogIndex(args.workspace_id);
      const resolved = index.resolve(args.domain, args.id);
      const complete = resolved.unresolvedParents.length === 0;

      const lines = [
        `${resolved.domain}/${resolved.id} <${resolved.ctype}>`,
        resolved.parentChain.length === 0
          ? 'no parent chain within this document'
          : `parent chain: ${[resolved.id, ...resolved.parentChain].join(' -> ')}`,
        ...(complete
          ? []
          : [
              `INCOMPLETE: could not resolve ${resolved.unresolvedParents.join(', ')}. Values inherited from there are missing, not absent.`,
            ]),
        `${resolved.fields.length} effective field(s).`,
      ];

      return ok(lines.join('\n'), {
        domain: resolved.domain,
        id: resolved.id,
        ctype: resolved.ctype,
        parentChain: [...resolved.parentChain],
        unresolvedParents: [...resolved.unresolvedParents],
        fields: [...resolved.fields],
        complete,
      });
    }),
  );

  server.registerTool(
    'sc2_find_catalog_references',
    {
      title: 'Find references to a catalog object',
      description:
        'Finds every catalog entry that refers to this object, by parent link, by a Link attribute, or by a bare value. SC2 references are untyped strings, so matching is by id and is deliberately over-inclusive: for "is this safe to change?", a false positive costs a second look while a false negative breaks the map. A reference count above 1 means the object is shared — editing it affects every referrer.',
      inputSchema: z.object({
        workspace_id: WorkspaceIdSchema,
        domain: z.string().min(1),
        id: z.string().min(1),
        limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
      }),
      outputSchema: z.object({
        total: z.number().int(),
        references: z.array(
          z.object({
            from: z.string(),
            fromDomain: z.string().nullable(),
            fieldPath: z.string(),
            via: z.enum(['Link', 'value', 'parent']),
            sourcePath: z.string(),
            line: z.number().int(),
          }),
        ),
        truncated: z.boolean(),
        shared: z.boolean(),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    toolHandler({ name: 'sc2_find_catalog_references', logger }, async (args) => {
      const index = await workspaces.getCatalogIndex(args.workspace_id);
      const all = index.findReferences(args.domain, args.id);
      const limit = args.limit ?? 50;
      const references = all.slice(0, limit);

      const distinctReferrers = new Set(all.map((reference) => reference.from));
      const shared = distinctReferrers.size > 1;

      const note = shared
        ? `${catalogKey(args.domain, args.id)} is referenced by ${distinctReferrers.size} distinct objects. Editing it changes behaviour for all of them; clone it first if you only mean to affect one.`
        : `${catalogKey(args.domain, args.id)} has ${distinctReferrers.size} distinct referrer(s) in this document. ${dependencyCaveat(index)}`;

      const lines = [
        `${all.length} reference(s) from ${distinctReferrers.size} object(s).`,
        ...references.map((reference) => `  ${reference.from}.${reference.fieldPath} (via ${reference.via}) — ${reference.sourcePath}:${reference.line}`),
        all.length > references.length ? `Showing the first ${limit}; raise "limit" for more.` : '',
        note,
      ].filter((line) => line !== '');

      return ok(lines.join('\n'), {
        total: all.length,
        references,
        truncated: all.length > references.length,
        shared,
        note,
      });
    }),
  );
}
