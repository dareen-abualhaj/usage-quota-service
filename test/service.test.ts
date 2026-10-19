import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { buildApp } from '../src/app';
import { createPool, migrate } from '../src/db';

let pool: Pool;
let app: ReturnType<typeof buildApp>;
let clock: Date;
const T0 = new Date('2026-03-15T12:00:00Z');

beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL ?? 'postgres://quota:quota@localhost:5432/quota', 20);
  await migrate(pool);
  app = buildApp(pool, { now: () => clock });
});
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(() => { clock = new Date(T0); });

async function call(method: 'GET' | 'POST' | 'PUT', url: string, key?: string, body?: unknown) {
  const res = await app.inject({ method, url, headers: key ? { 'x-api-key': key } : {}, payload: body as any });
  return { status: res.statusCode, body: res.json() as any };
}
const consume = (key: string, userId: string, units: number, requestId: string = randomUUID()) =>
  call('POST', '/consume', key, { userId, units, requestId });

// Creates an account with a custom account plan and one custom plan per user: [monthly, maxPerRequest]
async function mk(acct: [number, number], users: Record<string, [number, number]>) {
  const created = await call('POST', '/accounts', undefined, { name: 'test' });
  const key = created.body.apiKey as string;
  const ap = await call('POST', '/plans', key, { kind: 'account', name: 'A', monthlyAllowance: acct[0], maxPerRequest: acct[1] });
  await call('PUT', '/account/plan', key, { planId: ap.body.plan.id });
  const planIds: Record<string, number> = {};
  for (const [uid, [m, x]] of Object.entries(users)) {
    const p = await call('POST', '/plans', key, { kind: 'user', name: 'P-' + uid, monthlyAllowance: m, maxPerRequest: x });
    await call('POST', '/users', key, { userId: uid, planId: p.body.plan.id });
    planIds[uid] = p.body.plan.id;
  }
  return { key, planIds, accountPlanId: ap.body.plan.id as number };
}

describe('API keys & isolation', () => {
  it('rejects missing and invalid keys', async () => {
    expect((await call('GET', '/usage')).status).toBe(401);
    expect((await call('GET', '/usage', 'qk_wrong')).status).toBe(401);
    expect((await call('POST', '/consume', 'qk_wrong', { userId: 'u', units: 1, requestId: 'r' })).status).toBe(401);
  });
  it('admin token protects account creation when configured', async () => {
    const guarded = buildApp(pool, { adminToken: 's3cret' });
    const no = await guarded.inject({ method: 'POST', url: '/accounts', payload: { name: 'x' } });
    const yes = await guarded.inject({ method: 'POST', url: '/accounts', headers: { 'x-admin-token': 's3cret' }, payload: { name: 'x' } });
    expect(no.statusCode).toBe(401);
    expect(yes.statusCode).toBe(201);
    await guarded.close();
  });
  it('accounts cannot see or touch each other', async () => {
    const A = await mk([100, 10], { u1: [100, 10] });
    const B = await mk([100, 10], { u1: [100, 10] });
    await consume(A.key, 'u1', 5);
    expect((await call('GET', '/usage', B.key)).body.users[0].consumed).toBe(0);
    expect((await call('GET', '/requests', B.key)).body.items).toHaveLength(0);
    // B cannot use A's plan, nor read/update it
    expect((await call('PUT', '/account/plan', B.key, { planId: A.accountPlanId })).status).toBe(404);
    expect((await call('PUT', `/plans/${A.accountPlanId}`, B.key, { monthlyAllowance: 1 })).status).toBe(404);
    expect((await call('POST', '/users', B.key, { userId: 'u2', planId: A.planIds.u1 })).status).toBe(404);
    // B's own u1 and A's u1 are different users with separate usage
    expect((await call('GET', '/users/u1/usage', A.key)).body.user.consumed).toBe(5);
    expect((await call('GET', '/users/u1/usage', B.key)).body.user.consumed).toBe(0);
    expect((await call('GET', '/users/nobody/usage', B.key)).status).toBe(404);
  });
});

describe('consume rules', () => {
  it('accepts when both plans allow, counts on both levels', async () => {
    const { key } = await mk([1000, 100], { u: [100, 20] });
    const r = await consume(key, 'u', 10);
    expect(r.body.accepted).toBe(true);
    expect(r.body.user.consumed).toBe(10); expect(r.body.user.remaining).toBe(90);
    expect(r.body.account.consumed).toBe(10); expect(r.body.account.remaining).toBe(990);
  });
  it('user per-request limit rejects (spec example: 25 vs 20)', async () => {
    const { key } = await mk([10000, 100], { u: [1000, 20] });
    const r = await consume(key, 'u', 25);
    expect(r.body.accepted).toBe(false);
    expect(r.body.rejection).toMatchObject({ scope: 'user', rule: 'max_per_request' });
    expect((await call('GET', '/usage', key)).body.account.consumed).toBe(0);
  });
  it('account per-request limit rejects', async () => {
    const { key } = await mk([10000, 30], { u: [1000, 100] });
    const r = await consume(key, 'u', 40);
    expect(r.body.rejection).toMatchObject({ scope: 'account', rule: 'max_per_request' });
  });
  it('user monthly allowance rejects and consumes nothing', async () => {
    const { key } = await mk([1000, 100], { u: [10, 10] });
    expect((await consume(key, 'u', 10)).body.accepted).toBe(true);
    const r = await consume(key, 'u', 1);
    expect(r.body.rejection).toMatchObject({ scope: 'user', rule: 'monthly_allowance' });
    expect(r.body.user.consumed).toBe(10); expect(r.body.account.consumed).toBe(10);
  });
  it('shared account allowance rejects even if the user has plenty (spec example: 5 left, ask 10)', async () => {
    const { key } = await mk([15, 100], { u1: [100, 100], u2: [100, 100] });
    expect((await consume(key, 'u1', 10)).body.accepted).toBe(true);
    const r = await consume(key, 'u2', 10);
    expect(r.body.accepted).toBe(false);
    expect(r.body.rejection).toMatchObject({ scope: 'account', rule: 'monthly_allowance' });
    expect(r.body.account.remaining).toBe(5);
    expect(r.body.user.consumed).toBe(0);
  });
  it('users sharing a plan definition keep separate usage', async () => {
    const { key, planIds } = await mk([1000, 100], { u1: [10, 10] });
    await call('POST', '/users', key, { userId: 'u2', planId: planIds.u1 });
    await consume(key, 'u1', 10);
    expect((await consume(key, 'u1', 1)).body.accepted).toBe(false);
    expect((await consume(key, 'u2', 10)).body.accepted).toBe(true);
  });
  it('validates input and records nothing for invalid requests', async () => {
    const { key } = await mk([100, 10], { u: [100, 10] });
    for (const units of [0, -1, 1.5, '5', null]) expect((await consume(key, 'u', units as any)).status).toBe(400);
    expect((await call('POST', '/consume', key, { userId: 'u', units: 1 })).status).toBe(400);
    expect((await consume(key, 'ghost', 1)).status).toBe(404);
    expect((await call('GET', '/requests', key)).body.items).toHaveLength(0);
  });
});

describe('idempotency & concurrency', () => {
  it('replays the same decision for the same requestId, consuming once', async () => {
    const { key } = await mk([100, 10], { u: [100, 10] });
    const first = await consume(key, 'u', 5, 'req-1');
    const again = await consume(key, 'u', 5, 'req-1');
    expect(again.body.replayed).toBe(true);
    expect(again.body.accepted).toBe(first.body.accepted);
    expect((await call('GET', '/usage', key)).body.account.consumed).toBe(5);
    expect((await consume(key, 'u', 6, 'req-1')).status).toBe(409); // same id, different payload
  });
  it('20 parallel duplicates of one requestId consume exactly once', async () => {
    const { key } = await mk([100, 10], { u: [100, 10] });
    const rs = await Promise.all(Array.from({ length: 20 }, () => consume(key, 'u', 7, 'dup')));
    expect(rs.every((r) => r.status === 200 && r.body.accepted)).toBe(true);
    expect(rs.filter((r) => !r.body.replayed)).toHaveLength(1);
    expect((await call('GET', '/usage', key)).body.account.consumed).toBe(7);
  });
  it('never overspends under 100 parallel requests (account 50, users 40 each)', async () => {
    const { key } = await mk([50, 10], { a: [40, 10], b: [40, 10] });
    const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => consume(key, i % 2 ? 'a' : 'b', 1)));
    const accepted = rs.filter((r) => r.body.accepted).length;
    const u = (await call('GET', '/usage', key)).body;
    expect(accepted).toBe(50);
    expect(u.account.consumed).toBe(50);
    expect(u.users.reduce((s: number, x: any) => s + x.consumed, 0)).toBe(50);
    expect(u.users.every((x: any) => x.consumed <= 40)).toBe(true);
  });
});

describe('plan changes', () => {
  it('switching plans keeps consumed units and applies to new requests', async () => {
    const { key, planIds } = await mk([1000, 100], { u: [10, 10] });
    await consume(key, 'u', 10);
    expect((await consume(key, 'u', 1)).body.accepted).toBe(false);
    const big = await call('POST', '/plans', key, { kind: 'user', name: 'Big', monthlyAllowance: 100, maxPerRequest: 50 });
    await call('PUT', '/users/u/plan', key, { planId: big.body.plan.id });
    const u = (await call('GET', '/users/u/usage', key)).body.user;
    expect(u.consumed).toBe(10); expect(u.remaining).toBe(90); // no fresh allowance, just a higher limit
    expect((await consume(key, 'u', 20)).body.accepted).toBe(true);
    expect(planIds.u).toBeGreaterThan(0);
  });
  it('lowering allowance below usage shows 0 remaining and rejects', async () => {
    const { key, planIds } = await mk([1000, 100], { u: [20, 20] });
    await consume(key, 'u', 15);
    await call('PUT', `/plans/${planIds.u}`, key, { monthlyAllowance: 10 });
    const u = (await call('GET', '/users/u/usage', key)).body.user;
    expect(u.consumed).toBe(15); expect(u.remaining).toBe(0);
    const r = await consume(key, 'u', 1);
    expect(r.body.rejection).toMatchObject({ scope: 'user', rule: 'monthly_allowance' });
    await call('PUT', `/plans/${planIds.u}`, key, { monthlyAllowance: 30 }); // allowance available again
    expect((await consume(key, 'u', 1)).body.accepted).toBe(true);
  });
  it('plan update affects every user on that plan; history is preserved', async () => {
    const { key, planIds } = await mk([1000, 100], { u1: [100, 10] });
    await call('POST', '/users', key, { userId: 'u2', planId: planIds.u1 });
    await consume(key, 'u1', 10); await consume(key, 'u2', 10);
    await call('PUT', `/plans/${planIds.u1}`, key, { maxPerRequest: 5 });
    expect((await consume(key, 'u1', 6)).body.rejection).toMatchObject({ scope: 'user', rule: 'max_per_request' });
    expect((await consume(key, 'u2', 6)).body.rejection).toMatchObject({ scope: 'user', rule: 'max_per_request' });
    const h = (await call('GET', '/requests', key)).body.items;
    expect(h).toHaveLength(4);
    expect(h.filter((i: any) => i.accepted)).toHaveLength(2);
  });
  it('predefined plans are read-only and seeded', async () => {
    const { key } = await mk([100, 10], { u: [100, 10] });
    const plans = (await call('GET', '/plans', key)).body.plans.filter((p: any) => p.predefined).map((p: any) => p.name);
    expect(plans).toEqual(expect.arrayContaining(['Starter', 'Pro', 'Basic', 'Premium']));
    const starter = (await call('GET', '/plans?kind=account', key)).body.plans.find((p: any) => p.name === 'Starter');
    expect((await call('PUT', `/plans/${starter.id}`, key, { monthlyAllowance: 1 })).status).toBe(403);
  });
});

describe('months & history', () => {
  it('each UTC month starts at zero; old months stay queryable', async () => {
    const { key } = await mk([100, 50], { u: [100, 50] });
    clock = new Date('2026-03-31T23:59:59Z');
    await consume(key, 'u', 50);
    clock = new Date('2026-04-01T00:00:00Z');
    const now = (await call('GET', '/usage', key)).body;
    expect(now.month).toBe('2026-04'); expect(now.account.consumed).toBe(0); expect(now.users[0].consumed).toBe(0);
    const old = (await call('GET', '/usage?month=2026-03', key)).body;
    expect(old.account.consumed).toBe(50); expect(old.users[0].consumed).toBe(50);
    expect((await consume(key, 'u', 50)).body.accepted).toBe(true);
    expect((await call('GET', '/requests?month=2026-03', key)).body.items).toHaveLength(1);
  });
  it('paginates request history newest-first with a cursor', async () => {
    const { key } = await mk([1000, 10], { u: [1000, 10] });
    for (let i = 0; i < 5; i++) await consume(key, 'u', 1, `p-${i}`);
    const p1 = (await call('GET', '/requests?limit=2', key)).body;
    expect(p1.items.map((i: any) => i.requestId)).toEqual(['p-4', 'p-3']);
    const p2 = (await call('GET', `/requests?limit=2&cursor=${p1.nextCursor}`, key)).body;
    expect(p2.items.map((i: any) => i.requestId)).toEqual(['p-2', 'p-1']);
    const p3 = (await call('GET', `/requests?limit=2&cursor=${p2.nextCursor}`, key)).body;
    expect(p3.items.map((i: any) => i.requestId)).toEqual(['p-0']);
    expect(p3.nextCursor).toBeNull();
  });
});


describe('keys, request ids, single-user concurrency, usage listing, DB invariants', () => {
  it('stores only a SHA-256 hash of the API key, never the key', async () => {
    const created = await call('POST', '/accounts', undefined, { name: 'hash-check' });
    const key = created.body.apiKey as string;
    expect((await pool.query('SELECT 1 FROM accounts WHERE api_key_hash = $1', [key])).rowCount).toBe(0);
    const row = (await pool.query('SELECT api_key_hash FROM accounts WHERE id = $1', [created.body.account.id])).rows[0];
    expect(row.api_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.api_key_hash).not.toContain(key);
  });

  it('the same requestId in two different accounts is independent', async () => {
    const A = await mk([100, 10], { u: [100, 10] });
    const B = await mk([100, 10], { u: [100, 10] });
    const a = await consume(A.key, 'u', 5, 'shared-id');
    const b = await consume(B.key, 'u', 7, 'shared-id'); // different units: NOT a conflict, different account
    expect(a.body.accepted).toBe(true); expect(a.body.replayed).toBe(false);
    expect(b.status).toBe(200); expect(b.body.accepted).toBe(true); expect(b.body.replayed).toBe(false);
    expect((await call('GET', '/usage', A.key)).body.account.consumed).toBe(5);
    expect((await call('GET', '/usage', B.key)).body.account.consumed).toBe(7);
  });

  it('30 parallel requests against a user with allowance 20 accept exactly 20', async () => {
    const { key } = await mk([1000, 10], { solo: [20, 10] });
    const rs = await Promise.all(Array.from({ length: 30 }, () => consume(key, 'solo', 1)));
    expect(rs.filter((r) => r.body.accepted)).toHaveLength(20);
    const rejected = rs.filter((r) => !r.body.accepted);
    expect(rejected).toHaveLength(10);
    expect(rejected.every((r) => r.body.rejection.scope === 'user' && r.body.rejection.rule === 'monthly_allowance')).toBe(true);
    const u = (await call('GET', '/users/solo/usage', key)).body;
    expect(u.user.consumed).toBe(20); expect(u.user.remaining).toBe(0); expect(u.account.consumed).toBe(20);
  });

  it('GET /usage lists the account and every user with consumed and remaining', async () => {
    const { key } = await mk([1000, 100], { a: [100, 10], b: [50, 10] });
    await consume(key, 'a', 7); await consume(key, 'b', 3);
    const u = (await call('GET', '/usage', key)).body;
    expect(u.account).toMatchObject({ consumed: 10, remaining: 990, monthlyAllowance: 1000, maxPerRequest: 100 });
    const byId = Object.fromEntries(u.users.map((x: any) => [x.userId, x]));
    expect(byId.a).toMatchObject({ consumed: 7, remaining: 93, monthlyAllowance: 100, maxPerRequest: 10 });
    expect(byId.b).toMatchObject({ consumed: 3, remaining: 47, monthlyAllowance: 50, maxPerRequest: 10 });
    expect(byId.a.plan.name).toBe('P-a');
  });

  it('DB invariants hold after everything above (scripts/check-invariants.sql returns zero rows)', async () => {
    const sql = readFileSync(path.join(__dirname, '..', 'scripts', 'check-invariants.sql'), 'utf8');
    const violations = await pool.query(sql);
    expect(violations.rows).toEqual([]);
  });
});
