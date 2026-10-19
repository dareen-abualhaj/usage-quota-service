import { buildApp } from './app';
import { createPool, migrate, waitForDb } from './db';

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgres://quota:quota@localhost:5432/quota';
  const pool = createPool(url, Number(process.env.PG_POOL_MAX ?? 20));
  await waitForDb(pool);
  await migrate(pool);
  const app = buildApp(pool, {
    adminToken: process.env.ADMIN_TOKEN || undefined,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
}
main().catch((e) => { console.error(e); process.exit(1); });
