# ADR 0002 — Build the GameData catalog layer in-house; use the toolkit for Galaxy

- **Status:** Accepted
- **Date:** 2026-08-17
- **Related plan sections:** PLAN.md §7 (toolkit dependency strategy), §12 (lossless writing), §17 (GameData support), §42 Phases 5–6

## Context

PLAN.md §7 assumes `sc2-galaxy-toolkit` supplies the GameData model behind an adapter,
sketching a `GameDataIndex` interface with `resolveInheritance` and `findReferences`.

The toolkit was vendored at the pinned commit and built (`sc2-mod`, `sc2-data`,
`sc2-text`, `sc2-trigger`, `sc2-galaxy-lang` all compile cleanly). Reading what
`sc2-data` actually provides changes the picture.

### What `sc2-data` provides

`CatalogStore` is a **declaration index**, nothing more:

```ts
interface CatalogDeclaration {
    family: S2DataCatalogDomain;   // Unit, Abil, Effect, …
    ctype: string;                 // CUnit, CAbilEffectInstant, …
    id: string;
    uri: string;
    position: { line: number; character: number };
}
```

It is built by a **line-oriented regex scan** (`store.ts`: iterate lines, match an element
pattern, pull out `id`). `parent` and `default` are explicitly matched and then discarded.
There is no field data, no inheritance, and no reference graph.

So of PLAN.md §7's sketched interface, the toolkit supplies `search` and `get` (as
locations, not objects), and none of `resolveInheritance`, `findReferences`, or any notion
of a field value. §17's tools — `sc2_resolve_catalog_object`,
`sc2_find_catalog_references`, `sc2_get_catalog_reference_graph` — would all have to be
written on top regardless.

### What we already have

Phase 4 produced a span-tracking XML reader (`packages/sc2-core/src/xml/parse.ts`), built
for PLAN.md §12's lossless-writing requirement. It records the exact source range of every
element, attribute, and attribute value.

## Decision

**The GameData catalog layer is written in-house on our own XML parser.** The Galaxy
language services (parser, binder, type checker) continue to come from
`sc2-galaxy-lang` behind an adapter, as PLAN.md §7 intends.

Concretely:

- `packages/sc2-core/src/gamedata/` owns catalog parsing, indexing, inheritance
  resolution, and reference search.
- `S2DataCatalogDomain`'s 109 domain names are reproduced as **data** in `domains.ts`,
  with attribution. That list cannot be derived from map contents — `Actor` and
  `ActorSupport` are indistinguishable by shape — so a maintained list is the only correct
  source. It is data, not an API, so copying it does not create the coupling §7 warns about.
- The domain-resolution algorithm (split the element name on capital-letter boundaries,
  drop trailing subwords until a known domain matches, longest wins) is reimplemented; it
  is about ten lines.
- Nothing outside a future `packages/sc2-toolkit-adapter` may import toolkit packages.

## Why

1. **Spans are the point.** Phase 8 must change `<LifeMax value="45"/>` to `value="125"`
   by splicing bytes, leaving the rest of a 220 KB `UnitData.xml` byte-identical. A
   line-and-character position from a regex scan cannot support that; a parse tree with
   exact ranges can. Adopting the toolkit's index for reading would mean parsing every
   catalog file a second time for writing, with two models that could disagree.

2. **The delta is small and the risk is not.** The toolkit's contribution here is a regex
   loop plus a name list. Its own README calls the project work in progress, and it has
   three in-flight `refactor/*` branches. Taking a dependency for that trade is poor value.

3. **Correctness we can verify.** `parseCatalogFile` is checked against the real
   `Base.SC2Data/GameData/*.xml` files in the editor-produced map that ships with
   StarCraft II (PLAN.md §55 rule 1). A regex-per-line scan cannot see nested field
   structures, which real catalogs use.

4. **Galaxy is genuinely different.** A Galaxy parser, binder, and type checker is a large
   piece of work with no shortcut. That is exactly where a dependency earns its keep, and
   it stays behind an adapter per §7.

## Consequences

- `capabilities.gamedata` is **not** gated on toolkit availability. It depends on nothing
  outside the process, so it is reported from the implementation table alone.
- `CATALOG_DOMAINS` must be refreshed when Blizzard adds a domain. The failure mode is
  benign and visible: an unrecognised element is reported with a `null` domain and a
  warning diagnostic, never silently dropped.
- We own catalog correctness. Mitigated by testing against real editor output rather than
  fixtures we wrote ourselves.
- PLAN.md §7's `GameDataIndex` interface no longer describes an adapter over the toolkit.
  It describes our own service. The layering rule it exists to protect — nothing above the
  domain layer knows where data comes from — is unchanged.

## Not decided here

- Whether to use `sc2-mod`'s `SC2Workspace` for dependency resolution (PLAN.md §25). It
  does real work — archive discovery, dependency ordering, builtin resolution — and is a
  better candidate for adoption than `sc2-data`. Deferred until dependency loading is
  actually implemented.
- `sc2-text` and `sc2-trigger`, deferred to Phases 10 and 11.
