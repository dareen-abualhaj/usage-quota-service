// Load test: node scripts/load.mjs   (env: BASE_URL, ADMIN_TOKEN, DURATION, CONNECTIONS)
import autocannon from 'autocannon';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN = process.env.ADMIN_TOKEN ?? '';
const DURATION = Number(process.env.DURATION ?? 10);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 64);

async function api(method, path, key, body) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-api-key'] = key;
  if (ADMIN) headers['x-admin-token'] = ADMIN;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// Creates an account with a custom account plan and N users on one shared custom user plan.
async function makeAccount(name, nUsers, acct, user) {
  const { apiKey } = await api('POST', '/accounts', null, { name });
  const ap = await api('POST', '/plans', apiKey, { kind: 'account', name: 'L', monthlyAllowance: acct[0], maxPerRequest: acct[1] });
  await api('PUT', '/account/plan', apiKey, { planId: ap.plan.id });
  const up = await api('POST', '/plans', apiKey, { kind: 'user', name: 'L', monthlyAllowance: user[0], maxPerRequest: user[1] });
  const users = [];
  for (let i = 0; i < nUsers; i++) {
    const userId = `u${i}`;
    await api('POST', '/users', apiKey, { userId, planId: up.plan.id });
    users.push(userId);
  }
  return { apiKey, users };
}

function run(title, accounts, opts = {}) {
  return new Promise((resolve, reject) => {
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const inst = autocannon({
      url: BASE, connections: CONNECTIONS, ...(opts.amount ? { amount: opts.amount } : { duration: DURATION }),
      requests: [{
        method: 'POST', path: '/consume',
        setupRequest: (req) => {
          const acc = pick(accounts);
          req.headers = { 'content-type': 'application/json', 'x-api-key': acc.apiKey };
          req.body = JSON.stringify({ userId: pick(acc.users), units: 1, requestId: randomUUID() });
          return req;
        },
      }],
    }, (err, r) => {
      if (err) return reject(err);
      resolve({
        title, connections: CONNECTIONS, durationSec: Math.round(r.duration),
        reqPerSec: Math.round(r.requests.average), p50ms: r.latency.p50, p97_5ms: r.latency.p97_5, p99ms: r.latency.p99, maxMs: r.latency.max,
        totalRequests: r.requests.total, non2xx: r.non2xx, errors: r.errors, timeouts: r.timeouts,
      });
    });
    autocannon.track(inst, { renderProgressBar: false });
  });
}

const results = [];
const BIG = [1e11, 1000], UBIG = [1e10, 1000];

console.log('\n== Scenario 1: ONE account, 200 users (worst case: every request locks the same account row) ==');
const one = await makeAccount('load-one', 200, BIG, UBIG);
results.push(await run('1 account / 200 users', [one]));

console.log('\n== Scenario 2: 50 accounts, 20 users each (rows spread out) ==');
const many = [];
for (let i = 0; i < 50; i++) many.push(await makeAccount(`load-many-${i}`, 20, BIG, UBIG));
results.push(await run('50 accounts / 20 users each', many));

console.log('\n== Scenario 3: correctness under load: account allowance 1000, 20 users x 80 (limits ARE hit) ==');
const lim = await makeAccount('load-limit', 20, [1000, 10], [80, 10]);
// Fixed request count (not a duration): guarantees the allowance is exceeded on any machine,
// and autocannon only returns once every response arrived, so nothing is still in flight when we verify.
const r3 = await run('limit correctness (allowance 1000)', [lim], { amount: 3000 });
await new Promise((r) => setTimeout(r, 1000));
const usage = await api('GET', '/usage', lim.apiKey);
const sumUsers = usage.users.reduce((s, u) => s + u.consumed, 0);
const maxUser = Math.max(...usage.users.map((u) => u.consumed));
// Independent cross-check: re-add up every accepted request from the history table.
let acceptedUnits = 0, total = 0, rejected = 0, cursor = null;
do {
  const page = await api('GET', `/requests?limit=200${cursor ? '&cursor=' + cursor : ''}`, lim.apiKey);
  for (const it of page.items) { total++; if (it.accepted) acceptedUnits += it.units; else rejected++; }
  cursor = page.nextCursor;
} while (cursor);
r3.check = {
  requestsRecorded: total, rejected, acceptedUnitsFromHistory: acceptedUnits,
  accountConsumed: usage.account.consumed, accountAllowance: usage.account.monthlyAllowance,
  sumOfUserConsumed: sumUsers, maxUserConsumed: maxUser, userAllowance: 80,
  ok: usage.account.consumed === 1000 && sumUsers === 1000 && acceptedUnits === 1000 && maxUser <= 80,
};
results.push(r3);

console.log('\n================ RESULTS ================');
console.table(results.map(({ check, ...r }) => r));
console.log('Correctness check (scenario 3):', JSON.stringify(r3.check));
if (!r3.check.ok) { console.error('CORRECTNESS FAILURE'); process.exit(1); }
