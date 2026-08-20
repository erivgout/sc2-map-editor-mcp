# Supported component matrix

The authoritative answer for a running server is `sc2_get_server_info` — it reports what
this *process* can do, which is the intersection of what the code implements and what this
machine provides. This document explains what each flag means and why the gaps are where
they are.

A capability is `true` only when both hold:

1. The code exists **and** its behaviour is tested against real editor output.
2. Any external backend it needs is present on this machine.

That is why `mpq` can read `false` on a build that contains a complete MPQ implementation:
the sidecar binary is not there.

## Components

| Component | Read | Write | Notes |
|---|---|---|---|
| Workspace staging | ✅ | ✅ | Unpacked document directories. Packed archives need the MPQ helper. |
| `ComponentList.SC2Components` | ✅ | ✅ | Parsed and resolved; declarations can be added, updated, and removed losslessly. |
| `DocumentInfo` | ✅ | ✅ | Dependency chain in resolution order; add/remove dependencies and set fields. |
| GameData catalogs | ✅ | ✅ | Search, inheritance, references, patch/clone/create/delete. |
| Localized text | ✅ | ✅ | BOM and CRLF preserved exactly. |
| Galaxy scripts | ✅ | ✅ | Syntax only — see below. Needs the vendored toolkit built. |
| Triggers | ✅ | ✅ | Full local graph plus rename, complete-subgraph clone, and shared-node-aware delete. |
| SC2Layout | ✅ | ✅ | List, read, structurally diagnose, search, create, and losslessly patch. |
| Placed objects (`Objects`) | ✅ | ✅ | XML, not binary. Place, move, delete; terrain height is not consulted. |
| Regions | ✅ | ✅ | XML, not binary. Create, move, rename, delete. |
| Terrain | ✅ | ✅ | Typed height, texture, pathing, and cliff operations; bounded validated access to every known component. |
| MPQ archives | ✅ | ✅ | Byte-identical round trips on real ladder maps; repacked maps open in the editor. |
| Local dependency archives | ✅ | ❌ | Unpacked `.SC2Mod` directories are indexed; contents are read-only. |
| Stock (CASC) dependencies | ❌ | ❌ | Need a CASC reader; reported as `in-casc`, not missing. |
| `MapInfo` player slots (binary v39) | ✅ | ✅ | Reads dimensions and full player records; writes an exact human slot range while preserving neutral/hostile records. |
| `Attributes` player defaults | ❌ | ✅ | Not exposed as a general reader; synchronized when `MapInfo` human slots change. |
| `CustomAI` | ❌ | ❌ | XML, but not modelled. |

## Why each gap exists

**MPQ archives - complete.** The `sc2mpq` sidecar is built and working. Six real ladder maps
extract, repack, verify, and re-extract byte-identically, and the full
open -> edit -> commit -> reopen cycle passes on a real packed map.

PLAN.md section 10's last validation step - opening a repacked map in the Galaxy Editor -
has now been done. An existing user-made map was opened, extended through this server,
repacked, and opened in the editor, which loaded it and reported catalog errors against the
added objects by name; after those were fixed the same map reopened with no alerts at all.
That is the editor reading this build's output as a real document, which is the evidence
the gate was waiting for. See [native-helper.md](native-helper.md).

**Component inventory writes.** The three component mutation tools splice `DataComponent`
entries in place and preserve the file's CRLF and no-trailing-newline convention. Add and
update refuse an unresolved logical path unless the caller explicitly allows a forward
declaration. Remove deletes only the declaration, never the staged component files. A real
packed map with a changed `DocumentInfo` declaration was repacked, reopened through MCP,
loaded in Galaxy Editor, and launched into gameplay.

**MapInfo player slots.** The version 39 codec reads every player record and rewrites only
the bounded player section. `sc2_set_map_player_slots` creates an exact contiguous user
range beginning at player 1, optionally removes template computer slots, preserves neutral
and hostile records, and updates `Attributes` lobby defaults in the same transaction. The
result was repacked and launched in the installed client with exactly four human slots.

**Galaxy type checking.** The vendored `sc2-galaxy-lang` ships a `TypeChecker`, and it is
deliberately unused. A useful one needs the game's native declarations — `natives.galaxy`
and the trigger libraries — which live in the StarCraft II installation rather than in a
map. Without them, every call to a built-in reports as an unresolved symbol, and the
output would be a wall of false errors. `capabilities.galaxy.typecheck` is therefore
`false` and every tool description says "syntax only", so a clean diagnostics result is
not misread as "this compiles".

**Trigger writes.** The parser follows every document-owned relation, including `Item`,
`Event`, `Action`, `Parameter`, and `FunctionCall`. Library-qualified native references
remain external. `sc2_clone_trigger` copies a complete editor-authored subgraph, allocates
new eight-digit hexadecimal ids, remaps every local edge, and copies its localized names.
`sc2_delete_trigger` removes the selected edge and prunes only nodes with no remaining
incoming path. Shared nodes stay intact. The server still refuses to construct a new native
action or event from an undocumented identifier; cloning preserves the editor's original
schema instead. The installed-client check cloned an 18-element trigger subgraph in a real
packed map, repacked it, reopened it through MCP, loaded it in Galaxy Editor, and reached
live gameplay. The trigger validator reported no errors or warnings before and after the
archive round trip.

**Placed objects and regions.** PLAN.md §27 required editor round-trip validation before
any write. A real map had a region and unit added through these tools, was repacked, and
opened in the Galaxy Editor with the edits intact.

Two things are still not modelled, and both are stated at the tool rather than assumed
away. Terrain height is not consulted, so a placed object's `z` is written exactly as given
rather than snapped to the ground. And nothing here can see trigger or script references to
an object, so deleting one that something else uses will break it silently.

The convention that types are named `UnitType` on `<ObjectUnit>` but `Type` on points and
doodads was taken from 181 real entries in editor output, not assumed — reading only `Type`
had been reporting every placed unit in a real map as untyped.

**SC2Layout.** Layout support uses the repository's span-tracking XML parser, so targeted
changes preserve all bytes outside the selected element or attribute. The server can list,
read, structurally diagnose, search, create, and patch `.SC2Layout` files without the
optional Galaxy toolkit. A created and patched layout survived MPQ repacking, loaded in the
Galaxy Editor without a layout alert, and remained present after the editor saved the map.

**Terrain bulk data.** The server decodes `t3Terrain.xml`, rendering and synchronized
heights, cell flags, eight texture-mask layers, synchronized texture assignments, and
cliff levels. A height write updates `t3HeightMap` and `t3SyncHeightMap` in one transaction;
texture and cliff writes do the same for their synchronized counterparts. Advanced water,
hard-tile, fluff, and vertex-color data can be read and patched as bounded bytes. The file
length cannot change; documented magic and versions are checked, while fully decoded
components also check dimensions and exact expected length. See
[terrain.md](terrain.md) for the exact versions and invariants.

The terrain codecs pass synthetic corruption and mutation tests, decode Blizzard's
installed editor test map, and passed a packed-map editor cycle: edit, validate, repack,
reopen through MCP, open in the Galaxy Editor, save there, then reopen and validate again.
Primitive cell and vertex editing is available now. High-level brushes, ramp construction,
and semantic water-body generation remain roadmap work rather than hidden capability
claims.

**Dependency archives: local ones load, stock ones cannot.** A dependency that resolves to
an unpacked directory - a user's own `.SC2Mod` beside their map - is loaded, and its
objects become visible for inheritance, references, and search, tagged with the archive
they came from. They are *readable but not editable*: mutation refuses them and points at
cloning instead, because PLAN.md section 25 forbids modifying dependency archives.

Blizzard's stock dependencies are a different matter. There is no `Mods/` directory in a
retail installation; `VoidMulti.SC2Mod` and friends live inside the CASC content store
(`SC2Data/data` + `indices`). Reading those needs a CASC reader, which this build does not
have. `sc2_get_dependencies` reports them as `in-casc` rather than `not-found`, because
"this build cannot read it" and "your map is broken" are very different statements.

**Editor and runtime testing.** `sc2_launch_editor` opens a packed document or a workspace
staging tree in the Galaxy Editor. `sc2_test_document` performs the actual in-game check.
It copies the selected packed map or extensionless workspace tree into the installation's
bounded `Maps\Test\SC2MCPTest.SC2Map` location, writes an editor-compatible
`SC2TestConfig`, and invokes the preferred `SC2Switcher` binary. The tool waits for the
current game executable to appear and returns both launcher and game PIDs.

This path was captured from editor 5.0.16 / build 97563 and then reproduced through the
built MCP server. Directly invoking `SC2_x64.exe` failed; invoking `SC2Switcher_x64.exe`
with the captured arguments succeeded. A packed MCP-authored map reached live gameplay,
and an unpacked user map opened as a workspace, copied from its extensionless staging
directory, reached an in-game result screen. `sc2_get_last_test_log` correlates GameLogs
by launch time, reports whether the game PID is still running, includes the newest Alerts
and ScriptError logs, and extracts actionable diagnostics from both. Runtime support is advertised only when the
selected installation contains both SC2Switcher and a current game executable.

## Validation categories

`sc2_validate_document` reports every category on every run, with one of four statuses:

- `passed` — checked, nothing wrong
- `failed` — checked, problems found
- `skipped` — checkable, but not applicable to this document
- `unsupported` — **not examined at all**

The distinction between `passed` and `unsupported` is the point, and the report restates
the unsupported set separately so a clean result cannot be mistaken for a clean bill of
health.

Which categories are `unsupported` depends on the machine, not on a constant. `galaxy`
runs whenever the vendored toolkit is built, and checks authored scripts for syntax errors
— never types, and never the generated `MapScript.galaxy`. `triggers` parses the trigger
graph to confirm it reads, which is not the same as judging what the triggers do. `archive`
checks the staged tree for the things that only become fatal once it is packed, such as two
paths differing solely in case; the packed bytes themselves are verified at commit, by
reopening the archive and reading every member. `terrain` decodes and cross-validates every
required terrain component when `t3Terrain.xml` is present, and reports `skipped` when a
document has no terrain component.

These used to be hardcoded to `unsupported` with reasons that had stopped being true — the
report claimed the MPQ helper and the Galaxy parser were absent on builds that had both.
A category may only say `passed` when it actually ran.

## Keeping this honest

When a subsystem gains real support, `IMPLEMENTED` in
[`packages/sc2-core/src/capabilities.ts`](../packages/sc2-core/src/capabilities.ts) flips
in the same commit that lands its tests (PLAN.md §55 rule 14). The runtime probe then
intersects that with what the machine provides. There is no third place where a capability
can be asserted.
