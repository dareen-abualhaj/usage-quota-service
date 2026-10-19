import type { FastifyInstance } from 'fastify';
import { HttpError, bad, isUnique } from '../errors';
import { bodyOf, isInt, isStr, parseId } from '../validation';
import { planOut } from '../views';
import { findPlan } from '../services/lookup';
import type { Deps } from '../types';

export function planRoutes(app: FastifyInstance, d: Deps) {
  const { pool } = d;
  const nameTaken = () => new HttpError(409, 'plan_name_taken', 'You already have a plan of this kind with that name');

  // Predefined plans + this account's own plans.
  app.get('/plans', async (req) => {
    const acc = await d.authenticate(req);
    const kind = (req.query as any).kind;
    if (kind !== undefined && kind !== 'account' && kind !== 'user') throw bad('invalid_kind', "kind must be 'account' or 'user'");
    const r = await pool.query(
      `SELECT * FROM plans WHERE (account_id IS NULL OR account_id = $1) AND ($2::text IS NULL OR kind = $2) ORDER BY is_predefined DESC, id`,
      [acc.id, kind ?? null]);
    return { plans: r.rows.map(planOut) };
  });

  app.post('/plans', async (req, reply) => {
    const acc = await d.authenticate(req);
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
      if (isUnique(e)) throw nameTaken();
      throw e;
    }
  });

  // Changes take effect for the next /consume: it reads the plan rows inside its own transaction.
  app.put('/plans/:id', async (req) => {
    const acc = await d.authenticate(req);
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
      if (isUnique(e)) throw nameTaken();
      throw e;
    }
  });
}
