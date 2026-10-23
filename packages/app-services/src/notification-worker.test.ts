import { describe, it, expect, beforeEach } from 'vitest';
import { createOutboxEvent, type OutboxEvent } from '@chapters/domain';
import { InMemoryStore } from './memory.js';
import { NotificationWorkerCore } from './notification-worker.js';
import { WorkflowService } from './workflow.service.js';
import { SEED_IDS, seedSyntheticData } from './seed.js';

function makeEvent(id = 'evt-1'): OutboxEvent {
  return createOutboxEvent({
    id,
    type: 'donation.created',
    aggregateId: 'donation-1',
    payload: { title: 'New donation request', body: 'Someone requested your listing.' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
}

const recordingSleeper = (delays: number[]) => async (ms: number) => {
  delays.push(ms);
};

describe('NotificationWorkerCore', () => {
  it('delivers on the first attempt without sleeping', async () => {
    const delays: number[] = [];
    const delivered: string[] = [];
    const worker = new NotificationWorkerCore(
      async (e) => {
        delivered.push(e.id);
      },
      { sleeper: recordingSleeper(delays) },
    );
    const { event, outcome } = await worker.process(makeEvent());
    expect(outcome).toBe('DELIVERED');
    expect(event.status).toBe('DELIVERED');
    expect(event.attempts).toBe(0);
    expect(delivered).toEqual(['evt-1']);
    expect(delays).toEqual([]);
  });

  it('retries with exponential backoff and delivers after transient failures', async () => {
    const delays: number[] = [];
    let calls = 0;
    const worker = new NotificationWorkerCore(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error(`transient failure ${calls}`);
      },
      { maxAttempts: 3, baseDelayMs: 100, sleeper: recordingSleeper(delays) },
    );
    const { event, outcome } = await worker.process(makeEvent());
    expect(outcome).toBe('DELIVERED');
    expect(event.status).toBe('DELIVERED');
    expect(event.attempts).toBe(2); // two failures recorded before success
    expect(event.lastError).toBeUndefined();
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]); // backoff between attempts
  });

  it('moves the event to FAILED after max attempts with the error preserved', async () => {
    const delays: number[] = [];
    const worker = new NotificationWorkerCore(
      async () => {
        throw new Error('SMTP connection refused');
      },
      { maxAttempts: 3, baseDelayMs: 100, sleeper: recordingSleeper(delays) },
    );
    const { event, outcome } = await worker.process(makeEvent());
    expect(outcome).toBe('FAILED');
    expect(event.status).toBe('FAILED');
    expect(event.attempts).toBe(3);
    expect(event.lastError).toBe('SMTP connection refused');
    expect(delays).toEqual([100, 200]); // no sleep after the final attempt
  });

  it('does not reprocess an already-delivered event', async () => {
    let calls = 0;
    const worker = new NotificationWorkerCore(async () => {
      calls += 1;
    });
    const done = { ...makeEvent(), status: 'DELIVERED' as const };
    const { outcome } = await worker.process(done);
    expect(outcome).toBe('DELIVERED');
    expect(calls).toBe(0);
  });
});

describe('NotificationWorkerCore.processPending over the store', () => {
  let store: InMemoryStore;
  let workflow: WorkflowService;

  beforeEach(async () => {
    store = new InMemoryStore();
    await seedSyntheticData(store);
    let n = 0;
    workflow = new WorkflowService(store, { idGen: () => `id-${++n}` });
  });

  it('drains pending outbox events into notifications and persists final states', async () => {
    const donor = { id: SEED_IDS.donor, role: 'DONOR' as const };
    const orgAdmin = {
      id: SEED_IDS.orgAdmin,
      role: 'ORG_ADMIN' as const,
      organizationId: SEED_IDS.riversideOrg,
    };
    const listing = await workflow.createListing(donor, {
      title: 'Naruto Vol. 1–5 bundle',
      genre: 'Manga',
      language: 'English',
      condition: 'GOOD',
      ageSuitability: 'TEEN',
      quantity: 3,
    });
    await workflow.requestDonation(orgAdmin, { listingId: listing.id, quantity: 1 });
    expect(await store.outbox.listPending()).toHaveLength(1);

    const worker = new NotificationWorkerCore(workflow.notificationHandler, {
      sleeper: async () => {},
    });
    const result = await worker.processPending(store);
    expect(result).toEqual({ delivered: 1, failed: 0 });
    expect(await store.outbox.listPending()).toHaveLength(0);
    expect((await store.outbox.listAll())[0]!.status).toBe('DELIVERED');
    // The notification was materialized for the donor.
    const notes = await workflow.listNotificationsForUser(SEED_IDS.donor);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe('donation.created');
  });

  it('a permanently failing delivery marks the event FAILED but donation state stays intact', async () => {
    const donor = { id: SEED_IDS.donor, role: 'DONOR' as const };
    const orgAdmin = {
      id: SEED_IDS.orgAdmin,
      role: 'ORG_ADMIN' as const,
      organizationId: SEED_IDS.riversideOrg,
    };
    const listing = await workflow.createListing(donor, {
      title: 'One Piece Vol. 1',
      genre: 'Manga',
      language: 'English',
      condition: 'GOOD',
      ageSuitability: 'TEEN',
      quantity: 2,
    });
    const { donation } = await workflow.requestDonation(orgAdmin, {
      listingId: listing.id,
      quantity: 1,
    });

    const worker = new NotificationWorkerCore(
      async () => {
        throw new Error('notification provider down');
      },
      { maxAttempts: 2, baseDelayMs: 50, sleeper: async () => {} },
    );
    const result = await worker.processPending(store);
    expect(result).toEqual({ delivered: 0, failed: 1 });
    const events = await store.outbox.listAll();
    expect(events[0]!.status).toBe('FAILED');
    expect(events[0]!.lastError).toBe('notification provider down');
    // The donation itself is untouched by the notification failure.
    const reloaded = await workflow.getDonation(orgAdmin, donation.id);
    expect(reloaded.status).toBe('PENDING_APPROVAL');
  });
});
