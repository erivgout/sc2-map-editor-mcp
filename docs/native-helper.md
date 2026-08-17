# The `sc2mpq` native helper

Packed `.SC2Map`, `.SC2Mod`, and `.SC2Campaign` files are MPQ archives. Reading and
writing them needs [StormLib](https://github.com/ladislav-zezula/StormLib), a C++
library, so this repository ships a small helper binary rather than a Node addon.

**Status: the source is complete but has never been compiled or validated.** See
[Current status](#current-status).

## Why a sidecar process, not a Node addon

A native addon shares the server's address space. A crash inside StormLib while parsing a
malformed or hostile archive would take the MCP server down with it, losing every open
workspace. As a separate process, the same crash is a non-zero exit code that the server
turns into a structured `SC2_PACK_FAILED` error.

The cost is process-spawn overhead per operation, which is irrelevant next to the I/O of
extracting a map. PLAN.md §6 leaves the door open to an N-API addon later; because
everything goes through `MpqHelper`, that swap would not touch the domain layer.

## Building it

```bash
pwsh scripts/bootstrap.ps1 -Only StormLib
```

```bash
pwsh scripts/build-native.ps1
```

The result lands at `native/sc2mpq/bin/sc2mpq.exe`, which the adapter finds with no
configuration. Point `mpqHelperPath` at it if you build elsewhere.

### Requirements

- CMake 3.20+
- A C++20 compiler
- **On Windows:** the MSVC toolset **and** the Windows SDK. Having `cl.exe` present is
  not enough — the CRT headers (`VC\Tools\MSVC\<ver>\include`) and the SDK
  (`C:\Program Files (x86)\Windows Kits\10`) must also be installed. A Visual Studio
  install without the "Desktop development with C++" workload has the compiler binary but
  none of the headers or import libraries, and CMake fails deep in compiler detection
  rather than saying so.

  Install the workload through the Visual Studio Installer, or the standalone build tools:

  ```bash
  winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```

  This is a multi-gigabyte download and needs elevation.

## Current status

| Item | State |
|---|---|
| StormLib pinned (v9.40, `6bb1882`) | done — `vendor/PINS.json` |
| `info` / `list` / `extract` / `pack` / `verify` implemented | done — source only |
| TypeScript adapter with strict protocol validation | done, tested |
| Wired into `sc2_open_document` for packed sources | done |
| **Compiled** | **not yet — no Windows SDK on the development machine** |
| Round-trip tested against generated fixtures | written, skipped until the binary exists (`tests/mpq.integration.test.ts`) |
| Round-trip tested against editor-authored maps | **not done** — PLAN.md §10's real exit criterion |

`capabilities.mpq.write` therefore reports `false` even once you build the helper.
Repacking is not advertised until several editor-authored maps have survived
extract → repack → reopen in the Galaxy Editor. Producing that corpus is a manual step:
the maps cannot be committed here, and a repack that corrupts someone's map is the worst
failure this project can cause.

## CLI contract

Every command writes exactly one JSON object to stdout and exits 0 on success. Nothing
else is ever written to stdout; diagnostics go to stderr.

```text
sc2mpq version
sc2mpq info    <archive>
sc2mpq list    <archive>
sc2mpq extract <archive> <destination-dir>
sc2mpq pack    <source-dir> <output> [--sector-size N] [--mpq-version 1..4] [--max-file-count N]
sc2mpq verify  <archive>
```

The schemas are in [`packages/sc2-core/src/archive/protocol.ts`](../packages/sc2-core/src/archive/protocol.ts)
and are `.strict()`: an unexpected field makes the adapter refuse the response rather than
act on a half-understood one.

`version` reports a `protocolVersion` that must match `MPQ_HELPER_PROTOCOL_VERSION`. A
mismatch disables the helper entirely — a sidecar whose JSON means something subtly
different is more dangerous than no sidecar at all.

## Design notes worth knowing

**Sector size is preserved, not guessed.** Repacking with a different sector size rewrites
every compressed file in the archive. `pack` therefore takes `--sector-size`, and the
caller is expected to pass the value `info` reported for the source. There is no
"reasonable default" that round-trips.

**`(listfile)` is required to open an archive.** MPQ enumeration works through an internal
listfile. Without one, members whose names we never learn are invisible, so
"extracted everything" would be a guess — and a subsequent repack would silently drop
them. `createMpqExtractor` refuses such archives with `SC2_UNSUPPORTED_COMPONENT` instead.
Protected maps deliberately omit the listfile and are explicitly out of scope (PLAN.md §3).

**Internal files are not extracted.** `(listfile)`, `(attributes)`, `(signature)`, and
`(patch_metadata)` are archive bookkeeping, regenerated on pack. Extracting them would
make a clean round trip look lossy. `(attributes)` is not regenerated at all: it stores
timestamps, which would make output non-reproducible.

**A partial result is a failure.** Both `extract` and `pack` report `ok:false` and exit
non-zero if any member fails, and `pack` deletes the half-written archive. PLAN.md §10
forbids silently skipping a file; an archive that looks openable but is missing content is
worse than no archive.

**Archive paths are rejected, never sanitised.** Traversal, absolute paths, drive letters,
control characters, Windows reserved device names, and segments ending in a dot or space
are refused. The same rules live in `packages/sc2-core/src/paths.ts`; the two
implementations must agree, and where they differ the stricter one is correct.

**Hashing happens in TypeScript.** PLAN.md §10 asks `extract` to return content hashes.
The helper returns sizes only, and the TS layer hashes with the same SHA-256 code used for
workspace manifests everywhere else. One hash implementation instead of two that could
drift.
