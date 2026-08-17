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
  // Phase 3. Read is wired end to end and gated at runtime on the sidecar being present.
  //
  // Write stays false even though `sc2mpq pack` exists: PLAN.md §10 requires that
  // multiple editor-authored maps survive extract/repack and still load in the Galaxy
  // Editor before repacking may be advertised. That corpus does not exist yet, and a
  // repack that corrupts someone's map is the worst failure this project can produce.
  mpq: { read: true, write: false },
  // Phase 6. Read and parent-chain inheritance work against the document's own catalogs.
  //
  // These do NOT depend on the Galaxy Toolkit: the catalog layer is built on this repo's
  // own span-tracking XML parser, because the toolkit's CatalogStore indexes declarations
  // only and offers neither field values nor inheritance. Spans are also what Phase 8's
  // in-place mutations need. See docs/adr/0002-own-catalog-layer.md.
  gamedata: { read: true, write: true, inheritance: true },
  // Phases 5, 9.
  galaxy: { read: false, write: false, typecheck: false },
  // Phases 5, 11.
  triggers: { read: false, write: false },
  // Phase 10.
  localization: { read: false, write: false },
  layout: { read: false, write: false },
  // Phase 15.
  objects: { read: false, write: false },
  // Phase 16.
  terrain: { read: false, write: false },
  // Phase 13.
  editorLaunch: false,
  // Phase 13 / PLAN.md §30.
  runtimeSmokeTest: false,
});

/** Runtime facts about this machine that gate otherwise-implemented capabilities. */
export interface CapabilityInputs {
  /** The `sc2mpq` sidecar was located and answered a version probe. */
  readonly mpqHelperAvailable: boolean;
  /** A StarCraft II installation with an editor executable was resolved. */
  readonly editorAvailable: boolean;
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
  const { mpqHelperAvailable, editorAvailable, toolkitAvailable } = inputs;
  return {
    workspace: { ...IMPLEMENTED.workspace },
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
    triggers: {
      read: IMPLEMENTED.triggers.read && toolkitAvailable,
      write: IMPLEMENTED.triggers.write && toolkitAvailable,
    },
    localization: { ...IMPLEMENTED.localization },
    layout: {
      read: IMPLEMENTED.layout.read && toolkitAvailable,
      write: IMPLEMENTED.layout.write && toolkitAvailable,
    },
    objects: { ...IMPLEMENTED.objects },
    terrain: { ...IMPLEMENTED.terrain },
    editorLaunch: IMPLEMENTED.editorLaunch && editorAvailable,
    runtimeSmokeTest: IMPLEMENTED.runtimeSmokeTest && editorAvailable,
  };
}
