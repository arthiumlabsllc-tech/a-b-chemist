import bcrypt from 'bcryptjs';
import {
  hashPassword,
  isBcryptHash,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from '../utils/password';

/**
 * Password hashing, and the 'UNSET' rule the seeded owner depends on.
 *
 * Rounds are low here for speed. The cost parameter is asserted separately —
 * what matters is that the number given is the number used, not that the test
 * suite spends four seconds proving bcrypt is slow.
 */

const FAST_ROUNDS = 4;

describe('passwords', () => {
  describe('isBcryptHash', () => {
    it.each([
      ['$2a$12$LJ3m4ov/tNz0u9VbXyQ7e.abc', 'the 2a prefix bcryptjs writes'],
      ['$2b$10$abcdefghijklmnopqrstuu', 'the 2b prefix OpenBSD bcrypt writes'],
      ['$2y$12$abcdefghijklmnopqrstuu', 'the 2y prefix PHP crypt writes'],
    ])('accepts %s (%s)', async (stored) => {
      // A hash produced by another implementation must still verify, or an
      // account imported from elsewhere becomes unreachable.
      expect(isBcryptHash(stored)).toBe(true);
    });

    it.each([
      ['UNSET', 'the seeded owner, before onboarding'],
      ['', 'an empty column'],
      ['password123', 'a plaintext password, which must never verify'],
      ['$2a$12$', 'a truncated hash with no digest'],
      ['$2x$12$abcdefghijklmnopqrstuu', 'an unknown bcrypt variant'],
      ['bcrypt$2a$12$abc', 'a prefixed value that is not a bare hash'],
    ])('rejects %s (%s)', (stored) => {
      expect(isBcryptHash(stored)).toBe(false);
    });
  });

  describe('hashPassword', () => {
    it('produces a hash that verifies against the password', async () => {
      const hash = await hashPassword('correct horse battery', FAST_ROUNDS);

      expect(isBcryptHash(hash)).toBe(true);
      await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
    });

    it('salts, so the same password hashes differently each time', async () => {
      const first = await hashPassword('same-password', FAST_ROUNDS);
      const second = await hashPassword('same-password', FAST_ROUNDS);

      // Without a per-hash salt, two staff members sharing a password are
      // visibly sharing it, and a leaked hash table becomes a rainbow table.
      expect(first).not.toBe(second);
      await expect(verifyPassword('same-password', first)).resolves.toBe(true);
      await expect(verifyPassword('same-password', second)).resolves.toBe(true);
    });

    it('uses the rounds it was given', async () => {
      // The cost is stored in the hash itself, in characters 4-5. Asserting it
      // catches a call that silently ignores the configured work factor and
      // hashes at bcrypt's default instead.
      const hash = await hashPassword('rounds-check', 10);

      expect(hash.slice(4, 6)).toBe('10');
    });
  });

  describe('verifyPassword', () => {
    it('rejects a wrong password', async () => {
      const hash = await hashPassword('right-password', FAST_ROUNDS);

      await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
    });

    it('returns false for the seeded UNSET value instead of throwing', async () => {
      // The guarantee the seed depends on. Throwing here would turn the owner's
      // first login attempt into a 500, and comparing against 'UNSET' would
      // mean a password of "UNSET" signs in.
      await expect(verifyPassword('UNSET', 'UNSET')).resolves.toBe(false);
      await expect(verifyPassword('', 'UNSET')).resolves.toBe(false);
      await expect(verifyPassword('anything at all', 'UNSET')).resolves.toBe(false);
    });

    it('returns false for a stored plaintext password rather than comparing it', async () => {
      // If a plaintext value ever reached the column, comparing strings would
      // make that password work. It must not.
      await expect(verifyPassword('hunter2', 'hunter2')).resolves.toBe(false);
    });

    it('never hands a non-hash to bcrypt at all', async () => {
      // The three tests above would still pass with the `isBcryptHash` guard
      // deleted, because bcryptjs is itself lenient: it returns false for
      // 'UNSET', for '' and for a plaintext string rather than throwing. That
      // was verified by mutation — the guard survived its own removal.
      //
      // So the guarantee is pinned as the mechanism instead. A security property
      // must not rest on a third-party library tolerating malformed input it
      // could reasonably start rejecting in a future release; if bcryptjs ever
      // threw here, the owner's first login attempt would become a 500 and the
      // behaviour tests would go red for a reason nobody chose.
      const compare = jest.spyOn(bcrypt, 'compare');

      await verifyPassword('UNSET', 'UNSET');
      await verifyPassword('hunter2', 'hunter2');
      await verifyPassword('', '');

      expect(compare).not.toHaveBeenCalled();

      // And that the guard is not simply refusing everything: a real hash does
      // reach bcrypt, so the assertion above is about the shape of the input
      // rather than about verification having been switched off.
      const hash = await hashPassword('reaches-bcrypt', FAST_ROUNDS);
      await verifyPassword('reaches-bcrypt', hash);

      expect(compare).toHaveBeenCalledTimes(1);
      compare.mockRestore();
    });
  });

  describe('the length policy', () => {
    it('requires eight and allows seventy-two', () => {
      expect(MIN_PASSWORD_LENGTH).toBe(8);
      expect(MAX_PASSWORD_LENGTH).toBe(72);
    });

    it('caps at 72 because bcrypt ignores everything after that', async () => {
      // This is the reason MAX_PASSWORD_LENGTH exists, demonstrated rather than
      // asserted from documentation: a 100 character password and its own first
      // 72 characters are the same password as far as the hash is concerned.
      const long = 'a'.repeat(100);
      const hash = await hashPassword(long, FAST_ROUNDS);

      await expect(verifyPassword('a'.repeat(72), hash)).resolves.toBe(true);
      await expect(verifyPassword('a'.repeat(72) + 'totally-different', hash)).resolves.toBe(true);
    });
  });
});
