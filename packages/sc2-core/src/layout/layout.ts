import { SC2Error } from '../errors.js';
import { XmlEditor } from '../xml/edit.js';
import { attributeValue, parseXml, type XmlElement } from '../xml/parse.js';

export const LAYOUT_EXTENSION = '.SC2Layout';

export interface LayoutDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export interface LayoutElementSummary {
  readonly element: string;
  readonly name: string | null;
  readonly type: string | null;
  readonly file: string | null;
  readonly template: string | null;
  readonly line: number;
  readonly column: number;
}

export interface LayoutDocument {
  readonly root: XmlElement;
  readonly elements: readonly LayoutElementSummary[];
  readonly diagnostics: readonly LayoutDiagnostic[];
}

export interface LayoutSelector {
  readonly element: string;
  readonly attributes?: Readonly<Record<string, string>> | undefined;
  readonly occurrence?: number | undefined;
}

export type LayoutPatch =
  | { readonly op: 'set_attribute'; readonly name: string; readonly value: string }
  | { readonly op: 'remove_attribute'; readonly name: string }
  | { readonly op: 'replace_content'; readonly xml: string }
  | { readonly op: 'replace_element'; readonly xml: string }
  | { readonly op: 'append_child'; readonly xml: string }
  | { readonly op: 'delete_element' };

export interface LayoutMutationOutcome {
  readonly content: string;
  readonly summary: readonly string[];
}

export function isLayoutPath(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith(LAYOUT_EXTENSION.toLowerCase());
}

function lineColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return {
    line: before.split('\n').length,
    column: offset - lastNewline,
  };
}

function allElements(root: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  const visit = (element: XmlElement): void => {
    result.push(element);
    for (const child of element.children) {
      if (child.kind === 'element') visit(child);
    }
  };
  visit(root);
  return result;
}

function structuralDiagnostics(source: string, path: string, root: XmlElement): LayoutDiagnostic[] {
  const diagnostics: LayoutDiagnostic[] = [];

  if (root.name !== 'Desc') {
    const position = lineColumn(source, root.span.start);
    diagnostics.push({
      severity: 'error',
      message: `SC2Layout root must be <Desc>, found <${root.name}>.`,
      path,
      ...position,
    });
  }

  for (const element of allElements(root)) {
    if (element.name !== 'Frame') continue;
    const position = lineColumn(source, element.span.start);
    if (attributeValue(element, 'name') === undefined) {
      diagnostics.push({ severity: 'error', message: '<Frame> is missing its required name attribute.', path, ...position });
    }
    if (attributeValue(element, 'type') === undefined && attributeValue(element, 'template') === undefined) {
      diagnostics.push({
        severity: 'warning',
        message: '<Frame> has neither type nor template, so the editor cannot determine what to create.',
        path,
        ...position,
      });
    }
  }

  return diagnostics;
}

export function parseLayout(source: string, path = `Layout${LAYOUT_EXTENSION}`): LayoutDocument {
  const parsed = parseXml(source, { path });
  if (parsed.root === null) {
    throw new SC2Error('SC2_PARSE_ERROR', `${path} has no root element.`, { path, recoverable: false });
  }

  const elements = allElements(parsed.root).map((element) => ({
    element: element.name,
    name: attributeValue(element, 'name') ?? null,
    type: attributeValue(element, 'type') ?? null,
    file: attributeValue(element, 'file') ?? null,
    template: attributeValue(element, 'template') ?? null,
    ...lineColumn(source, element.span.start),
  }));

  return {
    root: parsed.root,
    elements,
    diagnostics: structuralDiagnostics(source, path, parsed.root),
  };
}

function validateFragment(xml: string, label: string): void {
  try {
    parseXml(`<SC2MCPFragment>${xml}</SC2MCPFragment>`, { path: label });
  } catch (error) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `${label} is not valid XML: ${error instanceof Error ? error.message : String(error)}`, {
      recoverable: true,
    });
  }
}

function matchingElement(source: string, path: string, selector: LayoutSelector): XmlElement {
  const document = parseLayout(source, path);
  const matches = allElements(document.root).filter((element) => {
    if (element.name !== selector.element) return false;
    return Object.entries(selector.attributes ?? {}).every(([name, value]) => attributeValue(element, name) === value);
  });
  const occurrence = selector.occurrence ?? 0;
  const match = matches[occurrence];
  if (match === undefined) {
    throw new SC2Error(
      'SC2_NOT_FOUND',
      `${path} has no matching <${selector.element}> at occurrence ${occurrence}.`,
      { path, recoverable: true, context: { matchCount: matches.length, selector } },
    );
  }
  return match;
}

export function applyLayoutPatch(
  source: string,
  path: string,
  selector: LayoutSelector,
  patch: LayoutPatch,
): LayoutMutationOutcome {
  const target = matchingElement(source, path, selector);
  const editor = new XmlEditor(source);

  switch (patch.op) {
    case 'set_attribute': {
      if (target.attributes.some((attribute) => attribute.name === patch.name)) {
        editor.setAttributeValue(target, patch.name, patch.value);
      } else {
        editor.addAttribute(target, patch.name, patch.value);
      }
      break;
    }
    case 'remove_attribute':
      editor.removeAttribute(target, patch.name);
      break;
    case 'replace_content':
      validateFragment(patch.xml, `${path} replacement content`);
      editor.replaceContent(target, patch.xml, `replace <${target.name}> content`);
      break;
    case 'replace_element':
      validateFragment(patch.xml, `${path} replacement element`);
      editor.replaceElement(target, patch.xml, `replace <${target.name}>`);
      break;
    case 'append_child':
      validateFragment(patch.xml, `${path} appended child`);
      editor.appendChild(target, patch.xml, `append child to <${target.name}>`);
      break;
    case 'delete_element':
      if (target.name === 'Desc' && target.span.start === parseLayout(source, path).root.span.start) {
        throw new SC2Error('SC2_UNSUPPORTED_OPERATION', 'The root <Desc> element cannot be deleted.', {
          path,
          recoverable: true,
        });
      }
      editor.removeElement(target, `delete <${target.name}>`);
      break;
  }

  const content = editor.apply();
  const checked = parseLayout(content, path);
  const errors = checked.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new SC2Error('SC2_VALIDATION_FAILED', `The layout patch would leave ${errors.length} structural error(s).`, {
      path,
      recoverable: true,
      context: { diagnostics: errors },
    });
  }

  return { content, summary: editor.summarize() };
}

export function createLayout(source?: string, path = `Layout${LAYOUT_EXTENSION}`): LayoutMutationOutcome {
  const content = source ?? '<?xml version="1.0" encoding="utf-8"?>\r\n<Desc>\r\n</Desc>\r\n';
  const document = parseLayout(content, path);
  const errors = document.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new SC2Error('SC2_VALIDATION_FAILED', `The new layout has ${errors.length} structural error(s).`, {
      path,
      recoverable: true,
      context: { diagnostics: errors },
    });
  }
  return { content, summary: [`created layout ${path}`] };
}

export function searchLayout(source: string, path: string, query: string): LayoutElementSummary[] {
  const needle = query.toLowerCase();
  return parseLayout(source, path).elements.filter((element) =>
    [element.element, element.name, element.type, element.file, element.template]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLowerCase().includes(needle)),
  );
}
