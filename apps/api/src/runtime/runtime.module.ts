import { Global, Logger, Module } from '@nestjs/common';
import {
  CredentialAuthService,
  InMemoryStore,
  NotificationWorkerCore,
  PrismaStore,
  WorkflowService,
  seedSyntheticCredentials,
  seedSyntheticData,
  type PrismaLike,
  type Store,
} from '@chapters/app-services';
import { resolveJwtSecret } from '../auth/jwt.service';

export const STORE = 'CHAPTERS_STORE';
export const WORKFLOW_SERVICE = 'CHAPTERS_WORKFLOW_SERVICE';
export const CREDENTIAL_AUTH = 'CHAPTERS_CREDENTIAL_AUTH';
export const NOTIFICATION_WORKER_CORE = 'CHAPTERS_NOTIFICATION_WORKER_CORE';

const logger = new Logger('RuntimeModule');

/**
 * Builds the runtime `Store` selected by `STORE_ADAPTER`:
 *
 *  - `memory` (default): the verified in-memory adapter, seeded with the
 *    synthetic demo data + synthetic dev credentials. State resets on
 *    restart — this is the adapter exercised by the test suites and the
 *    HTTP smoke test.
 *  - `prisma`: the Prisma adapter against `DATABASE_URL`. Selectable but
 *    UNVERIFIED — it has never run against a live PostgreSQL in this repo's
 *    build environment (see STATUS.md). It fails fast with a clear error if
 *    `DATABASE_URL` is missing rather than silently falling back.
 */
async function createStore(): Promise<Store> {
  const adapter = (process.env.STORE_ADAPTER ?? 'memory').toLowerCase();
  if (adapter === 'prisma') {
    if (!process.env.DATABASE_URL) {
      throw new Error('STORE_ADAPTER=prisma requires DATABASE_URL to be set');
    }
    logger.warn(
      'STORE_ADAPTER=prisma selected: PrismaStore is UNVERIFIED against a live database (see STATUS.md).',
    );
    // Dynamic import so the default memory path never needs a generated
    // Prisma client or a database connection. Selecting this adapter
    // requires `npx prisma generate` + a reachable database at runtime.
    const prismaModule = (await import('@prisma/client')) as unknown as {
      PrismaClient: new () => PrismaLike;
    };
    return new PrismaStore(new prismaModule.PrismaClient());
  }
  if (adapter !== 'memory') {
    throw new Error(`Unknown STORE_ADAPTER "${adapter}" (expected "memory" or "prisma")`);
  }
  const store = new InMemoryStore();
  await seedSyntheticData(store);
  await seedSyntheticCredentials(store);
  logger.log(
    'Runtime store: InMemoryStore (STORE_ADAPTER=memory), seeded with SYNTHETIC demo users/orgs and SYNTHETIC dev credentials.',
  );
  return store;
}

/**
 * Wires the tested application layer (`packages/app-services`) into Nest:
 * a single shared Store, the WorkflowService that listings/donations
 * delegate to, the bcrypt CredentialAuthService, and the queue-agnostic
 * NotificationWorkerCore consumed by the BullMQ adapter.
 */
@Global()
@Module({
  providers: [
    { provide: STORE, useFactory: createStore },
    {
      provide: WORKFLOW_SERVICE,
      useFactory: (store: Store) => new WorkflowService(store),
      inject: [STORE],
    },
    {
      provide: CREDENTIAL_AUTH,
      useFactory: (store: Store) => new CredentialAuthService(store, resolveJwtSecret()),
      inject: [STORE],
    },
    {
      provide: NOTIFICATION_WORKER_CORE,
      useFactory: (workflow: WorkflowService) =>
        new NotificationWorkerCore(workflow.notificationHandler),
      inject: [WORKFLOW_SERVICE],
    },
  ],
  exports: [STORE, WORKFLOW_SERVICE, CREDENTIAL_AUTH, NOTIFICATION_WORKER_CORE],
})
export class RuntimeModule {}
