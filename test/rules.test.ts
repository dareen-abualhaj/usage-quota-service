// Unit tests for the pure rules: no database, no HTTP.
import { describe, it, expect } from 'vitest';
import { evaluate, remaining, rejectionMessage } from '../src/rules';

const plan = (monthlyAllowance: number, maxPerRequest: number) => ({ monthlyAllowance, maxPerRequest });
// The example from the brief: account 10,000/month & 100/request, user 1,000/month & 20/request.
const base = (units: number, accountConsumed = 0, userConsumed = 0) => ({
  units,
  account: { limits: plan(10000, 100), consumed: accountConsumed },
  user: { limits: plan(1000, 20), consumed: userConsumed },
});

describe('evaluate()', () => {
  it('accepts a request that satisfies both plans', () => {
    expect(evaluate(base(10))).toBeNull();
  });
  it('rejects 25 units by the USER per-request limit even though both monthly allowances have room', () => {
    expect(evaluate(base(25))).toEqual({ scope: 'user', rule: 'max_per_request' });
  });
  it('rejects by the ACCOUNT per-request limit when only the account limit is exceeded', () => {
    const r = evaluate({ units: 40, account: { limits: plan(10000, 30), consumed: 0 }, user: { limits: plan(1000, 100), consumed: 0 } });
    expect(r).toEqual({ scope: 'account', rule: 'max_per_request' });
  });
  it('rejects by the USER monthly allowance', () => {
    expect(evaluate(base(10, 0, 995))).toEqual({ scope: 'user', rule: 'monthly_allowance' });
  });
  it('rejects by the ACCOUNT monthly allowance even if the user has plenty left (5 left, ask 10)', () => {
    expect(evaluate(base(10, 9995, 0))).toEqual({ scope: 'account', rule: 'monthly_allowance' });
  });
  it('accepts exactly up to the remaining allowance (boundary)', () => {
    expect(evaluate(base(10, 0, 990))).toBeNull();      // user has exactly 10 left
    expect(evaluate(base(10, 9990, 0))).toBeNull();     // account has exactly 10 left
    expect(evaluate(base(11, 0, 990))).not.toBeNull();  // one more is too many
  });
  it('reports the user rule first when several rules are violated', () => {
    const r = evaluate({ units: 500, account: { limits: plan(10, 5), consumed: 0 }, user: { limits: plan(10, 5), consumed: 0 } });
    expect(r).toEqual({ scope: 'user', rule: 'max_per_request' });
  });
  it('allowance lowered below existing usage: nothing remains and every request is rejected', () => {
    const r = evaluate({ units: 1, account: { limits: plan(10000, 100), consumed: 0 }, user: { limits: plan(10, 20), consumed: 15 } });
    expect(r).toEqual({ scope: 'user', rule: 'monthly_allowance' });
  });
});

describe('remaining()', () => {
  it('is allowance minus consumed', () => expect(remaining(100, 30)).toBe(70));
  it('never goes negative', () => expect(remaining(10, 15)).toBe(0));
});

describe('rejectionMessage()', () => {
  it('names who and which rule', () => {
    expect(rejectionMessage({ scope: 'account', rule: 'monthly_allowance' })).toBe('Account monthly allowance would be exceeded');
    expect(rejectionMessage({ scope: 'user', rule: 'max_per_request' })).toBe('User per-request limit would be exceeded');
  });
});
