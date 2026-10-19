# Load test results

**How:** `scripts/load.mjs` (autocannon, 64 connections, 10 s per scenario, `POST /consume` with a fresh `requestId` per request, 1 unit each).
Reproduce: `docker compose up -d --build && npm install && ADMIN_TOKEN=dev-admin-token npm run load`.

**Environment (caveat):** run on a 1-vCPU sandbox where PostgreSQL 16, the Node service and the load generator all shared that single core, with default Postgres settings (fsync on). Absolute numbers are therefore low and not representative of real hardware; the *relative* findings are what matter. Re-run on your machine for your own numbers.

## Results (after optimization)

| Scenario | req/s | p50 | p97.5 | p99 | non-2xx / errors |
|---|---|---|---|---|---|
| 1 account, 200 users (hot account row) | 266 | 213 ms | 465 ms | 548 ms | 0 / 0 |
| 50 accounts × 20 users | 464 | 133 ms | 185 ms | 193 ms | 0 / 0 |
| Limits actually hit (account 1000, users 80 each) | 346 | 169 ms | 332 ms | 368 ms | 0 / 0 |

## Correctness under load (scenario 3)

3,501 requests were recorded; 2,501 were rejected (limits hit). Final state: account consumed **1000 / 1000**, sum of user consumed **1000**, max single user **67 / 80**, and the sum of accepted units re-added from the request history is **1000**. So counters equal history, nothing overspent, and rejected requests consumed nothing, with 64 concurrent connections. (The same property is asserted in `test/service.test.ts` with 100 parallel requests.)

## What I learned

1. **Latency is dominated by DB round trips.** The first version used ~11 queries per `/consume`. Baseline: 245 req/s (hot account) and 403 req/s (spread). I (a) cached valid API-key lookups, (b) merged the user lookup and plan read into one query, and (c) merged the three writes into one CTE statement. Result: 266 req/s (+9%) and 464 req/s (+15%), with all 19 tests still passing. The gain is modest here because on one shared core CPU, not network latency, is the limit; with a networked DB the round-trip savings matter more.
2. **The hot account row is the bottleneck by design.** One account is ~43% slower than 50 accounts spread out, because requests for the same account serialize on its row lock. This is the price of exact shared-allowance enforcement; it is documented as a limitation. Mitigations if needed: shard/batch the account counter (reserve blocks of units per instance) at the cost of exactness.
3. **No deadlocks or errors** across all runs thanks to the fixed lock order (account → user).
4. Next steps if I had more time: prepared statements/pipelining, tune `synchronous_commit` only if durability trade-offs are acceptable (not changed here), and test on dedicated hardware.
