// THE RULES. Pure functions: no database, no HTTP, no clock. Easy to unit-test and easy to extend:
// a new rule type is one more check in evaluate() (plus its own tests).

export interface PlanLimits { monthlyAllowance: number; maxPerRequest: number }
export interface Level { limits: PlanLimits; consumed: number }   // one side: the account or the user
export type Scope = 'account' | 'user';
export type Rule = 'max_per_request' | 'monthly_allowance';
export interface Rejection { scope: Scope; rule: Rule }

// Units still available this month. Never negative, even if the allowance was lowered below usage.
export const remaining = (allowance: number, consumed: number) => Math.max(0, allowance - consumed);

// Both plans must allow the request. Returns the FIRST violated rule, or null if accepted.
// The order only decides which violation is reported, never whether the request is rejected.
export function evaluate(input: { units: number; account: Level; user: Level }): Rejection | null {
  const { units, account, user } = input;
  if (units > user.limits.maxPerRequest) return { scope: 'user', rule: 'max_per_request' };
  if (units > account.limits.maxPerRequest) return { scope: 'account', rule: 'max_per_request' };
  if (units > remaining(user.limits.monthlyAllowance, user.consumed)) return { scope: 'user', rule: 'monthly_allowance' };
  if (units > remaining(account.limits.monthlyAllowance, account.consumed)) return { scope: 'account', rule: 'monthly_allowance' };
  return null;
}

export const rejectionMessage = (r: Rejection) =>
  `${r.scope === 'user' ? 'User' : 'Account'} ${r.rule === 'max_per_request' ? 'per-request limit' : 'monthly allowance'} would be exceeded`;
