import type { FastifyInstance } from 'fastify';
import { bad } from '../errors';
import { bodyOf, isInt, isStr, monthOf } from '../validation';
import { consume } from '../services/consume';
import type { Deps } from '../types';

// HTTP layer only: authenticate, validate, call the accounting service.
export function consumeRoutes(app: FastifyInstance, d: Deps) {
  app.post('/consume', async (req) => {
    const acc = await d.authenticate(req);
    const b = bodyOf(req);
    if (!isStr(b.userId)) throw bad('invalid_user_id', 'userId must be a non-empty string');
    if (!isInt(b.units, 1)) throw bad('invalid_units', 'units must be a positive whole number');
    if (!isStr(b.requestId)) throw bad('invalid_request_id', 'requestId must be a non-empty string');
    return consume(d.pool, {
      accountId: acc.id, userId: b.userId, units: b.units, requestId: b.requestId,
      month: monthOf(d.now()), // the month a request counts toward = when it is processed (UTC)
    });
  });
}
