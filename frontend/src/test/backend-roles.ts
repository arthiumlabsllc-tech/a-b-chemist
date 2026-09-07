/**
 * The backend's role-to-permission map, read from its source.
 *
 * Test support, in `src/test/` beside `setup.ts` rather than in a `__tests__`
 * directory, because two suites need it and `testMatch` collects anything named
 * `*.test.ts` — a shared helper must not be named like a suite.
 *
 * ## Why it parses the backend instead of copying the lists
 *
 * The obvious way to write a frontend test that needs "what a pharmacist may do"
 * is to type the list out. That list is then a third copy of a fact that already
 * lives in `backend/src/utils/permissions.ts` and is mirrored once in
 * `auth-session.ts`, and it goes stale silently: a permission added to the
 * backend leaves the copy behind, the frontend tests keep passing against
 * yesterday's roles, and the thing that eventually breaks is the till.
 *
 * Parsing means a rename or a reformat in the backend fails these suites loudly.
 * The helper throws rather than returning an empty list, because an empty list
 * would make every comparison pass — the same vacuity the mirror guard has its
 * own test for.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PERMISSIONS_FILE = join(
  __dirname,
  '..',
  '..',
  '..',
  'backend',
  'src',
  'utils',
  'permissions.ts'
);

function source(): string {
  return readFileSync(PERMISSIONS_FILE, 'utf8');
}

/**
 * The quoted strings inside a `const … = [ … ]` block.
 *
 * Throws when the block is missing. `noUncheckedIndexedAccess` makes the capture
 * group `string | undefined`, so the narrowing has to happen somewhere and this
 * is the one place it does.
 */
function quotedBlock(text: string, opener: RegExp, name: string): string[] {
  const body = opener.exec(text)?.[1];
  if (body === undefined) {
    throw new Error(`Could not find ${name} in backend/src/utils/permissions.ts`);
  }
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

/** Every permission the backend declares, in declaration order. */
export function allPermissions(): string[] {
  return quotedBlock(source(), /export const PERMISSIONS = \[([\s\S]*?)\] as const;/, 'PERMISSIONS');
}

/** The five the brief makes owner-only. */
export function ownerOnlyPermissions(): string[] {
  return quotedBlock(
    source(),
    /const OWNER_ONLY: readonly Permission\[\] = \[([\s\S]*?)\];/,
    'OWNER_ONLY'
  );
}

/**
 * What a role holds, derived the way the backend derives it.
 *
 * The pharmacist is *not* a list in the source: it is `PERMISSIONS.filter(not in
 * OWNER_ONLY)`, so reproducing it here means reproducing the subtraction and not
 * the result. Writing out eighteen names would be a copy of a computation, and
 * the copy is what drifts.
 */
export function permissionsFor(role: 'pharmacy_owner' | 'pharmacist' | 'staff'): string[] {
  if (role === 'pharmacy_owner') {
    return allPermissions();
  }
  if (role === 'staff') {
    return quotedBlock(source(), /const STAFF: readonly Permission\[\] = \[([\s\S]*?)\];/, 'STAFF');
  }
  const ownerOnly = new Set(ownerOnlyPermissions());
  return allPermissions().filter((permission) => !ownerOnly.has(permission));
}
