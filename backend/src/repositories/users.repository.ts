import { query } from '../database/pool';
import { HttpError } from '../utils/http';
import type { UserRole } from '../utils/permissions';

/**
 * The users table, and nothing else.
 *
 * Every read returns the password hash too, because the only consumer that
 * needs it is login — but no route may echo a UserRow: responses go through
 * `toSafeUser` in the auth service, never through this shape.
 */

export interface UserRow {
  id: string;
  pharmacyId: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: UserRole;
  passwordHash: string;
  isActive: boolean;
  sessionVersion: number;
  lastLoginAt: string | null;
}

export interface NewStaff {
  pharmacyId: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: UserRole;
  passwordHash: string;
}

export interface StaffPatch {
  fullName?: string;
  phone?: string | null;
  role?: UserRole;
  isActive?: boolean;
}

const COLUMNS =
  'id, pharmacy_id, full_name, email, phone, role, password_hash, is_active, session_version, last_login_at';

function mapRow(row: Record<string, unknown>): UserRow {
  return {
    id: row.id as string,
    pharmacyId: row.pharmacy_id as string,
    fullName: row.full_name as string,
    email: row.email as string,
    phone: (row.phone as string | null) ?? null,
    role: row.role as UserRole,
    passwordHash: row.password_hash as string,
    isActive: row.is_active as boolean,
    sessionVersion: row.session_version as number,
    lastLoginAt: (row.last_login_at as string | null) ?? null,
  };
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  // lower() on both sides: signing in must not depend on how the shift typed
  // the address, and the unique index is on lower(email) to match.
  const result = await query(
    `select ${COLUMNS} from users where lower(email) = lower($1) limit 1`,
    [email]
  );
  const first = result.rows[0];
  return first === undefined ? null : mapRow(first);
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const result = await query(`select ${COLUMNS} from users where id = $1`, [id]);
  const first = result.rows[0];
  return first === undefined ? null : mapRow(first);
}

export async function markLogin(id: string): Promise<void> {
  await query('update users set last_login_at = now() where id = $1', [id]);
}

/** Ends every outstanding session for the user, access and refresh alike. */
export async function bumpSessionVersion(id: string): Promise<void> {
  await query(
    'update users set session_version = session_version + 1 where id = $1',
    [id]
  );
}

export async function listStaff(pharmacyId: string): Promise<UserRow[]> {
  const result = await query(
    `select ${COLUMNS} from users where pharmacy_id = $1 order by full_name, email`,
    [pharmacyId]
  );
  return result.rows.map(mapRow);
}

export async function createStaff(input: NewStaff): Promise<UserRow> {
  try {
    const result = await query(
      `insert into users (pharmacy_id, full_name, email, phone, role, password_hash)
       values ($1, $2, $3, $4, $5, $6)
       returning ${COLUMNS}`,
      [
        input.pharmacyId,
        input.fullName,
        input.email,
        input.phone,
        input.role,
        input.passwordHash,
      ]
    );
    const inserted = result.rows[0];
    if (inserted === undefined) {
      // INSERT ... RETURNING always yields the row it inserted; nothing here
      // can legitimately produce an empty result.
      throw new Error('insert into users returned no row');
    }
    return mapRow(inserted);
  } catch (error) {
    // The unique index is on lower(email), so a clash arrives as a unique
    // violation rather than something the caller can pre-check race-free.
    if ((error as { code?: string }).code === '23505') {
      throw new HttpError(409, 'A staff member with that email already exists', {
        code: 'email_taken',
      });
    }
    throw error;
  }
}

export async function countActiveOwners(
  pharmacyId: string,
  excludeUserId?: string
): Promise<number> {
  const result = await query(
    `select count(*)::int as n from users
      where pharmacy_id = $1
        and role = 'pharmacy_owner'
        and is_active = true
        and ($2::uuid is null or id <> $2::uuid)`,
    [pharmacyId, excludeUserId ?? null]
  );
  const first = result.rows[0];
  return first === undefined ? 0 : (first.n as number);
}

/**
 * Applies a staff edit. A role change or a deactivation bumps the session
 * version in the same statement, so the edited person's tokens stop working
 * on the same commit that changes what they are allowed to do — not on the
 * next request that happens to check.
 */
export async function updateStaff(
  id: string,
  patch: StaffPatch,
  options: { invalidateSessions: boolean }
): Promise<UserRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (column: string, value: unknown): string => {
    values.push(value);
    return `${column} = $${values.length}`;
  };

  if (patch.fullName !== undefined) sets.push(push('full_name', patch.fullName));
  if (patch.phone !== undefined) sets.push(push('phone', patch.phone));
  if (patch.role !== undefined) sets.push(push('role', patch.role));
  if (patch.isActive !== undefined) sets.push(push('is_active', patch.isActive));
  if (sets.length === 0) {
    return findUserById(id);
  }
  if (options.invalidateSessions) {
    sets.push('session_version = session_version + 1');
  }
  sets.push(push('updated_at', new Date().toISOString()));

  values.push(id);
  const result = await query(
    `update users set ${sets.join(', ')} where id = $${values.length} returning ${COLUMNS}`,
    values
  );
  const first = result.rows[0];
  return first === undefined ? null : mapRow(first);
}

export async function setPassword(id: string, passwordHash: string): Promise<void> {
  // The bump is the point: whoever was holding the old session, including
  // anyone who knew the old password, stops here.
  await query(
    `update users
        set password_hash = $1, session_version = session_version + 1, updated_at = now()
      where id = $2`,
    [passwordHash, id]
  );
}
