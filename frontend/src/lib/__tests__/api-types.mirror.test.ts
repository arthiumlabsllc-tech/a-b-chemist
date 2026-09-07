/**
 * The mirrored contract, checked against the source it was copied from.
 *
 * `lib/api-types.ts` and the two hand-copied lists in `lib/auth-session.ts` are
 * copies, because the backend emits no declarations for this app to import. A
 * copy that is only annotated drifts, and the drift shows up as `undefined` in a
 * browser rather than as a failure anywhere anybody would see it. So the copies
 * are parsed and compared instead.
 *
 * ## How it works
 *
 * An `@mirrors <backend file> <backend interface>` tag in the doc comment above
 * an interface, in either source file, declares the pair. This suite reads both
 * files as text, strips comments, walks each interface body tracking brace depth,
 * and compares the resulting member maps: name, optionality and the
 * whitespace-collapsed type text. Adding a mirrored interface means adding a tag
 * and nothing else — the pairs below are discovered, not listed.
 *
 * Comparing *type text* rather than only names is what makes this worth having.
 * A field renamed from `available` to `availableUnits` is obvious; a field
 * retyped from `string` to `number` — which is what happens when somebody decides
 * the API should send pesewas rather than a decimal string — is not, and it
 * breaks the arithmetic quietly in the same way.
 *
 * ## What it cannot do
 *
 * It is textual, and honest about being so. It does not understand TypeScript; it
 * understands the two files it reads, in the style they are written. Three
 * consequences, each accepted deliberately:
 *
 * - Comments are stripped with a regex, so a `//` inside a string literal would
 *   be mistaken for one. No mirrored interface holds a URL or a Windows path.
 * - A member written as a method (`read(): string`) would fail to parse. That is
 *   a thrown error naming the member, not a silent pass — mirrored payloads are
 *   data, and a method on one would be a mistake worth stopping for.
 * - Only `export interface` declarations are checked for exhaustiveness, not
 *   `export type` aliases. The two aliases that are copies of a backend list —
 *   `GatewayMode` here and `Permission` in `auth-session.ts` — are compared
 *   individually below; a third would need adding to that list.
 *
 * ## Why it runs in the frontend
 *
 * It reads the backend's source, so it has to run where both trees exist: inside
 * the monorepo, in a suite that already has the frontend open. The backend cannot
 * host it without depending on the frontend, and a third place to run it is a
 * third thing to forget.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_LINE_QUANTITY } from 'a-and-b-chemist-shared';

import {
  SALE_LIMITS,
  SALE_PAYMENT_METHODS,
  MOVEMENT_TYPES,
  PRODUCT_LIMITS,
  REPORT_LIMITS,
} from '../api-types';
import { USER_ROLES } from '../auth-session';

/** `frontend/src/lib/__tests__` to the monorepo root is four levels. */
const MONOREPO_ROOT = join(__dirname, '..', '..', '..', '..');
const API_TYPES_PATH = join(__dirname, '..', 'api-types.ts');
const AUTH_SESSION_PATH = join(__dirname, '..', 'auth-session.ts');

function readAt(absolutePath: string): string {
  return readFileSync(absolutePath, 'utf8');
}

/** Reads a backend source file by its workspace-relative path. */
function readBackend(relativePath: string): string {
  return readAt(join(MONOREPO_ROOT, relativePath));
}

/**
 * Removes comments, replacing each with a space rather than with nothing.
 *
 * The space matters: without it `string/** x *\/|null` would collapse to
 * `string|null`, which is a different type and would compare equal to a genuine
 * `string | null` on the other side.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Collapses every whitespace run to one space, so formatting is not drift. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The text between the braces that follow `header`.
 *
 * Braces are counted rather than searched for, because `TaxSettingsView.act1151`
 * holds a nested object type and a naive "up to the first `}`" would end the body
 * inside it and compare half an interface.
 */
function bodyAfter(source: string, header: string, where: string): string {
  const start = source.indexOf(header);
  if (start === -1) {
    throw new Error(`${where}: no \`${header}\``);
  }
  const open = source.indexOf('{', start + header.length);
  if (open === -1) {
    throw new Error(`${where}: \`${header}\` has no opening brace`);
  }
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  throw new Error(`${where}: \`${header}\` has unbalanced braces`);
}

/** One member, as the comparison sees it: `? 0.1500`-style optionality plus type. */
function signature(optional: string, type: string): string {
  return collapse(`${optional} ${collapse(type)}`);
}

function addMember(
  into: Map<string, string>,
  raw: string,
  interfaceName: string,
  where: string
): void {
  const text = collapse(raw);
  if (text === '') {
    return;
  }
  const match = /^([A-Za-z_$][\w$]*)(\??)\s*:\s*([\s\S]+)$/.exec(text);
  const member = match?.[1];
  const optional = match?.[2];
  const type = match?.[3];
  if (member === undefined || optional === undefined || type === undefined) {
    throw new Error(
      `${where}: could not parse a member of \`${interfaceName}\`: "${text.slice(0, 90)}"`
    );
  }
  into.set(member, signature(optional, type));
}

/** Every top-level member of an interface, keyed by name. */
function interfaceMembers(
  strippedSource: string,
  interfaceName: string,
  where: string
): Map<string, string> {
  const body = bodyAfter(strippedSource, `export interface ${interfaceName}`, where);
  const members = new Map<string, string>();

  // Semicolons split members, but only at depth zero: the nested object type in
  // `act1151` is one member whose own semicolons belong to it.
  let depth = 0;
  let pending = '';
  for (const character of body) {
    if (character === '{' || character === '[' || character === '(') {
      depth += 1;
    } else if (character === '}' || character === ']' || character === ')') {
      depth -= 1;
    }
    if (character === ';' && depth === 0) {
      addMember(members, pending, interfaceName, where);
      pending = '';
      continue;
    }
    pending += character;
  }
  addMember(members, pending, interfaceName, where);

  if (members.size === 0) {
    throw new Error(`${where}: \`${interfaceName}\` parsed to no members`);
  }
  return members;
}

interface Mirror {
  /** The file the copy lives in, for messages. */
  copiedInto: string;
  /** Workspace-relative path of the source of truth. */
  backendFile: string;
  /** Interface name in the backend file. */
  backendName: string;
  /** Interface name in this app — it need not match (`SafeUser` → `AuthUser`). */
  localName: string;
}

/**
 * The `@mirrors` tags in one file, each paired with the interface below it.
 *
 * Read from the raw source, before comments are stripped, because the tags are
 * comments.
 *
 * The pattern is anchored to the end of a line, with only a closing comment
 * allowed after the interface name. That is what keeps prose about the tag from
 * being read as one: a sentence mentioning it mid-line has a next word, and a
 * bare `\s+(\S+)\s+(\w+)` would happily take that word for a file path and the
 * one after it for an interface, then fail on a file that does not exist.
 */
const MIRROR_TAG = /@mirrors[ \t]+(\S+)[ \t]+(\w+)[ \t]*(?:\*\/)?[ \t]*$/gm;

function mirrorTags(rawSource: string, copiedInto: string): Mirror[] {
  const tags: Array<{ index: number; backendFile: string; backendName: string }> = [];
  for (const match of rawSource.matchAll(MIRROR_TAG)) {
    const backendFile = match[1];
    const backendName = match[2];
    if (backendFile === undefined || backendName === undefined) {
      continue;
    }
    tags.push({ index: match.index ?? 0, backendFile, backendName });
  }

  const declared: Array<{ index: number; localName: string }> = [];
  for (const match of rawSource.matchAll(/^export interface (\w+)/gm)) {
    const localName = match[1];
    if (localName === undefined) {
      continue;
    }
    declared.push({ index: match.index ?? 0, localName });
  }

  return tags.map((tag) => {
    const target = declared.find((entry) => entry.index > tag.index);
    if (target === undefined) {
      throw new Error(
        `${copiedInto}: \`@mirrors ${tag.backendFile} ${tag.backendName}\` has no interface after it`
      );
    }
    return {
      copiedInto,
      backendFile: tag.backendFile,
      backendName: tag.backendName,
      localName: target.localName,
    };
  });
}

/** Names of every `export interface` in a file. */
function declaredInterfaceNames(rawSource: string): string[] {
  const names: string[] = [];
  for (const match of rawSource.matchAll(/^export interface (\w+)/gm)) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/** The string literals of `export const NAME = [...]`. */
function constStringArray(strippedSource: string, name: string, where: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]`).exec(strippedSource);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`${where}: no \`export const ${name} = [...]\``);
  }
  const items = body
    .split(',')
    .map((part) => collapse(part))
    .filter((part) => part !== '')
    .map((part) => {
      const quoted = /^'([^']*)'$/.exec(part) ?? /^"([^"]*)"$/.exec(part);
      const value = quoted?.[1];
      if (value === undefined) {
        throw new Error(`${where}: \`${name}\` holds an entry that is not a literal: "${part}"`);
      }
      return value;
    });
  if (items.length === 0) {
    throw new Error(`${where}: \`${name}\` is empty`);
  }
  return items;
}

/** The string literals of `export type NAME = 'a' | 'b';`. */
function unionLiterals(strippedSource: string, name: string, where: string): string[] {
  const match = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(strippedSource);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`${where}: no \`export type ${name} = ...;\``);
  }
  const items = body
    .split('|')
    .map((part) => collapse(part))
    .filter((part) => part !== '')
    .map((part) => {
      const quoted = /^'([^']*)'$/.exec(part);
      const value = quoted?.[1];
      if (value === undefined) {
        throw new Error(`${where}: \`${name}\` has a member that is not a literal: "${part}"`);
      }
      return value;
    });
  if (items.length === 0) {
    throw new Error(`${where}: \`${name}\` is empty`);
  }
  return items;
}

/**
 * A bound written as a name rather than a number, resolved through the package
 * that defines it.
 *
 * `SALE_LIMITS.quantity.max` is `MAX_LINE_QUANTITY` in the backend, imported from
 * the shared engine, and resolving it there instead of hardcoding `1000000` here
 * is what keeps this from becoming a third copy of the figure. An unknown name
 * throws rather than being skipped: a symbolic bound this suite cannot resolve is
 * a bound it would otherwise silently stop checking.
 */
const SYMBOLIC_BOUNDS: Record<string, number> = { MAX_LINE_QUANTITY };

function resolveBound(text: string, where: string): number {
  const literal = collapse(text);
  if (/^\d[\d_]*$/.test(literal)) {
    return Number(literal.replace(/_/g, ''));
  }
  const resolved = SYMBOLIC_BOUNDS[literal];
  if (resolved === undefined) {
    throw new Error(`${where}: cannot resolve the bound \`${literal}\` to a number`);
  }
  return resolved;
}

/** Every `key: { min, max }` in a limits object, flattened to dotted keys. */
function limitLeaves(strippedSource: string, name: string, where: string): Map<string, number> {
  const body = bodyAfter(strippedSource, `export const ${name}`, where);
  const leaves = new Map<string, number>();
  for (const match of body.matchAll(/(\w+)\s*:\s*\{\s*min:\s*([\w_]+)\s*,\s*max:\s*([\w_]+)\s*\}/g)) {
    const key = match[1];
    const min = match[2];
    const max = match[3];
    if (key === undefined || min === undefined || max === undefined) {
      continue;
    }
    leaves.set(`${key}.min`, resolveBound(min, where));
    leaves.set(`${key}.max`, resolveBound(max, where));
  }
  if (leaves.size === 0) {
    throw new Error(`${where}: \`${name}\` parsed to no bounds`);
  }
  return leaves;
}

function flattenLimits(limits: Record<string, { min: number; max: number }>): Map<string, number> {
  const leaves = new Map<string, number>();
  for (const [key, bound] of Object.entries(limits)) {
    leaves.set(`${key}.min`, bound.min);
    leaves.set(`${key}.max`, bound.max);
  }
  return leaves;
}

/**
 * Interfaces this app defines rather than copies, so the exhaustiveness check
 * below can tell an unguarded mirror from a shape that was never one.
 *
 * Each is either a response envelope assembled inline in a route (so there is no
 * backend interface to tag) or a request body, whose precise type is ours to
 * choose — the service types its inputs as `unknown` on purpose and coerces them.
 */
const CLIENT_OWNED = new Set([
  'TillProductsResponse',
  'TillCategoriesResponse',
  'ApproversResponse',
  'PaymentConfigResponse',
  'TaxSettingsResponse',
  'TaxSettingsBody',
  'CreateSaleLine',
  'CreateSalePayment',
  'CreateSaleBody',
]);

/** Reads both sides once; the suites below all work from these. */
const apiTypesRaw = readAt(API_TYPES_PATH);
const authSessionRaw = readAt(AUTH_SESSION_PATH);
const apiTypesStripped = stripComments(apiTypesRaw);
const authSessionStripped = stripComments(authSessionRaw);
const mirrors: Mirror[] = [
  ...mirrorTags(apiTypesRaw, 'api-types.ts'),
  ...mirrorTags(authSessionRaw, 'auth-session.ts'),
];

describe('the mirrored API contract', () => {
  it('finds mirrors to check, so a deleted tag cannot empty the suite', () => {
    // Guarding the guard. Every comparison below is a loop over `mirrors`, so a
    // regex that stopped matching — or a tag reformatted into something it does
    // not recognise — would leave all of them passing vacuously.
    expect(mirrors.length).toBeGreaterThanOrEqual(19);
    expect(mirrors.map((mirror) => mirror.localName)).toContain('TillProduct');
    expect(mirrors.map((mirror) => mirror.localName)).toContain('AuthUser');
    // The reports bundle is the largest single set of copies in this file: ten
    // interfaces, four of them nested inside another. A tag dropped from one of
    // the inner ones would leave it passing for the wrong reason — the outer
    // interface would still be checked, and its member would still be named
    // `daily`, only now nothing would notice the row inside it changing.
    for (const name of [
      'ReportWindow',
      'DailyRow',
      'ProductProfitRow',
      'StaffRow',
      'TenderRow',
      'DrawerRow',
      'VatRow',
      'ReportSummary',
      'StatusBreakdownRow',
      'ReportProfitability',
      'SalesReport',
    ]) {
      expect(mirrors.map((mirror) => mirror.localName)).toContain(name);
    }
  });

  it('agrees with the backend interface every tag names, member for member', () => {
    const problems: string[] = [];

    for (const mirror of mirrors) {
      const mine = interfaceMembers(
        mirror.copiedInto === 'api-types.ts' ? apiTypesStripped : authSessionStripped,
        mirror.localName,
        mirror.copiedInto
      );
      const theirs = interfaceMembers(
        stripComments(readBackend(mirror.backendFile)),
        mirror.backendName,
        mirror.backendFile
      );

      for (const [member, type] of mine) {
        const other = theirs.get(member);
        if (other === undefined) {
          problems.push(
            `${mirror.localName}.${member} is declared here but the backend's ${mirror.backendName} does not send it`
          );
        } else if (other !== type) {
          problems.push(
            `${mirror.localName}.${member} is \`${type}\` here but \`${other}\` in ${mirror.backendName}`
          );
        }
      }
      for (const member of theirs.keys()) {
        if (!mine.has(member)) {
          problems.push(
            `${mirror.backendName}.${member} is sent by the backend but missing from ${mirror.localName}`
          );
        }
      }
    }

    // Collected and asserted once rather than per mirror, so a rename that
    // touches three interfaces is reported as three problems in one run instead
    // of one problem and two suites never reached.
    expect(problems).toEqual([]);
  });

  it('leaves no exported interface in api-types.ts unaccounted for', () => {
    const declared = declaredInterfaceNames(apiTypesRaw);
    const tagged = new Set(
      mirrors.filter((mirror) => mirror.copiedInto === 'api-types.ts').map((m) => m.localName)
    );

    const untagged = declared.filter((name) => !tagged.has(name) && !CLIENT_OWNED.has(name));
    const stale = [...CLIENT_OWNED].filter(
      (name) => !declared.includes(name) && !tagged.has(name)
    );

    // Both directions. An untagged interface is a mirror nobody is checking; a
    // `CLIENT_OWNED` entry naming an interface that has gone is a hole in the
    // list waiting for a future interface of the same name to fall into.
    expect({ untagged, stale }).toEqual({ untagged: [], stale: [] });
  });
});

describe('the copied lists', () => {
  const permissionsTs = stripComments(readBackend('backend/src/utils/permissions.ts'));
  const schemaEnumsTs = stripComments(readBackend('backend/src/utils/schema-enums.ts'));
  const configTs = stripComments(readBackend('backend/src/config/index.ts'));

  it('holds the same tenders the database enum does', () => {
    // Compared sorted: the order a modal lists two tenders in is a frontend
    // decision, and failing on a reorder would be a test guarding nothing.
    expect([...SALE_PAYMENT_METHODS].sort()).toEqual(
      constStringArray(schemaEnumsTs, 'SALE_PAYMENT_METHODS', 'schema-enums.ts').sort()
    );
  });

  it('holds the same movement types the database enum does', () => {
    // A ledger row is labelled through `MOVEMENT_WORD`, a `Record<MovementType,
    // string>`, so a type added to the enum without a label is a compile error.
    // This is the other half: a type added to the *database* without being added
    // here would render as a blank cell, and nothing else would catch it.
    expect([...MOVEMENT_TYPES].sort()).toEqual(
      constStringArray(schemaEnumsTs, 'MOVEMENT_TYPES', 'schema-enums.ts').sort()
    );
  });

  it('holds the same roles the backend grants permissions by', () => {
    expect([...USER_ROLES].sort()).toEqual(
      constStringArray(permissionsTs, 'USER_ROLES', 'permissions.ts').sort()
    );
  });

  it('names every permission the backend can grant, and no others', () => {
    // The one whose failure is quietest and worst. `can()` tests membership of a
    // list the server sends, so a permission misspelt here never matches and the
    // button it gates simply never appears — for every role, forever, with
    // nothing logged and nothing thrown.
    const granted = unionLiterals(authSessionStripped, 'Permission', 'auth-session.ts');
    const defined = constStringArray(permissionsTs, 'PERMISSIONS', 'permissions.ts');

    expect({
      missingFromFrontend: defined.filter((name) => !granted.includes(name)),
      unknownToFrontend: granted.filter((name) => !defined.includes(name)),
    }).toEqual({ missingFromFrontend: [], unknownToFrontend: [] });
  });

  it('holds the same gateway modes the backend reports', () => {
    const reported = unionLiterals(configTs, 'GatewayMode', 'config/index.ts');
    const rendered = unionLiterals(apiTypesStripped, 'GatewayMode', 'api-types.ts');

    expect(rendered.sort()).toEqual(reported.sort());
  });

  it('holds the same sale limits the API enforces', () => {
    const enforced = limitLeaves(
      stripComments(readBackend('backend/src/services/sales.service.ts')),
      'SALE_LIMITS',
      'sales.service.ts'
    );
    const assumed = flattenLimits(SALE_LIMITS);

    const problems: string[] = [];
    for (const [key, value] of assumed) {
      const other = enforced.get(key);
      if (other === undefined) {
        problems.push(`SALE_LIMITS.${key} is assumed here but the API has no such bound`);
      } else if (other !== value) {
        problems.push(`SALE_LIMITS.${key} is ${value} here but ${other} in the API`);
      }
    }
    for (const key of enforced.keys()) {
      if (!assumed.has(key)) {
        problems.push(`the API bounds SALE_LIMITS.${key} but this app does not know it`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('holds the same product limits the API enforces', () => {
    // Same check as `SALE_LIMITS`, over the inventory service's bounds. The
    // inventory forms validate a product, a receive, an adjustment and a
    // write-off against these before the round trip; a bound that drifted would
    // let a form accept a value the API then refuses, or refuse one it would
    // have taken.
    const enforced = limitLeaves(
      stripComments(readBackend('backend/src/services/inventory.service.ts')),
      'PRODUCT_LIMITS',
      'inventory.service.ts'
    );
    const assumed = flattenLimits(PRODUCT_LIMITS);

    const problems: string[] = [];
    for (const [key, value] of assumed) {
      const other = enforced.get(key);
      if (other === undefined) {
        problems.push(`PRODUCT_LIMITS.${key} is assumed here but the API has no such bound`);
      } else if (other !== value) {
        problems.push(`PRODUCT_LIMITS.${key} is ${value} here but ${other} in the API`);
      }
    }
    for (const key of enforced.keys()) {
      if (!assumed.has(key)) {
        problems.push(`the API bounds PRODUCT_LIMITS.${key} but this app does not know it`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('holds the same report limits the API enforces', () => {
    // Same check as `SALE_LIMITS`, over the reports service's window bound. The
    // date picker refuses a range wider than this before the round trip; a bound
    // that drifted would let it offer a range the API answers with a 400 — after
    // the operator has waited for eight aggregates to be refused, on a page whose
    // job is to be believed.
    const enforced = limitLeaves(
      stripComments(readBackend('backend/src/services/reports.service.ts')),
      'REPORT_LIMITS',
      'reports.service.ts'
    );
    const assumed = flattenLimits(REPORT_LIMITS);

    const problems: string[] = [];
    for (const [key, value] of assumed) {
      const other = enforced.get(key);
      if (other === undefined) {
        problems.push(`REPORT_LIMITS.${key} is assumed here but the API has no such bound`);
      } else if (other !== value) {
        problems.push(`REPORT_LIMITS.${key} is ${value} here but ${other} in the API`);
      }
    }
    for (const key of enforced.keys()) {
      if (!assumed.has(key)) {
        problems.push(`the API bounds REPORT_LIMITS.${key} but this app does not know it`);
      }
    }

    expect(problems).toEqual([]);
  });
});
