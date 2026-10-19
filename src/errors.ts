// One error type for every expected failure. app.ts turns it into { error: { code, message } }.
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const bad = (code: string, msg: string) => new HttpError(400, code, msg);
export const notFound = (code: string, msg: string) => new HttpError(404, code, msg);
export const isUnique = (e: any) => e?.code === '23505'; // PostgreSQL unique_violation
