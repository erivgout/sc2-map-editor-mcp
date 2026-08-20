# SC2 Map Editor MCP Server — Master Build Plan

> **Project goal:** Build a production-quality Model Context Protocol (MCP) server that lets Codex/ChatGPT/Claude inspect, edit, validate, pack, and test StarCraft II maps and mods without forcing the model to manually click through the Galaxy Editor.
>
> **Primary platform:** Windows 11 with a normal retail StarCraft II installation.
>
> **Primary implementation language:** TypeScript on Node.js 22+.
>
> **MCP target:** MCP specification `2026-07-28`, using the official TypeScript SDK v2.
>
> **Core principle:** Treat the SC2 Editor as a validator/test target and optional UI fallback, not as the main editing API. Prefer deterministic manipulation of SC2 document contents.

---

# 1. Definition of Done

The project is successful when an MCP-capable coding agent can perform workflows like these safely and repeatably:

1. Open a local `.SC2Map`, `.SC2Mod`, `.SC2Campaign`, or unpacked SC2 document.
2. Inspect its components, dependencies, GameData, Galaxy scripts, triggers, localization, layouts, map metadata, objects, regions, and eventually terrain.
3. Search for a unit/ability/effect/behavior/actor/etc. and understand its inherited values and references.
4. Modify existing GameData objects.
5. Create new GameData objects and wire their references correctly.
6. Read, modify, and validate Galaxy code.
7. Read and eventually modify GUI trigger data.
8. Read and modify localization/string tables.
9. Import or replace map-local assets safely.
10. Validate the document before writing a final result.
11. Repack a staged document to a new `.SC2Map`/`.SC2Mod` without corrupting it.
12. Launch the StarCraft II Editor or test the map when a local installation is available.
13. Capture useful diagnostics from the toolchain/test cycle and return them to the calling model.
14. Make all mutations auditable, diffable, revertible, and safe by default.
15. Eventually expose higher-level authoring tools such as “clone this unit and give it a new weapon” without requiring the model to hand-edit a large XML graph.

The first usable release does **not** need complete terrain authoring. A strong v1 should make Galaxy, GameData, localization, component inspection, validation, safe pack/unpack, and local test workflows excellent.

---

# 2. Research Baseline / Sources

Treat the following as the starting reference set. Pin versions/commits during implementation instead of blindly following `main`.

## MCP

- MCP 2026-07-28 specification:
  - https://modelcontextprotocol.io/specification/2026-07-28
- MCP transports:
  - https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
- MCP tools:
  - https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- MCP resources:
  - https://modelcontextprotocol.io/specification/2026-07-28/server/resources
- Official TypeScript SDK:
  - https://github.com/modelcontextprotocol/typescript-sdk

As of this plan, SDK v2 uses split packages such as `@modelcontextprotocol/server` and targets the 2026-07-28 MCP spec.

## SC2 structured-data / language tooling

- Current SC2 Galaxy Toolkit:
  - https://github.com/sc2-arcade-watcher/sc2-galaxy-toolkit
- Its architecture includes:
  - `sc2-mod` — archive directory/workspace/dependency abstraction
  - `sc2-data` — GameData catalog parsing/model
  - `sc2-trigger` — trigger data model/XML parsing
  - `sc2-text` — localization / GameStrings
  - `sc2-galaxy-lang` — Galaxy parser/binder/type checker
  - `sc2-layout-lang` — SC2Layout language tooling
  - `sc2-xml` — XML parser
- The project currently describes itself as work in progress, so **wrap it behind our own adapter** and pin a commit.

Useful package manifests:
- https://raw.githubusercontent.com/sc2-arcade-watcher/sc2-galaxy-toolkit/main/packages/sc2-mod/package.json
- https://raw.githubusercontent.com/sc2-arcade-watcher/sc2-galaxy-toolkit/main/packages/sc2-data/package.json
- https://raw.githubusercontent.com/sc2-arcade-watcher/sc2-galaxy-toolkit/main/packages/sc2-trigger/package.json
- https://raw.githubusercontent.com/sc2-arcade-watcher/sc2-galaxy-toolkit/main/packages/sc2-galaxy-lang/package.json

## SC2 archive and file formats

- StormLib:
  - https://github.com/ladislav-zezula/StormLib
- SC2 file-format documentation:
  - https://github.com/sc2-arcade-watcher/sc2-file-format-docs
- Current extracted SC2 GameData/UI/Galaxy reference:
  - https://github.com/sc2-arcade-watcher/sc2-game-data
- External map patching proof-of-concept using StormLib:
  - https://github.com/Vers-AI/sc2-aie-maps-patcher

The file-format documentation includes material for:
- SC2 archive/VFS behavior
- MPQ behavior
- `ComponentList.SC2Components`
- `DocumentInfo`
- `MapInfo`
- terrain descriptor/binary files
- painted pathing/creep layers
- terrain loading pipeline
- launcher/editor IPC research

**Important:** the SC2 file-format repository is reverse-engineered community documentation, not an official Blizzard specification. Every write-capable codec based on it must be validated against real editor-produced documents and round-trip tests.

## Official SC2 runtime/API reference

- Blizzard `s2client-proto`:
  - https://github.com/Blizzard/s2client-proto
- Protocol docs:
  - https://github.com/Blizzard/s2client-proto/blob/master/docs/protocol.md

Use this only where it is genuinely useful for automated runtime smoke tests. It is a gameplay/runtime API, not an editor API.

---

# 3. Non-Goals

Do **not** turn v1 into an everything-at-once automation project.

The following are explicitly not core-v1 goals:

- Automating Battle.net publishing.
- Circumventing Blizzard protections.
- Editing protected/encrypted content that the user is not authorized to modify.
- Botting multiplayer matches.
- Arbitrary keyboard/mouse automation across the desktop.
- Shipping Blizzard game assets or extracted base GameData in this repository.
- Depending on proprietary map data being committed into the repository.
- Fully replacing every Galaxy Editor UI module in the first release.
- Supporting remote untrusted users in the first release.

The server is a **local authoring tool** for maps/mods the user is working on.

---

# 4. Guiding Architecture

Use a layered design.

```text
MCP Client
(Codex / ChatGPT / Claude / IDE)
        |
        v
+------------------------------+
| MCP Protocol Layer           |
| - tools                      |
| - resources                  |
| - schemas                    |
| - structured errors          |
+------------------------------+
        |
        v
+------------------------------+
| Application / Domain Layer   |
| - workspace service          |
| - change transactions        |
| - GameData service           |
| - Galaxy service             |
| - Trigger service            |
| - Text/localization service  |
| - Layout service             |
| - Map metadata service       |
| - Asset service              |
| - validation service         |
| - test/launch service        |
+------------------------------+
        |
        v
+------------------------------+
| SC2 Adapters                 |
| - Galaxy Toolkit adapter     |
| - lossless XML editor        |
| - directory archive adapter  |
| - MPQ staging adapter        |
| - SC2 codecs                 |
| - process launcher adapter   |
| - optional s2client adapter  |
+------------------------------+
        |
        v
+------------------------------+
| Files / SC2 installation     |
| / StormLib helper / Editor   |
+------------------------------+
```

Do not place SC2 parsing logic directly inside MCP tool handlers. Tool handlers should validate input, call a domain service, and translate the result to MCP output.

---

# 5. Repository Layout

Recommended monorepo:

```text
sc2-map-editor-mcp/
├─ README.md
├─ PLAN.md
├─ LICENSE
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ eslint.config.mjs
├─ vitest.workspace.ts
│
├─ apps/
│  └─ sc2-mcp-server/
│     ├─ src/
│     │  ├─ main.ts
│     │  ├─ server.ts
│     │  ├─ config.ts
│     │  ├─ tools/
│     │  ├─ resources/
│     │  └─ mcp-errors.ts
│     └─ package.json
│
├─ packages/
│  ├─ sc2-core/
│  │  ├─ src/
│  │  │  ├─ workspace/
│  │  │  ├─ changes/
│  │  │  ├─ archive/
│  │  │  ├─ gamedata/
│  │  │  ├─ galaxy/
│  │  │  ├─ triggers/
│  │  │  ├─ text/
│  │  │  ├─ layout/
│  │  │  ├─ metadata/
│  │  │  ├─ assets/
│  │  │  ├─ objects/
│  │  │  ├─ terrain/
│  │  │  ├─ validation/
│  │  │  └─ testing/
│  │  └─ package.json
│  │
│  ├─ sc2-toolkit-adapter/
│  ├─ sc2-lossless-xml/
│  ├─ sc2-codecs/
│  ├─ sc2-process/
│  └─ sc2-test-utils/
│
├─ native/
│  └─ sc2mpq/
│     ├─ CMakeLists.txt
│     ├─ src/
│     └─ tests/
│
├─ vendor/
│  └─ sc2-galaxy-toolkit/
│
├─ fixtures/
│  ├─ generated/
│  ├─ minimal-map/
│  └─ README.md
│
├─ scripts/
│  ├─ bootstrap.ps1
│  ├─ build-native.ps1
│  ├─ test-e2e.ps1
│  └─ inspect-installation.ts
│
├─ docs/
│  ├─ architecture.md
│  ├─ tool-contracts.md
│  ├─ sc2-formats.md
│  ├─ testing.md
│  ├─ security.md
│  └─ adr/
│
└─ .github/
   └─ workflows/
```

---

# 6. Technology Choices

## Required

- Node.js 22+
- TypeScript
- pnpm
- ESM
- official `@modelcontextprotocol/server` v2 SDK
- Zod v4 or another Standard Schema implementation; prefer Zod v4
- Vitest
- ESLint
- Prettier only if desired; do not reformat user SC2 content with it
- `execa` or equivalent safe child-process wrapper
- `chokidar` only if filesystem watch/subscription support is implemented

## SC2-specific

- Pinned `sc2-galaxy-toolkit` worktree/submodule for parsing/semantic analysis
- StormLib for packed MPQ read/write
- A small native `sc2mpq` helper executable rather than direct Node FFI for the first release

## Why the native helper is preferred

Avoid making the entire MCP process depend on fragile Node native FFI bindings.

Expose a narrow CLI:

```text
sc2mpq info <archive>
sc2mpq list <archive> --json
sc2mpq extract <archive> <directory>
sc2mpq pack <directory> <output> --json
sc2mpq verify <archive> --json
```

The TypeScript layer invokes it with an argument array, never through `cmd.exe /c` string concatenation.

Later, if performance matters, the helper can become an N-API addon without changing the domain layer.

---

# 7. Dependency Strategy for `sc2-galaxy-toolkit`

Do not couple the MCP directly to the toolkit's internal files.

## Step 1

Pin a known-good commit in `vendor/sc2-galaxy-toolkit`.

Because its packages currently use `workspace:*` dependencies, the simplest development approach is to make the vendored toolkit packages part of the root pnpm workspace.

## Step 2

Create `packages/sc2-toolkit-adapter`.

Everything outside this package talks to our own stable interfaces such as:

```ts
interface GalaxyAnalyzer {
  parse(file: TextDocumentInput): GalaxyParseResult;
  getDiagnostics(file: TextDocumentInput): Diagnostic[];
  getSymbols(file: TextDocumentInput): SymbolSummary[];
  findReferences(symbol: SymbolLocator): ReferenceLocation[];
}

interface GameDataIndex {
  load(workspace: WorkspaceSnapshot): Promise<void>;
  search(query: CatalogSearchQuery): CatalogObjectSummary[];
  get(domain: string, id: string): CatalogObject | null;
  resolveInheritance(domain: string, id: string): ResolvedCatalogObject;
  findReferences(locator: CatalogLocator): CatalogReference[];
}
```

If toolkit APIs change, only the adapter should need significant updates.

## Step 3

At startup report:

- toolkit commit hash
- MCP SDK version
- native MPQ helper version
- detected SC2 installation/build if available

---

# 8. SC2 Document Model

Represent a working document with a durable workspace ID.

```ts
interface SC2WorkspaceDescriptor {
  id: string;
  sourcePath: string;
  sourceKind: "directory" | "mpq";
  documentKind: "map" | "mod" | "campaign" | "unknown";
  stagingPath: string;
  sourceHash: string;
  revision: number;
  dirty: boolean;
  createdAt: string;
  lastAccessedAt: string;
}
```

Do not rely on MCP connection/session state.

A request that mutates a document must include `workspace_id`.

Workspace state must be stored on disk in a server-owned directory so that it survives a client reconnect and remains compatible with MCP's newer stateless request model.

Suggested layout:

```text
%LOCALAPPDATA%/sc2-map-editor-mcp/
├─ config.json
├─ workspaces/
│  └─ <workspace-id>/
│     ├─ state.json
│     ├─ source/
│     ├─ working/
│     ├─ snapshots/
│     ├─ changes/
│     └─ logs/
└─ cache/
```

---

# 9. Packed Map Safety Model

Never edit a packed `.SC2Map` or `.SC2Mod` in place by default.

## Open flow for MPQ input

1. Resolve and validate the source path.
2. Hash the source file.
3. Create a server-owned workspace.
4. Extract the MPQ into `working/`.
5. Store the original hash and metadata.
6. Parse from `working/`.
7. Mutations affect only `working/`.

## Commit flow

1. Revalidate all dirty components.
2. Ensure original source hash still matches unless the caller explicitly allows divergence.
3. Repack `working/` to a temporary output.
4. Verify the new archive can be opened.
5. Verify required files/components exist.
6. Optionally launch the editor/game for a smoke test.
7. Atomically rename the temporary output to the requested destination.
8. Never overwrite the source unless the caller explicitly requested it.
9. If overwrite is requested, create a timestamped backup first.

## Directory source

For directory-mode SC2 documents, use the same staging model by default.

Later an advanced config may allow `direct_write=true`, but it should not be the default.

---

# 10. Native MPQ Helper Requirements

Implement `native/sc2mpq` early.

## Commands

### `info`

Return JSON:

```json
{
  "ok": true,
  "archiveVersion": 0,
  "fileCount": 143,
  "hasUserData": false,
  "sectorSize": 16777216
}
```

### `list`

Return normalized archive paths using `/` in JSON even if MPQ internals use `\`.

### `extract`

Must:

- reject path traversal
- reject absolute archive paths
- reject extraction outside the destination
- create parent directories safely
- return a manifest with hashes/sizes
- report files it could not extract

### `pack`

Must:

- sort file paths deterministically
- normalize archive path separators
- choose SC2-compatible compression settings
- support configurable sector size
- never silently skip a file
- return a manifest

Use the external patcher's successful 16 MB sector-size approach as an initial reference, but validate against maps produced by the current editor.

### `verify`

Must:

- reopen the archive
- enumerate files
- read representative files
- compare expected manifest
- return structured diagnostics

## Round-trip validation

Take multiple self-authored maps created by the editor.

For each:

1. extract
2. repack with no changes
3. verify archive
4. open in Galaxy Editor
5. test map
6. compare logical contents

Do not declare MPQ write support complete until this works across multiple maps and mods.

---

# 11. Component Discovery

Parse `ComponentList.SC2Components` when present.

Known component categories include, among others:

- GameData
- localized text
- DocumentInfo
- MapInfo
- Triggers
- terrain descriptor
- placed objects
- regions
- UI layout index
- cutscenes
- custom AI

Do not assume every document contains every component.

Expose a normalized structure:

```ts
interface ComponentDescriptor {
  typeCode: string;
  path: string;
  locale?: string;
  exists: boolean;
  writable: boolean;
  parser: string | null;
  diagnostics: Diagnostic[];
}
```

A tool must never claim to support writing a component just because it can read the file.

---

# 12. Lossless Writing Is a Requirement

Parsing and writing are separate concerns.

A semantic parser that can understand GameData is not automatically a safe serializer.

## Requirements for editable XML

Preserve whenever possible:

- XML declaration
- encoding declaration
- comments
- element order
- attribute order where practical
- whitespace/newline convention
- unrelated unknown elements/attributes
- custom editor data the MCP does not understand

## Strategy

Build `sc2-lossless-xml`.

Preferred approach:

1. parse a concrete syntax tree or token stream with byte/character spans
2. make targeted replacements
3. leave untouched text byte-for-byte unchanged
4. only use canonical serialization for newly created nodes/files

If the toolkit XML parser exposes reliable spans, reuse them.

If it does not, implement a small lossless XML edit layer instead of reserializing entire GameData files through a generic JavaScript object conversion.

## Why this matters

The MCP should produce small, reviewable diffs and must not destroy data it does not understand.

---

# 13. Change / Transaction System

Every mutating tool must use the same change engine.

## Common mutation arguments

```ts
{
  workspace_id: string,
  expected_revision?: number,
  dry_run?: boolean
}
```

## Common mutation result

```ts
{
  change_id: string,
  revision_before: number,
  revision_after: number,
  dry_run: boolean,
  files_changed: [
    {
      path: string,
      before_hash: string,
      after_hash: string
    }
  ],
  summary: string[],
  diagnostics: Diagnostic[],
  requires_repack: boolean
}
```

## Required functionality

- snapshot before first mutation in a transaction
- apply atomic file changes
- rollback if any operation fails
- human-readable change summary
- unified diff for text
- structured semantic diff for catalog objects
- optimistic concurrency via `expected_revision`
- workspace revision increments after successful mutation
- `dry_run` returns the proposed diff without changing `working/`

## Tools

- `sc2_get_changes`
- `sc2_diff_workspace`
- `sc2_revert_change`
- `sc2_create_snapshot`
- `sc2_restore_snapshot`
- `sc2_discard_workspace`

---

# 14. MCP Server Design

## Transport

### v1

Implement stdio first.

It is the simplest and most useful transport for local coding agents.

### later

Add Streamable HTTP only after local stdio is stable.

Remote mode introduces authentication, path exposure, and security issues that are unnecessary for the first release.

## Tool naming

Use stable snake_case names with an `sc2_` prefix.

Example:

```text
sc2_open_document
sc2_get_document_summary
sc2_search_catalog
sc2_get_catalog_object
sc2_patch_catalog_object
sc2_validate_document
```

## Tool schemas

- Strict schemas.
- Enumerations where possible.
- Do not accept arbitrary shell strings.
- Return structured content in addition to concise text.
- Keep output deterministic.
- Use pagination for large result sets.

## Tool annotations

Mark tools read-only vs mutating/destructive according to the current MCP SDK/spec capabilities.

Do not call a tool “read only” if it creates workspace files or modifies the user document.

---

# 15. MCP Resources

Use resources for contextual data that an agent may want to read repeatedly.

Proposed URIs:

```text
sc2://workspace/<id>/summary
sc2://workspace/<id>/components
sc2://workspace/<id>/dependencies
sc2://workspace/<id>/diagnostics
sc2://workspace/<id>/changes

sc2://workspace/<id>/catalog/<domain>/<object-id>
sc2://workspace/<id>/galaxy/<path>
sc2://workspace/<id>/text/<locale>/<table>
sc2://workspace/<id>/layout/<path>
```

Support resource templates rather than registering tens of thousands of fixed resources.

Later add resource subscriptions for:

- diagnostics changed
- workspace changed
- Galaxy file changed

---

# 16. Core Tool Catalog

Do not implement every tool on day one. Register tools only when their backend is trustworthy.

## A. Environment / installation

### `sc2_get_server_info`

Returns:

- server version
- MCP protocol target
- toolkit commit
- MPQ helper version
- enabled capabilities

### `sc2_detect_installations`

Search configured paths and conservative known locations.

Do not scan the entire disk.

Return candidates rather than silently selecting one when ambiguous.

### `sc2_set_runtime_config`

Prefer config file/CLI flags for v1 rather than mutation through MCP unless needed.

---

## B. Workspace / document

### `sc2_open_document`

Inputs:

- source path
- optional document kind
- optional read-only mode

Outputs:

- workspace ID
- detected kind
- component summary
- initial diagnostics

### `sc2_get_document_summary`

Return:

- kind
- components
- dependencies
- locales
- catalog counts
- Galaxy scripts
- dirty state
- revision
- source/staging info

### `sc2_list_components`

### `sc2_list_files`

Paginated.

### `sc2_read_file`

Restrict to files inside the workspace.

Text by default; binary only with explicit size limits.

### `sc2_search_files`

Search filenames and text.

### `sc2_commit_document`

Inputs:

- workspace ID
- output path
- overwrite flag default false
- run validation default true
- run smoke test optional

### `sc2_discard_workspace`

---

# 17. GameData Support

This is one of the highest-priority parts of the project.

## Goal

Give the model a semantic Data Editor API rather than forcing it to guess XML links.

## Domains

Support catalog domains discovered by the toolkit/data files, including typical categories such as:

- Unit
- Actor
- Ability
- Effect
- Behavior
- Weapon
- Upgrade
- Button
- Requirement
- Validator
- Model
- Sound
- Turret
- Mover
- TargetFind
- Footprint
- Race
- User
- and all other domains found in the actual schema/catalog set

Do not hardcode the above as the complete list.

## Read tools

### `sc2_list_catalog_domains`

### `sc2_search_catalog`

Inputs:

```json
{
  "workspace_id": "...",
  "query": "marine",
  "domains": ["Unit", "Actor"],
  "limit": 50
}
```

### `sc2_get_catalog_object`

Support:

- raw XML representation
- parsed semantic representation
- resolved inherited view

### `sc2_resolve_catalog_object`

Return:

- object
- parent chain
- final resolved values
- source location of each final value if possible

### `sc2_find_catalog_references`

Critical tool.

Given `(domain,id)`, return all known references to it across:

- GameData
- Galaxy where resolvable
- triggers where resolvable
- layouts/text where appropriate

### `sc2_get_catalog_reference_graph`

Bound depth and result count.

Return nodes/edges suitable for model reasoning.

---

# 18. GameData Mutation API

Begin with generic deterministic primitives.

## `sc2_clone_catalog_object`

Inputs:

- source domain
- source ID
- new ID
- optional new parent
- optional text-name mapping

## `sc2_create_catalog_object`

Require an explicit domain and ID.

Prefer parent/template-based creation rather than generating giant full objects.

## `sc2_patch_catalog_object`

Use structured patch operations.

Example:

```json
{
  "workspace_id": "...",
  "domain": "Unit",
  "id": "MyMarine",
  "patches": [
    { "op": "set", "path": "LifeMax", "value": "125" },
    { "op": "set", "path": "LifeStart", "value": "125" }
  ],
  "dry_run": true
}
```

Patch operations must be SC2-aware.

Possible ops:

- `set`
- `remove`
- `insert`
- `append`
- `replace`
- `clear_array_index`
- `set_array_index`

Do not expose XPath as the primary public API.

## `sc2_delete_catalog_object`

Implement late.

Before deletion:

- find references
- refuse if references remain unless `force=true`
- return all broken references in dry-run

---

# 19. High-Level GameData Authoring Tools

Add only after low-level catalog mutation is stable.

These tools are the feature that will eventually make the MCP dramatically easier for agents to use.

Examples:

### `sc2_create_unit_from_template`

Inputs:

- base unit
- new ID
- display name
- optional actor clone
- optional button/icon
- optional stat overrides

### `sc2_create_weapon_bundle`

Can create/wire:

- Weapon
- launch effect
- damage effect
- optional search effect
- actor events if requested

### `sc2_create_ability_bundle`

### `sc2_create_upgrade_bundle`

### `sc2_attach_weapon_to_unit`

### `sc2_attach_ability_to_unit`

### `sc2_create_buff_behavior`

### `sc2_create_damage_effect`

These should internally call the same transaction engine and produce a dependency graph of what they created.

Never hide magic IDs. Return every created/modified object.

---

# 20. Galaxy Script Support

Use `sc2-galaxy-lang` through the adapter.

## Read tools

### `sc2_list_galaxy_files`

### `sc2_get_galaxy_file`

### `sc2_get_galaxy_symbols`

### `sc2_get_galaxy_symbol`

### `sc2_find_galaxy_references`

### `sc2_get_galaxy_diagnostics`

### `sc2_search_galaxy`

## Mutation tools

### `sc2_apply_galaxy_patch`

Prefer explicit text edits or diff patches with context checks.

### `sc2_replace_galaxy_symbol`

Only implement when symbol resolution is reliable.

### `sc2_rename_galaxy_symbol`

Must:

- resolve symbol
- find references
- preview changes
- apply atomically
- rerun diagnostics

### `sc2_create_galaxy_file`

### `sc2_delete_galaxy_file`

Late/destructive.

## Validation

After every Galaxy mutation:

1. parse
2. bind
3. type-check
4. report diagnostics
5. block commit on severe diagnostics unless force is explicitly requested

---

# 21. Trigger Support

Triggers are harder to write safely than plain Galaxy.

Start read-only.

## v1 read tools

- `sc2_list_triggers`
- `sc2_get_trigger`
- `sc2_search_triggers`
- `sc2_get_trigger_generated_symbols`
- `sc2_get_trigger_diagnostics`

Expose trigger hierarchy:

```text
library
folder
trigger
function
event
condition
action
variable
parameter
```

Use toolkit trigger parsing where possible.

## Mutation sequence

### Stage 1

Safe metadata changes:

- rename trigger
- enable/disable trigger
- change comments/descriptions if format support is reliable

### Stage 2

Clone known trigger structures.

### Stage 3

Create trigger actions/events using schema-aware builders.

### Stage 4

Full GUI-trigger authoring.

For any trigger mutation, load the result in the editor during integration tests.

Do not generate trigger XML by guessing undocumented IDs.

---

# 22. Localization / Text

Implement early because it is comparatively low risk and important for authored content.

Likely tables include GameStrings and related localized data.

## Tools

- `sc2_list_locales`
- `sc2_list_text_tables`
- `sc2_search_text_keys`
- `sc2_get_text_value`
- `sc2_set_text_value`
- `sc2_delete_text_key`
- `sc2_copy_text_key`
- `sc2_find_missing_localization`

## Requirements

Preserve:

- newline convention
- BOM/encoding where present
- duplicate handling semantics
- comments/unknown lines if present

High-level tools that create catalog objects should optionally create/update text keys in the same transaction.

---

# 23. SC2Layout / UI

Use `sc2-layout-lang` where possible.

Start with:

- list layout files
- read file
- diagnostics
- search frame/template definitions
- find references

Then add targeted XML mutation.

Tools:

- `sc2_list_layouts`
- `sc2_get_layout`
- `sc2_get_layout_diagnostics`
- `sc2_search_layouts`
- `sc2_apply_layout_patch`

Do not attempt a WYSIWYG UI designer inside the MCP.

---

# 24. Map Metadata

Implement read support for:

- `DocumentInfo`
- `MapInfo`
- dependencies
- map dimensions
- player/team data where codec support is validated
- author/publish metadata where appropriate

Tools:

- `sc2_get_document_info`
- `sc2_get_map_info`
- `sc2_get_dependencies`

Mutation should begin with XML-based `DocumentInfo`.

Binary `MapInfo` writes require:

1. a validated codec
2. version-gate preservation
3. no-op byte-identical or semantically equivalent round trips
4. tests across several editor versions/maps

---

# 25. Dependencies

Dependency resolution is essential for understanding inherited GameData.

Use `sc2-mod` where possible.

Expose:

### `sc2_get_dependencies`

Return ordered dependency chain.

### `sc2_explain_dependency_resolution`

Given a catalog object or file path, explain which archive supplies the winning value.

### `sc2_find_shadowed_object`

Show whether an object exists in multiple dependency layers.

Do not automatically modify installed Blizzard dependency archives.

Only mutate the open map/mod workspace.

---

# 26. Assets

v1 asset handling:

- list map-local assets
- inspect path/size/hash
- import asset
- replace asset
- remove unused map-local asset only after reference analysis
- copy an asset within the document

Tools:

- `sc2_list_assets`
- `sc2_import_asset`
- `sc2_replace_asset`
- `sc2_find_asset_references`

Security:

- max size
- extension allow/deny rules
- path normalization
- no executable launch
- no arbitrary writes outside workspace

Do not bundle Blizzard assets.

---

# 27. Placed Objects / Regions / Cameras / Points

Treat this as a post-v1 capability unless a reliable codec is available sooner.

First research the actual `Objects`, `Regions`, and related formats from real maps.

Required sequence:

1. corpus of self-authored maps with controlled changes
2. binary/XML diffing
3. find existing format docs/codecs
4. read-only parser
5. no-op round-trip
6. single-object edit
7. editor open/test
8. generalize

Planned tools:

- `sc2_list_placed_units`
- `sc2_get_placed_unit`
- `sc2_list_doodads`
- `sc2_list_points`
- `sc2_list_regions`
- `sc2_list_cameras`
- `sc2_place_unit`
- `sc2_move_object`
- `sc2_delete_placed_object`
- `sc2_create_region`

Do not implement write calls until the corresponding codec passes editor round-trip tests.

---

# 28. Terrain Roadmap

Terrain is a separate subsystem, not “just another XML file.”

Current reverse-engineered documentation covers multiple files including:

- `t3Terrain.xml`
- `t3HeightMap`
- `t3Water`
- `t3CellFlags`
- `t3TextureMasks`
- sync height/cliff/texture data
- painted pathing
- painted creep
- additional terrain structures

Build it in stages.

## Terrain Phase A — inspection

Tools:

- `sc2_get_terrain_summary`
- `sc2_get_terrain_bounds`
- `sc2_sample_height`
- `sc2_get_texture_set`
- `sc2_get_cliff_summary`

No writes.

## Terrain Phase B — codecs

For each binary component:

- parser
- encoder
- version gates
- exact/no-op round trip tests
- fuzz/property tests for bounds
- corrupted input tests

## Terrain Phase C — primitive edits

- set height cell
- apply bounded height brush
- modify texture mask
- modify painted pathing
- add/remove water only when codec is proven

## Terrain Phase D — higher-level authoring

- raise/lower/smooth brush
- paint texture
- paint pathing
- create ramps/cliffs
- procedural terrain operations

## Terrain Phase E — procedural map generation

Only after all low-level invariants are understood.

A procedural generator must produce data the current Galaxy Editor can open and save again.

---

# 29. SC2 Editor Integration

The MCP should work without UI automation for core editing.

Still provide editor integration for validation and user convenience.

## Installation discovery

Prefer:

1. explicit config
2. environment variable
3. conservative known installation locations
4. optional platform-specific discovery

Do not hardcode a single executable path.

## Tools

### `sc2_launch_editor`

Inputs:

- workspace/document path
- optional read-only intent

Return process metadata.

### `sc2_test_document`

This tool should use the most reliable supported launch/test mechanism discovered during implementation.

Do not promise automatic test launching until empirically verified on the current editor/client.

### `sc2_get_last_test_log`

Return captured server-side launch/log information and any parsable SC2 diagnostics.

## UI automation fallback

If a feature cannot be performed through file manipulation and there is a compelling reason to automate the editor UI, implement a separate optional Windows adapter.

Rules:

- disabled by default
- capability clearly reported
- no coordinate-only click macros
- prefer UI Automation accessibility selectors
- bounded to the Galaxy Editor process
- never used for core GameData/Galaxy editing when direct file manipulation works

---

# 30. Runtime Smoke Testing with Blizzard SC2 API

Optional but useful.

The Blizzard `s2client-proto` API can create games with local map data and expose observations.

Potential v2 test:

```text
sc2_runtime_smoke_test
```

Possible checks:

- map launches
- game reaches active status
- expected test marker unit exists
- trigger test signal occurs
- no immediate fatal launch error

Do not use this as a replacement for editor validation.

Custom dependency behavior must be tested carefully.

---

# 31. Validation Framework

One top-level validator should aggregate specialized validators.

## `sc2_validate_document`

Return:

```json
{
  "valid": false,
  "errors": [],
  "warnings": [],
  "checks": {
    "archive": "...",
    "components": "...",
    "xml": "...",
    "gamedata": "...",
    "galaxy": "...",
    "triggers": "...",
    "localization": "...",
    "references": "...",
    "terrain": "passed"
  }
}
```

## Validation categories

### Archive

- required files exist
- no duplicate illegal paths
- archive readable

### Components

- ComponentList references exist
- known components parse

### XML

- well formed
- lossless editor can reopen

### GameData

- duplicate IDs
- missing parent where required
- broken references
- invalid domain references where inferable
- array index conflicts

### Galaxy

- parse errors
- bind/type errors
- missing includes where resolvable

### Trigger

- parser diagnostics
- missing string refs
- generated symbol inconsistencies where detectable

### Localization

- missing keys
- references to absent text
- locale mismatch warnings

### Assets

- missing referenced map-local files
- illegal paths

### Terrain

- version/magic checks
- dimension consistency
- array bounds
- sync data consistency where understood

---

# 32. Reference Graph

Build a reusable graph/index service.

Nodes:

- catalog objects
- Galaxy symbols
- trigger elements
- text keys
- assets
- layout nodes
- placed objects

Edges:

- parent
- field reference
- text reference
- asset reference
- Galaxy reference
- trigger-generated reference

This enables:

- “what uses this?”
- safe delete
- clone assistance
- rename assistance
- impact analysis
- unused object detection

Do not block the first read-only MVP on a perfect graph. Start with GameData parent/reference edges and expand.

---

# 33. Search

Provide one cross-domain search tool eventually:

### `sc2_search`

Inputs:

```json
{
  "workspace_id": "...",
  "query": "stimpack",
  "types": ["catalog", "galaxy", "trigger", "text", "layout"],
  "limit": 100
}
```

Return typed results with source locations.

Use domain-specific search indexes internally.

---

# 34. Error Model

Create stable domain errors.

Examples:

```text
SC2_WORKSPACE_NOT_FOUND
SC2_SOURCE_CHANGED
SC2_UNSUPPORTED_COMPONENT
SC2_PARSE_ERROR
SC2_VALIDATION_FAILED
SC2_BROKEN_REFERENCE
SC2_CONFLICT
SC2_PACK_FAILED
SC2_EDITOR_NOT_FOUND
SC2_TEST_LAUNCH_FAILED
SC2_PATH_DENIED
```

Every MCP tool error should include:

- machine-readable code
- human message
- relevant path/object ID
- recoverable boolean
- suggested next action when clear

Do not dump giant native stack traces to the model by default.

Store full logs separately.

---

# 35. Security Requirements

This is a local filesystem mutation server. Treat it seriously.

## Path security

- canonicalize all paths
- configurable allowed roots
- reject traversal
- reject symlink escapes
- do not let archive contents write outside staging
- never accept raw output paths without allowlist validation

## Process security

- no arbitrary shell command tool
- no `eval`
- no `cmd /c <user-string>`
- spawn known binaries with argument arrays
- editor/runtime paths must be validated executables
- environment inherited conservatively

## Mutation security

- staging by default
- dry-run support
- backups before overwrite
- atomic writes
- optimistic revisions
- validation before pack
- explicit `force` for dangerous deletes/invalid commits

## Resource limits

- maximum archive size configurable
- maximum extracted file count
- maximum individual file size
- bounded search result counts
- bounded reference graph depth
- timeouts for external processes
- cancellation support where MCP/client allows it

---

# 36. Logging

Structured logging only.

Log:

- request/tool name
- workspace ID
- duration
- change ID
- validation counts
- process exit code

Do not log:

- entire map files
- giant Galaxy scripts
- binary blobs
- unnecessary personal paths in telemetry

No telemetry in v1 unless explicitly added and opt-in.

---

# 37. Test Strategy

Testing is not optional.

## Unit tests

For:

- path guards
- workspace state
- change engine
- XML patching
- localization parser/writer
- catalog patch operations
- reference graph
- Galaxy adapter
- codecs
- MCP schemas

## Property / round-trip tests

Especially for:

- lossless XML edits
- MPQ manifests
- binary codecs
- terrain

Required invariant:

```text
decode(encode(decode(bytes))) ~= decode(bytes)
```

For components that claim lossless support:

```text
encode(decode(bytes)) == bytes
```

when no mutation is made, except for explicitly documented normalization.

## Integration tests

Use self-authored or generated fixtures.

Do not commit copyrighted Blizzard base assets.

### Integration Test 1 — workspace

- open directory fixture
- list components
- read summary
- discard

### Integration Test 2 — packed map

- pack fixture
- open packed map
- extract
- inspect
- commit to second output
- reopen second output

### Integration Test 3 — GameData read

- locate known custom unit
- resolve parent
- find refs

### Integration Test 4 — GameData edit

- dry-run LifeMax change
- verify diff
- apply
- validate
- repack
- reopen

### Integration Test 5 — Galaxy

- introduce known parse error
- diagnostics detects it
- fix it
- diagnostics clears

### Integration Test 6 — localization

- set custom unit name
- read it back
- pack
- reopen

### Integration Test 7 — transaction rollback

- create multi-file mutation
- force second write to fail
- verify no partial changes remain

### Integration Test 8 — editor

On a machine with SC2 Editor:

- create output
- launch/open
- record successful load

### Integration Test 9 — end-to-end custom unit

Eventually:

1. clone unit
2. clone/attach actor
3. add localization
4. change stats
5. validate refs
6. pack
7. open editor/test

---

# 38. Fixture Strategy

Create a tiny self-authored test map in the Galaxy Editor specifically for this project.

It should contain:

- one custom unit
- one custom ability
- one custom effect
- one behavior
- one trigger
- one custom Galaxy file
- one localization key
- one basic UI layout override if practical
- a few placed objects
- small simple terrain

Document exactly how the fixture was created.

If licensing/distribution is uncertain, do not commit the packed map. Instead include a script/instructions that generates the minimal directory fixture from project-authored content and use a user-local editor-produced test map for full integration.

---

# 39. CI

CI should run everything that does not require StarCraft II.

On Windows:

- TypeScript build
- lint
- unit tests
- native helper build
- generated fixture MPQ round-trip tests

On Linux if practical:

- TypeScript build/tests
- StormLib helper tests

Editor/runtime tests are local/manual or self-hosted CI only.

Never make public CI depend on a StarCraft II installation.

---

# 40. Versioning

Version separately:

- MCP server
- internal workspace state schema
- native MPQ helper protocol
- binary codecs

Store versions in workspace state.

If workspace state becomes incompatible, fail with a migration message rather than corrupting it.

---

# 41. Capability Reporting

Implement a machine-readable capabilities object.

Example:

```json
{
  "workspace": { "read": true, "write": true },
  "components": { "read": true, "write": true },
  "mpq": { "read": true, "write": true },
  "gamedata": { "read": true, "write": true, "inheritance": true },
  "galaxy": { "read": true, "write": true, "typecheck": false },
  "triggers": { "read": true, "write": true },
  "localization": { "read": true, "write": true },
  "layout": { "read": true, "write": true },
  "objects": { "read": true, "write": true },
  "terrain": { "read": true, "write": true },
  "editorLaunch": true,
  "runtimeSmokeTest": true
}
```

Tools whose required backend is unavailable should not be falsely advertised as working.

---

# 42. Recommended Implementation Phases

---

## Phase 0 — Research and spikes

### Tasks

- [ ] Clone/pin current MCP TypeScript SDK version.
- [ ] Clone/pin `sc2-galaxy-toolkit`.
- [ ] Confirm Node/pnpm versions.
- [ ] Build toolkit packages locally.
- [ ] Create several self-authored SC2 test documents.
- [ ] Inspect packed vs directory structures.
- [ ] Confirm current editor can load a StormLib-repacked unchanged map.
- [ ] Document file-list differences.
- [ ] Determine reliable SC2 installation/editor discovery.
- [x] Determine reliable local test-map launch method.
- [ ] Record unsupported/unknown formats.

### Exit criteria

A short `docs/adr/0001-foundation.md` exists with verified choices.

No production MCP tools are needed yet.

---

## Phase 1 — MCP skeleton

### Tasks

- [ ] Create TypeScript monorepo.
- [ ] Add official MCP server SDK v2.
- [ ] Implement stdio server.
- [ ] Add `sc2_get_server_info`.
- [ ] Add logging/error wrapper.
- [ ] Add strict schemas.
- [ ] Add server smoke test.

### Exit criteria

An MCP client can launch the server over stdio and call one tool successfully.

---

## Phase 2 — Workspace and path security

### Tasks

- [ ] Configured allowed roots.
- [ ] Canonical path guard.
- [ ] Durable workspace store.
- [ ] Revision handling.
- [ ] Workspace cleanup policy.
- [ ] Directory source staging.
- [ ] `sc2_open_document`.
- [ ] `sc2_get_document_summary`.
- [ ] `sc2_discard_workspace`.

### Exit criteria

A directory document can be staged/read without any direct source modification.

---

## Phase 3 — MPQ support

### Tasks

- [ ] Build StormLib helper.
- [ ] list/info/extract commands.
- [ ] pack command.
- [ ] verify command.
- [ ] manifests/hashes.
- [ ] packed-source staging.
- [ ] commit-to-new-file flow.
- [ ] no-op round-trip tests.

### Exit criteria

Multiple self-authored `.SC2Map` and `.SC2Mod` files survive extract/repack and load in the editor.

---

## Phase 4 — Component and raw inspection

### Tasks

- [x] ComponentList parser and lossless declaration mutation.
- [ ] file listing.
- [ ] safe file reading.
- [ ] raw text search.
- [ ] DocumentInfo read.
- [ ] dependency summary.

### Exit criteria

The agent can meaningfully inventory a map before editing it.

---

## Phase 5 — Galaxy Toolkit adapter

### Tasks

- [ ] Adapter package.
- [ ] workspace integration.
- [ ] Galaxy parser.
- [ ] symbols.
- [ ] references.
- [ ] diagnostics.
- [ ] GameData parser/index.
- [ ] trigger parser.
- [ ] text parser.

### Exit criteria

All toolkit APIs are hidden behind our interfaces and covered by tests.

---

## Phase 6 — GameData read-only intelligence

### Tasks

- [ ] list domains.
- [ ] search objects.
- [ ] object details.
- [ ] parent/inheritance resolution.
- [ ] reference discovery.
- [ ] dependency source explanation.

### Exit criteria

The model can answer Data Editor questions about a map accurately without changing it.

---

## Phase 7 — Lossless write/change engine

### Tasks

- [ ] generic snapshot/rollback.
- [ ] dry-run.
- [ ] unified text diff.
- [ ] lossless XML editor.
- [ ] atomic writes.
- [ ] revision conflicts.
- [ ] change history tools.

### Exit criteria

A failed multi-file mutation cannot leave partial edits.

---

## Phase 8 — GameData mutation

### Tasks

- [ ] clone object.
- [ ] create object.
- [ ] patch fields.
- [ ] array operations.
- [ ] validation after edit.
- [ ] localization co-edit.
- [ ] reference-safe delete only when mature.

### Exit criteria

A custom unit's stats can be edited, packed, opened, and tested.

---

## Phase 9 — Galaxy mutation

### Tasks

- [ ] apply targeted patch.
- [ ] create file.
- [ ] rename symbol where safe.
- [ ] post-edit diagnostics.
- [ ] rollback invalid edits.

### Exit criteria

The model can implement nontrivial map logic and receive compiler-style diagnostics.

---

## Phase 10 — Localization and layout

### Tasks

- [x] text write tools.
- [x] locale validation.
- [x] layout read/diagnostics.
- [x] targeted layout mutation after lossless writer support.

### Exit criteria

New GameData objects can receive correct user-facing names/tooltips.

---

## Phase 11 — Trigger mutation

### Tasks

- [x] safe trigger metadata edits.
- [x] clone and delete complete editor-authored trigger subgraphs.
- [ ] schema-aware action/event builders.
- [x] editor validation corpus for cloned trigger graphs.

### Exit criteria

A simple GUI trigger can be created by MCP and opened successfully in the editor.

---

## Phase 12 — Validation and commit hardening

### Tasks

- [ ] aggregate validator.
- [ ] broken reference checks.
- [ ] commit preflight.
- [ ] pack verification.
- [ ] source hash conflict checks.
- [ ] backup/overwrite flow.

### Exit criteria

`sc2_commit_document` is safe enough for normal use.

---

## Phase 13 — Editor/test integration

### Tasks

- [x] detect install.
- [x] launch editor.
- [x] open staged/output document.
- [x] implement verified test-map workflow.
- [x] collect process/log diagnostics.
- [x] runtime smoke test through the installed client; no separate runtime API required.

### Exit criteria

The agent can make an edit and automatically drive a verify/test cycle without clicking through the Data Editor manually.

---

## Phase 14 — High-level authoring API

### Tasks

- [ ] unit-from-template builder.
- [ ] weapon bundle builder.
- [ ] ability builder.
- [ ] behavior builder.
- [ ] upgrade builder.
- [ ] automatic reference/text wiring.
- [ ] semantic diff summary.

### Exit criteria

A prompt such as “clone the Marine, give it 125 HP, rename it, and give it a 20-damage weapon” can be completed through a small number of high-level tool calls.

---

## Phase 15 — Objects / regions / cameras

### Tasks

- [ ] research/codec.
- [ ] read-only tools.
- [ ] no-op round trip.
- [ ] placement/move/delete.
- [ ] editor tests.

### Exit criteria

The model can place and move units/points/regions safely.

---

## Phase 16 — Terrain

### Tasks

- [x] read codecs.
- [x] write codecs.
- [x] height sampling.
- [ ] height brush.
- [x] texture masks.
- [x] painted pathing.
- [x] cliff-cell editing.
- [ ] high-level ramp authoring.
- [ ] semantic water-body authoring. Bounded validated raw access is available.
- [x] editor round-trip validation.
- [ ] procedural terrain utilities.

### Exit criteria

The model can perform controlled terrain edits and produce maps that the current editor can open/save/test.

---

## Phase 17 — Release quality

### Tasks

- [ ] installer/bootstrap.
- [ ] self-diagnostics command.
- [ ] configuration docs.
- [ ] MCP client setup examples.
- [ ] signed/reproducible native helper if distributing binaries.
- [ ] changelog.
- [ ] versioned releases.
- [ ] backup recovery docs.

---

# 43. MVP Tool Set

Do not wait for the entire plan before shipping a useful alpha.

The first genuinely useful MCP should have:

```text
sc2_get_server_info
sc2_detect_installations

sc2_open_document
sc2_get_document_summary
sc2_list_components
sc2_list_files
sc2_read_file
sc2_search_files
sc2_diff_workspace
sc2_discard_workspace

sc2_list_catalog_domains
sc2_search_catalog
sc2_get_catalog_object
sc2_resolve_catalog_object
sc2_find_catalog_references
sc2_clone_catalog_object
sc2_patch_catalog_object

sc2_list_galaxy_files
sc2_get_galaxy_file
sc2_get_galaxy_symbols
sc2_find_galaxy_references
sc2_get_galaxy_diagnostics
sc2_apply_galaxy_patch

sc2_list_locales
sc2_get_text_value
sc2_set_text_value

sc2_validate_document
sc2_commit_document
```

That alone would already make the MCP extremely useful.

---

# 44. Example Agent Workflow

User asks:

> Clone the Marine into `RailMarine`, give it 125 HP, a new display name, and change its weapon damage.

Expected tool flow:

```text
1. sc2_open_document
2. sc2_search_catalog(query="Marine")
3. sc2_get_catalog_object(Unit, Marine)
4. sc2_get_catalog_reference_graph(Unit, Marine)
5. sc2_clone_catalog_object(Unit, Marine -> RailMarine, dry_run=true)
6. sc2_clone_catalog_object(... apply)
7. sc2_patch_catalog_object(RailMarine LifeMax/LifeStart)
8. sc2_set_text_value(...)
9. sc2_get_catalog_object(Weapon, relevant weapon)
10. clone/patch weapon rather than editing the base shared weapon
11. attach cloned weapon to RailMarine
12. sc2_validate_document
13. sc2_diff_workspace
14. sc2_commit_document(output=RailMarineTest.SC2Map)
15. optional sc2_test_document
```

The MCP should help the agent avoid accidentally modifying the shared base Marine weapon used by other units.

---

# 45. Semantic Safety Rules for High-Level Tools

High-level authoring tools must understand shared references.

Example:

If an agent asks:

> Make this unit's weapon do 100 damage.

Do **not** blindly edit a weapon/effect object that is shared by 20 units.

The service should:

1. inspect reference count
2. warn if shared
3. by default clone the shared object chain needed for isolation
4. rewire only the target unit
5. return exactly what was cloned

Provide an explicit `modify_shared=true` escape hatch.

Apply the same policy to:

- effects
- behaviors
- actors
- buttons
- abilities
- upgrades
- validators

---

# 46. ID Generation

Never invent IDs without checking collisions.

Implement an ID service.

Rules:

- validate SC2-compatible identifier characters/length
- check entire effective dependency/catalog view
- deterministic suggestion from requested name
- suffix collision resolution
- return chosen ID before mutation in dry-run

Example:

```text
requested: Rail Marine
suggested: RailMarine
collision: true
final: RailMarine2
```

Let caller override.

---

# 47. Unknown Data Preservation

SC2 is old, complex, and extensible.

Rule:

> Unknown data must be preserved, not deleted.

If a parser does not understand a field/node/version:

- expose raw representation if safe
- mark semantic understanding partial
- block high-level destructive rewrite
- allow targeted text patch only when the caller explicitly chooses it

Never “clean up” unknown XML automatically.

---

# 48. Performance

Maps can be large.

## Indexing

- lazy-load large subsystems
- cache semantic indexes per workspace revision
- invalidate by changed file/domain
- avoid reparsing the entire map after a one-line change where possible

## Search

- pre-index catalog IDs/names
- pre-index Galaxy symbols
- use bounded results
- paginate

## Hashing

Use a fast modern hash for workspace manifests; cryptographic SHA-256 is fine if performance is adequate and simplicity is preferred.

Do not hash giant unchanged assets on every tool call.

---

# 49. Concurrency

Assume multiple model tool calls may overlap.

Implement a per-workspace mutation lock.

Reads may run concurrently when safe.

Mutations:

```text
acquire workspace lock
check expected revision
apply transaction
validate touched components
increment revision
release lock
```

A stale caller receives `SC2_CONFLICT`, not silent overwrites.

---

# 50. File Watching

Optional later feature.

If the user opens the staged directory in the editor or another text editor, the MCP may detect external changes.

On change:

- recalculate revision
- invalidate caches
- report workspace changed
- never overwrite externally changed content without conflict detection

Resource subscriptions can eventually notify supporting MCP clients.

---

# 51. Configuration

Example config:

```json
{
  "allowedRoots": [
    "C:\\Users\\USER\\Documents\\StarCraft II\\Maps",
    "D:\\SC2Projects"
  ],
  "workspaceRoot": "C:\\Users\\USER\\AppData\\Local\\sc2-map-editor-mcp",
  "sc2InstallPath": "C:\\Program Files (x86)\\StarCraft II",
  "mpqHelperPath": null,
  "defaultLocale": "enUS",
  "allowOverwrite": false,
  "maxArchiveBytes": 2147483648,
  "maxExtractedFiles": 50000,
  "maxSingleFileBytes": 268435456
}
```

Do not commit user-specific config.

---

# 52. CLI Diagnostics

In addition to MCP, ship a small CLI wrapper:

```text
sc2-mcp doctor
sc2-mcp inspect <map>
sc2-mcp validate <map>
sc2-mcp unpack <map> <dir>
sc2-mcp pack <dir> <map>
```

This is invaluable for debugging without an MCP client.

The CLI must call the same domain services as MCP, not duplicate implementation.

---

# 53. Documentation Required Before v1

- installation
- Codex MCP config example
- Claude Desktop/other MCP client example if desired
- allowed root setup
- how staging works
- how backups work
- supported component matrix
- known limitations
- how to run `doctor`
- how to recover a workspace
- how to report a map that fails round-trip

---

# 54. Suggested ADRs

Create architecture decision records as choices are verified.

Suggested:

```text
0001-typescript-and-mcp-sdk-v2.md
0002-staging-workspace-model.md
0003-stormlib-sidecar.md
0004-galaxy-toolkit-adapter.md
0005-lossless-xml-writing.md
0006-no-ui-automation-in-core.md
0007-reference-graph.md
0008-terrain-codec-strategy.md
```

---

# 55. Codex Working Rules

Codex should follow these rules while building the repository:

1. **Verify before assuming.** If an SC2 file format/API behavior is uncertain, create a spike/test against real self-authored editor output.
2. **Do not fake support.** A tool is not “implemented” until it can succeed on a real fixture and has tests.
3. **Do not silently normalize user data.**
4. **Never edit source packed maps in place during normal development.**
5. **Keep every write transactional.**
6. **Pin unstable dependencies.**
7. **Wrap third-party APIs.**
8. **Prefer direct file/data manipulation over UI automation.**
9. **Do not ship Blizzard copyrighted content.**
10. **Add tests with every new writable format.**
11. **Use current MCP SDK v2 APIs, not old pre-2026 examples copied from blog posts.**
12. **Keep stdio logs off stdout.** MCP protocol stdout must remain clean; send logs to stderr/files as appropriate.
13. **Run build, lint, and tests before marking a phase complete.**
14. **Update the supported-capabilities matrix whenever a subsystem changes.**
15. **Record discoveries about undocumented SC2 behavior in `docs/sc2-formats.md`.**
16. **Prefer small vertical slices that work end to end over huge untested scaffolding.**

---

# 56. First Vertical Slice Codex Should Build

After the Phase 0 research spike, build this exact end-to-end slice before expanding scope:

1. stdio MCP server starts
2. `sc2_open_document` accepts a directory fixture
3. component list is parsed
4. GameData index loads
5. `sc2_search_catalog` finds a custom unit
6. `sc2_get_catalog_object` returns semantic + raw info
7. `sc2_patch_catalog_object(... dry_run=true)` shows an exact diff
8. applying the patch updates only staging
9. `sc2_validate_document` passes
10. `sc2_diff_workspace` displays the change
11. `sc2_commit_document` creates a packed `.SC2Map`
12. packed map is verified by the MPQ helper
13. manually/automatically open it in the current Galaxy Editor
14. confirm the changed unit value appears correctly

Once this vertical slice works, the architectural risk is dramatically lower.

---

# 57. Second Vertical Slice

Add Galaxy editing:

1. load a custom Galaxy script
2. return symbols
3. apply a small code change
4. detect a deliberately introduced type/syntax error
5. rollback or fix it
6. validate
7. repack
8. test map

---

# 58. Third Vertical Slice

Add a semantic high-level edit:

> “Clone UnitA into UnitB, rename it, create a private weapon/effect chain, and change damage.”

This proves:

- catalog cloning
- reference graph
- shared-object safety
- multi-file transaction
- localization
- validation
- packing
- editor testing

That is the point where this project becomes much more than a raw file MCP.

---

# 59. Long-Term Vision

Once mature, the MCP should allow natural-language requests such as:

> Create a hero version of the Zealot with six abilities, levels 1–30, an equipment system, three upgrade branches, custom UI, and boss encounters.

The model should be able to decompose that into:

- GameData object creation
- Galaxy systems
- triggers
- localization
- UI layouts
- placed objects
- imported assets
- terrain/regions
- validation
- test cycles

without requiring the user to manually construct hundreds of links in the Galaxy Editor.

The way to reach that goal is **not** to start with a giant `create_game()` tool. Build reliable low-level primitives, reference-aware semantic operations, validation, and transactions first. Then compose high-level authoring tools on top.

---

# 60. Final Build Priority

If time/scope must be prioritized, use this order:

1. Safe workspace/staging
2. MPQ extract/repack
3. Component inventory
4. GameData read/intelligence
5. Lossless mutation engine
6. GameData write
7. Galaxy read/write/diagnostics
8. Localization
9. Validation/reference graph
10. Commit + editor/test workflow
11. High-level unit/weapon/ability builders
12. Trigger write
13. UI/layout write
14. placed objects/regions
15. terrain
16. procedural authoring
17. optional UI automation

This ordering produces a useful MCP early while preserving a path toward a near-complete SC2 Map Editor automation layer.
