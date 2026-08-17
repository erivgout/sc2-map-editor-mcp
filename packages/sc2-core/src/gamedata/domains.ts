/**
 * Catalog domains (PLAN.md §17).
 *
 * A GameData entry's XML element name is its *concrete type*, not its domain:
 * `CAbilEffectInstant`, `CAbilTrain`, and `CAbilBuild` are all abilities. SC2 groups them
 * by the longest domain prefix, so `parent=` links and `Link=` references resolve within
 * the domain, not the concrete type.
 *
 * The domain list below is the curated set from `sc2-galaxy-toolkit`'s
 * `S2DataCatalogDomain` (pinned commit in `vendor/PINS.json`). Deriving it from the data
 * is not possible — `Abil` vs `Actor` vs `ActorSupport` cannot be told apart by shape —
 * so a maintained list is the only correct source. It is reproduced here as data rather
 * than imported, because it is a stable enumeration rather than an API, and PLAN.md §7
 * keeps toolkit *types* out of everything except the adapter.
 *
 * The set is open: an element whose prefix matches nothing is reported with a `null`
 * domain rather than dropped (PLAN.md §47).
 */

/**
 * Known catalog domains, sorted for stable output.
 *
 * Source: sc2-galaxy-toolkit @ 95d1ff8, `packages/sc2-data/src/domains.ts`.
 */
export const CATALOG_DOMAINS: readonly string[] = Object.freeze([
  'Abil', 'Accumulator', 'Achievement', 'AchievementTerm', 'Actor', 'ActorSupport', 'Alert',
  'ArmyCategory', 'ArmyUnit', 'ArmyUpgrade', 'Artifact', 'ArtifactSlot', 'AttachMethod',
  'BankCondition', 'Beam', 'Behavior', 'Boost', 'Bundle', 'Button', 'Camera', 'Campaign',
  'Character', 'Cliff', 'CliffMesh', 'ColorStyle', 'Commander', 'Config', 'ConsoleSkin',
  'Conversation', 'ConversationState', 'Cursor', 'DSP', 'DataCollection', 'DataCollectionPattern',
  'DecalPack', 'Effect', 'Emoticon', 'EmoticonPack', 'Error', 'Footprint', 'FoW', 'Game',
  'GameUI', 'Herd', 'HerdNode', 'Hero', 'HeroAbil', 'HeroStat', 'Item', 'ItemClass',
  'ItemContainer', 'Kinetic', 'LensFlareSet', 'Light', 'Location', 'Loot', 'Map', 'Model',
  'Mount', 'Mover', 'Objective', 'PhysicsMaterial', 'Ping', 'PlayerResponse', 'PortraitPack',
  'Preload', 'PremiumMap', 'Race', 'RaceBannerPack', 'Requirement', 'RequirementNode', 'Reverb',
  'Reward', 'ScoreResult', 'ScoreValue', 'Shape', 'Skin', 'SkinPack', 'Sound', 'SoundExclusivity',
  'SoundMixSnapshot', 'Soundtrack', 'Spray', 'SprayPack', 'StimPack', 'TacCooldown', 'Tactical',
  'Talent', 'TalentProfile', 'TargetFind', 'TargetSort', 'Terrain', 'TerrainObject', 'TerrainTex',
  'Texture', 'TextureSheet', 'Tile', 'Trophy', 'Turret', 'Unit', 'Upgrade', 'User', 'Validator',
  'VoiceOver', 'VoicePack', 'WarChest', 'WarChestSeason', 'Water', 'Weapon',
]);

const DOMAIN_SET = new Set(CATALOG_DOMAINS);

/** Splits `AbilEffectInstant` into `['Abil', 'Effect', 'Instant']`. */
function splitSubwords(name: string): string[] {
  return name.split(/(?=[A-Z])/).filter((part) => part !== '');
}

/**
 * Derives the domain from a catalog element name.
 *
 * `CAbilEffectInstant` → `Abil`: strip the leading `C`, then drop trailing subwords until
 * what remains is a known domain. Longest match wins, so `CActorSupport…` resolves to
 * `ActorSupport` rather than `Actor`.
 *
 * Returns `null` for an element that is not a catalog entry at all, or whose domain this
 * build does not know.
 */
export function domainFromElementName(elementName: string): string | null {
  if (!elementName.startsWith('C') || elementName.length < 2) return null;

  const subwords = splitSubwords(elementName.slice(1));
  if (subwords.length === 0) return null;

  for (let length = subwords.length; length >= 1; length -= 1) {
    const candidate = subwords.slice(0, length).join('');
    if (DOMAIN_SET.has(candidate)) return candidate;
  }
  return null;
}

/** True when an element name looks like a catalog entry declaration. */
export function isCatalogElementName(elementName: string): boolean {
  return /^C[A-Z]/.test(elementName);
}

export function isKnownDomain(domain: string): boolean {
  return DOMAIN_SET.has(domain);
}
