// Example client: a tiny "document processing app" backend. It holds the account's API key
// server-side (never in the browser) and calls the quota service on behalf of its users.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const SERVICE = process.env.SERVICE_URL ?? 'http://localhost:3000';
const ADMIN = process.env.ADMIN_TOKEN ?? '';
const PORT = Number(process.env.PORT ?? 8080);
let session = null; // { apiKey, accountPlanId, planIds: {Basic, Premium} }

async function svc(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (session?.apiKey) headers['x-api-key'] = session.apiKey;
  if (ADMIN) headers['x-admin-token'] = ADMIN;
  const res = await fetch(SERVICE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Demo account: custom account plan (120/month, 100 per request), alice on Basic, bob on Premium.
async function setup() {
  session = null;
  const acc = await svc('POST', '/accounts', { name: 'Demo Co' });
  if (acc.status !== 201) throw new Error('cannot create account: ' + JSON.stringify(acc.body));
  session = { apiKey: acc.body.apiKey };
  const plans = (await svc('GET', '/plans')).body.plans;
  const byName = (n) => plans.find((p) => p.predefined && p.name === n).id;
  const ap = await svc('POST', '/plans', { kind: 'account', name: 'Demo Account Plan', monthlyAllowance: 120, maxPerRequest: 100 });
  session.accountPlanId = ap.body.plan.id;
  await svc('PUT', '/account/plan', { planId: session.accountPlanId });
  session.planIds = { Basic: byName('Basic'), Premium: byName('Premium') };
  await svc('POST', '/users', { userId: 'alice', planId: session.planIds.Basic });
  await svc('POST', '/users', { userId: 'bob', planId: session.planIds.Premium });
}
const processDocument = (userId, units) => svc('POST', '/consume', { userId, units, requestId: randomUUID() });
const state = async () => ({
  usage: (await svc('GET', '/usage')).body,
  users: (await svc('GET', '/users')).body,
  plans: (await svc('GET', '/plans')).body,
});

async function demo() {
  await setup();
  const log = [];
  const step = async (title, fn) => { const r = await fn(); log.push({ title, status: r.status, result: r.body }); };
  await step('alice (Basic: 100/mo, 10 per request) processes a 5-unit document', () => processDocument('alice', 5));
  await step('alice tries 15 units -> rejected by HER per-request limit', () => processDocument('alice', 15));
  await step('bob (Premium) processes 100 units -> accepted (account used: 105/120)', () => processDocument('bob', 100));
  await step('bob tries 50 units -> rejected by the shared ACCOUNT monthly allowance (15 left)', () => processDocument('bob', 50));
  await step('switch alice to Premium (no client code change)', () => svc('PUT', '/users/alice/plan', { planId: session.planIds.Premium }));
  await step('alice retries 15 units -> now accepted (account: 120/120)', () => processDocument('alice', 15));
  await step('bob tries 1 unit -> account exhausted', () => processDocument('bob', 1));
  await step('raise the account plan to 1000/month via the API (no redeploy)', () => svc('PUT', `/plans/${session.accountPlanId}`, { monthlyAllowance: 1000 }));
  await step('bob retries 50 units -> accepted', () => processDocument('bob', 50));
  return { log, state: await state() };
}

const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => resolve(s ? JSON.parse(s) : {})); });

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html'))
      return res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(new URL('./public/index.html', import.meta.url)));
    if (!req.url.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.method === 'POST' && req.url === '/api/setup') { await setup(); return json(res, 200, await state()); }
    if (req.method === 'POST' && req.url === '/api/demo') return json(res, 200, await demo());
    if (!session) return json(res, 409, { error: 'Run setup first' });
    if (req.method === 'GET' && req.url === '/api/state') return json(res, 200, await state());
    const b = await readBody(req);
    if (req.method === 'POST' && req.url === '/api/consume') return json(res, 200, await processDocument(b.userId, Number(b.units)));
    if (req.method === 'POST' && req.url === '/api/user-plan')
      return json(res, 200, await svc('PUT', `/users/${encodeURIComponent(b.userId)}/plan`, { planId: session.planIds[b.plan] }));
    if (req.method === 'POST' && req.url === '/api/account-plan')
      return json(res, 200, await svc('PUT', `/plans/${session.accountPlanId}`, { monthlyAllowance: Number(b.monthlyAllowance), maxPerRequest: Number(b.maxPerRequest) }));
    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 500, { error: String(e.message ?? e) }); }
}).listen(PORT, '0.0.0.0', () => console.log(`example client on :${PORT} -> ${SERVICE}`));
