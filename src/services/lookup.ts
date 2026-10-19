// Read helpers shared by several routes. Every one is scoped to an account, which is what enforces isolation.
import { bad, notFound } from '../errors';
import { isInt } from '../validation';
import { side } from '../views';
import type { Db } from '../types';

// A plan is usable by an account if it is predefined or owned by that account.
export async function findPlan(db: Db, accountId: number, planId: unknown, kind?: 'account' | 'user') {
  if (!isInt(planId, 1)) throw bad('invalid_plan_id', 'planId must be a positive integer');
  const r = await db.query('SELECT * FROM plans WHERE id = $1 AND (account_id IS NULL OR account_id = $2)', [planId, accountId]);
  const p = r.rows[0];
  if (!p) throw notFound('plan_not_found', 'Plan not found');
  if (kind && p.kind !== kind) throw bad('plan_kind_mismatch', `Plan must be of kind '${kind}'`);
  return p;
}

export async function findUser(db: Db, accountId: number, externalId: string) {
  const r = await db.query('SELECT id, external_id FROM users WHERE account_id = $1 AND external_id = $2', [accountId, externalId]);
  if (!r.rows[0]) throw notFound('user_not_found', 'User not found in this account');
  return r.rows[0] as { id: number; external_id: string };
}

export async function accountSide(db: Db, accountId: number, month: string) {
  const r = await db.query(
    `SELECT row_to_json(p) AS plan, COALESCE(au.consumed, 0) AS consumed
       FROM accounts a JOIN plans p ON p.id = a.plan_id
       LEFT JOIN account_usage au ON au.account_id = a.id AND au.month = $2
      WHERE a.id = $1`, [accountId, month]);
  return side(r.rows[0].plan, r.rows[0].consumed);
}

export async function userSide(db: Db, userDbId: number, month: string) {
  const r = await db.query(
    `SELECT row_to_json(p) AS plan, COALESCE(uu.consumed, 0) AS consumed
       FROM users u JOIN plans p ON p.id = u.plan_id
       LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.month = $2
      WHERE u.id = $1`, [userDbId, month]);
  return side(r.rows[0].plan, r.rows[0].consumed);
}
