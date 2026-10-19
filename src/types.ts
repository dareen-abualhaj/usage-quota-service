import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';

export type Db = Pool | PoolClient;
export interface Account { id: number; name: string }

// Everything a route needs, passed in explicitly (no globals), so tests can swap the clock etc.
export interface Deps {
  pool: Pool;
  now: () => Date;
  authenticate: (req: FastifyRequest) => Promise<Account>;
  adminToken?: string;
}
