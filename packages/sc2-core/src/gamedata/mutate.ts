/**
 * GameData mutation (PLAN.md §18).
 *
 * Turns SC2-aware patch operations into byte-level edits through {@link XmlEditor}, so a
 * one-field change produces a one-line diff in a 220 KB catalog file rather than a
 * wholesale rewrite.
 *
 * This module computes *what the file should become*. It does not write anything —
 * applying, snapshotting, and rolling back are the transaction engine's job.
 */

import { SC2Error } from '../errors.js';
import { XmlEditor, expandSelfClosingElement } from '../xml/edit.js';
import { attributeValue, childElements, escapeAttribute, parseXml, type XmlElement } from '../xml/parse.js';
import { domainFromElementName } from './domains.js';
import { formatFieldPath, lookupField, nextArrayIndex, parseFieldPath, type FieldPathSegment } from './fieldPath.js';

/**
 * A single patch operation.
 *
 * Kept small and SC2-shaped on purpose. Every operation names a field path, so its effect
 * is analysable before it runs.
 */
export type CatalogPatch =
  /** Set the `value` attribute, creating the field if it is absent. */
  | { readonly op: 'set'; readonly path: string; readonly value: string }
  /** Set the `Link` attribute (a reference to another catalog object). */
  | { readonly op: 'set_link'; readonly path: string; readonly value: string }
  /** Set any other attribute by name, for fields this model does not handle specially. */
  | { readonly op: 'set_attribute'; readonly path: string; readonly attribute: string; readonly value: string }
  /** Remove the addressed field entirely. */
  | { readonly op: 'remove'; readonly path: string }
  /** Append a new numerically-indexed array element. `path` names the array field. */
  | {
      readonly op: 'append_array';
      readonly path: string;
      readonly value?: string | undefined;
      readonly link?: string | undefined;
    };

export interface PatchOutcome {
  /** The file's new contents. Identical to the input when nothing changed. */
  readonly content: string;
  /** One line per applied operation, for the change summary. */
  readonly summary: string[];
  /** Operations that were already satisfied, so did nothing. */
  readonly noOps: string[];
}

/** Finds the element declaring `(domain, id)` inside a parsed catalog document. */
export function findEntryElement(root: XmlElement, domain: string, id: string): XmlElement | null {
  for (const element of childElements(root)) {
    if (attributeValue(element, 'id') !== id) continue;
    if (domainFromElementName(element.name) !== domain) continue;
    return element;
  }
  return null;
}

/** Renders a field element, matching the `<Name index="…" value="…"/>` shape SC2 uses. */
function renderField(name: string, options: { index?: string | undefined; value?: string | undefined; link?: string | undefined }): string {
  const attributes: string[] = [];
  if (options.index !== undefined) attributes.push(`index="${escapeAttribute(options.index)}"`);
  if (options.value !== undefined) attributes.push(`value="${escapeAttribute(options.value)}"`);
  if (options.link !== undefined) attributes.push(`Link="${escapeAttribute(options.link)}"`);
  return `<${name}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}/>`;
}

function setOrAddAttribute(editor: XmlEditor, element: XmlElement, attribute: string, value: string): boolean {
  const existing = element.attributes.find((candidate) => candidate.name === attribute);
  if (existing !== undefined) {
    if (existing.value === value) return false; // Already correct; do not manufacture a diff.
    editor.setAttributeValue(element, attribute, value);
    return true;
  }
  editor.addAttribute(element, attribute, value);
  return true;
}

/**
 * Applies patch operations to one catalog file.
 *
 * @param source The catalog file's current contents.
 * @param domain Catalog domain of the object being patched.
 * @param id Object id.
 * @throws SC2Error when the object or an intermediate path segment does not exist.
 */
export function applyCatalogPatches(
  source: string,
  domain: string,
  id: string,
  patches: readonly CatalogPatch[],
  sourcePath: string,
): PatchOutcome {
  const summary: string[] = [];
  const noOps: string[] = [];

  // Each patch is applied against a freshly parsed copy of the previous result. Structural
  // work — expanding `<X/>` into `<X>…</X>`, materialising a missing container — changes the
  // spans every later edit is addressed by, so batching them into one buffer would either
  // collide or write to stale offsets.
  let current = source;
  for (const patch of patches) {
    current = applyOnePatch(current, domain, id, patch, sourcePath, summary, noOps);
  }

  return { content: current, summary, noOps };
}

/** Finds the entry being patched, or explains which part of the address failed. */
function locateEntry(source: string, domain: string, id: string, sourcePath: string): XmlElement {
  const document = parseXml(source, { path: sourcePath });
  if (document.root === null) {
    throw new SC2Error('SC2_PARSE_ERROR', `${sourcePath} has no root element.`, { path: sourcePath, recoverable: false });
  }

  const entryElement = findEntryElement(document.root, domain, id);
  if (entryElement === null) {
    throw new SC2Error('SC2_NOT_FOUND', `${sourcePath} does not declare ${domain}/${id}.`, {
      path: sourcePath,
      objectId: `${domain}/${id}`,
      recoverable: true,
    });
  }
  return entryElement;
}

/**
 * Guarantees the element that will hold `segments`' final field exists and can take
 * children, creating missing containers and expanding self-closing ones as needed.
 *
 * This is what makes the create-then-patch workflow work: a freshly created
 * `<CUnit id="X" parent="Y"/>` has no content, and every field added to it afterwards
 * needs the open/close form first.
 */
function ensureHolder(
  source: string,
  domain: string,
  id: string,
  segments: readonly FieldPathSegment[],
  sourcePath: string,
  summary: string[],
): string {
  const holderSegments = segments.slice(0, -1);

  for (;;) {
    const entry = locateEntry(source, domain, id, sourcePath);
    const lookup = lookupField(entry, holderSegments);
    const holder = holderSegments.length === 0 ? entry : lookup.element;

    if (holder !== null) {
      if (!holder.selfClosing) return source;
      source = expandSelfClosingElement(source, holder);
      continue;
    }

    // A container along the way is missing. Create the shallowest one and go round again;
    // the next pass either finds it or expands it.
    if (lookup.parent.selfClosing) {
      source = expandSelfClosingElement(source, lookup.parent);
      continue;
    }

    const resolved = lookup.resolvedSegments.length;
    const missing = holderSegments[resolved];
    if (missing === undefined) {
      throw new SC2Error('SC2_INTERNAL_ERROR', `Could not resolve a holder for a patch on ${domain}/${id}.`, {
        objectId: `${domain}/${id}`,
        recoverable: false,
      });
    }

    const editor = new XmlEditor(source);
    editor.appendChild(
      lookup.parent,
      renderField(missing.name, { index: missing.index ?? undefined }),
      `create ${missing.name}`,
    );
    summary.push(`created ${domain}/${id}.${formatFieldPath(holderSegments.slice(0, resolved + 1))}`);
    source = editor.apply();
  }
}

/** Applies one patch to a parsed copy of `source` and returns the new contents. */
function applyOnePatch(
  source: string,
  domain: string,
  id: string,
  patch: CatalogPatch,
  sourcePath: string,
  summary: string[],
  noOps: string[],
): string {
  const segments = parseFieldPath(patch.path);
  if (segments.length === 0) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Empty field path in a patch for ${domain}/${id}.`, { recoverable: true });
  }

  // Removing never adds structure, so it is resolved against the source as it stands.
  if (patch.op === 'remove') {
    const entry = locateEntry(source, domain, id, sourcePath);
    const found = lookupField(entry, segments).element;
    if (found === null) {
      noOps.push(`${domain}/${id}.${patch.path} does not exist; nothing to remove`);
      return source;
    }
    const editor = new XmlEditor(source);
    editor.removeElement(found, `remove ${patch.path}`);
    summary.push(`removed ${domain}/${id}.${patch.path}`);
    return editor.apply();
  }

  source = ensureHolder(source, domain, id, segments, sourcePath, summary);

  const entryElement = locateEntry(source, domain, id, sourcePath);
  const lookup = lookupField(entryElement, segments);
  const editor = new XmlEditor(source);

  switch (patch.op) {
      case 'set':
      case 'set_link':
      case 'set_attribute': {
        const attribute = patch.op === 'set' ? 'value' : patch.op === 'set_link' ? 'Link' : patch.attribute;

        if (lookup.element === null) {
          const last = segments.at(-1);
          if (last === undefined) {
            throw new SC2Error('SC2_INVALID_ARGUMENT', `Empty field path in a patch for ${domain}/${id}.`, {
              recoverable: true,
            });
          }
          const rendered = renderField(last.name, {
            index: last.index ?? undefined,
            ...(attribute === 'value' ? { value: patch.value } : {}),
            ...(attribute === 'Link' ? { link: patch.value } : {}),
          });

          // A non-standard attribute on a field that does not exist yet would need a
          // shape this renderer cannot express; refuse rather than guess at it.
          if (attribute !== 'value' && attribute !== 'Link') {
            throw new SC2Error(
              'SC2_UNSUPPORTED_OPERATION',
              `Cannot create field "${patch.path}" with attribute "${attribute}"; only value and Link fields can be created.`,
              { objectId: `${domain}/${id}`, recoverable: true },
            );
          }

          editor.appendChild(lookup.parent, rendered, `create ${patch.path} = ${patch.value}`);
          summary.push(`created ${domain}/${id}.${patch.path} = ${patch.value}`);
          break;
        }

        const previous = attributeValue(lookup.element, attribute) ?? '(unset)';
        if (setOrAddAttribute(editor, lookup.element, attribute, patch.value)) {
          summary.push(`set ${domain}/${id}.${patch.path}@${attribute}: ${previous} -> ${patch.value}`);
        } else {
          noOps.push(`${domain}/${id}.${patch.path}@${attribute} is already ${patch.value}`);
        }
        break;
      }

      case 'append_array': {
        if (patch.value === undefined && patch.link === undefined) {
          throw new SC2Error('SC2_INVALID_ARGUMENT', 'append_array needs a value or a link.', { recoverable: true });
        }

        // The array field itself is addressed without an index; the new element gets one.
        const last = segments.at(-1);
        if (last === undefined) {
          throw new SC2Error('SC2_INVALID_ARGUMENT', `Empty field path in a patch for ${domain}/${id}.`, {
            recoverable: true,
          });
        }
        if (last.index !== null) {
          throw new SC2Error(
            'SC2_INVALID_ARGUMENT',
            `append_array takes the array's name without an index; got "${patch.path}".`,
            { recoverable: true, suggestedAction: 'Use "WeaponArray" rather than "WeaponArray[0]".' },
          );
        }

        const container = segments.length === 1 ? entryElement : lookupField(entryElement, segments.slice(0, -1)).element;
        if (container === null) {
          throw new SC2Error('SC2_NOT_FOUND', `Cannot reach "${patch.path}" on ${domain}/${id}.`, {
            objectId: `${domain}/${id}`,
            recoverable: true,
          });
        }

        const index = nextArrayIndex(container, last.name);
        const rendered = renderField(last.name, {
          index: String(index),
          ...(patch.value === undefined ? {} : { value: patch.value }),
          ...(patch.link === undefined ? {} : { link: patch.link }),
        });
        editor.appendChild(container, rendered, `append ${patch.path}[${index}]`);
        summary.push(`appended ${domain}/${id}.${last.name}[${index}] = ${patch.link ?? patch.value ?? ''}`);
        break;
      }
  }

  return editor.isEmpty ? source : editor.apply();
}

export interface CloneOutcome {
  readonly content: string;
  readonly summary: string[];
}

/**
 * Clones a catalog entry under a new id, appended after the original.
 *
 * The clone is a byte copy of the source declaration with its `id` replaced, so anything
 * the model does not understand comes along intact (PLAN.md §47). Placing it immediately
 * after the original keeps the diff readable.
 */
export function cloneCatalogEntry(
  source: string,
  domain: string,
  sourceId: string,
  newId: string,
  sourcePath: string,
  options: { readonly newParent?: string | undefined } = {},
): CloneOutcome {
  const document = parseXml(source, { path: sourcePath });
  if (document.root === null) {
    throw new SC2Error('SC2_PARSE_ERROR', `${sourcePath} has no root element.`, { path: sourcePath, recoverable: false });
  }

  const original = findEntryElement(document.root, domain, sourceId);
  if (original === null) {
    throw new SC2Error('SC2_NOT_FOUND', `${sourcePath} does not declare ${domain}/${sourceId}.`, {
      path: sourcePath,
      objectId: `${domain}/${sourceId}`,
      recoverable: true,
    });
  }

  if (findEntryElement(document.root, domain, newId) !== null) {
    throw new SC2Error('SC2_CONFLICT', `${domain}/${newId} already exists in ${sourcePath}.`, {
      path: sourcePath,
      objectId: `${domain}/${newId}`,
      recoverable: true,
      suggestedAction: 'Choose a different id.',
    });
  }

  // Build the clone by editing a copy of just the original's text, so the id (and parent)
  // are replaced without disturbing anything else in the declaration.
  const declaration = source.slice(original.span.start, original.span.end);
  const cloneDocument = parseXml(declaration);
  const cloneRoot = cloneDocument.root;
  if (cloneRoot === null) {
    throw new SC2Error('SC2_INTERNAL_ERROR', 'Could not reparse the declaration being cloned.', { recoverable: false });
  }

  const cloneEditor = new XmlEditor(declaration);
  cloneEditor.setAttributeValue(cloneRoot, 'id', newId);
  if (options.newParent !== undefined) {
    if (cloneRoot.attributes.some((attribute) => attribute.name === 'parent')) {
      cloneEditor.setAttributeValue(cloneRoot, 'parent', options.newParent);
    } else {
      cloneEditor.addAttribute(cloneRoot, 'parent', options.newParent);
    }
  }
  const clonedText = cloneEditor.apply();

  const editor = new XmlEditor(source);
  editor.insertAfter(original, clonedText, `clone ${domain}/${sourceId} as ${newId}`);

  return {
    content: editor.apply(),
    summary: [
      `cloned ${domain}/${sourceId} as ${domain}/${newId} in ${sourcePath}`,
      ...(options.newParent === undefined ? [] : [`set ${domain}/${newId} parent = ${options.newParent}`]),
    ],
  };
}

/**
 * Creates a new, empty catalog entry at the end of a catalog file.
 *
 * Prefers parent-based creation: a `<CUnit id="X" parent="Y"/>` inherits everything from
 * `Y`, which is both what the editor does and what keeps the diff small (PLAN.md §18).
 */
export function createCatalogEntry(
  source: string,
  ctype: string,
  newId: string,
  sourcePath: string,
  options: {
    readonly parent?: string | undefined;
    readonly attributes?: Readonly<Record<string, string>> | undefined;
  } = {},
): CloneOutcome {
  const document = parseXml(source, { path: sourcePath });
  if (document.root?.name !== 'Catalog') {
    throw new SC2Error('SC2_PARSE_ERROR', `${sourcePath} is not a GameData catalog.`, { path: sourcePath, recoverable: false });
  }

  const domain = domainFromElementName(ctype);
  if (domain !== null && findEntryElement(document.root, domain, newId) !== null) {
    throw new SC2Error('SC2_CONFLICT', `${domain}/${newId} already exists in ${sourcePath}.`, {
      path: sourcePath,
      objectId: `${domain}/${newId}`,
      recoverable: true,
    });
  }

  const attributes = [`id="${escapeAttribute(newId)}"`];
  if (options.parent !== undefined) attributes.push(`parent="${escapeAttribute(options.parent)}"`);
  for (const [name, value] of Object.entries(options.attributes ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (name === 'id' || name === 'parent') {
      throw new SC2Error('SC2_INVALID_ARGUMENT', `Catalog entry attribute "${name}" has its own argument.`, {
        path: sourcePath,
        objectId: `${domain ?? '?'}/${newId}`,
        recoverable: true,
      });
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) {
      throw new SC2Error('SC2_INVALID_ARGUMENT', `Invalid XML attribute name: ${name}`, {
        path: sourcePath,
        objectId: `${domain ?? '?'}/${newId}`,
        recoverable: true,
      });
    }
    attributes.push(`${name}="${escapeAttribute(value)}"`);
  }

  const editor = new XmlEditor(source);
  editor.appendChild(document.root, `<${ctype} ${attributes.join(' ')}/>`, `create ${ctype} ${newId}`);

  return {
    content: editor.apply(),
    summary: [
      `created ${domain ?? '?'}/${newId} as <${ctype}>${options.parent === undefined ? '' : ` parent=${options.parent}`}${
        options.attributes === undefined ? '' : ` with ${Object.keys(options.attributes).length} root attribute(s)`
      }`,
    ],
  };
}

/** Removes a catalog entry from a file. */
export function deleteCatalogEntry(source: string, domain: string, id: string, sourcePath: string): CloneOutcome {
  const document = parseXml(source, { path: sourcePath });
  if (document.root === null) {
    throw new SC2Error('SC2_PARSE_ERROR', `${sourcePath} has no root element.`, { path: sourcePath, recoverable: false });
  }

  const element = findEntryElement(document.root, domain, id);
  if (element === null) {
    throw new SC2Error('SC2_NOT_FOUND', `${sourcePath} does not declare ${domain}/${id}.`, {
      path: sourcePath,
      objectId: `${domain}/${id}`,
      recoverable: true,
    });
  }

  const editor = new XmlEditor(source);
  editor.removeElement(element, `delete ${domain}/${id}`);
  return { content: editor.apply(), summary: [`deleted ${domain}/${id} from ${sourcePath}`] };
}
