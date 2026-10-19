import type { FastifyInstance } from 'fastify';
import { bad } from '../errors';
import { isMonth, monthParam } from '../validation';
import { side } from '../views';
import { accountSide, findUser, userSide } from '../services/lookup';
import type { Deps } from '../types';

export function usageRoutes(app: FastifyInstance, d: Deps) {
  const { pool } = d;

  // Consumed and remaining for the account and every user, for a month (default: current UTC month).
  app.get('/usage', async (req) => {
    const acc = await d.authenticate(req);
    const month = monthParam((req.query as any).month, d.now());
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
    const acc = await d.authenticate(req);
    const month = monthParam((req.query as any).month, d.now());
    const user = await findUser(pool, acc.id, (req.params as any).userId);
    return { month, account: await accountSide(pool, acc.id, month), user: { userId: user.external_id, ...(await userSide(pool, user.id, month)) } };
  });

  // Request history, newest first, keyset pagination (cursor = id of the last item seen).
  app.get('/requests', async (req) => {
    const acc = await d.authenticate(req);
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
}
