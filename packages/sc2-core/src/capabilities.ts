/**
 * Machine-readable capability reporting (PLAN.md §41).
 *
 * This object is a contract with the calling model: if a flag is `true`, the
 * corresponding tools exist *and* their backend has been validated against real SC2
 * documents. PLAN.md §55 rule 2 — "do not fake support" — is enforced here by making
 * every flag default to `false` and requiring an explicit, justified flip.
 *
 * Whenever a subsystem gains real support, flip its flag in the same commit that
 * lands the tests (PLAN.md §55 rule 14).
 */

export interface ReadWriteCapability {
  read: boolean;
  write: boolean;
}

export interface ServerCapabilities {
  workspace: ReadWriteCapability;
  components: ReadWriteCapability;
  mpq: ReadWriteCapability;
  gamedata: ReadWriteCapability & { inheritance: boolean };
  galaxy: ReadWriteCapability & { typecheck: boolean };
  triggers: ReadWriteCapability;
  localization: ReadWriteCapability;
  layout: ReadWriteCapability;
  objects: ReadWriteCapability;
  terrain: ReadWriteCapability;
  editorLaunch: boolean;
  runtimeSmokeTest: boolean;
}

/**
 * The honest baseline: nothing is supported until a phase lands and proves it.
 * Every `true` below must be traceable to a passing test on a real fixture.
 */
export const NO_CAPABILITIES: ServerCapabilities = Object.freeze({
  workspace: { read: false, write: false },
  components: { read: false, write: false },
  mpq: { read: false, write: false },
  gamedata: { read: false, write: false, inheritance: false },
  galaxy: { read: false, write: false, typecheck: false },
  triggers: { read: false, write: false },
  localization: { read: false, write: false },
  layout: { read: false, write: false },
  objects: { read: false, write: false },
  terrain: { read: false, write: false },
  editorLaunch: false,
  runtimeSmokeTest: false,
});

/**
 * What this build has *code* for, independent of the machine it runs on.
 *
 * Update these in the same commit that lands the subsystem's tests. A capability is
 * only advertised when BOTH this table and the runtime probe agree.
 */
export const IMPLEMENTED: ServerCapabilities = Object.freeze({
  // Phase 2: staging, path guard, open/summary/discard for directory sources.
  workspace: { read: true, write: true },
  // ComponentList entries can be added, updated, and removed through lossless spans.
  components: { read: true, write: true },
  // Phase 3, gated at runtime on the sidecar being present.
  //
  // Six real ladder maps extract, repack, verify, and re-extract byte-identically (every
  // member's SHA-256 matches). The full open -> edit -> commit -> reopen cycle passes on a
  // real packed map, and repacked output has been opened successfully in the Galaxy
  // Editor. In-game execution is reported separately by `runtimeSmokeTest` below.
  mpq: { read: true, write: true },
  // Phase 6. Read and parent-chain inheritance work against the document's own catalogs.
  //
  // These do NOT depend on the Galaxy Toolkit: the catalog layer is built on this repo's
  // own span-tracking XML parser, because the toolkit's CatalogStore indexes declarations
  // only and offers neither field values nor inheritance. Spans are also what Phase 8's
  // in-place mutations need. See docs/adr/0002-own-catalog-layer.md.
  gamedata: { read: true, write: true, inheritance: true },
  // Phase 9, through the vendored sc2-galaxy-lang parser. Read and targeted text
  // patching work; `typecheck` stays false because a real checker needs the game's
  // native declarations, which are not in a map — see packages/sc2-core/src/galaxy.
  galaxy: { read: true, write: true, typecheck: false },
  // Phase 11. The full local reference graph is parsed. Clone and delete operations work
  // on complete editor-authored subgraphs, remap local ids, preserve native library ids,
  // and update TriggerStrings in the same transaction.
  triggers: { read: true, write: true },
  // Phase 10. Text tables are line-oriented and reference nothing, so they are the
  // lowest-risk writable component in the document.
  localization: { read: true, write: true },
  // SC2Layout files use the same lossless XML spans as other document XML. The layout
  // layer adds structural diagnostics, element search, creation, and targeted patches.
  layout: { read: true, write: true },
  // Phase 15. Objects and Regions turned out to be plain XML rather than the binary
  // formats PLAN.md §27 anticipated, so neither reading nor writing needs reverse
  // engineering — edits splice bytes the same way GameData does. §27's round-trip gate has
  // been met: a map edited here repacks and reopens in the Galaxy Editor with the changes
  // intact and no alerts. Object placement does not auto-sample terrain, so a placed
  // object's z is written exactly as given rather than snapped to the ground.
  objects: { read: true, write: true },
  // Phase 16. Validated codecs cover the descriptor, rendering and synchronized heights,
  // pathing flags, texture masks and synchronized texture data, and cliff levels. Every
  // binary write is bounds-checked and committed with its synchronized counterpart.
  terrain: { read: true, write: true },
  // Phase 13. Opens packed or unpacked documents in the Galaxy Editor.
  editorLaunch: true,
  // Phase 13 / PLAN.md §29. Mirrors the Test Document process path observed on editor
  // 5.0.16: bounded staging, SC2TestConfig, SC2Switcher, game-process detection, and logs.
  runtimeSmokeTest: true,
});

/** Runtime facts about this machine that gate otherwise-implemented capabilities. */
export interface CapabilityInputs {
  /** The `sc2mpq` sidecar was located and answered a version probe. */
  readonly mpqHelperAvailable: boolean;
  /** A StarCraft II installation with an editor executable was resolved. */
  readonly editorAvailable: boolean;
  /** The selected installation has SC2Switcher and a current game executable. */
  readonly runtimeLauncherAvailable: boolean;
  /** The vendored Galaxy Toolkit adapter loaded successfully. */
  readonly toolkitAvailable: boolean;
}

/**
 * Intersects {@link IMPLEMENTED} with what this machine actually provides.
 *
 * A capability that is implemented but whose backend is missing reports `false` —
 * the model is told the truth about this process, not about the codebase.
 */
export function deriveCapabilities(inputs: CapabilityInputs): ServerCapabilities {
  const { mpqHelperAvailable, editorAvailable, runtimeLauncherAvailable, toolkitAvailable } = inputs;
  return {
    workspace: { ...IMPLEMENTED.workspace },
    components: { ...IMPLEMENTED.components },
    mpq: {
      read: IMPLEMENTED.mpq.read && mpqHelperAvailable,
      write: IMPLEMENTED.mpq.write && mpqHelperAvailable,
    },
    // Not gated on the toolkit: the catalog layer is built on this repo's own XML parser
    // and depends on nothing outside the process.
    gamedata: { ...IMPLEMENTED.gamedata },
    galaxy: {
      read: IMPLEMENTED.galaxy.read && toolkitAvailable,
      write: IMPLEMENTED.galaxy.write && toolkitAvailable,
      typecheck: IMPLEMENTED.galaxy.typecheck && toolkitAvailable,
    },
    // Not gated on the toolkit: trigger data turned out to be plain XML, so this repo's
    // own parser handles it.
    triggers: { ...IMPLEMENTED.triggers },
    localization: { ...IMPLEMENTED.localization },
    // Layout parsing and lossless mutation are local and do not need the toolkit.
    layout: { ...IMPLEMENTED.layout },
    objects: { ...IMPLEMENTED.objects },
    terrain: { ...IMPLEMENTED.terrain },
    editorLaunch: IMPLEMENTED.editorLaunch && editorAvailable,
    runtimeSmokeTest: IMPLEMENTED.runtimeSmokeTest && runtimeLauncherAvailable,
  };
}
