// THE ACCOUNTING. One transaction decides and records a request. Read this file top to bottom to trace a request.
import type { Pool } from 'pg';
import { HttpError, notFound } from '../errors';
import { evaluate, rejectionMessage, type PlanLimits, type Rejection } from '../rules';
import { side } from '../views';
import { accountSide, userSide } from './lookup';

export interface ConsumeInput { accountId: number; userId: string; units: number; requestId: string; month: string }

const limitsOf = (plan: any): PlanLimits => ({ monthlyAllowance: plan.monthly_allowance, maxPerRequest: plan.max_per_request });
const rejectionOut = (r: Rejection | null) => (r ? { ...r, message: rejectionMessage(r) } : null);

export async function consume(pool: Pool, input: ConsumeInput) {
  const { accountId, userId, units, requestId, month } = input;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // One round trip: the user + both plans currently applied (read inside the tx, after the request started,
    // so any plan edit committed before this request arrived is always seen).
    const ctx = (await client.query(
      `SELECT u.id, row_to_json(ap) AS a, row_to_json(up) AS u
         FROM users u JOIN accounts a ON a.id = u.account_id
         JOIN plans ap ON ap.id = a.plan_id JOIN plans up ON up.id = u.plan_id
        WHERE u.account_id = $1 AND u.external_id = $2`, [accountId, userId])).rows[0];
    if (!ctx) throw notFound('user_not_found', 'User not found in this account');
    const user = { id: ctx.id as number };
    const accountPlan = ctx.a, userPlan = ctx.u;

    // 1) Idempotency: claim the request id. A concurrent duplicate blocks here until we commit/rollback.
    const ins = await client.query(
      `INSERT INTO requests (account_id, user_id, request_id, units, month) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (account_id, request_id) DO NOTHING RETURNING id`,
      [accountId, user.id, requestId, units, month]);
    if (!ins.rows[0]) {
      // Already seen: replay the stored decision (or 409 if it was a different request).
      await client.query('ROLLBACK');
      const ex = (await client.query('SELECT * FROM requests WHERE account_id = $1 AND request_id = $2', [accountId, requestId])).rows[0];
      if (ex.user_id !== user.id || ex.units !== units)
        throw new HttpError(409, 'request_id_conflict', 'requestId was already used with different userId/units');
      const stored: Rejection | null = ex.accepted ? null : { scope: ex.rejected_scope, rule: ex.rejected_rule };
      return {
        requestId, userId, units, month: ex.month as string, accepted: ex.accepted as boolean, replayed: true,
        rejection: rejectionOut(stored),
        account: await accountSide(client, accountId, ex.month), user: await userSide(client, user.id, ex.month),
      };
    }

    // 2) Lock usage rows. FIXED ORDER: account first, then user => no deadlocks.
    //    The no-op DO UPDATE creates the row if missing AND takes the row lock, in one statement.
    const accountConsumed = (await client.query(
      `INSERT INTO account_usage (account_id, month, consumed) VALUES ($1,$2,0)
       ON CONFLICT (account_id, month) DO UPDATE SET consumed = account_usage.consumed RETURNING consumed`, [accountId, month])).rows[0].consumed as number;
    const userConsumed = (await client.query(
      `INSERT INTO user_usage (user_id, month, consumed) VALUES ($1,$2,0)
       ON CONFLICT (user_id, month) DO UPDATE SET consumed = user_usage.consumed RETURNING consumed`, [user.id, month])).rows[0].consumed as number;

    // 3) Decide (pure rules, see rules.ts).
    const rejection = evaluate({
      units,
      account: { limits: limitsOf(accountPlan), consumed: accountConsumed },
      user: { limits: limitsOf(userPlan), consumed: userConsumed },
    });

    // 4) Write. Rows are already locked by us, so the increments cannot race. One statement = one round trip.
    let newAccount = accountConsumed, newUser = userConsumed;
    if (!rejection) {
      newAccount += units; newUser += units;
      await client.query(
        `WITH a AS (UPDATE account_usage SET consumed = consumed + $3 WHERE account_id = $1 AND month = $2),
              u AS (UPDATE user_usage SET consumed = consumed + $3 WHERE user_id = $4 AND month = $2)
         UPDATE requests SET accepted = true WHERE id = $5`,
        [accountId, month, units, user.id, ins.rows[0].id]);
    } else {
      await client.query('UPDATE requests SET rejected_scope = $2, rejected_rule = $3 WHERE id = $1',
        [ins.rows[0].id, rejection.scope, rejection.rule]);
    }
    await client.query('COMMIT');

    return {
      requestId, userId, units, month, accepted: !rejection, replayed: false,
      rejection: rejectionOut(rejection),
      account: side(accountPlan, newAccount), user: side(userPlan, newUser),
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
