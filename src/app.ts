import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { HttpError } from './errors';
import { createAuthenticator } from './services/auth';
import { accountRoutes } from './routes/accounts';
import { planRoutes } from './routes/plans';
import { userRoutes } from './routes/users';
import { usageRoutes } from './routes/usage';
import { consumeRoutes } from './routes/consume';
import type { Deps } from './types';

export interface AppOptions {
  now?: () => Date;               // injectable clock (used by tests for month rollover)
  adminToken?: string;            // if set, POST /accounts requires header x-admin-token
  logger?: boolean | object;
}

// Builds the app without starting a server, so tests can use app.inject().
export function buildApp(pool: Pool, opts: AppOptions = {}) {
  const app = Fastify({ logger: opts.logger ?? false });
  const deps: Deps = {
    pool,
    now: opts.now ?? (() => new Date()),
    authenticate: createAuthenticator(pool),
    adminToken: opts.adminToken,
  };

  app.setErrorHandler((err: any, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof HttpError)
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (err.validation || (err.statusCode && err.statusCode < 500))
      return reply.status(err.statusCode ?? 400).send({ error: { code: 'bad_request', message: err.message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Internal error' } });
  });

  app.get('/health', async () => { await pool.query('SELECT 1'); return { status: 'ok' }; });

  accountRoutes(app, deps);
  planRoutes(app, deps);
  userRoutes(app, deps);
  usageRoutes(app, deps);
  consumeRoutes(app, deps);
  return app;
}
