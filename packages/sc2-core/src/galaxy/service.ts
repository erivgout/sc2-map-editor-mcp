/**
 * Galaxy files in a staged document (PLAN.md §20).
 *
 * SC2 keeps Galaxy in two very different roles, and conflating them is how a tool
 * destroys someone's triggers:
 *
 *  - `MapScript.galaxy` at the document root is **generated** from the trigger data. It is
 *    overwritten wholesale every time the editor saves triggers, so hand-editing it is
 *    pointless at best.
 *  - `*.SC2Data/*.galaxy` are **authored** libraries, which is what a caller means by
 *    "the map's script".
 *
 * Both are listed, and each is labelled, so the distinction is impossible to miss.
 */

export const GENERATED_MAP_SCRIPT = 'mapscript.galaxy';

export interface GalaxyFileLocation {
  readonly path: string;
  readonly sizeBytes: number;
  /** True for `MapScript.galaxy`, which the editor regenerates from trigger data. */
  readonly generated: boolean;
}

/** Picks Galaxy scripts out of a staged file listing. */
export function findGalaxyFiles(files: readonly { relativePath: string; size: number }[]): GalaxyFileLocation[] {
  const found = files
    .filter((file) => file.relativePath.toLowerCase().endsWith('.galaxy'))
    .map((file) => ({
      path: file.relativePath,
      sizeBytes: file.size,
      generated: file.relativePath.toLowerCase() === GENERATED_MAP_SCRIPT,
    }));

  found.sort((left, right) => left.path.localeCompare(right.path));
  return found;
}
