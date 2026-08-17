/**
 * Localization discovery across a staged document (PLAN.md §22).
 *
 * Text lives at `<locale>.SC2Data/LocalizedData/<Table>.txt`. The locale is the layer
 * directory's prefix, so it comes from the path rather than from any header inside the
 * file.
 */

export const LOCALIZED_DATA_DIRECTORY = 'localizeddata';

export interface TextTableLocation {
  /** Archive-style path, e.g. `enUS.SC2Data/LocalizedData/GameStrings.txt`. */
  readonly path: string;
  /** Locale from the layer directory, e.g. `enUS`. */
  readonly locale: string;
  /** Table name without the extension, e.g. `GameStrings`. */
  readonly table: string;
  readonly sizeBytes: number;
}

/**
 * Picks the localized text tables out of a staged file listing.
 *
 * Anything under a `*.SC2Data/LocalizedData/` directory with a `.txt` extension counts.
 * A file elsewhere is not a text table no matter what it is called.
 */
export function findTextTables(files: readonly { relativePath: string; size: number }[]): TextTableLocation[] {
  const tables: TextTableLocation[] = [];

  for (const file of files) {
    const segments = file.relativePath.split('/');
    if (segments.length < 3) continue;

    const layer = segments[0] ?? '';
    if (!layer.toLowerCase().endsWith('.sc2data')) continue;
    if ((segments[1] ?? '').toLowerCase() !== LOCALIZED_DATA_DIRECTORY) continue;

    const fileName = segments[segments.length - 1] ?? '';
    if (!fileName.toLowerCase().endsWith('.txt')) continue;

    tables.push({
      path: file.relativePath,
      locale: layer.slice(0, layer.length - '.SC2Data'.length),
      table: fileName.slice(0, fileName.length - '.txt'.length),
      sizeBytes: file.size,
    });
  }

  tables.sort((left, right) => left.path.localeCompare(right.path));
  return tables;
}

/** Distinct locales present, sorted. `Base` is excluded — it holds no localized text. */
export function localesFrom(tables: readonly TextTableLocation[]): string[] {
  return [...new Set(tables.map((table) => table.locale))].filter((locale) => locale.toLowerCase() !== 'base').sort();
}
