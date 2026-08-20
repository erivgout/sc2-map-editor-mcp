import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(repoRoot, 'apps', 'sc2-mcp-server', 'dist', 'main.js');
const mapsRoot = process.env.SC2MCP_GAUNTLET_MAPS_ROOT ?? process.env.SC2MCP_ALLOWED_ROOTS?.split(path.delimiter)[0];
if (mapsRoot === undefined || mapsRoot.length === 0) {
  throw new Error('Set SC2MCP_GAUNTLET_MAPS_ROOT to the StarCraft II Maps directory.');
}
const stateRoot = path.join(repoRoot, '.gauntlet-mcp-state');
const gauntletLibraryPath = path.join(repoRoot, 'scripts', 'gauntlet', 'LibMCPGauntlet.galaxy');
const gauntletLayoutPath = path.join(repoRoot, 'scripts', 'gauntlet', 'MCPGauntlet.SC2Layout');

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    stderr: 'pipe',
    env: {
      ...process.env,
      SC2MCP_ALLOWED_ROOTS: mapsRoot,
      SC2MCP_WORKSPACE_ROOT: stateRoot,
      SC2MCP_SC2_INSTALL_PATH: process.env.SC2MCP_SC2_INSTALL_PATH ?? 'C:\\Program Files (x86)\\StarCraft II',
      SC2MCP_ALLOW_OVERWRITE: 'true',
      SC2MCP_LOG_LEVEL: 'warn',
    },
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  const client = new Client({ name: 'mcp-gauntlet-acceptance', version: '0.0.0' });
  await client.connect(transport);
  await client.listTools();
  return { client, transport };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const detail = result.structuredContent ?? result.content;
    throw new Error(`${name} failed:\n${JSON.stringify(detail, null, 2)}`);
  }
  return result.structuredContent;
}

async function mutate(client, name, args) {
  process.stderr.write(`[gauntlet] ${name}\n`);
  return call(client, name, { ...args, dry_run: false });
}

const catalogUnits = [
  { id: 'MCPHeroVanguard', parent: 'Marine', actorParent: 'Marine', life: 650, armor: 3, speed: 3.1, hero: true },
  { id: 'MCPHeroArcanist', parent: 'Sentry', actorParent: 'Sentry', life: 520, armor: 2, speed: 3.0, hero: true },
  { id: 'MCPHeroWarden', parent: 'Marauder', actorParent: 'Marauder', life: 760, armor: 5, speed: 2.65, hero: true },
  { id: 'MCPHeroShade', parent: 'Ghost', actorParent: 'Ghost', life: 560, armor: 2, speed: 3.25, hero: true },
  { id: 'MCPEnemySkitter', parent: 'Zergling', actorParent: 'Zergling', life: 90, armor: 0, speed: 3.35 },
  { id: 'MCPEnemyBrute', parent: 'Roach', actorParent: 'Roach', life: 190, armor: 1, speed: 2.45 },
  { id: 'MCPEnemyCaster', parent: 'Hydralisk', actorParent: 'Hydralisk', life: 135, armor: 0, speed: 2.7 },
  { id: 'MCPEnemyEliteJuggernaut', parent: 'Ultralisk', actorParent: 'Ultralisk', life: 520, armor: 4, speed: 2.25 },
  { id: 'MCPEnemyEliteReaver', parent: 'HybridReaver', actorParent: 'HybridReaver', life: 420, armor: 3, speed: 2.55 },
  { id: 'MCPBossBroodmother', parent: 'Queen', actorParent: 'Queen', life: 3200, armor: 4, speed: 2.15 },
  { id: 'MCPBossWarMachine', parent: 'Thor', actorParent: 'Thor', life: 5200, armor: 6, speed: 1.8 },
  { id: 'MCPBossVoidTitan', parent: 'Archon', actorParent: 'Archon', life: 7600, armor: 8, speed: 2.0 },
];

const abilityText = [
  ['Kinetic Burst', 'Blast up to six enemies near Vanguard. Damage scales with level and Arsenal upgrades.'],
  ['Aegis Field', 'Restore life to every living hero. Vitality and Power improve the recovery.'],
  ['Rally Leap', 'Jump back to the arena core. Use it to escape a collapsing gate.'],
  ['Last Stand', 'Release a large shockwave and restore the squad. Long cooldown.'],
  ['Arc Lance', 'Strike three enemies within long range with focused psionic damage.'],
  ['Time Fold', 'Reset Arc Lance and remove five seconds from Gravity Well.'],
  ['Gravity Well', 'Damage every enemy in a medium area around Arcanist.'],
  ['Singularity', 'Detonate a massive area burst around Arcanist. Long cooldown.'],
  ['Seismic Slam', 'Damage every enemy close to Warden.'],
  ['Bulwark Pulse', 'Restore a large amount of life to the whole squad.'],
  ['Challenge Roar', 'Punish every enemy in a wide area and hold the center.'],
  ['Fortress Protocol', 'Heal the squad and discharge a heavy defensive blast.'],
  ['Phase Knives', 'Hit two nearby enemies with high burst damage.'],
  ['Smoke Step', 'Blink to a random safe point around the arena core.'],
  ['Execute', 'Deal extreme damage to one nearby target.'],
  ['Shadow Double', 'Create an allied Ghost that attacks enemies at the arena core.'],
];

const upgradeText = [
  ['Calibrated Arsenal', '+5 ability power. All damaging hero abilities hit harder.'],
  ['Reinforced Core', '+50 maximum life and immediately restore the gained life.'],
  ['Overclocked Systems', 'Reduce ability cooldowns by one second, within each ability minimum.'],
  ['Field Manual', 'Gain two bonus XP from every enemy reward.'],
  ['Reactive Plating', 'Raise hero armor through a player-specific catalog upgrade.'],
  ['Phoenix Protocol', 'Reduce revival time by two seconds, down to four seconds.'],
  ['Salvage Cache', 'Gain 20 XP immediately. This may trigger another level.'],
  ['Perfect Focus', '+3 ability power and one rank of cooldown reduction.'],
];

const unitText = {
  MCPHeroVanguard: ['Vanguard Rook', 'A frontline soldier who mixes close-range bursts, squad healing, mobility, and a last-stand ultimate.'],
  MCPHeroArcanist: ['Arcanist Lyra', 'A psionic controller with long reach, cooldown manipulation, area control, and a singularity ultimate.'],
  MCPHeroWarden: ['Warden Bastion', 'A durable protector built around area pressure, team recovery, and holding the arena core.'],
  MCPHeroShade: ['Shade Vex', 'A mobile assassin who chains precision strikes, blinks, executes priority targets, and summons a double.'],
  MCPEnemySkitter: ['Rift Skitter', 'Fast swarm creature. Weak alone, dangerous in numbers.'],
  MCPEnemyBrute: ['Rift Brute', 'Armored linebreaker with high life.'],
  MCPEnemyCaster: ['Rift Spitter', 'Ranged attacker that pressures heroes behind the front line.'],
  MCPEnemyEliteJuggernaut: ['Elite Juggernaut', 'An elite enemy with heavy armor and exceptional life.'],
  MCPEnemyEliteReaver: ['Elite Reaver', 'An elite hybrid that combines speed with burst damage.'],
  MCPBossBroodmother: ['The Broodmother', 'Wave 4 boss. Each phase calls a larger brood into the arena.'],
  MCPBossWarMachine: ['The War Machine', 'Wave 8 boss. Its phase changes deploy elite siege escorts.'],
  MCPBossVoidTitan: ['The Void Titan', 'Final boss. Each phase combines casters, brutes, and elite hybrids.'],
};

function localizationEntries() {
  const entries = [
    { key: 'UI/MCPGauntlet/Title', value: 'MCP GAUNTLET' },
    { key: 'UI/MCPGauntlet/TitleTooltip', value: 'Cooperative survival roguelite. Defeat twelve waves and all three bosses.' },
    { key: 'UI/MCPGauntlet/Wave', value: 'WAVE 0 / 12' },
    { key: 'UI/MCPGauntlet/WaveTooltip', value: 'Bosses arrive on waves 4, 8, and 12.' },
    { key: 'UI/MCPGauntlet/Status', value: 'READY' },
    { key: 'UI/MCPGauntlet/StatusTooltip', value: 'Your current power or revival countdown.' },
    { key: 'UI/MCPGauntlet/UpgradeTitle', value: 'CHOOSE ONE RANDOMIZED UPGRADE' },
    { key: 'UI/MCPGauntlet/UpgradeTitleTooltip', value: 'Each level offers three synchronized random choices. The game pauses no simulation state.' },
    { key: 'UI/MCPGauntlet/Welcome', value: 'MCP GAUNTLET ONLINE<n/>Hold the core. First wave in six seconds.' },
    { key: 'UI/MCPGauntlet/WaveIncoming', value: 'WAVE INCOMING: ' },
    { key: 'UI/MCPGauntlet/WaveCleared', value: 'WAVE CLEARED<n/>Eight seconds to regroup.' },
    { key: 'UI/MCPGauntlet/BossArrived', value: 'BOSS SIGNATURE DETECTED' },
    { key: 'UI/MCPGauntlet/BossPhaseTwo', value: 'BOSS PHASE TWO<n/>Reinforcements entering all gates.' },
    { key: 'UI/MCPGauntlet/BossPhaseThree', value: 'BOSS FINAL PHASE<n/>Elite reinforcements deployed.' },
    { key: 'UI/MCPGauntlet/LevelUp', value: 'LEVEL UP<n/>Choose one upgrade.' },
    { key: 'UI/MCPGauntlet/UpgradeApplied', value: 'UPGRADE INSTALLED' },
    { key: 'UI/MCPGauntlet/Cooldown', value: 'Ability cooling down.' },
    { key: 'UI/MCPGauntlet/PlayerDown', value: ' is down.' },
    { key: 'UI/MCPGauntlet/Revived', value: 'REVIVAL COMPLETE' },
    { key: 'UI/MCPGauntlet/Victory', value: 'THE VOID TITAN HAS FALLEN<n/>MCP GAUNTLET COMPLETE' },
    { key: 'UI/MCPGauntlet/Defeat', value: 'TEAM WIPED<n/>MCP GAUNTLET FAILED' },
  ];
  for (const [id, [name, tooltip]] of Object.entries(unitText)) {
    entries.push({ key: `Unit/Name/${id}`, value: name });
    entries.push({ key: `Unit/Tooltip/${id}`, value: tooltip });
  }
  abilityText.forEach(([name, tooltip], offset) => {
    const player = Math.floor(offset / 4) + 1;
    const slot = (offset % 4) + 1;
    const id = `MCPAbilityP${player}S${slot}`;
    entries.push({ key: `Button/Name/${id}`, value: name });
    entries.push({ key: `Button/Tooltip/${id}`, value: tooltip });
  });
  upgradeText.forEach(([name, tooltip], index) => {
    entries.push({ key: `Upgrade/Name/${index}`, value: name });
    entries.push({ key: `Upgrade/Tooltip/${index}`, value: tooltip });
    entries.push({ key: `Upgrade/Name/MCPUpgrade${index}`, value: name });
  });
  return entries;
}

async function cleanGameplay(client, workspaceId) {
  const objects = await call(client, 'sc2_list_placed_objects', { workspace_id: workspaceId, limit: 1000 });
  for (const object of objects.objects) {
    if (object.id !== null) {
      await mutate(client, 'sc2_delete_object', { workspace_id: workspaceId, object_id: object.id });
    }
  }
  const regions = await call(client, 'sc2_list_regions', { workspace_id: workspaceId });
  for (const region of regions.regions) {
    if (region.id !== null) {
      await mutate(client, 'sc2_delete_region', { workspace_id: workspaceId, region_id: region.id });
    }
  }
  const triggers = await call(client, 'sc2_list_triggers', { workspace_id: workspaceId, max_depth: 1 });
  for (const root of triggers.tree) {
    await mutate(client, 'sc2_delete_trigger', { workspace_id: workspaceId, id: root.id, parent_id: null });
  }
  const domains = await call(client, 'sc2_list_catalog_domains', { workspace_id: workspaceId });
  for (const { domain } of domains.present) {
    const search = await call(client, 'sc2_search_catalog', { workspace_id: workspaceId, domains: [domain], limit: 200 });
    for (const entry of search.results) {
      if (entry.layer === 'document') {
        await mutate(client, 'sc2_delete_catalog_object', {
          workspace_id: workspaceId,
          domain,
          id: entry.id,
          force: true,
        });
      }
    }
  }
}

async function buildCatalog(client, workspaceId) {
  for (const unit of catalogUnits) {
    await mutate(client, 'sc2_create_catalog_object', {
      workspace_id: workspaceId,
      ctype: 'CUnit',
      id: unit.id,
      parent: unit.parent,
      file: 'Base.SC2Data/GameData/UnitData.xml',
    });
    const patches = [
      { op: 'set', path: 'LifeMax', value: String(unit.life) },
      { op: 'set', path: 'LifeStart', value: String(unit.life) },
      { op: 'set', path: 'LifeArmor', value: String(unit.armor) },
      { op: 'set', path: 'Speed', value: String(unit.speed) },
    ];
    if (unit.hero) {
      patches.push(
        { op: 'set', path: 'EnergyMax', value: '200' },
        { op: 'set', path: 'EnergyStart', value: '200' },
        { op: 'set', path: 'FlagArray[Hero]', value: '1' },
      );
    }
    await mutate(client, 'sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Unit',
      id: unit.id,
      patches,
    });
    await mutate(client, 'sc2_create_catalog_object', {
      workspace_id: workspaceId,
      ctype: 'CActorUnit',
      id: `${unit.id}Actor`,
      parent: 'GenericUnitBase',
      attributes: { unitName: unit.id },
      file: 'Base.SC2Data/GameData/ActorData.xml',
    });
    await mutate(client, 'sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Actor',
      id: `${unit.id}Actor`,
      patches: [{ op: 'set', path: 'Model', value: unit.actorParent }],
    });
  }
  for (let offset = 0; offset < abilityText.length; offset += 1) {
    const player = Math.floor(offset / 4) + 1;
    const slot = (offset % 4) + 1;
    const id = `MCPAbilityP${player}S${slot}`;
    await mutate(client, 'sc2_create_catalog_object', {
      workspace_id: workspaceId,
      ctype: 'CButton',
      id,
      file: 'Base.SC2Data/GameData/ButtonData.xml',
    });
    await mutate(client, 'sc2_patch_catalog_object', {
      workspace_id: workspaceId,
      domain: 'Button',
      id,
      patches: [{ op: 'set', path: 'Icon', value: 'Assets\\Textures\\btn-ability-terran-spectre-psioniclash.dds' }],
    });
  }
  for (let index = 0; index < upgradeText.length; index += 1) {
    await mutate(client, 'sc2_create_catalog_object', {
      workspace_id: workspaceId,
      ctype: 'CUpgrade',
      id: `MCPUpgrade${index}`,
      file: 'Base.SC2Data/GameData/UpgradeData.xml',
    });
  }
}

async function buildMapData(client, workspaceId) {
  const regions = [
    ['MCP Arena', '128,128', '58'],
    ['MCP Sanctum', '128,128', '12'],
    ['North Rift Gate', '128,184', '8'],
    ['East Rift Gate', '184,128', '8'],
    ['South Rift Gate', '128,72', '8'],
    ['West Rift Gate', '72,128', '8'],
    ['Player One Pad', '124,131', '4'],
    ['Player Two Pad', '128,131', '4'],
    ['Player Three Pad', '124,125', '4'],
    ['Player Four Pad', '128,125', '4'],
  ];
  for (const [name, center, radius] of regions) {
    await mutate(client, 'sc2_create_region', {
      workspace_id: workspaceId,
      name,
      shape: { type: 'circle', values: { center, radius } },
    });
  }
  const points = [
    ['Gauntlet Core', '128,128,0'],
    ['North Gate', '128,184,0'],
    ['East Gate', '184,128,0'],
    ['South Gate', '128,72,0'],
    ['West Gate', '72,128,0'],
    ['Hero Pad 1', '124,131,0'],
    ['Hero Pad 2', '128,131,0'],
    ['Hero Pad 3', '124,125,0'],
    ['Hero Pad 4', '128,125,0'],
  ];
  for (const [name, position] of points) {
    await mutate(client, 'sc2_place_object', {
      workspace_id: workspaceId,
      kind: 'ObjectPoint',
      type: 'Normal',
      position,
      attributes: { Name: name, Color: '0,255,255,255' },
    });
  }
  const terrainVertices = [
    [128, 128, 8.8],
    [124, 124, 8.6], [128, 124, 8.6], [132, 124, 8.6],
    [124, 128, 8.6], [132, 128, 8.6],
    [124, 132, 8.6], [128, 132, 8.6], [132, 132, 8.6],
    [128, 176, 8.4], [124, 180, 8.5], [128, 180, 8.6], [132, 180, 8.5], [128, 184, 8.4],
    [176, 128, 8.4], [180, 124, 8.5], [180, 128, 8.6], [180, 132, 8.5], [184, 128, 8.4],
    [128, 80, 8.4], [124, 76, 8.5], [128, 76, 8.6], [132, 76, 8.5], [128, 72, 8.4],
    [80, 128, 8.4], [76, 124, 8.5], [76, 128, 8.6], [76, 132, 8.5], [72, 128, 8.4],
  ];
  for (const [x, y, worldHeight] of terrainVertices) {
    await mutate(client, 'sc2_set_terrain_height', {
      workspace_id: workspaceId,
      x,
      y,
      world_height: worldHeight,
    });
  }
}

async function build(sourceName = 'Blank.SC2Map') {
  const { client } = await connect();
  try {
    const opened = await call(client, 'sc2_open_document', { source_path: path.join(mapsRoot, sourceName) });
    const workspaceId = opened.workspace.id;
    process.stderr.write(`[gauntlet] workspace ${workspaceId}\n`);
    await call(client, 'sc2_create_snapshot', { workspace_id: workspaceId, label: 'source before MCP Gauntlet acceptance build' });
    await cleanGameplay(client, workspaceId);
    await mutate(client, 'sc2_set_map_player_slots', {
      workspace_id: workspaceId,
      max_players: 4,
      remove_computer_players: true,
    });
    await call(client, 'sc2_create_snapshot', { workspace_id: workspaceId, label: 'blank map shell' });

    await mutate(client, 'sc2_set_document_info', { workspace_id: workspaceId, field: 'Name', value: 'MCP Gauntlet' });
    await mutate(client, 'sc2_set_document_info', { workspace_id: workspaceId, field: 'Author', value: 'OpenAI Codex via SC2 Map Editor MCP' });
    await mutate(client, 'sc2_set_document_info', {
      workspace_id: workspaceId,
      field: 'Description',
      value: 'A 1-4 player cooperative survival roguelite with four heroes, randomized upgrades, elites, and three multi-phase bosses.',
    });
    const dependencies = await call(client, 'sc2_get_dependencies', { workspace_id: workspaceId });
    if (!dependencies.dependencies.some((dependency) => dependency.file === 'Mods/VoidMulti.SC2Mod')) {
      await mutate(client, 'sc2_add_dependency', {
        workspace_id: workspaceId,
        dependency: 'bnet:Void Multi (Mod)/0.0/999,file:Mods/VoidMulti.SC2Mod',
      });
    }

    await buildMapData(client, workspaceId);
    await buildCatalog(client, workspaceId);
    await mutate(client, 'sc2_set_text_value', {
      workspace_id: workspaceId,
      locale: 'enUS',
      table: 'GameStrings',
      entries: localizationEntries(),
    });

    const layoutContent = await readFile(gauntletLayoutPath, 'utf8');
    await mutate(client, 'sc2_create_layout', {
      workspace_id: workspaceId,
      path: 'Base.SC2Data/UI/Layout/MCPGauntlet.SC2Layout',
      content: layoutContent,
    });
    await mutate(client, 'sc2_add_component', {
      workspace_id: workspaceId,
      type_code: 'layo',
      path: 'Base.SC2Data/UI/Layout/MCPGauntlet.SC2Layout',
    });

    const galaxyContent = await readFile(gauntletLibraryPath, 'utf8');
    await mutate(client, 'sc2_create_galaxy_file', {
      workspace_id: workspaceId,
      path: 'Base.SC2Data/LibMCPGauntlet.galaxy',
      content: galaxyContent,
    });
    await mutate(client, 'sc2_set_galaxy_entrypoint', {
      workspace_id: workspaceId,
      library_path: 'Base.SC2Data/LibMCPGauntlet.galaxy',
      init_function: 'MCPG_Init',
    });

    const galaxy = await call(client, 'sc2_get_galaxy_diagnostics', { workspace_id: workspaceId });
    const validation = await call(client, 'sc2_validate_document', { workspace_id: workspaceId, include_warnings: true });
    const missing = await call(client, 'sc2_find_missing_localization', {
      workspace_id: workspaceId,
      domains: ['Unit', 'Button', 'Upgrade'],
      locale: 'enUS',
      table: 'GameStrings',
      limit: 200,
    });
    if (galaxy.errorCount !== 0 || !validation.valid || missing.total !== 0) {
      throw new Error(`Preflight failed:\n${JSON.stringify({ galaxy, validation, missing }, null, 2)}`);
    }
    await call(client, 'sc2_create_snapshot', { workspace_id: workspaceId, label: 'validated MCP Gauntlet build' });
    const outputPath = path.join(mapsRoot, 'MCP Gauntlet.SC2Map');
    const committed = await call(client, 'sc2_commit_document', {
      workspace_id: workspaceId,
      output_path: outputPath,
      overwrite: true,
      backup: false,
    });
    process.stdout.write(`${JSON.stringify({ workspaceId, outputPath, galaxy, validation, missing, committed }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

async function testMap(documentName = 'MCP Gauntlet.SC2Map') {
  const { client } = await connect();
  try {
    const launch = await call(client, 'sc2_test_document', {
      document_path: path.join(mapsRoot, documentName),
      startup_timeout_ms: 60_000,
    });
    process.stdout.write(`${JSON.stringify({ event: 'launch', launch })}\n`);
    for (let attempt = 0; attempt < 36; attempt += 1) {
      await delay(5_000);
      const status = await call(client, 'sc2_get_last_test_log');
      process.stdout.write(`${JSON.stringify({
        event: 'status',
        attempt,
        run: status.run,
        diagnostics: status.diagnostics,
        logs: status.logs,
        alertsContent: status.alertsContent,
        scriptErrorContent: status.scriptErrorContent,
      })}\n`);
      if (status.run?.status === 'exited') {
        break;
      }
    }
  } finally {
    await client.close();
  }
}

async function lastTestLog() {
  const { client } = await connect();
  try {
    const status = await call(client, 'sc2_get_last_test_log');
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

async function inspect(sourceName) {
  const { client } = await connect();
  try {
    const info = await call(client, 'sc2_get_server_info');
    const opened = await call(client, 'sc2_open_document', {
      source_path: path.join(mapsRoot, sourceName),
    });
    const workspaceId = opened.workspace.id;
    const summary = await call(client, 'sc2_get_document_summary', { workspace_id: workspaceId });
    const dependencies = await call(client, 'sc2_get_dependencies', { workspace_id: workspaceId });
    const domains = await call(client, 'sc2_list_catalog_domains', { workspace_id: workspaceId });
    const objects = await call(client, 'sc2_list_placed_objects', { workspace_id: workspaceId, limit: 1000 });
    let regions = { regions: [] };
    try {
      regions = await call(client, 'sc2_list_regions', { workspace_id: workspaceId });
    } catch (error) {
      regions = { regions: [], error: error.message };
    }
    const scripts = await call(client, 'sc2_list_galaxy_files', { workspace_id: workspaceId });
    const layouts = await call(client, 'sc2_list_layouts', { workspace_id: workspaceId });
    const triggers = await call(client, 'sc2_list_triggers', { workspace_id: workspaceId });
    const terrain = await call(client, 'sc2_get_terrain_summary', { workspace_id: workspaceId });
    const mapPlayers = await call(client, 'sc2_get_map_players', { workspace_id: workspaceId });
    const validation = await call(client, 'sc2_validate_document', { workspace_id: workspaceId });
    process.stdout.write(`${JSON.stringify({
      sourceName,
      workspaceId,
      capabilities: info.capabilities,
      limitations: info.limitations,
      summary,
      dependencies,
      domains,
      objects: {
        total: objects.total,
        countsByKind: objects.countsByKind,
        ids: objects.objects.map((object) => ({ id: object.id, kind: object.kind, type: object.type, position: object.position })),
      },
      regions: {
        total: regions.regions.length,
        error: regions.error,
        ids: regions.regions.map((region) => ({ id: region.id, name: region.name, shapeType: region.shapeType, shape: region.shape })),
      },
      scripts,
      layouts,
      triggers: {
        elementCount: triggers.elementCount,
        countsByType: triggers.countsByType,
        danglingIds: triggers.danglingIds,
        roots: triggers.tree.map((entry) => ({ id: entry.id, type: entry.type, name: entry.name })),
      },
      terrain,
      mapPlayers,
      validation,
    }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

const [command = 'inspect', sourceName] = process.argv.slice(2);
if (command === 'inspect') {
  await inspect(sourceName ?? 'MCP Gauntlet.SC2Map');
}
else if (command === 'build') {
  await build(sourceName ?? 'Blank.SC2Map');
}
else if (command === 'test') {
  await testMap(sourceName ?? 'MCP Gauntlet.SC2Map');
}
else if (command === 'logs') {
  await lastTestLog();
}
else {
  throw new Error(`Unknown command: ${command}`);
}
