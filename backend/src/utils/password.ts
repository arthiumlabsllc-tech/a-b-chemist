import bcrypt from 'bcryptjs';

/**
 * Password hashing, verification and the policy both obey.
 *
 * `verifyPassword` returns false for a stored value that is not bcrypt output
 * instead of throwing or, worse, comparing against it. The seeded owner row
 * ships with the literal 'UNSET' so the seed publishes no usable password;
 * that account must fail login cleanly until onboarding writes a real hash.
 *
 * The policy lives here rather than in the validator so that a script and an
 * HTTP route cannot drift apart on what a usable password is.
 */

/**
 * bcrypt reads the first 72 bytes of the input and ignores the rest. A 200
 * character password is therefore silently a 72 character one, and the person
 * who chose it believes something stronger is protecting their till. Refusing
 * the length outright is the honest option: the limit is real, so it is stated.
 */
export const MAX_PASSWORD_LENGTH = 72;

/**
 * Eight characters, not twelve with a symbol. This is a counter in a pharmacy
 * where the owner types the password into a tablet in front of a queue; a rule
 * nobody can meet is a rule that produces a written-down password under the
 * till, which is worse than a shorter one held in someone's head.
 */
export const MIN_PASSWORD_LENGTH = 8;

const BCRYPT_SHAPE = /^\$2[aby]\$\d{2}\$./;

export function isBcryptHash(stored: string): boolean {
  return BCRYPT_SHAPE.test(stored);
}

export async function hashPassword(plain: string, rounds: number): Promise<string> {
  return bcrypt.hash(plain, rounds);
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!isBcryptHash(stored)) return false;
  return bcrypt.compare(plain, stored);
}
