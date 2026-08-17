/**
 * `DocumentInfo` (PLAN.md §24, §25).
 *
 * Verified against the unpacked `EditorTest.SC2Map` from a retail StarCraft II
 * installation. The real shape wraps every scalar in a `<Value>` element:
 *
 * ```xml
 * <DocInfo>
 *     <ModType><Value>Interface</Value></ModType>
 *     <Dependencies>
 *         <Value>bnet:Void Multi (Mod)/0.0/999,file:Mods/VoidMulti.SC2Mod</Value>
 *     </Dependencies>
 *     <Screenshot>
 *         <File><Value>unknown[2].tga</Value></File>
 *         <CaptionId><Value>1</Value></CaptionId>
 *     </Screenshot>
 * </DocInfo>
 * ```
 *
 * Fields vary by document: the sample above has no `<Name>` or `<Author>` at all. So
 * every field here is nullable, and absence is reported as `null` rather than an empty
 * string — "not set" and "set to nothing" are different, and only one of them is a bug.
 */

import { SC2Error } from '../errors.js';
import { childElements, deepTextContent, firstChild, parseXml, textContent } from '../xml/parse.js';

export const DOCUMENT_INFO_FILENAME = 'DocumentInfo';

/**
 * One entry from `<Dependencies>`.
 *
 * The raw form is `bnet:<Name>/<Major>.<Minor>/<Build>,file:<path>` — a Battle.net
 * identity paired with a local file fallback. Both halves are kept alongside the
 * original string, because dependency order and exact spelling determine which archive
 * supplies a GameData value (PLAN.md §25), and a normalised-only view would lose that.
 */
export interface DocumentDependency {
  /** The entry exactly as written. */
  readonly raw: string;
  /** The `bnet:` half, e.g. `Void Multi (Mod)/0.0/999`, or `null` if absent. */
  readonly bnet: string | null;
  /** The `file:` half, e.g. `Mods/VoidMulti.SC2Mod`, or `null` if absent. */
  readonly file: string | null;
  /** Display name parsed out of the bnet identity, when there is one. */
  readonly name: string | null;
}

export interface DocumentScreenshot {
  readonly file: string | null;
  readonly captionId: string | null;
  readonly flags: string | null;
}

export interface DocumentInfo {
  readonly name: string | null;
  readonly author: string | null;
  readonly modType: string | null;
  readonly icon: string | null;
  readonly description: string | null;
  /** In declaration order, which is the dependency resolution order. */
  readonly dependencies: readonly DocumentDependency[];
  readonly screenshot: DocumentScreenshot | null;
  readonly screenshotHowToPlay: DocumentScreenshot | null;
  /**
   * Top-level elements this parser does not model, with their text.
   *
   * Surfaced rather than dropped so a caller can see there is more in the file than we
   * understand (PLAN.md §47).
   */
  readonly unrecognizedFields: Readonly<Record<string, string>>;
}

/** Reads `<Field><Value>text</Value></Field>`, the shape every scalar uses. */
function readValue(parent: ReturnType<typeof parseXml>['root'], fieldName: string): string | null {
  if (parent === null) return null;
  const field = firstChild(parent, fieldName);
  if (field === null) return null;
  const valueElement = firstChild(field, 'Value');
  if (valueElement === null) return null;
  const text = textContent(valueElement);
  // Whitespace-only values appear in real files (e.g. `<Flags><Value> </Value></Flags>`)
  // and are meaningfully different from an absent element, so they are not trimmed away
  // into null.
  return text;
}

function parseDependency(raw: string): DocumentDependency {
  let bnet: string | null = null;
  let file: string | null = null;

  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('bnet:')) bnet = trimmed.slice('bnet:'.length);
    else if (trimmed.startsWith('file:')) file = trimmed.slice('file:'.length);
  }

  // `Void Multi (Mod)/0.0/999` -> `Void Multi (Mod)`. Split on the first `/` only:
  // display names themselves can contain slashes.
  const name = bnet === null ? null : (bnet.split('/')[0] ?? null);

  return { raw, bnet, file, name };
}

function parseScreenshot(parent: ReturnType<typeof parseXml>['root'], fieldName: string): DocumentScreenshot | null {
  if (parent === null) return null;
  const element = firstChild(parent, fieldName);
  if (element === null) return null;
  return {
    file: readValue(element, 'File'),
    captionId: readValue(element, 'CaptionId'),
    flags: readValue(element, 'Flags'),
  };
}

const MODELLED_FIELDS = new Set([
  'Name',
  'Author',
  'ModType',
  'Icon',
  'Description',
  'Dependencies',
  'Screenshot',
  'ScreenshotHowToPlay',
]);

export function parseDocumentInfo(source: string): DocumentInfo {
  const document = parseXml(source, { path: DOCUMENT_INFO_FILENAME });
  const root = document.root;

  if (root?.name !== 'DocInfo') {
    throw new SC2Error('SC2_PARSE_ERROR', `${DOCUMENT_INFO_FILENAME} must have a <DocInfo> root element.`, {
      path: DOCUMENT_INFO_FILENAME,
      recoverable: false,
      context: { foundRoot: root?.name ?? null },
    });
  }

  const dependenciesElement = firstChild(root, 'Dependencies');
  const dependencies =
    dependenciesElement === null
      ? []
      : childElements(dependenciesElement, 'Value')
          .map((value) => textContent(value).trim())
          .filter((raw) => raw !== '')
          .map(parseDependency);

  const unrecognizedFields: Record<string, string> = {};
  for (const child of childElements(root)) {
    if (MODELLED_FIELDS.has(child.name)) continue;
    // Deep text, because these fields use the same `<Field><Value>…</Value></Field>`
    // nesting as the modelled ones; direct text alone would report every one as empty.
    unrecognizedFields[child.name] = deepTextContent(child);
  }

  return {
    name: readValue(root, 'Name'),
    author: readValue(root, 'Author'),
    modType: readValue(root, 'ModType'),
    icon: readValue(root, 'Icon'),
    description: readValue(root, 'Description'),
    dependencies,
    screenshot: parseScreenshot(root, 'Screenshot'),
    screenshotHowToPlay: parseScreenshot(root, 'ScreenshotHowToPlay'),
    unrecognizedFields,
  };
}
