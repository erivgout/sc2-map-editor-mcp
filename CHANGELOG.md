# Changelog

This project is pre-release. Versions are not yet published; entries are grouped by the
build-plan phase they complete.

## Unreleased

### Added

- **Workspace staging** (PLAN.md Phase 2). `sc2_open_document` copies a document into a
  server-owned working tree; the source is never modified. Durable, revision-tracked
  workspaces survive client reconnects.
- **Path security** (§35). Allowed-roots enforcement with canonicalisation before
  containment checks, so symlinks cannot escape. Archive paths are rejected rather than
  sanitised.
- **Component inventory** (Phase 4). `ComponentList.SC2Components` and `DocumentInfo`,
  with each component resolved to the files it actually covers.
- **GameData catalogs** (Phases 6, 8). Search, inheritance resolution with per-value
  provenance, reference finding, and field-level mutation by addressable path.
- **Lossless XML editing and transactions** (Phases 7). Byte-range splicing that leaves
  untouched text identical; snapshot-before-write, all-or-nothing application with
  rollback, `dry_run`, unified diffs, and revert.
- **Localization** (Phase 10). Text tables with BOM and CRLF preserved, plus a
  missing-display-name report.
- **Galaxy scripts** (Phase 9). Parsing, symbols, syntax diagnostics, and guarded text
  patching via the vendored toolkit.
- **Triggers** (Phase 11). Structure and names, read-only apart from renaming.
- **Placed objects and regions** (Phase 15). Read, place/create, move, rename, rescale,
  and delete operations, validated by reopening the packed result in the Galaxy Editor.
- **Terrain descriptor** (Phase 16). Tile set, dimensions, cliff sets, and binary
  component headers are readable. Terrain bulk data remains inspection-only.
- **Packed MPQ documents** (Phase 3). The `sc2mpq` sidecar opens, verifies, extracts,
  repacks, and reopens `.SC2Map`, `.SC2Mod`, and `.SC2Campaign` archives. Real ladder
  maps round-trip byte-identically, and authored output loads in the Galaxy Editor.
- **Local dependencies** (Phase 6). Unpacked `.SC2Mod` directories are indexed as
  read-only dependency sources for inheritance, search, and reference analysis.
- **Validation and commit** (Phase 12). Per-category verdicts that distinguish "checked and
  clean" from "not checked"; commit with preflight, source-divergence detection, and
  backup.
- **High-level authoring** (Phases 14, §45). Unit-from-template and shared-object
  isolation, so changing one unit's weapon cannot silently change twenty others.
- **Editor integration** (Phase 13). Open a document in the Galaxy Editor; read its logs;
  locate the user's Maps folder through the registry.

### Known gaps

- **No Galaxy type checking.** Diagnostics are syntax-only; see
  [docs/galaxy.md](docs/galaxy.md).
- **No structural trigger editing.** Trigger names can be changed, but graph nodes and
  undocumented editor ids are not generated.
- **No SC2Layout support.** Layout files are not parsed or edited.
- **No terrain writing.** Height, texture, pathing, cliff, and water codecs are not
  implemented.
- **No stock CASC dependency loading.** Local unpacked mods load, but Blizzard's stock
  mods remain inside the installation's CASC store.
- **No automated in-game smoke test.** The server opens documents in the Galaxy Editor
  and reads its logs, but it does not claim an unverified test-map launch path.

Full detail: [docs/capabilities.md](docs/capabilities.md).

### Notable format findings

Recorded in [docs/sc2-formats.md](docs/sc2-formats.md), all verified against the
editor-produced map that ships with StarCraft II:

- In `ComponentList.SC2Components` the component path is the element's **text content**,
  not an attribute, and it is a logical name resolved inside the `*.SC2Data` layers.
- `Triggers`, `Objects`, `Regions`, `Attributes`, and `CustomAI` are **XML**, not the
  binary formats the plan anticipated.
- Four-character-code byte order is **not uniform**: `t3HeightMap` stores `HMAP` in file
  order while `MapInfo` stores `MapI` reversed.
- Text tables carry a UTF-8 BOM, and values contain `=`, so the key/value split is on the
  first one only.
- A weapon names its effect through `Effect value=`, not `Link=`.
