import type { FastifyInstance } from 'fastify';
import { HttpError, bad, isUnique } from '../errors';
import { bodyOf, isStr } from '../validation';
import { planOut } from '../views';
import { findPlan, findUser } from '../services/lookup';
import type { Deps } from '../types';

export function userRoutes(app: FastifyInstance, d: Deps) {
  const { pool } = d;

  app.post('/users', async (req, reply) => {
    const acc = await d.authenticate(req);
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
    const acc = await d.authenticate(req);
    const r = await pool.query(
      `SELECT u.external_id, row_to_json(p) AS plan FROM users u JOIN plans p ON p.id = u.plan_id WHERE u.account_id = $1 ORDER BY u.id`, [acc.id]);
    return { users: r.rows.map((x) => ({ userId: x.external_id, plan: planOut(x.plan) })) };
  });

  app.put('/users/:userId/plan', async (req) => {
    const acc = await d.authenticate(req);
    const user = await findUser(pool, acc.id, (req.params as any).userId);
    const plan = await findPlan(pool, acc.id, bodyOf(req).planId, 'user');
    await pool.query('UPDATE users SET plan_id = $1 WHERE id = $2', [plan.id, user.id]);
    return { user: { userId: user.external_id, plan: planOut(plan) } };
  });
}
