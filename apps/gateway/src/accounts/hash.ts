/**
 * Shared crypto helper for the accounts stores. One SHA-256 hex digest used by
 * both the access-key store ([session-store.ts]) and the admin-secret cookie
 * ([admin-auth.ts]) — kept in one place so the hashing choice never diverges.
 */
import { createHash } from 'node:crypto';

/** SHA-256 hex digest of a string. */
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
