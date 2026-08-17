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
| `ComponentList.SC2Components` | ✅ | ❌ | Parsed and resolved to real files. |
| `DocumentInfo` | ✅ | ❌ | Including the dependency chain in resolution order. |
| GameData catalogs | ✅ | ✅ | Search, inheritance, references, patch/clone/create/delete. |
| Localized text | ✅ | ✅ | BOM and CRLF preserved exactly. |
| Galaxy scripts | ✅ | ✅ | Syntax only — see below. Needs the vendored toolkit built. |
| Triggers | ✅ | ⚠️ | Structure and names readable; **renaming only**. |
| Placed objects (`Objects`) | ✅ | ❌ | XML, not binary. |
| Regions | ✅ | ❌ | XML, not binary. |
| Terrain | ⚠️ | ❌ | Descriptor only; bulk data reported by header, never decoded. |
| MPQ archives | ✅ | ⚠️ | Byte-identical round trips on real ladder maps; not yet opened in the editor. |
| Local dependency archives | ✅ | ❌ | Unpacked `.SC2Mod` directories are indexed; contents are read-only. |
| Stock (CASC) dependencies | ❌ | ❌ | Need a CASC reader; reported as `in-casc`, not missing. |
| `Attributes`, `CustomAI` | ❌ | ❌ | XML, but not modelled. |
| SC2Layout | ❌ | ❌ | Not started. |
| `MapInfo` (binary) | ❌ | ❌ | Magic and version only. |

## Why each gap exists

**MPQ archives - one manual step outstanding.** The `sc2mpq` sidecar is built and working.
Six real ladder maps extract, repack, verify, and re-extract byte-identically, and the full
open -> edit -> commit -> reopen cycle passes on a real packed map. What has *not* happened
is opening a repacked map in the Galaxy Editor - PLAN.md section 10's last validation step,
which cannot be automated. Every packed commit emits a warning saying so.
See [native-helper.md](native-helper.md).

**Galaxy type checking.** The vendored `sc2-galaxy-lang` ships a `TypeChecker`, and it is
deliberately unused. A useful one needs the game's native declarations — `natives.galaxy`
and the trigger libraries — which live in the StarCraft II installation rather than in a
map. Without them, every call to a built-in reports as an unresolved symbol, and the
output would be a wall of false errors. `capabilities.galaxy.typecheck` is therefore
`false` and every tool description says "syntax only", so a clean diagnostics result is
not misread as "this compiles".

**Trigger structural editing.** Trigger data is readable XML, so the temptation is real.
PLAN.md §21 warns against generating trigger XML by guessing undocumented ids, and the
element graph is full of them: `FunctionCall`, `Param`, `ParamDef` entries reference
editor-internal identifiers whose allocation rules are not documented anywhere reliable.
Renaming is the one write, and it is safe precisely because it edits `TriggerStrings.txt`
rather than the trigger data.

**Placed objects and terrain writing.** PLAN.md §27 and §28 require a codec validated by
editor round-trip tests before any write. None has been run. Placing a unit is not just
appending XML — it involves id allocation, flag semantics, and interaction with terrain
height that this code does not model.

**Terrain bulk data.** `t3Terrain.xml` is a readable descriptor. The height map, texture
masks, cell flags, and sync data are binary formats whose layouts have not been
established. Their four-character code, version, and size are reported because those are
observable facts; nothing is inferred about the payload.

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

## Validation categories

`sc2_validate_document` reports every category on every run, with one of four statuses:

- `passed` — checked, nothing wrong
- `failed` — checked, problems found
- `skipped` — checkable, but not applicable to this document
- `unsupported` — **not examined at all**

The distinction between `passed` and `unsupported` is the point. `galaxy`, `triggers`, and
`terrain` are `unsupported` today, and the report restates that set separately so a clean
result cannot be mistaken for a clean bill of health.

## Keeping this honest

When a subsystem gains real support, `IMPLEMENTED` in
[`packages/sc2-core/src/capabilities.ts`](../packages/sc2-core/src/capabilities.ts) flips
in the same commit that lands its tests (PLAN.md §55 rule 14). The runtime probe then
intersects that with what the machine provides. There is no third place where a capability
can be asserted.
