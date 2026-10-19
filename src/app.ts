import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;
export interface AppOptions {
  now?: () => Date;               // injectable clock (used by tests for month rollover)
  adminToken?: string;            // if set, POST /accounts requires header x-admin-token
  logger?: boolean | object;
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const bad = (code: string, msg: string) => new HttpError(400, code, msg);
const notFound = (code: string, msg: string) => new HttpError(404, code, msg);
const isUnique = (e: any) => e?.code === '23505';

const MAX_INT = 1_000_000_000_000;
const isInt = (n: unknown, min: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= MAX_INT;
const isStr = (s: unknown, max = 200): s is string =>
  typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

const sha256 = (k: string) => createHash('sha256').update(k).digest('hex');
const monthOf = (d: Date) => d.toISOString().slice(0, 7); // UTC 'YYYY-MM'
const bodyOf = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;

const planOut = (p: any) => ({
  id: p.id, accountId: p.account_id, kind: p.kind, name: p.name,
  monthlyAllowance: p.monthly_allowance, maxPerRequest: p.max_per_request, predefined: p.is_predefined,
});
// One side (account or user) of the picture: the plan applied now + usage for a month.
const side = (plan: any, consumed: number) => ({
  plan: { id: plan.id, name: plan.name },
  monthlyAllowance: plan.monthly_allowance,
  maxPerRequest: plan.max_per_request,
  consumed,
  remaining: Math.max(0, plan.monthly_allowance - consumed), // never negative, even if allowance was lowered
});

export function buildApp(pool: Pool, opts: AppOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const app = Fastify({ logger: opts.logger ?? false });

  app.setErrorHandler((err: any, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof HttpError)
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (err.validation || (err.statusCode && err.statusCode < 500))
      return reply.status(err.statusCode ?? 400).send({ error: { code: 'bad_request', message: err.message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Internal error' } });
  });

  // ---------- helpers ----------
  // Keys are immutable in this version (no rotation/revocation endpoint), so caching hash -> account is safe.
  // If revocation is ever added, delete the entry there. Only VALID keys are cached.
  const authCache = new Map<string, { id: number; name: string; exp: number }>();
  async function auth(req: FastifyRequest): Promise<{ id: number; name: string }> {
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || !key) throw new HttpError(401, 'missing_api_key', 'x-api-key header is required');
    const h = sha256(key);
    const hit = authCache.get(h);
    if (hit && hit.exp > Date.now()) return hit;
    const r = await pool.query('SELECT id, name FROM accounts WHERE api_key_hash = $1', [h]);
    if (!r.rows[0]) throw new HttpError(401, 'invalid_api_key', 'Invalid API key');
    if (authCache.size > 10000) authCache.clear();
    authCache.set(h, { ...r.rows[0], exp: Date.now() + 60_000 });
    return r.rows[0];
  }
  const parseId = (v: string) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1) throw bad('invalid_id', 'id must be a positive integer');
    return n;
  };
  const monthParam = (v: unknown) => {
    if (v === undefined) return monthOf(now());
    if (!isMonth(v)) throw bad('invalid_month', "month must look like '2026-03'");
    return v;
  };
  // A plan is usable by an account if it is predefined or owned by that account.
  async function findPlan(db: Db, accountId: number, planId: unknown, kind?: 'account' | 'user') {
    if (!isInt(planId, 1)) throw bad('invalid_plan_id', 'planId must be a positive integer');
    const r = await db.query('SELECT * FROM plans WHERE id = $1 AND (account_id IS NULL OR account_id = $2)', [planId, accountId]);
    const p = r.rows[0];
    if (!p) throw notFound('plan_not_found', 'Plan not found');
    if (kind && p.kind !== kind) throw bad('plan_kind_mismatch', `Plan must be of kind '${kind}'`);
    return p;
  }
  async function accountSide(db: Db, accountId: number, month: string) {
    const r = await db.query(
      `SELECT row_to_json(p) AS plan, COALESCE(au.consumed, 0) AS consumed
         FROM accounts a JOIN plans p ON p.id = a.plan_id
         LEFT JOIN account_usage au ON au.account_id = a.id AND au.month = $2
        WHERE a.id = $1`, [accountId, month]);
    return side(r.rows[0].plan, r.rows[0].consumed);
  }
  async function userSide(db: Db, userDbId: number, month: string) {
    const r = await db.query(
      `SELECT row_to_json(p) AS plan, COALESCE(uu.consumed, 0) AS consumed
         FROM users u JOIN plans p ON p.id = u.plan_id
         LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.month = $2
        WHERE u.id = $1`, [userDbId, month]);
    return side(r.rows[0].plan, r.rows[0].consumed);
  }
  async function findUser(db: Db, accountId: number, externalId: string) {
    const r = await db.query('SELECT id, external_id FROM users WHERE account_id = $1 AND external_id = $2', [accountId, externalId]);
    if (!r.rows[0]) throw notFound('user_not_found', 'User not found in this account');
    return r.rows[0] as { id: number; external_id: string };
  }
  const rejectionMessage = (scope: string, rule: string) =>
    `${scope === 'user' ? 'User' : 'Account'} ${rule === 'max_per_request' ? 'per-request limit' : 'monthly allowance'} would be exceeded`;

  app.get('/health', async () => ({ status: 'ok' }));

  // ---------- accounts ----------
  app.post('/accounts', async (req, reply) => {
    if (opts.adminToken && req.headers['x-admin-token'] !== opts.adminToken)
      throw new HttpError(401, 'invalid_admin_token', 'x-admin-token header is required to create accounts');
    const b = bodyOf(req);
    if (!isStr(b.name)) throw bad('invalid_name', 'name is required');
    let planId: number;
    if (b.planId === undefined) {
      planId = (await pool.query(`SELECT id FROM plans WHERE account_id IS NULL AND kind = 'account' AND name = 'Starter'`)).rows[0].id;
    } else {
      if (!isInt(b.planId, 1)) throw bad('invalid_plan_id', 'planId must be a positive integer');
      const r = await pool.query(`SELECT id FROM plans WHERE id = $1 AND account_id IS NULL AND kind = 'account'`, [b.planId]);
      if (!r.rows[0]) throw notFound('plan_not_found', 'Predefined account plan not found');
      planId = r.rows[0].id;
    }
    const apiKey = 'qk_' + randomBytes(24).toString('hex');
    const r = await pool.query('INSERT INTO accounts (name, api_key_hash, plan_id) VALUES ($1,$2,$3) RETURNING id, name, plan_id',
      [b.name.trim(), sha256(apiKey), planId]);
    reply.code(201);
    return { account: { id: r.rows[0].id, name: r.rows[0].name, planId }, apiKey, note: 'Store this key now: it cannot be retrieved again.' };
  });

  app.get('/account', async (req) => {
    const acc = await auth(req);
    const month = monthParam((req.query as any).month);
    return { id: acc.id, name: acc.name, month, ...(await accountSide(pool, acc.id, month)) };
  });

  app.put('/account/plan', async (req) => {
    const acc = await auth(req);
    const plan = await findPlan(pool, acc.id, bodyOf(req).planId, 'account');
    await pool.query('UPDATE accounts SET plan_id = $1 WHERE id = $2', [plan.id, acc.id]);
    return { plan: planOut(plan) };
  });

  // ---------- plans ----------
  app.get('/plans', async (req) => {
    const acc = await auth(req);
    const kind = (req.query as any).kind;
    if (kind !== undefined && kind !== 'account' && kind !== 'user') throw bad('invalid_kind', "kind must be 'account' or 'user'");
    const r = await pool.query(
      `SELECT * FROM plans WHERE (account_id IS NULL OR account_id = $1) AND ($2::text IS NULL OR kind = $2) ORDER BY is_predefined DESC, id`,
      [acc.id, kind ?? null]);
    return { plans: r.rows.map(planOut) };
  });

  app.post('/plans', async (req, reply) => {
    const acc = await auth(req);
    const b = bodyOf(req);
    if (b.kind !== 'account' && b.kind !== 'user') throw bad('invalid_kind', "kind must be 'account' or 'user'");
    if (!isStr(b.name, 100)) throw bad('invalid_name', 'name is required');
    if (!isInt(b.monthlyAllowance, 0)) throw bad('invalid_monthly_allowance', 'monthlyAllowance must be a whole number >= 0');
    if (!isInt(b.maxPerRequest, 1)) throw bad('invalid_max_per_request', 'maxPerRequest must be a whole number >= 1');
    try {
      const r = await pool.query(
        'INSERT INTO plans (account_id, kind, name, monthly_allowance, max_per_request) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [acc.id, b.kind, b.name.trim(), b.monthlyAllowance, b.maxPerRequest]);
      reply.code(201);
      return { plan: planOut(r.rows[0]) };
    } catch (e) {
      if (isUnique(e)) throw new HttpError(409, 'plan_name_taken', 'You already have a plan of this kind with that name');
      throw e;
    }
  });

  // Changes take effect for the next /consume: it reads the plan row inside its own transaction.
  app.put('/plans/:id', async (req) => {
    const acc = await auth(req);
    const id = parseId((req.params as any).id);
    const b = bodyOf(req);
    if (b.name === undefined && b.monthlyAllowance === undefined && b.maxPerRequest === undefined)
      throw bad('nothing_to_update', 'Provide name, monthlyAllowance and/or maxPerRequest');
    if (b.name !== undefined && !isStr(b.name, 100)) throw bad('invalid_name', 'name must be a non-empty string');
    if (b.monthlyAllowance !== undefined && !isInt(b.monthlyAllowance, 0)) throw bad('invalid_monthly_allowance', 'monthlyAllowance must be a whole number >= 0');
    if (b.maxPerRequest !== undefined && !isInt(b.maxPerRequest, 1)) throw bad('invalid_max_per_request', 'maxPerRequest must be a whole number >= 1');
    const existing = await findPlan(pool, acc.id, id);
    if (existing.is_predefined) throw new HttpError(403, 'plan_read_only', 'Predefined plans are read-only');
    try {
      const r = await pool.query(
        `UPDATE plans SET name = COALESCE($3, name), monthly_allowance = COALESCE($4, monthly_allowance),
                          max_per_request = COALESCE($5, max_per_request)
          WHERE id = $1 AND account_id = $2 RETURNING *`,
        [id, acc.id, b.name ?? null, b.monthlyAllowance ?? null, b.maxPerRequest ?? null]);
      return { plan: planOut(r.rows[0]) };
    } catch (e) {
      if (isUnique(e)) throw new HttpError(409, 'plan_name_taken', 'You already have a plan of this kind with that name');
      throw e;
    }
  });

  // ---------- users ----------
  app.post('/users', async (req, reply) => {
    const acc = await auth(req);
    const b = bodyOf(req);
    if (!isStr(b.userId)) throw bad('invalid_user_id', 'userId must be a non-empty string');
    const plan = b.planId === undefined
      ? (await pool.query(`SELECT * FROM plans WHERE account_id IS NULL AND kind = 'user' AND name = 'Basic'`)).rows[0]
      : await findPlan(pool, acc.id, b.planId, 'user');
    try {
      await pool.query('INSERT INTO users (account_id, external_id, plan_id) VALUES ($1,$2,$3)', [acc.id, b.userId, plan.id]);
    } catch (e) {
      if (isUnique(e)) throw new HttpError(409, 'user_exists', 'User already registered');
      throw e;
    }
    reply.code(201);
    return { user: { userId: b.userId, plan: planOut(plan) } };
  });

  app.get('/users', async (req) => {
    const acc = await auth(req);
    const r = await pool.query(
      `SELECT u.external_id, row_to_json(p) AS plan FROM users u JOIN plans p ON p.id = u.plan_id WHERE u.account_id = $1 ORDER BY u.id`, [acc.id]);
    return { users: r.rows.map((x) => ({ userId: x.external_id, plan: planOut(x.plan) })) };
  });

  app.put('/users/:userId/plan', async (req) => {
    const acc = await auth(req);
    const user = await findUser(pool, acc.id, (req.params as any).userId);
    const plan = await findPlan(pool, acc.id, bodyOf(req).planId, 'user');
    await pool.query('UPDATE users SET plan_id = $1 WHERE id = $2', [plan.id, user.id]);
    return { user: { userId: user.external_id, plan: planOut(plan) } };
  });

  // ---------- usage & history ----------
  app.get('/usage', async (req) => {
    const acc = await auth(req);
    const month = monthParam((req.query as any).month);
    const users = await pool.query(
      `SELECT u.external_id, row_to_json(p) AS plan, COALESCE(uu.consumed, 0) AS consumed
         FROM users u JOIN plans p ON p.id = u.plan_id
         LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.month = $2
        WHERE u.account_id = $1 ORDER BY u.id`, [acc.id, month]);
    return {
      month,
      account: await accountSide(pool, acc.id, month),
      users: users.rows.map((u) => ({ userId: u.external_id, ...side(u.plan, u.consumed) })),
    };
  });

  app.get('/users/:userId/usage', async (req) => {
    const acc = await auth(req);
    const month = monthParam((req.query as any).month);
    const user = await findUser(pool, acc.id, (req.params as any).userId);
    return { month, account: await accountSide(pool, acc.id, month), user: { userId: user.external_id, ...(await userSide(pool, user.id, month)) } };
  });

  app.get('/requests', async (req) => {
    const acc = await auth(req);
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('invalid_limit', 'limit must be 1..200');
    const params: unknown[] = [acc.id];
    let where = 'r.account_id = $1';
    if (q.cursor !== undefined) {
      if (!/^\d+$/.test(q.cursor)) throw bad('invalid_cursor', 'cursor must come from a previous nextCursor');
      params.push(Number(q.cursor)); where += ` AND r.id < $${params.length}`;
    }
    if (q.userId !== undefined) { params.push(q.userId); where += ` AND u.external_id = $${params.length}`; }
    if (q.month !== undefined) {
      if (!isMonth(q.month)) throw bad('invalid_month', "month must look like '2026-03'");
      params.push(q.month); where += ` AND r.month = $${params.length}`;
    }
    params.push(limit + 1);
    const r = await pool.query(
      `SELECT r.*, u.external_id FROM requests r JOIN users u ON u.id = r.user_id
        WHERE ${where} ORDER BY r.id DESC LIMIT $${params.length}`, params);
    const rows = r.rows.slice(0, limit);
    return {
      items: rows.map((x) => ({
        id: x.id, requestId: x.request_id, userId: x.external_id, units: x.units, month: x.month,
        accepted: x.accepted,
        rejection: x.accepted ? null : { scope: x.rejected_scope, rule: x.rejected_rule },
        createdAt: x.created_at,
      })),
      nextCursor: r.rows.length > limit ? rows[rows.length - 1].id : null,
    };
  });

  // ---------- consume (the core) ----------
  app.post('/consume', async (req) => {
    const acc = await auth(req);
    const b = bodyOf(req);
    if (!isStr(b.userId)) throw bad('invalid_user_id', 'userId must be a non-empty string');
    if (!isInt(b.units, 1)) throw bad('invalid_units', 'units must be a positive whole number');
    if (!isStr(b.requestId)) throw bad('invalid_request_id', 'requestId must be a non-empty string');
    const { userId, units, requestId } = b as { userId: string; units: number; requestId: string };
    const month = monthOf(now());

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // One round trip: the user + both plans currently applied (read inside the tx, after the request started,
      // so any plan edit committed before this request arrived is always seen).
      const ctx = (await client.query(
        `SELECT u.id, row_to_json(ap) AS a, row_to_json(up) AS u
           FROM users u JOIN accounts a ON a.id = u.account_id
           JOIN plans ap ON ap.id = a.plan_id JOIN plans up ON up.id = u.plan_id
          WHERE u.account_id = $1 AND u.external_id = $2`, [acc.id, userId])).rows[0];
      if (!ctx) throw notFound('user_not_found', 'User not found in this account');
      const user = { id: ctx.id as number };
      const A = ctx.a, U = ctx.u;

      // 1) Idempotency: claim the request id. A concurrent duplicate blocks here until we commit/rollback.
      const ins = await client.query(
        `INSERT INTO requests (account_id, user_id, request_id, units, month) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (account_id, request_id) DO NOTHING RETURNING id`,
        [acc.id, user.id, requestId, units, month]);
      if (!ins.rows[0]) {
        await client.query('ROLLBACK');
        const ex = (await client.query('SELECT * FROM requests WHERE account_id = $1 AND request_id = $2', [acc.id, requestId])).rows[0];
        if (ex.user_id !== user.id || ex.units !== units)
          throw new HttpError(409, 'request_id_conflict', 'requestId was already used with different userId/units');
        return {
          requestId, userId, units, month: ex.month, accepted: ex.accepted, replayed: true,
          rejection: ex.accepted ? null : { scope: ex.rejected_scope, rule: ex.rejected_rule, message: rejectionMessage(ex.rejected_scope, ex.rejected_rule) },
          account: await accountSide(client, acc.id, ex.month), user: await userSide(client, user.id, ex.month),
        };
      }

      // 2) Lock usage rows. FIXED ORDER: account first, then user => no deadlocks.
      //    The no-op DO UPDATE creates the row if missing AND takes the row lock, in one statement.
      const aC = (await client.query(
        `INSERT INTO account_usage (account_id, month, consumed) VALUES ($1,$2,0)
         ON CONFLICT (account_id, month) DO UPDATE SET consumed = account_usage.consumed RETURNING consumed`, [acc.id, month])).rows[0].consumed as number;
      const uC = (await client.query(
        `INSERT INTO user_usage (user_id, month, consumed) VALUES ($1,$2,0)
         ON CONFLICT (user_id, month) DO UPDATE SET consumed = user_usage.consumed RETURNING consumed`, [user.id, month])).rows[0].consumed as number;

      // 3) Decide. Order of checks only affects WHICH violated rule is reported.
      let rej: { scope: 'user' | 'account'; rule: 'max_per_request' | 'monthly_allowance' } | null = null;
      if (units > U.max_per_request) rej = { scope: 'user', rule: 'max_per_request' };
      else if (units > A.max_per_request) rej = { scope: 'account', rule: 'max_per_request' };
      else if (units > Math.max(0, U.monthly_allowance - uC)) rej = { scope: 'user', rule: 'monthly_allowance' };
      else if (units > Math.max(0, A.monthly_allowance - aC)) rej = { scope: 'account', rule: 'monthly_allowance' };

      // 4) Write. Rows are already locked by us, so the increments cannot race. One statement = one round trip.
      let newA = aC, newU = uC;
      if (!rej) {
        newA = aC + units; newU = uC + units;
        await client.query(
          `WITH a AS (UPDATE account_usage SET consumed = consumed + $3 WHERE account_id = $1 AND month = $2),
                u AS (UPDATE user_usage SET consumed = consumed + $3 WHERE user_id = $4 AND month = $2)
           UPDATE requests SET accepted = true WHERE id = $5`,
          [acc.id, month, units, user.id, ins.rows[0].id]);
      } else {
        await client.query('UPDATE requests SET rejected_scope = $2, rejected_rule = $3 WHERE id = $1',
          [ins.rows[0].id, rej.scope, rej.rule]);
      }
      await client.query('COMMIT');

      return {
        requestId, userId, units, month, accepted: !rej, replayed: false,
        rejection: rej ? { ...rej, message: rejectionMessage(rej.scope, rej.rule) } : null,
        account: side(A, newA), user: side(U, newU),
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });

  return app;
}
