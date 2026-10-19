import type { FastifyInstance } from 'fastify';
import { HttpError, bad, notFound } from '../errors';
import { bodyOf, isInt, isStr, monthParam } from '../validation';
import { planOut } from '../views';
import { generateApiKey, sha256 } from '../services/auth';
import { accountSide, findPlan } from '../services/lookup';
import type { Deps } from '../types';

export function accountRoutes(app: FastifyInstance, d: Deps) {
  const { pool } = d;

  // Create an account and issue its API key (shown once; only the hash is stored).
  app.post('/accounts', async (req, reply) => {
    if (d.adminToken && req.headers['x-admin-token'] !== d.adminToken)
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
    const apiKey = generateApiKey();
    const r = await pool.query('INSERT INTO accounts (name, api_key_hash, plan_id) VALUES ($1,$2,$3) RETURNING id, name',
      [b.name.trim(), sha256(apiKey), planId]);
    reply.code(201);
    return { account: { id: r.rows[0].id, name: r.rows[0].name, planId }, apiKey, note: 'Store this key now: it cannot be retrieved again.' };
  });

  app.get('/account', async (req) => {
    const acc = await d.authenticate(req);
    const month = monthParam((req.query as any).month, d.now());
    return { id: acc.id, name: acc.name, month, ...(await accountSide(pool, acc.id, month)) };
  });

  app.put('/account/plan', async (req) => {
    const acc = await d.authenticate(req);
    const plan = await findPlan(pool, acc.id, bodyOf(req).planId, 'account');
    await pool.query('UPDATE accounts SET plan_id = $1 WHERE id = $2', [plan.id, acc.id]);
    return { plan: planOut(plan) };
  });
}
