-- Accounting invariants, checked directly in the database (independent of the API).
-- Returns one row per violation. ZERO ROWS = everything is consistent.
--
-- Run (bash):        docker compose exec -T db psql -U quota -d quota < scripts/check-invariants.sql
-- Run (PowerShell):  Get-Content scripts/check-invariants.sql | docker compose exec -T db psql -U quota -d quota
-- `npm run load` also runs this file automatically.

-- 1) An account's counter must equal the sum of its users' counters (same month).
SELECT 'account_counter_ne_sum_of_users' AS violation, au.account_id, au.month,
       au.consumed::numeric AS counter, COALESCE(SUM(uu.consumed), 0)::numeric AS expected
  FROM account_usage au
  LEFT JOIN users u ON u.account_id = au.account_id
  LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.month = au.month
 GROUP BY au.account_id, au.month, au.consumed
HAVING au.consumed <> COALESCE(SUM(uu.consumed), 0)

UNION ALL
-- 2) An account's counter must equal the sum of its ACCEPTED requests.
SELECT 'account_counter_ne_accepted_requests', au.account_id, au.month, au.consumed::numeric,
       COALESCE((SELECT SUM(r.units) FROM requests r
                  WHERE r.account_id = au.account_id AND r.month = au.month AND r.accepted), 0)::numeric
  FROM account_usage au
 WHERE au.consumed <> COALESCE((SELECT SUM(r.units) FROM requests r
                                 WHERE r.account_id = au.account_id AND r.month = au.month AND r.accepted), 0)

UNION ALL
-- 3) A user's counter must equal the sum of that user's ACCEPTED requests.
SELECT 'user_counter_ne_accepted_requests', u.account_id, uu.month, uu.consumed::numeric,
       COALESCE((SELECT SUM(r.units) FROM requests r
                  WHERE r.user_id = uu.user_id AND r.month = uu.month AND r.accepted), 0)::numeric
  FROM user_usage uu JOIN users u ON u.id = uu.user_id
 WHERE uu.consumed <> COALESCE((SELECT SUM(r.units) FROM requests r
                                 WHERE r.user_id = uu.user_id AND r.month = uu.month AND r.accepted), 0)

UNION ALL
-- 4) Every rejected request must say which rule rejected it (and an accepted one must not).
SELECT 'rejection_reason_inconsistent', r.account_id, r.month, r.id::numeric, 0::numeric
  FROM requests r
 WHERE (r.accepted AND (r.rejected_scope IS NOT NULL OR r.rejected_rule IS NOT NULL))
    OR (NOT r.accepted AND (r.rejected_scope IS NULL OR r.rejected_rule IS NULL));
