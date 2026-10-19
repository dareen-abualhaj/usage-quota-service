# Load test results

**How:** `scripts/load.mjs` (autocannon, 64 connections, `POST /consume` with a fresh `requestId` per request, 1 unit each).
Scenarios 1 and 2 run for 10 s; scenario 3 sends a fixed 3,000 requests so the allowance is always exceeded.
Reproduce: `docker compose up -d --build && npm install && ADMIN_TOKEN=dev-admin-token npm run load`
(PowerShell: `$env:ADMIN_TOKEN="dev-admin-token"; npm run load`).

**Environment (caveat):** a Windows laptop running Docker Desktop (WSL2), with PostgreSQL 16 in a container, the Node service in a container, and the load generator on the same machine. Default Postgres settings (fsync on). Numbers vary between runs (about ±20%), so read them as orders of magnitude, not exact figures.

## Results

| Scenario | req/s | p50 | p97.5 | p99 | non-2xx / errors |
|---|---|---|---|---|---|
| 1 account, 200 users (hot account row) | 104 | 456 ms | 1355 ms | 1760 ms | 0 / 0 |
| 50 accounts × 20 users | 423 | 126 ms | 355 ms | 1095 ms | 0 / 0 |
| Limits actually hit (account 1000, users 80 each, 3,000 requests) | 100 | 414 ms | 2038 ms | 2619 ms | 0 / 0 |

## Correctness under load (scenario 3)

3,000 requests were recorded, 2,000 of them rejected because limits were hit. Final state: account consumed **1000 / 1000**, sum of user consumption **1000**, largest single user **64 / 80**, and the accepted units re-added from the request history are **1000**. Counters equal history, nothing was overspent, and rejected requests consumed nothing, with 64 concurrent connections. The same property is asserted in `test/service.test.ts` with 100 parallel requests.

## What I learned

1. **The hot account row is the bottleneck, by design.** One account reaches about 100 req/s while 50 accounts reach about 420 req/s (about 4x). Every request for the same account takes that account's usage-row lock and holds it until COMMIT, so requests for one account run one after another and their rate is capped at roughly 1 / (transaction time including the commit flush). On Docker Desktop/WSL2 the disk flush is slow, which lowers that cap. Different accounts do not block each other. This is the price of exact enforcement of the shared allowance, and it is listed as a known limitation.
2. **Latency is dominated by database round trips.** The first version used about 11 queries per `/consume`; I reduced it by caching valid API-key lookups, merging the user and plan lookups into one query, and merging the three writes into one statement. On a separate 1-CPU test machine this improved throughput by roughly 10-15% with all tests still passing (I did not repeat the before/after comparison on this laptop).
3. **No deadlocks or errors in any run**, thanks to the fixed lock order (account row first, then user row).
4. **A mistake I caught in my own test:** an earlier version of scenario 3 read `/usage` and `/requests` at slightly different moments while requests were still finishing, and it ran for a fixed duration that did not always reach the allowance. I fixed it by sending a fixed number of requests and waiting for all responses before verifying.
5. **Next steps:** shorten the account-lock hold time (take the account lock last), batch counters per instance for very hot accounts (at the cost of exactness), and test on dedicated hardware.