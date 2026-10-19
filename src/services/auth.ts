import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { HttpError } from '../errors';
import type { Account } from '../types';

export const sha256 = (k: string) => createHash('sha256').update(k).digest('hex');
// 192 random bits: a plain SHA-256 hash is enough to store (there is no password to brute-force).
export const generateApiKey = () => 'qk_' + randomBytes(24).toString('hex');

// x-api-key header -> account. Keys are immutable in this version (no rotation/revocation endpoint), so caching
// hash -> account is safe. If revocation is ever added, delete the entry there. Only VALID keys are cached.
export function createAuthenticator(pool: Pool) {
  const cache = new Map<string, Account & { exp: number }>();
  return async (req: FastifyRequest): Promise<Account> => {
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || !key) throw new HttpError(401, 'missing_api_key', 'x-api-key header is required');
    const h = sha256(key);
    const hit = cache.get(h);
    if (hit && hit.exp > Date.now()) return { id: hit.id, name: hit.name };
    const r = await pool.query('SELECT id, name FROM accounts WHERE api_key_hash = $1', [h]);
    if (!r.rows[0]) throw new HttpError(401, 'invalid_api_key', 'Invalid API key');
    if (cache.size > 10000) cache.clear();
    cache.set(h, { ...r.rows[0], exp: Date.now() + 60_000 });
    return r.rows[0];
  };
}
