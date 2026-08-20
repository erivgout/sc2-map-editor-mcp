/** Graph-aware, lossless trigger mutations built only from editor-authored structures. */

import { randomBytes } from 'node:crypto';

import { SC2Error } from '../errors.js';
import { XmlEditor, indentationBefore } from '../xml/edit.js';
import { attributeValue, childElements, parseXml, type XmlElement } from '../xml/parse.js';
import { isTriggerReferenceElement, parseTriggerData, TRIGGERS_FILENAME, type TriggerData } from './parse.js';

export interface CloneTriggerOptions {
  readonly sourceId: string;
  /** `undefined` auto-selects a unique incoming edge. `null` selects the Root edge. */
  readonly parentId?: string | null | undefined;
  /** Test hook. Production callers use random editor-style eight-digit hex ids. */
  readonly generateId?: (() => string) | undefined;
}

export interface CloneTriggerOutcome {
  readonly content: string;
  readonly sourceId: string;
  readonly clonedRootId: string;
  readonly parentId: string | null;
  readonly idMap: ReadonlyMap<string, string>;
  readonly summary: readonly string[];
}

export interface DeleteTriggerOptions {
  readonly id: string;
  /** `undefined` auto-selects a unique incoming edge. `null` selects the Root edge. */
  readonly parentId?: string | null | undefined;
}

export interface DeleteTriggerOutcome {
  readonly content: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly removedIds: readonly string[];
  readonly summary: readonly string[];
}

interface TriggerNodes {
  readonly data: TriggerData;
  readonly documentRoot: XmlElement;
  readonly rootContainer: XmlElement;
  readonly elementNodes: ReadonlyMap<string, XmlElement>;
}

interface IncomingReference {
  readonly parentId: string | null;
  readonly node: XmlElement;
}

function parseTriggerNodes(source: string): TriggerNodes {
  const data = parseTriggerData(source);
  const document = parseXml(source, { path: TRIGGERS_FILENAME });
  if (document.root?.name !== 'TriggerData') {
    throw new SC2Error('SC2_PARSE_ERROR', `${TRIGGERS_FILENAME} must have a <TriggerData> root element.`, {
      path: TRIGGERS_FILENAME,
      recoverable: false,
    });
  }
  const roots = childElements(document.root, 'Root');
  if (roots.length !== 1) {
    throw new SC2Error('SC2_PARSE_ERROR', `${TRIGGERS_FILENAME} must contain exactly one <Root> element.`, {
      path: TRIGGERS_FILENAME,
      recoverable: false,
    });
  }

  const elementNodes = new Map<string, XmlElement>();
  for (const element of childElements(document.root, 'Element')) {
    const id = attributeValue(element, 'Id');
    if (id !== undefined) elementNodes.set(id, element);
  }
  const rootContainer = roots[0];
  if (rootContainer === undefined) {
    throw new SC2Error('SC2_INTERNAL_ERROR', 'The validated trigger root disappeared.', {
      path: TRIGGERS_FILENAME,
      recoverable: false,
    });
  }
  return { data, documentRoot: document.root, rootContainer, elementNodes };
}

function localReferenceNodes(container: XmlElement): XmlElement[] {
  return childElements(container).filter(
    (child) => isTriggerReferenceElement(child) && attributeValue(child, 'Library') === undefined,
  );
}

function incomingReferences(nodes: TriggerNodes, id: string): IncomingReference[] {
  const incoming: IncomingReference[] = [];
  for (const child of localReferenceNodes(nodes.rootContainer)) {
    if (attributeValue(child, 'Id') === id) incoming.push({ parentId: null, node: child });
  }
  for (const [parentId, element] of nodes.elementNodes) {
    for (const child of localReferenceNodes(element)) {
      if (attributeValue(child, 'Id') === id) incoming.push({ parentId, node: child });
    }
  }
  return incoming;
}

function selectIncoming(nodes: TriggerNodes, id: string, parentId: string | null | undefined): IncomingReference {
  if (!nodes.data.elements.has(id)) {
    throw new SC2Error('SC2_NOT_FOUND', `No trigger element with id "${id}".`, {
      path: TRIGGERS_FILENAME,
      recoverable: true,
    });
  }
  const candidates = incomingReferences(nodes, id);
  const matches = parentId === undefined ? candidates : candidates.filter((entry) => entry.parentId === parentId);
  if (matches.length === 0) {
    throw new SC2Error('SC2_NOT_FOUND', `Trigger element ${id} is not referenced by ${parentId === null ? 'Root' : parentId ?? 'any parent'}.`, {
      path: TRIGGERS_FILENAME,
      recoverable: true,
      context: { referencedBy: candidates.map((entry) => entry.parentId ?? 'Root') },
    });
  }
  if (matches.length > 1) {
    throw new SC2Error('SC2_CONFLICT', `Trigger element ${id} has ${matches.length} matching incoming references. Select parent_id.`, {
      path: TRIGGERS_FILENAME,
      recoverable: true,
      context: { referencedBy: candidates.map((entry) => entry.parentId ?? 'Root') },
    });
  }
  const match = matches[0];
  if (match === undefined) {
    throw new SC2Error('SC2_INTERNAL_ERROR', 'A selected trigger reference disappeared.', {
      path: TRIGGERS_FILENAME,
      recoverable: false,
    });
  }
  return match;
}

function reachable(data: TriggerData, startingIds: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const pending = [...startingIds];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    const element = data.elements.get(id);
    if (element === undefined) continue;
    seen.add(id);
    pending.push(...element.childIds);
  }
  return seen;
}

function rewriteFragmentIds(fragment: string, idMap: ReadonlyMap<string, string>): string {
  const document = parseXml(fragment, { path: TRIGGERS_FILENAME });
  if (document.root === null) {
    throw new SC2Error('SC2_INTERNAL_ERROR', 'Could not parse an editor-authored trigger fragment.', {
      path: TRIGGERS_FILENAME,
      recoverable: false,
    });
  }
  const editor = new XmlEditor(fragment);
  const visit = (element: XmlElement, isRoot: boolean): void => {
    const id = attributeValue(element, 'Id');
    const replacement = id === undefined ? undefined : idMap.get(id);
    if (
      replacement !== undefined &&
      (isRoot || (isTriggerReferenceElement(element) && attributeValue(element, 'Library') === undefined))
    ) {
      editor.setAttributeValue(element, 'Id', replacement);
    }
    for (const child of childElements(element)) visit(child, false);
  };
  visit(document.root, true);
  return editor.apply();
}

function nextUniqueId(used: Set<string>, generateId: () => string): string {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const id = generateId().toUpperCase();
    if (!/^[0-9A-F]{8}$/u.test(id)) {
      throw new SC2Error('SC2_INTERNAL_ERROR', `Generated trigger id is not eight hexadecimal digits: ${id}.`, {
        path: TRIGGERS_FILENAME,
        recoverable: false,
      });
    }
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new SC2Error('SC2_CONFLICT', 'Could not allocate a unique trigger id after 1000 attempts.', {
    path: TRIGGERS_FILENAME,
    recoverable: false,
  });
}

export function cloneTriggerSubgraph(source: string, options: CloneTriggerOptions): CloneTriggerOutcome {
  const nodes = parseTriggerNodes(source);
  const incoming = selectIncoming(nodes, options.sourceId, options.parentId);
  const clonedIds = reachable(nodes.data, [options.sourceId]);
  const orderedIds = [...nodes.data.elements.keys()].filter((id) => clonedIds.has(id));
  const used = new Set<string>(nodes.data.elements.keys());
  for (const reference of nodes.data.rootReferences) used.add(reference.id);
  for (const element of nodes.data.elements.values()) {
    for (const reference of element.references) used.add(reference.id);
  }
  const generateId = options.generateId ?? (() => randomBytes(4).toString('hex'));
  const idMap = new Map<string, string>();
  for (const id of orderedIds) idMap.set(id, nextUniqueId(used, generateId));

  const blocks = orderedIds.map((id) => {
    const node = nodes.elementNodes.get(id);
    if (node === undefined) {
      throw new SC2Error('SC2_INTERNAL_ERROR', `No XML node for trigger element ${id}.`, {
        path: TRIGGERS_FILENAME,
        recoverable: false,
      });
    }
    return rewriteFragmentIds(source.slice(node.span.start, node.span.end), idMap);
  });
  const clonedRootId = idMap.get(options.sourceId);
  if (clonedRootId === undefined) {
    throw new SC2Error('SC2_INTERNAL_ERROR', `Could not allocate a clone id for ${options.sourceId}.`, {
      path: TRIGGERS_FILENAME,
      recoverable: false,
    });
  }

  const referenceFragment = source.slice(incoming.node.span.start, incoming.node.span.end);
  const clonedReference = rewriteFragmentIds(referenceFragment, new Map([[options.sourceId, clonedRootId]]));
  const lastElement = [...nodes.elementNodes.values()].at(-1);
  if (lastElement === undefined) {
    throw new SC2Error('SC2_INTERNAL_ERROR', 'A trigger source element exists but its XML node is missing.', {
      path: TRIGGERS_FILENAME,
      recoverable: false,
    });
  }
  const topIndent = indentationBefore(source, lastElement.span.start);
  const editor = new XmlEditor(source);
  editor.insertAfter(incoming.node, clonedReference, `attach cloned trigger ${clonedRootId}`);
  editor.insertAfter(
    lastElement,
    blocks.join(`${editor.newline}${topIndent}`),
    `append ${blocks.length} cloned trigger element(s)`,
  );
  const content = editor.apply();
  const reparsed = parseTriggerData(content);
  if (!reparsed.elements.has(clonedRootId) || reparsed.danglingIds.join('\0') !== nodes.data.danglingIds.join('\0')) {
    throw new SC2Error('SC2_INTERNAL_ERROR', 'The cloned trigger graph failed post-mutation validation.', {
      path: TRIGGERS_FILENAME,
      recoverable: false,
    });
  }

  return {
    content,
    sourceId: options.sourceId,
    clonedRootId,
    parentId: incoming.parentId,
    idMap,
    summary: [
      `cloned trigger subgraph ${options.sourceId} -> ${clonedRootId}`,
      `copied ${orderedIds.length} editor-authored element(s) and remapped every document-owned reference`,
      `attached the clone beside its source under ${incoming.parentId ?? 'Root'}`,
    ],
  };
}

function reachableAfterRemoving(nodes: TriggerNodes, removedReference: IncomingReference, subtree: ReadonlySet<string>): Set<string> {
  const starts = localReferenceNodes(nodes.rootContainer)
    .filter((node) => node.span.start !== removedReference.node.span.start)
    .map((node) => attributeValue(node, 'Id'))
    .filter((id): id is string => id !== undefined);
  starts.push(...[...nodes.data.elements.keys()].filter((id) => !subtree.has(id)));

  const seen = new Set<string>();
  const pending = [...starts];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    const element = nodes.data.elements.get(id);
    const elementNode = nodes.elementNodes.get(id);
    if (element === undefined || elementNode === undefined) continue;
    seen.add(id);
    for (const reference of localReferenceNodes(elementNode)) {
      if (reference.span.start === removedReference.node.span.start) continue;
      const childId = attributeValue(reference, 'Id');
      if (childId !== undefined) pending.push(childId);
    }
  }
  return seen;
}

export function deleteTriggerSubgraph(source: string, options: DeleteTriggerOptions): DeleteTriggerOutcome {
  const nodes = parseTriggerNodes(source);
  const incoming = selectIncoming(nodes, options.id, options.parentId);
  const subtree = reachable(nodes.data, [options.id]);
  const preserved = reachableAfterRemoving(nodes, incoming, subtree);
  const removedIds = [...nodes.data.elements.keys()].filter((id) => subtree.has(id) && !preserved.has(id));

  const editor = new XmlEditor(source);
  if (incoming.parentId === null || !removedIds.includes(incoming.parentId)) {
    editor.removeElement(incoming.node, `detach trigger ${options.id} from ${incoming.parentId ?? 'Root'}`);
  }
  for (const id of removedIds) {
    const node = nodes.elementNodes.get(id);
    if (node !== undefined) editor.removeElement(node, `remove unreferenced trigger element ${id}`);
  }
  const content = editor.apply();
  const reparsed = parseTriggerData(content);
  if (reparsed.danglingIds.join('\0') !== nodes.data.danglingIds.join('\0')) {
    throw new SC2Error('SC2_INTERNAL_ERROR', 'Deleting the trigger branch introduced a dangling reference.', {
      path: TRIGGERS_FILENAME,
      recoverable: false,
    });
  }

  return {
    content,
    id: options.id,
    parentId: incoming.parentId,
    removedIds,
    summary: [
      `detached trigger element ${options.id} from ${incoming.parentId ?? 'Root'}`,
      `removed ${removedIds.length} element(s) that had no remaining incoming path; shared elements were preserved`,
    ],
  };
}
