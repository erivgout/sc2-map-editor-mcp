# SC2 Map Editor MCP

An MCP server that lets a coding agent inspect and edit StarCraft II maps and mods by
manipulating their file contents directly, instead of driving the Galaxy Editor UI.

**Status: pre-release.** Most of [PLAN.md](PLAN.md) is implemented, with the gaps stated
explicitly rather than glossed. Read [Current capabilities](#current-capabilities), or ask
a running server via `sc2_get_server_info` — that is the authoritative answer for a
particular build and machine.

## Current capabilities

The server reports this itself via `sc2_get_server_info` — that is the authoritative
answer for a running build. As of now:

| Subsystem | Read | Write | Notes |
|---|---|---|---|
| Workspace staging | ✅ | ✅ | Unpacked document directories only |
| Component inventory | ✅ | ❌ | `ComponentList`, `DocumentInfo`, dependencies — verified against real editor output |
| GameData catalogs | ✅ | ✅ | Search, inspect, resolve inheritance, find references, patch/clone/create/delete. Own document only — dependencies are not loaded |
| MPQ archives (`.SC2Map`, `.SC2Mod`) | ✅ | ✅ | Byte-identical round trips on real ladder maps, and maps packed here open in the editor — see [docs/native-helper.md](docs/native-helper.md) |
| Galaxy scripts | ✅ | ✅ | Parse, symbols, syntax diagnostics, safe text patching. **No type checking** — needs the game's natives. Requires the vendored toolkit to be built |
| Triggers | ✅ | ⚠️ | Structure, names, search. Renaming only — structural editing deliberately not implemented |
| Localization | ✅ | ✅ | Text tables, preserving BOM and CRLF exactly |
| SC2Layout | ❌ | ❌ | Phase 10 |
| Placed objects / regions | ✅ | ❌ | Both are XML, not binary. Read-only — writing needs an editor round-trip test |
| Terrain | ⚠️ | ❌ | Descriptor only (tile set, dimensions, cliff sets). Bulk data reported by magic/version/size, never decoded |
| Editor launch | ✅ | n/a | Opens a document in the Galaxy Editor; reads its logs. Automatic **test-map launching is not provided** — no reliable mechanism verified |

Why the gaps are where they are, and what "⚠️" means in each row:
[docs/capabilities.md](docs/capabilities.md).

Packed archives work end to end: an existing map opened from a `.SC2Map`, extended here,
repacked here, and opened in the Galaxy Editor loads as a real document, with the editor
resolving the added catalogs by name. Building the helper needs a C++ toolchain and the Windows SDK
(`scripts/build-native.ps1`); without it `capabilities.mpq` reports `false` and packed
archives are refused with a clear error.

**Dependencies: local ones load, Blizzard's do not.** A `.SC2Mod` directory beside your map
is indexed, and its objects become visible for inheritance and references - read-only, since
this server never modifies dependency archives. Blizzard's stock mods live inside the
installation's CASC store, which this build cannot read; they are reported as `in-casc`
rather than missing, because that is a very different thing from your map being broken.

### Tools

| Tool | Read-only | Purpose |
|---|---|---|
| `sc2_get_server_info` | yes | Versions, configuration, capability matrix, limitations |
| `sc2_detect_installations` | yes | Find StarCraft II without scanning the disk |
| `sc2_open_document` | no | Stage a document, get a `workspace_id` |
| `sc2_get_document_summary` | yes | Kind, counts, components, dependencies, diagnostics, known gaps |
| `sc2_list_workspaces` | yes | Recover a `workspace_id` after a reconnect |
| `sc2_list_components` | yes | Parse `ComponentList.SC2Components`; resolve each entry to real files |
| `sc2_get_document_info` | yes | Name, author, mod type, icon, screenshots, dependencies |
| `sc2_get_dependencies` | yes | Dependency chain in resolution order |
| `sc2_list_component_types` | yes | Reference table of component type codes |
| `sc2_list_catalog_domains` | yes | Catalog domains present, with entry counts |
| `sc2_search_catalog` | yes | Find catalog objects by id, filtered by domain |
| `sc2_get_catalog_object` | yes | One object's own declaration, plus verbatim XML |
| `sc2_resolve_catalog_object` | yes | Effective values with inheritance, and where each came from |
| `sc2_find_catalog_references` | yes | What refers to an object, and whether it is shared |
| `sc2_patch_catalog_object` | no | Field-level edits by path, with shared-object warnings |
| `sc2_clone_catalog_object` | no | Copy an object under a new id, byte-for-byte |
| `sc2_create_catalog_object` | no | Add a new object, ideally with a parent |
| `sc2_delete_catalog_object` | no | Remove an object; refuses while referenced |
| `sc2_list_locales` | yes | Locales and text tables present |
| `sc2_search_text_keys` | yes | Search a text table by key or value |
| `sc2_get_text_value` | yes | Read one localized string |
| `sc2_set_text_value` | no | Create or update localized strings |
| `sc2_delete_text_key` | no | Remove localized strings |
| `sc2_copy_text_key` | no | Copy strings between keys or locales |
| `sc2_find_missing_localization` | yes | Catalog objects with no display name |
| `sc2_launch_editor` | no | Open a document in the Galaxy Editor to confirm it loads |
| `sc2_get_editor_logs` | yes | List or read the editor's own logs |
| `sc2_get_user_maps` | yes | The user's Maps folder, resolved through the registry |
| `sc2_list_galaxy_files` | yes | Scripts in the document; flags the generated MapScript |
| `sc2_get_galaxy_file` | yes | Read a script, optionally by line range |
| `sc2_get_galaxy_symbols` | yes | Functions, variables, structs, includes |
| `sc2_get_galaxy_diagnostics` | yes | Syntax errors with line and column |
| `sc2_apply_galaxy_patch` | no | Exact-text edit, refused if it breaks the parse |
| `sc2_create_galaxy_file` | no | Add a library, syntax-checked first |
| `sc2_list_triggers` | yes | The trigger tree with names resolved |
| `sc2_get_trigger` | yes | One element: type, name, contents, referrers, raw XML |
| `sc2_search_triggers` | yes | Find trigger elements by name |
| `sc2_rename_trigger` | no | Rename an element (edits TriggerStrings only) |
| `sc2_list_placed_objects` | yes | Units, doodads, and points on the map |
| `sc2_list_regions` | yes | Regions with their shapes |
| `sc2_get_terrain_summary` | yes | Terrain descriptor plus binary component headers |
| `sc2_create_unit_from_template` | no | Clone a unit with a name, stats, and its own weapon |
| `sc2_set_unit_weapon_damage` | no | Change one unit's damage without touching units that share it |
| `sc2_isolate_shared_object` | no | Give one owner its own copy of something shared |
| `sc2_check_shared_object` | yes | Would editing this reach beyond one owner? |
| `sc2_validate_document` | yes | Every check this build has, per category, with unchecked ones named |
| `sc2_commit_document` | no | Write the staged document out, with backup and preflight |
| `sc2_diff_workspace` | yes | Unified diff against the source, or against a snapshot |
| `sc2_get_changes` | yes | Change history, with the snapshot taken before each |
| `sc2_revert_change` | no | Undo the most recent change |
| `sc2_create_snapshot` | no | Pin a known-good state |
| `sc2_list_snapshots` | yes | Snapshots held for a workspace |
| `sc2_restore_snapshot` | no | Roll the staging tree back to a snapshot |
| `sc2_list_files` | yes | Paginated listing of the staged tree |
| `sc2_read_file` | yes | Read one staged file (text, or base64 for binary) |
| `sc2_search_files` | yes | Literal substring search across staged text files |
| `sc2_discard_workspace` | no | Delete the staging copy; source untouched |

## The safety model

This is a program that edits your maps on a language model's instructions, so the
defaults are conservative:

- **Your source is never modified.** `sc2_open_document` copies the document into a
  server-owned staging directory. Every edit lands there. `sc2_commit_document` is the
  only way anything leaves it, and it refuses on three independent grounds — validation
  errors, the source having changed underneath you, and an occupied destination — each of
  which has to be waived separately.
- **Paths are allowlisted.** Nothing outside `allowedRoots` can be read or written.
  Paths are canonicalised first, so symlinks cannot be used to escape.
- **Nothing runs a shell.** External programs are spawned with argument arrays, a
  timeout, and a trimmed environment. There is no "run this command" tool.
- **Unimplemented means unimplemented.** A capability flag is only `true` when the code
  exists *and* its backend is present on this machine. The server would rather tell you
  it cannot do something than guess.
- **Shared objects are never edited by accident.** Twenty units share one weapon. Asking
  to change "this unit's damage" clones the chain, rewires only that unit, and tells you
  exactly what it copied — unless you explicitly ask to modify the shared original.
- **Edits are lossless, previewable, and reversible.** XML changes splice exact byte
  ranges, so everything outside the edit — comments, attribute order, CRLF endings,
  whether the file ends in a newline — comes out identical. Every mutation snapshots
  first, supports `dry_run`, produces a unified diff, rolls back completely if any part
  fails, and can be reverted afterwards.

## Requirements

- Node.js 22 or newer (developed against 26)
- pnpm 10
- Windows, for anything involving StarCraft II itself. The core is cross-platform;
  editor integration is not.

## Getting started

```bash
pnpm install
```

```bash
pnpm run verify
```

`verify` runs lint, typecheck, build, and the full test suite — including an
integration test that spawns the built server as a real child process and speaks MCP to
it over stdio.

To read or write packed `.SC2Map` archives you also need the `sc2mpq` sidecar, which is
built rather than shipped — it is a native binary, and a committed one would carry the
build machine's paths. Fetch the pinned StormLib and compile it:

```bash
pwsh scripts/bootstrap.ps1 -Only StormLib
```

```bash
pwsh scripts/build-native.ps1
```

This needs CMake, the MSVC toolset **and** the Windows SDK; see
[docs/native-helper.md](docs/native-helper.md), which explains what fails without them.
Everything except packed-archive support works fine if you skip it — `capabilities.mpq`
simply reports `false`.

Create a config file (see [docs/configuration.md](docs/configuration.md)):

```bash
node apps/sc2-mcp-server/dist/main.js doctor
```

`doctor` prints the resolved configuration, the detected StarCraft II installation, and
the capability matrix. It exits non-zero when the server would be unable to do anything
useful — for example when no allowed roots are configured.

### Connecting an MCP client

The server speaks MCP over stdio. Point your client at the built entry point:

```json
{
  "mcpServers": {
    "sc2": {
      "command": "node",
      "args": ["C:\\path\\to\\SC2EditorMCP\\apps\\sc2-mcp-server\\dist\\main.js"],
      "env": {
        "SC2MCP_ALLOWED_ROOTS": "C:\\Users\\me\\OneDrive\\Documents\\StarCraft II\\Maps"
      }
    }
  }
}
```

## Repository layout

```text
apps/sc2-mcp-server/     MCP protocol layer: tools, schemas, error translation, stdio entry
packages/sc2-core/       Domain layer: config, path guard, workspace staging, MPQ adapter
packages/sc2-test-utils/ Test fixtures and temp-directory helpers
native/sc2mpq/           C++ MPQ sidecar (StormLib), built separately
docs/                    capabilities.md, sc2-formats.md, native-helper.md, galaxy.md
docs/adr/                Architecture decision records
vendor/PINS.json         Pinned upstream sources (checkouts are gitignored)
scripts/                 bootstrap.ps1 (fetch pins), build-native.ps1 (build the sidecar)
tests/                   Cross-package integration tests
```

The layering rule (PLAN.md §4): tool handlers validate input, call a domain service, and
translate the result. SC2 parsing never lives in a tool handler.

## Licensing and content

MIT — see [LICENSE](LICENSE). Trademark and third-party notices are in
[NOTICE.md](NOTICE.md); this project is not affiliated with or endorsed by Blizzard
Entertainment.

No Blizzard assets, extracted game data, or copyrighted map content is included in this
repository, and none will be. Test fixtures are project-authored placeholders — useful
for exercising staging and transaction machinery, useless for validating format
parsers, which must be checked against real editor output.
