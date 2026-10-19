# Usage Metering and Quota Service

A backend that other applications call to decide whether one of *their* users may consume N units, and to record the outcome.
TypeScript · Fastify · PostgreSQL (plain SQL via `pg`). One service, one database.

## Run it

```bash
docker compose up --build
```

| What | URL |
|---|---|
| Example client (open this) | http://localhost:8080 |
| Quota service API | http://localhost:3000 |
| PostgreSQL | localhost:5432 (user/password/db: `quota`) |

On the client page: **1. Setup demo account**, then **2. Run scripted demo**. The demo shows, in order: an accepted action, a rejection by a *user* limit, a rejection by the shared *account* limit, a user plan switch, and an account plan edit changing what a user can do, with no client change and no redeploy. You can also process documents manually and switch plans from the page. Headless: `curl -X POST localhost:8080/api/demo`.

Schema creation and predefined-plan seeding run automatically on service start (`db/init.sql`, idempotent).

Config (env): `DATABASE_URL`, `PORT` (3000), `ADMIN_TOKEN` (if set, creating accounts requires header `x-admin-token`; compose sets `dev-admin-token`), `PG_POOL_MAX` (20), `LOG_LEVEL`.

## Concepts

- **Account**: an application/company. Has one account plan. Gets an API key at creation (shown once, stored only as a SHA-256 hash).
- **User**: registered under an account by the caller's own id (`userId`, unique per account). Has one user plan.
- **Plan**: `{kind: account|user, name, monthlyAllowance, maxPerRequest}`. Predefined plans are global and read-only; custom plans belong to one account and can be shared by many users (usage stays per user).
- **Units**: positive whole numbers (max 1e12).

Predefined plans (seeded):

| Kind | Name | Monthly | Per request |
|---|---|---|---|
| account | Starter (default for new accounts) | 1,000 | 100 |
| account | Pro | 100,000 | 1,000 |
| user | Basic (default for new users) | 100 | 10 |
| user | Premium | 1,000 | 100 |

## API

Everything except `/health` and `POST /accounts` needs `x-api-key: <key>`. Errors: `{"error":{"code","message"}}`.

| Method & path | Purpose |
|---|---|
| `POST /accounts` `{name, planId?}` | Create account → `{account, apiKey}` (needs `x-admin-token` if configured) |
| `GET /account?month=` | Account, its plan, consumed/remaining |
| `PUT /account/plan` `{planId}` | Assign an account plan |
| `GET /plans?kind=` | Predefined + your own plans (these are the limits you can apply) |
| `POST /plans` `{kind,name,monthlyAllowance,maxPerRequest}` | Create custom plan |
| `PUT /plans/:id` `{name?,monthlyAllowance?,maxPerRequest?}` | Update custom plan (predefined → 403) |
| `POST /users` `{userId, planId?}` | Register user |
| `GET /users` | Users and their plans |
| `PUT /users/:userId/plan` `{planId}` | Change a user's plan |
| **`POST /consume`** `{userId, units, requestId}` | The decision endpoint |
| `GET /usage?month=YYYY-MM` | Account + all users: consumed, remaining, limits, plan |
| `GET /users/:userId/usage?month=` | One user + the account |
| `GET /requests?limit=&cursor=&userId=&month=` | History, newest first; `nextCursor` for the next page (null at the end) |

```bash
curl -s -X POST localhost:3000/accounts -H 'x-admin-token: dev-admin-token' -H 'content-type: application/json' -d '{"name":"Acme"}'
# -> {"account":{...},"apiKey":"qk_..."}   (save it)
KEY=qk_...
curl -s -X POST localhost:3000/users -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"userId":"alice"}'
curl -s -X POST localhost:3000/consume -H "x-api-key: $KEY" -H 'content-type: application/json' \
     -d '{"userId":"alice","units":25,"requestId":"doc-123"}'
```
```json
{ "requestId":"doc-123","userId":"alice","units":25,"month":"2026-03","accepted":false,"replayed":false,
  "rejection":{"scope":"user","rule":"max_per_request","message":"User per-request limit would be exceeded"},
  "account":{"plan":{"id":1,"name":"Starter"},"monthlyAllowance":1000,"maxPerRequest":100,"consumed":0,"remaining":1000},
  "user":{"plan":{"id":3,"name":"Basic"},"monthlyAllowance":100,"maxPerRequest":10,"consumed":0,"remaining":100} }
```
`rejection.scope` is `account|user`; `rejection.rule` is `max_per_request|monthly_allowance`.

## Rules and how a request is decided

Both plans must allow the request. Checks, in order (order only affects *which* violated rule is reported): user per-request, account per-request, user monthly, account monthly. Accepted ⇒ +units on the user **and** the account (account usage = sum of its users'). Rejected ⇒ nothing consumed. Month = UTC month at processing time. Remaining = `max(0, allowance − consumed)`.

### Plan changes
Plans are read inside each `/consume` transaction, so an edit applies to every request that arrives after the edit commits. Switching a plan keeps units already consumed (no fresh allowance). Lowering an allowance below current usage ⇒ remaining 0 and rejections until the allowance is raised or the month rolls over. History rows are never rewritten.

### Retries / idempotency
`requestId` is unique per account. Same `requestId` + same user/units ⇒ the **stored decision is replayed** (`replayed:true`), consuming nothing again, including when duplicates arrive concurrently (the second blocks on the unique index until the first commits). Same `requestId` with different user/units ⇒ `409 request_id_conflict`. Invalid requests (400/404/401) are not recorded and consume nothing, so they can be retried freely.

## Design decisions

- **Correctness via row locks, in one transaction.** `/consume`: (1) load user + both plans, (2) claim `requestId` with `INSERT … ON CONFLICT DO NOTHING`, (3) upsert-and-lock the `account_usage` row then the `user_usage` row (`ON CONFLICT DO UPDATE SET consumed = consumed` creates the row if needed and takes the row lock in one statement), (4) decide from the locked values, (5) one statement increments both counters and marks the request, (6) commit. Because the check and the increment happen under the row lock, concurrent requests cannot overspend. **Lock order is always account → user**, so no deadlocks.
- **Idempotency in the database**, not in memory, so it survives restarts and works across instances.
- **Usage counters are rows per (entity, month)**, not computed by summing history: O(1) decisions, and the account counter is updated atomically with the user counter. History (`requests`) is a separate append-only log used for the audit/history API and for cross-checking counters in tests.
- **Auth**: SHA-256 of the key is looked up; valid keys are cached in memory for 60 s (keys are immutable in this version).
- **Rejection is HTTP 200 with `accepted:false`**: it is a decision, not an error. Errors use 4xx/5xx.

## Product assumptions (brief left these open)

1. Units must be integers ≥ 1 and ≤ 1e12; anything else is a 400 and is not recorded.
2. Rejections are recorded in history under their `requestId`; retrying a *rejected* `requestId` replays the rejection even if plans changed since. Callers should use a new `requestId` for a new attempt.
3. Only one violated rule is reported (the first in the order above).
4. Usage/remaining for past months are shown against the **currently assigned** plan.
5. New accounts default to Starter, new users to Basic.
6. Account creation is gated by `ADMIN_TOKEN` if set (otherwise open; fine for local use).
7. Plans cannot be deleted, and a plan assigned to an account/user is always usable by it. Plan names are unique per account and kind.
8. User ids are the caller's strings, scoped per account.
9. No additional custom rule types were added: I kept the core reliable rather than adding unfinished extras.

## Tests

Integration tests run against a real PostgreSQL (no mocks), via Fastify's in-process `inject`.

```bash
docker compose up -d db
npm install
npm test            # DATABASE_URL defaults to postgres://quota:quota@localhost:5432/quota
```
Covers: API-key validation, admin token, account isolation (usage, history, plans, users), all four rejection rules, rejection consumes nothing, shared-plan separate usage, input validation, idempotent replay + conflict, 20 parallel duplicate requests, 100 parallel requests never overspending, plan switch / lowering below usage / plan update affecting all users / history preserved, predefined plans read-only, UTC month rollover with an injected clock, pagination.

## Performance testing

```bash
docker compose up -d --build         # service on :3000
npm install
ADMIN_TOKEN=dev-admin-token npm run load     # DURATION=10 CONNECTIONS=64 by default
```
Uses `autocannon` (`scripts/load.mjs`). Scenarios: one hot account with 200 users, 50 accounts spread out, and a correctness run where limits are really hit and the final counters are checked against an independent re-sum of the request history. Results and analysis: [docs/LOAD_TEST.md](docs/LOAD_TEST.md).

## Known limitations

- **Hot account row**: every accepted/rejected request for one account serializes on that account's `account_usage` row lock. Throughput per account is bounded by transaction latency; different accounts scale independently.
- Single PostgreSQL, single region; no read replicas, no sharding.
- API keys cannot be rotated/revoked, and there is no way to delete accounts, users or plans.
- Admin token is a single shared secret, not a role system.
- `requests` grows forever (no retention/partitioning).
- Allowances/limits capped at 1e12 (stored as BIGINT, read as JS numbers).

## Tracing a request (for the walkthrough)

`POST /consume` → `auth()` (header → SHA-256 → account) → validation → `BEGIN` → load user+plans → claim `requestId` (replay / 409 if taken) → lock account usage row, then user usage row → decide → one write statement → `COMMIT` → response. Code: `src/app.ts`, route `/consume`. Schema: `db/init.sql`.
