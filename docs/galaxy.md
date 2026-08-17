# Galaxy script support

Galaxy reading is backed by `sc2-galaxy-lang` from the pinned
[`sc2-galaxy-toolkit`](https://github.com/sc2-arcade-watcher/sc2-galaxy-toolkit), consumed
through the adapter in
[`packages/sc2-core/src/galaxy/adapter.ts`](../packages/sc2-core/src/galaxy/adapter.ts).

## Enabling it

The toolkit is vendored, gitignored, and built separately, so a fresh clone does not have
it and `capabilities.galaxy` reports `false`.

```bash
pwsh scripts/bootstrap.ps1 -Only sc2-galaxy-toolkit
```

```bash
cd vendor/sc2-galaxy-toolkit && pnpm install && pnpm --filter "sc2-galaxy-lang..." run build
```

The adapter looks for
`vendor/sc2-galaxy-toolkit/packages/sc2-galaxy-lang/lib/src/index.js` and loads it
dynamically. A static import would make `pnpm install` fail on a clone that has not
bootstrapped, which is why the dependency is late-bound rather than declared.

## Syntax, not semantics

**No type checking.** The toolkit has a `TypeChecker`; it is deliberately unused.

A Galaxy file calls into the game's native library — `natives.galaxy`, `TriggerLibs/*` —
which lives in the StarCraft II installation, not in a map. Without those declarations
loaded, every call to a built-in resolves to nothing and the checker reports it. The output
would be hundreds of errors that are all false, which is worse than no output.

So the tools report **parse** diagnostics only, and every description says so. A clean
`sc2_get_galaxy_diagnostics` result means the file is syntactically well formed. It does
not mean it compiles, that its identifiers resolve, or that its argument types are right.

Wiring in the native declarations would need to locate them in the installation, load them
into the toolkit's store, and handle version differences between game builds. That is a
real piece of work, not a flag to flip.

## `MapScript.galaxy` is generated

The editor writes `MapScript.galaxy` from the trigger data on every save. Editing it
accomplishes nothing — the next save overwrites it.

`sc2_list_galaxy_files` flags it `generated`, `sc2_get_galaxy_diagnostics` skips it unless
asked for by name, and `sc2_apply_galaxy_patch` refuses it outright with an error pointing
at the triggers instead. Authored libraries live under `*.SC2Data/`.

## How patching stays safe

`sc2_apply_galaxy_patch` replaces exact text rather than applying a diff, with two guards:

1. **The snippet must be unambiguous.** If `old_text` appears more than once the patch is
   refused unless the caller names the occurrence. A patch that lands on whichever match
   came first is worse than one that fails.
2. **The result is reparsed.** If the edit introduces syntax errors the write is refused
   unless `force` is set. Errors that were already there do not block, so a broken file can
   still be repaired.

Both are covered in `tests/galaxy.integration.test.ts`, which skips itself when the toolkit
is absent.
