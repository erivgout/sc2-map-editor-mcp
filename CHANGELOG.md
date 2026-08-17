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
- **Placed objects, regions, terrain descriptor** (Phases 15–16). Read-only.
- **Validation and commit** (Phase 12). Per-category verdicts that distinguish "checked and
  clean" from "not checked"; commit with preflight, source-divergence detection, and
  backup.
- **High-level authoring** (Phases 14, §45). Unit-from-template and shared-object
  isolation, so changing one unit's weapon cannot silently change twenty others.
- **Editor integration** (Phase 13). Open a document in the Galaxy Editor; read its logs;
  locate the user's Maps folder through the registry.

### Known gaps

- **Packed `.SC2Map` archives cannot be opened.** The `sc2mpq` sidecar is written but has
  never been compiled — see [docs/native-helper.md](docs/native-helper.md).
- **No Galaxy type checking.** Syntax only; see [docs/galaxy.md](docs/galaxy.md).
- **No structural trigger editing**, and **no writing** of placed objects or terrain.
- **Dependency archives are not loaded**, so catalog results cover the open document only.

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
