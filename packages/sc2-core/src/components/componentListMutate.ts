/** Lossless mutations for ComponentList.SC2Components. */

import { SC2Error } from '../errors.js';
import { XmlEditor } from '../xml/edit.js';
import { attributeValue, childElements, escapeText, parseXml, textContent, type XmlElement } from '../xml/parse.js';
import { COMPONENT_LIST_FILENAME } from './componentList.js';

export interface ComponentIdentity {
  readonly typeCode: string;
  /** `undefined` selects by type when it is unambiguous. `null` selects an entry with no Locale. */
  readonly locale?: string | null | undefined;
}

export interface ComponentListEntry {
  readonly typeCode: string;
  readonly path: string;
  readonly locale: string | null;
}

export interface AddComponentInput {
  readonly typeCode: string;
  readonly path: string;
  readonly locale?: string | null | undefined;
}

export interface UpdateComponentInput {
  readonly newTypeCode?: string | undefined;
  readonly newPath?: string | undefined;
  /** `undefined` keeps the current value. `null` removes the Locale attribute. */
  readonly newLocale?: string | null | undefined;
}

export interface ComponentListMutationOutcome {
  readonly content: string;
  readonly summary: readonly string[];
  readonly component: ComponentListEntry;
}

function componentRoot(source: string): XmlElement {
  const document = parseXml(source, { path: COMPONENT_LIST_FILENAME });
  if (document.root?.name !== 'Components') {
    throw new SC2Error('SC2_PARSE_ERROR', `${COMPONENT_LIST_FILENAME} must have a <Components> root element.`, {
      path: COMPONENT_LIST_FILENAME,
      recoverable: false,
      context: { foundRoot: document.root?.name ?? null },
    });
  }
  return document.root;
}

function normalizeTypeCode(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9]{4}$/u.test(normalized)) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Component type codes must contain exactly four ASCII letters or digits; got "${value}".`, {
      path: COMPONENT_LIST_FILENAME,
      recoverable: true,
    });
  }
  return normalized;
}

function normalizeLocale(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  const trimmed = value.trim();
  if (!/^[A-Za-z]{4}$/u.test(trimmed)) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Component locales must use the four-letter SC2 form, such as enUS; got "${value}".`, {
      path: COMPONENT_LIST_FILENAME,
      recoverable: true,
    });
  }
  return `${trimmed.slice(0, 2).toLowerCase()}${trimmed.slice(2).toUpperCase()}`;
}

function normalizeLogicalPath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    /[\0\r\n]/u.test(normalized)
  ) {
    throw new SC2Error('SC2_INVALID_ARGUMENT', `Not a safe component logical path: "${value}".`, {
      path: COMPONENT_LIST_FILENAME,
      recoverable: true,
      suggestedAction: 'Use a document-relative logical name such as GameData, DocumentInfo, or UI/Layout.',
    });
  }
  return normalized;
}

function entryOf(element: XmlElement): ComponentListEntry {
  return {
    typeCode: attributeValue(element, 'Type') ?? '',
    path: textContent(element).trim(),
    locale: attributeValue(element, 'Locale') ?? null,
  };
}

function dataComponents(root: XmlElement): XmlElement[] {
  return [...childElements(root, 'DataComponent')];
}

function sameIdentity(left: ComponentIdentity, right: ComponentIdentity): boolean {
  return (
    left.typeCode.toLowerCase() === right.typeCode.toLowerCase() &&
    (left.locale ?? null)?.toLowerCase() === (right.locale ?? null)?.toLowerCase()
  );
}

function selectComponent(root: XmlElement, identity: ComponentIdentity): XmlElement {
  const typeCode = normalizeTypeCode(identity.typeCode);
  const locale = normalizeLocale(identity.locale);
  const matches = dataComponents(root).filter((element) => {
    if ((attributeValue(element, 'Type') ?? '').toLowerCase() !== typeCode) return false;
    if (locale === undefined) return true;
    return (attributeValue(element, 'Locale') ?? null)?.toLowerCase() === locale?.toLowerCase();
  });

  if (matches.length === 0) {
    throw new SC2Error('SC2_NOT_FOUND', `No ${typeCode} component${locale === undefined ? '' : ` for locale ${locale ?? '(none)'}`}.`, {
      path: COMPONENT_LIST_FILENAME,
      recoverable: true,
    });
  }
  if (matches.length > 1) {
    throw new SC2Error('SC2_CONFLICT', `Component type ${typeCode} has ${matches.length} entries. Select one by locale.`, {
      path: COMPONENT_LIST_FILENAME,
      recoverable: true,
      context: { locales: matches.map((element) => attributeValue(element, 'Locale') ?? null) },
    });
  }
  const match = matches[0];
  if (match === undefined) {
    throw new SC2Error('SC2_INTERNAL_ERROR', 'A selected component entry disappeared.', {
      path: COMPONENT_LIST_FILENAME,
      recoverable: false,
    });
  }
  return match;
}

function assertIdentityAvailable(root: XmlElement, entry: ComponentIdentity, except?: XmlElement): void {
  const conflict = dataComponents(root).find(
    (element) => element !== except && sameIdentity(entryOf(element), entry),
  );
  if (conflict !== undefined) {
    throw new SC2Error(
      'SC2_CONFLICT',
      `Component ${entry.typeCode}${entry.locale == null ? '' : ` for ${entry.locale}`} is already declared.`,
      { path: COMPONENT_LIST_FILENAME, recoverable: true },
    );
  }
}

export function addComponent(source: string, input: AddComponentInput): ComponentListMutationOutcome {
  const root = componentRoot(source);
  const component: ComponentListEntry = {
    typeCode: normalizeTypeCode(input.typeCode),
    path: normalizeLogicalPath(input.path),
    locale: normalizeLocale(input.locale) ?? null,
  };
  assertIdentityAvailable(root, component);

  const localeAttribute = component.locale === null ? '' : ` Locale="${component.locale}"`;
  const rendered = `<DataComponent Type="${component.typeCode}"${localeAttribute}>${escapeText(component.path)}</DataComponent>`;
  const editor = new XmlEditor(source);
  editor.appendChild(root, rendered, `add ${component.typeCode} component ${component.path}`);
  return {
    content: editor.apply(),
    summary: [`added component ${component.typeCode}${component.locale === null ? '' : ` [${component.locale}]`} -> ${component.path}`],
    component,
  };
}

export function updateComponent(
  source: string,
  identity: ComponentIdentity,
  input: UpdateComponentInput,
): ComponentListMutationOutcome {
  const root = componentRoot(source);
  const target = selectComponent(root, identity);
  const before = entryOf(target);
  const component: ComponentListEntry = {
    typeCode: input.newTypeCode === undefined ? before.typeCode : normalizeTypeCode(input.newTypeCode),
    path: input.newPath === undefined ? before.path : normalizeLogicalPath(input.newPath),
    locale: input.newLocale === undefined ? before.locale : normalizeLocale(input.newLocale) ?? null,
  };
  assertIdentityAvailable(root, component, target);

  const editor = new XmlEditor(source);
  if (before.typeCode !== component.typeCode) editor.setAttributeValue(target, 'Type', component.typeCode);
  if (before.path !== component.path) {
    if (target.contentSpan === null) {
      throw new SC2Error('SC2_UNSUPPORTED_OPERATION', 'A self-closing component entry cannot be assigned a path.', {
        path: COMPONENT_LIST_FILENAME,
        recoverable: true,
      });
    }
    editor.replaceContent(target, escapeText(component.path), `set ${component.typeCode} component path`);
  }
  if (before.locale !== component.locale) {
    if (before.locale === null && component.locale !== null) editor.addAttribute(target, 'Locale', component.locale);
    else if (before.locale !== null && component.locale === null) editor.removeAttribute(target, 'Locale');
    else if (component.locale !== null) editor.setAttributeValue(target, 'Locale', component.locale);
  }

  return {
    content: editor.apply(),
    summary: editor.isEmpty
      ? []
      : [`updated component ${before.typeCode}${before.locale === null ? '' : ` [${before.locale}]`} -> ${component.typeCode}${component.locale === null ? '' : ` [${component.locale}]`} ${component.path}`],
    component,
  };
}

export function removeComponent(source: string, identity: ComponentIdentity): ComponentListMutationOutcome {
  const root = componentRoot(source);
  const target = selectComponent(root, identity);
  const component = entryOf(target);
  const editor = new XmlEditor(source);
  editor.removeElement(target, `remove ${component.typeCode} component ${component.path}`);
  return {
    content: editor.apply(),
    summary: [`removed component declaration ${component.typeCode}${component.locale === null ? '' : ` [${component.locale}]`} -> ${component.path}; component files were preserved`],
    component,
  };
}
