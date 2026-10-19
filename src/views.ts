// How things look in API responses.
import { remaining } from './rules';

export const planOut = (p: any) => ({
  id: p.id, accountId: p.account_id, kind: p.kind, name: p.name,
  monthlyAllowance: p.monthly_allowance, maxPerRequest: p.max_per_request, predefined: p.is_predefined,
});

// One side (account or user): the plan applied now + usage for a month.
export const side = (plan: any, consumed: number) => ({
  plan: { id: plan.id, name: plan.name },
  monthlyAllowance: plan.monthly_allowance,
  maxPerRequest: plan.max_per_request,
  consumed,
  remaining: remaining(plan.monthly_allowance, consumed),
});
