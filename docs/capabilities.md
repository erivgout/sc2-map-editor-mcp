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
| MPQ archives | ⚠️ | ❌ | Implemented but **never compiled**. |
| `Attributes`, `CustomAI` | ❌ | ❌ | XML, but not modelled. |
| SC2Layout | ❌ | ❌ | Not started. |
| `MapInfo` (binary) | ❌ | ❌ | Magic and version only. |

## Why each gap exists

**MPQ archives — implemented, never compiled.** The `sc2mpq` sidecar is complete C++ over
a pinned StormLib, and the TypeScript adapter is wired into `sc2_open_document`. It has
never been built, because the development machine has `cl.exe` but no CRT headers and no
Windows SDK. Even once built, `mpq.write` stays `false` until several editor-authored maps
survive extract → repack → reopen (PLAN.md §10). A repack that corrupts someone's map is
the worst failure this project can produce, so that gate does not move on a code review.
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

**Dependency archives are never loaded.** Every catalog result covers the open document
only. An object defined in `VoidMulti.SC2Mod` is not in the index, so "not found" means
"not in this document" — every tool that could be misread on this point says so
explicitly. This is the single most likely way to draw a wrong conclusion from this
server's output.

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
