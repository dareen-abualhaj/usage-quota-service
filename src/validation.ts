import type { FastifyRequest } from 'fastify';
import { bad } from './errors';

export const MAX_INT = 1_000_000_000_000;
export const isInt = (n: unknown, min: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= MAX_INT;
export const isStr = (s: unknown, max = 200): s is string =>
  typeof s === 'string' && s.trim().length > 0 && s.length <= max;
export const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

export const bodyOf = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
export const monthOf = (d: Date) => d.toISOString().slice(0, 7); // UTC 'YYYY-MM'

export function parseId(v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw bad('invalid_id', 'id must be a positive integer');
  return n;
}
// ?month=YYYY-MM, defaulting to the current UTC month.
export function monthParam(v: unknown, now: Date): string {
  if (v === undefined) return monthOf(now);
  if (!isMonth(v)) throw bad('invalid_month', "month must look like '2026-03'");
  return v;
}
