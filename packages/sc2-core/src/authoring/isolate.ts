/**
 * Shared-object isolation (PLAN.md §45).
 *
 * The problem this solves is the one that makes naive Data Editor automation dangerous.
 * A user asks "make this unit's weapon do 100 damage". The unit's weapon is
 * `GaussRifle`; so is every other Marine's, and the Marauder's, and a campaign unit's.
 * Editing it in place quietly changes twenty units.
 *
 * The rule: **when a change would reach objects the caller did not name, clone the chain
 * needed to isolate it, rewire only the named object, and report exactly what was
 * cloned.** Never silently edit a shared object, and never silently clone one either —
 * the caller is told both ways.
 *
 * Field names here were read off real editor output, not inferred:
 *   `<CWeaponLegacy id="AcidSaliva"><Effect value="RoachSearchArea"/></CWeaponLegacy>`
 *   `<CEffectDamage id="AmonTentacleADamage"><Amount value="1750"/></CEffectDamage>`
 * Note that the weapon→effect link uses `value`, not `Link`.
 */

import { SC2Error } from '../errors.js';
import { CatalogIndex, catalogKey, type CatalogReference } from '../gamedata/index.js';
import type { CatalogEditSession, CreatedObject } from './editorSession.js';

/** Who refers to an object, and whether that is more than the one caller named. */
export interface SharingReport {
  readonly objectId: string;
  /** Distinct catalog objects that reference it. */
  readonly referrers: readonly string[];
  /** True when something other than `exceptFor` also refers to it. */
  readonly shared: boolean;
}

export function describeSharing(index: CatalogIndex, domain: string, id: string, exceptFor?: string): SharingReport {
  const referrers = [...new Set(index.findReferences(domain, id).map((reference) => reference.from))];
  const others = exceptFor === undefined ? referrers : referrers.filter((referrer) => referrer !== exceptFor);
  return { objectId: catalogKey(domain, id), referrers, shared: others.length > 0 };
}

/** A default id for an isolated copy: `GaussRifle` used by `RailMarine` -> `RailMarineGaussRifle`. */
export function derivedId(ownerId: string, sharedId: string): string {
  return `${ownerId}${sharedId}`;
}

export interface IsolateOptions {
  /** Only rewire references coming from this object. */
  readonly ownerId: string;
  readonly ownerDomain: string;
  /** Id for the clone. Defaults to {@link derivedId}. */
  readonly newId?: string | undefined;
  /**
   * Isolate even when nothing else refers to the object.
   *
   * Off by default: cloning an object only one thing uses adds a duplicate for no benefit.
   */
  readonly always?: boolean | undefined;
}

export interface IsolateResult {
  /** Null when no clone was needed. */
  readonly cloned: CreatedObject | null;
  /** The id the owner now points at — the clone's, or the original's. */
  readonly effectiveId: string;
  readonly sharing: SharingReport;
  /** Field paths on the owner that were repointed. */
  readonly rewiredFields: readonly string[];
}

/**
 * Clones a shared object and repoints one owner's references at the copy.
 *
 * Returns without cloning when the object is not actually shared, so the common case
 * stays a plain in-place edit and the document does not accumulate near-duplicates.
 */
export async function isolateSharedObject(
  session: CatalogEditSession,
  index: CatalogIndex,
  domain: string,
  id: string,
  options: IsolateOptions,
): Promise<IsolateResult> {
  const ownerKey = catalogKey(options.ownerDomain, options.ownerId);
  const sharing = describeSharing(index, domain, id, ownerKey);

  if (!sharing.shared && options.always !== true) {
    return { cloned: null, effectiveId: id, sharing, rewiredFields: [] };
  }

  const newId = options.newId ?? derivedId(options.ownerId, id);
  const cloned = await session.clone(domain, id, newId);

  // Repoint only the owner's own references. Every other referrer keeps the original,
  // which is the entire point.
  const ownerReferences: CatalogReference[] = index
    .findReferences(domain, id)
    .filter((reference) => reference.from === ownerKey && reference.via !== 'parent');

  if (ownerReferences.length === 0) {
    throw new SC2Error(
      'SC2_BROKEN_REFERENCE',
      `${ownerKey} does not reference ${catalogKey(domain, id)}, so there is nothing to repoint.`,
      {
        objectId: catalogKey(domain, id),
        recoverable: true,
        suggestedAction: 'Check which object actually holds the reference with sc2_find_catalog_references.',
      },
    );
  }

  await session.patch(
    options.ownerDomain,
    options.ownerId,
    ownerReferences.map((reference) =>
      reference.via === 'Link'
        ? ({ op: 'set_link', path: reference.fieldPath, value: newId } as const)
        : ({ op: 'set', path: reference.fieldPath, value: newId } as const),
    ),
  );

  session.note(
    `isolated ${catalogKey(domain, id)} as ${catalogKey(domain, newId)} for ${ownerKey}; ${sharing.referrers.length - 1} other referrer(s) keep the original`,
  );

  return {
    cloned,
    effectiveId: newId,
    sharing,
    rewiredFields: ownerReferences.map((reference) => reference.fieldPath),
  };
}

/** The weapon field that names a unit's weapons, as observed in real UnitData. */
export const UNIT_WEAPON_FIELD = 'WeaponArray';
/** The field on a weapon that names its effect. Uses `value`, not `Link`. */
export const WEAPON_EFFECT_FIELD = 'Effect';
/** The damage field on a damage effect. */
export const EFFECT_AMOUNT_FIELD = 'Amount';

export interface WeaponChain {
  readonly weaponId: string;
  /** Field path on the unit that names the weapon, e.g. `WeaponArray[0]`. */
  readonly weaponFieldPath: string;
  /** The effect the weapon points at, when it names one. */
  readonly effectId: string | null;
}

/**
 * Finds a unit's weapon and the effect behind it.
 *
 * Deliberately shallow: it follows `WeaponArray -> Effect` and stops. Real SC2 effect
 * trees can be many levels deep (`CEffectSet` fanning out to several damage effects), and
 * guessing at which leaf a caller meant would be worse than saying the chain is not a
 * simple one.
 */
export function findWeaponChain(index: CatalogIndex, unitId: string, weaponIndex = 0): WeaponChain {
  const unit = index.get('Unit', unitId);
  if (unit === null) {
    throw new SC2Error('SC2_NOT_FOUND', `No Unit/${unitId} in this document.`, {
      objectId: `Unit/${unitId}`,
      recoverable: true,
    });
  }

  const weaponFields = index
    .ownFields(unit)
    .filter(({ field }) => field.name === UNIT_WEAPON_FIELD && (field.link ?? field.value) !== null);

  if (weaponFields.length === 0) {
    throw new SC2Error('SC2_NOT_FOUND', `Unit/${unitId} declares no ${UNIT_WEAPON_FIELD} of its own.`, {
      objectId: `Unit/${unitId}`,
      recoverable: true,
      suggestedAction:
        'It may inherit one from its parent. Resolve the object first, then edit the parent or give this unit its own weapon.',
    });
  }

  const chosen = weaponFields[weaponIndex];
  if (chosen === undefined) {
    throw new SC2Error('SC2_NOT_FOUND', `Unit/${unitId} has ${weaponFields.length} weapon(s); index ${weaponIndex} is out of range.`, {
      objectId: `Unit/${unitId}`,
      recoverable: true,
    });
  }

  const weaponId = chosen.field.link ?? chosen.field.value ?? '';
  const weapon = index.get('Weapon', weaponId);
  const effectId =
    weapon === null
      ? null
      : (index.ownFields(weapon).find(({ field }) => field.name === WEAPON_EFFECT_FIELD)?.field.value ?? null);

  return { weaponId, weaponFieldPath: chosen.path, effectId };
}
