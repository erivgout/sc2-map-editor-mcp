/**
 * GUI trigger data (PLAN.md §21).
 *
 * Verified against the `Triggers` component of the editor-produced map that ships with
 * StarCraft II — a 1 MB file that turns out to be plain XML:
 *
 * ```xml
 * <TriggerData>
 *     <Root>
 *         <Item Type="Category" Id="148F844D"/>
 *     </Root>
 *     <Element Type="Category" Id="148F844D">
 *         <Item Type="Trigger" Id="717EE832"/>
 *     </Element>
 * </TriggerData>
 * ```
 *
 * Two structural facts drive everything here:
 *
 *  - `<Root>` uses `<Item>` references. Elements use relation-specific tags such as
 *    `<Item>`, `<Event>`, `<Action>`, `<Parameter>`, and `<FunctionCall>`. The tree is
 *    built by following their ids rather than by nesting. An element can be referenced
 *    from more than one place, and a cycle is possible in malformed data.
 *  - **Names are not in this file.** They live in `TriggerStrings.txt` as
 *    `<Type>/Name/<Id>` — `Category/Name/148F844D=varibles`. An id alone is meaningless
 *    to a human, so anything user-facing has to join the two.
 *
 * Element types observed: Category, Comment, CustomScript, FunctionCall, FunctionDef,
 * Param, ParamDef, Trigger, Variable. The set is treated as open.
 *
 * Mutation clones or removes complete editor-authored subgraphs. It never invents native
 * function, action, event, parameter, or preset identifiers.
 */

import { SC2Error } from '../errors.js';
import { attributeValue, childElements, parseXml, type XmlElement, type XmlSpan } from '../xml/parse.js';

export const TRIGGERS_FILENAME = 'Triggers';

export interface TriggerReference {
  /** Relation tag in the XML, such as Item, Event, Action, or Parameter. */
  readonly tag: string;
  readonly type: string;
  readonly id: string;
  /** External library references are not edges in the document-owned graph. */
  readonly library: string | null;
  readonly span: XmlSpan;
}

export interface TriggerElement {
  readonly id: string;
  readonly type: string;
  /** Ids of the children this element lists, in order. */
  readonly childIds: readonly string[];
  /** Every direct id-bearing field, including external library references. */
  readonly references: readonly TriggerReference[];
  /** Direct child element names other than `<Item>`, e.g. `VariableType`. For orientation. */
  readonly detailFields: readonly string[];
  readonly span: XmlSpan;
  readonly line: number;
}

export interface TriggerData {
  /** Top-level ids, in declaration order. */
  readonly rootIds: readonly string[];
  readonly rootReferences: readonly TriggerReference[];
  readonly elements: ReadonlyMap<string, TriggerElement>;
  /** Ids referenced by an `<Item>` but never declared as an `<Element>`. */
  readonly danglingIds: readonly string[];
  /** Counts by element type, for a quick shape summary. */
  readonly countsByType: ReadonlyMap<string, number>;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return line;
}

/** `ValueId` is scalar map/region data. Other id-bearing children are graph references. */
export function isTriggerReferenceElement(element: XmlElement): boolean {
  return element.name !== 'ValueId' && attributeValue(element, 'Id') !== undefined;
}

function readReferences(element: XmlElement): TriggerReference[] {
  return childElements(element).flatMap((child) => {
    if (!isTriggerReferenceElement(child)) return [];
    const id = attributeValue(child, 'Id');
    if (id === undefined || id === '') return [];
    return [
      {
        tag: child.name,
        type: attributeValue(child, 'Type') ?? 'Unknown',
        id,
        library: attributeValue(child, 'Library') ?? null,
        span: child.span,
      },
    ];
  });
}

export function parseTriggerData(source: string): TriggerData {
  const document = parseXml(source, { path: TRIGGERS_FILENAME });
  if (document.root?.name !== 'TriggerData') {
    throw new SC2Error('SC2_PARSE_ERROR', `${TRIGGERS_FILENAME} must have a <TriggerData> root element.`, {
      path: TRIGGERS_FILENAME,
      recoverable: false,
      context: { foundRoot: document.root?.name ?? null },
    });
  }

  let rootReferences: TriggerReference[] | null = null;
  const elements = new Map<string, TriggerElement>();
  const countsByType = new Map<string, number>();

  for (const child of childElements(document.root)) {
    if (child.name === 'Root') {
      if (rootReferences !== null) {
        throw new SC2Error('SC2_PARSE_ERROR', `${TRIGGERS_FILENAME} contains more than one <Root> element.`, {
          path: TRIGGERS_FILENAME,
          recoverable: false,
        });
      }
      rootReferences = readReferences(child).filter((reference) => reference.library === null);
      continue;
    }
    if (child.name !== 'Element') continue;

    const id = attributeValue(child, 'Id');
    const type = attributeValue(child, 'Type') ?? 'Unknown';
    if (id === undefined) continue;
    if (elements.has(id)) {
      throw new SC2Error('SC2_PARSE_ERROR', `${TRIGGERS_FILENAME} declares element id ${id} more than once.`, {
        path: TRIGGERS_FILENAME,
        recoverable: false,
      });
    }

    const references = readReferences(child);

    const detailFields = [
      ...new Set(
        childElements(child)
          .filter((field) => !isTriggerReferenceElement(field) || attributeValue(field, 'Library') !== undefined)
          .map((field) => field.name),
      ),
    ];

    elements.set(id, {
      id,
      type,
      childIds: references.filter((reference) => reference.library === null).map((reference) => reference.id),
      references,
      detailFields,
      span: child.span,
      line: lineAt(document.source, child.span.start),
    });
    countsByType.set(type, (countsByType.get(type) ?? 0) + 1);
  }

  if (rootReferences === null) {
    throw new SC2Error('SC2_PARSE_ERROR', `${TRIGGERS_FILENAME} has no <Root> element.`, {
      path: TRIGGERS_FILENAME,
      recoverable: false,
    });
  }
  const rootIds = rootReferences.map((reference) => reference.id);

  // An `<Item>` naming an id nothing declares is a real authoring defect, and the kind of
  // thing a listing would otherwise silently drop.
  const dangling = new Set<string>();
  for (const id of rootIds) if (!elements.has(id)) dangling.add(id);
  for (const element of elements.values()) {
    for (const childId of element.childIds) if (!elements.has(childId)) dangling.add(childId);
  }

  return { rootIds, rootReferences, elements, danglingIds: [...dangling].sort(), countsByType };
}

export interface TriggerTreeNode {
  readonly id: string;
  readonly type: string;
  /** Resolved from the trigger string table, or `null` when it has no name. */
  readonly name: string | null;
  readonly line: number;
  readonly children: readonly TriggerTreeNode[];
  /** True when this id was already expanded higher up — the tree is a graph. */
  readonly repeated: boolean;
}

export interface BuildTreeOptions {
  /** `<Type>/Name/<Id>` lookups, normally the parsed TriggerStrings table. */
  readonly names?: ReadonlyMap<string, string> | undefined;
  /** How deep to expand. Deep trigger trees are large; bounded output is the default. */
  readonly maxDepth?: number;
}

/** The conventional trigger-name key: `Category/Name/148F844D`. */
export function triggerNameKey(type: string, id: string): string {
  return `${type}/Name/${id}`;
}

/**
 * Builds the display tree.
 *
 * Cycles and shared references are handled by marking a repeated id rather than
 * expanding it again — real trigger data reuses elements, and a naive walk would not
 * terminate.
 */
export function buildTriggerTree(data: TriggerData, options: BuildTreeOptions = {}): TriggerTreeNode[] {
  const maxDepth = options.maxDepth ?? 4;
  const names = options.names;

  const expand = (id: string, depth: number, seen: ReadonlySet<string>): TriggerTreeNode | null => {
    const element = data.elements.get(id);
    if (element === undefined) return null;

    const repeated = seen.has(id);
    const children =
      repeated || depth >= maxDepth
        ? []
        : element.childIds
            .map((childId) => expand(childId, depth + 1, new Set([...seen, id])))
            .filter((node): node is TriggerTreeNode => node !== null);

    return {
      id,
      type: element.type,
      name: names?.get(triggerNameKey(element.type, id)) ?? null,
      line: element.line,
      children,
      repeated,
    };
  };

  return data.rootIds
    .map((id) => expand(id, 0, new Set()))
    .filter((node): node is TriggerTreeNode => node !== null);
}
