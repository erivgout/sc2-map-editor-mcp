import { describe, expect, it } from 'vitest';

import { SC2Error } from '../errors.js';
import { renderGalaxyEntrypoint } from './entrypoint.js';

describe('renderGalaxyEntrypoint', () => {
  it('includes one authored library and calls its initializer', () => {
    const entrypoint = renderGalaxyEntrypoint('Base.SC2Data\\LibMCPGauntlet.galaxy', 'MCPG_Init');

    expect(entrypoint.includePath).toBe('Base.SC2Data/LibMCPGauntlet');
    expect(entrypoint.content).toContain('include "TriggerLibs/NativeLib"');
    expect(entrypoint.content).toContain('include "Base.SC2Data/LibMCPGauntlet"');
    expect(entrypoint.content).toContain('    MCPG_Init();');
    expect(entrypoint.content).not.toContain('InitTriggers');
  });

  it('refuses self-inclusion, non-Galaxy files, and invalid function names', () => {
    expect(() => renderGalaxyEntrypoint('MapScript.galaxy', 'Init')).toThrow(SC2Error);
    expect(() => renderGalaxyEntrypoint('Base.SC2Data/Library.txt', 'Init')).toThrow(SC2Error);
    expect(() => renderGalaxyEntrypoint('Base.SC2Data/Library.galaxy', 'bad();')).toThrow(SC2Error);
  });
});
