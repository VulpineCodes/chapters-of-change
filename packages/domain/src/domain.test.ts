import { describe, it, expect } from 'vitest';
import { createDonation, transitionDonation, canTransition, IllegalTransitionError } from './donation.js';
import { canApproveDonation, canEditListing, canRequestDonation, canCancelDonation } from './rbac.js';
import { searchListings, type Listing } from './listing.js';
import { IdempotencyStore, makeIdempotencyKey } from './idempotency.js';
import { OutboxDispatcher, createOutboxEvent } from './outbox.js';

const baseDonation = () => createDonation({ id: 'd1', listingId: 'l1', donorId: 'donor1', organizationId: 'org1', quantity: 2, createdAt: new Date(), updatedAt: new Date() });

describe('donation state machine — valid transitions', () => {
  it('walks the happy path DRAFT→…→COMPLETED', () => {
    let d = baseDonation();
    d = transitionDonation(d, 'PENDING_APPROVAL', 'org1');
    d = transitionDonation(d, 'APPROVED', 'donor1');
    d = transitionDonation(d, 'IN_TRANSIT', 'donor1');
    d = transitionDonation(d, 'DELIVERED', 'donor1');
    d = transitionDonation(d, 'COMPLETED', 'org1');
    expect(d.status).toBe('COMPLETED');
    expect(d.history).toHaveLength(5);
  });
  it('allows rejection and cancellation branches', () => {
    let d = transitionDonation(baseDonation(), 'PENDING_APPROVAL', 'a');
    expect(transitionDonation(d, 'REJECTED', 'a').status).toBe('REJECTED');
    expect(transitionDonation(baseDonation(), 'CANCELLED', 'a').status).toBe('CANCELLED');
  });
});

describe('donation state machine — invalid transitions', () => {
  it('rejects skipping states', () => {
    expect(() => transitionDonation(baseDonation(), 'APPROVED', 'a')).toThrow(IllegalTransitionError);
    expect(() => transitionDonation(baseDonation(), 'DELIVERED', 'a')).toThrow(IllegalTransitionError);
  });
  it('rejects transitions out of terminal states', () => {
    const d = transitionDonation(transitionDonation(baseDonation(), 'PENDING_APPROVAL', 'a'), 'REJECTED', 'a');
    expect(canTransition('REJECTED', 'APPROVED')).toBe(false);
    expect(() => transitionDonation(d, 'APPROVED', 'a')).toThrow(IllegalTransitionError);
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
  });
});

describe('RBAC / authorization failures', () => {
  const donation = { donorId: 'donor1', organizationId: 'org1' };
  it('only donor/admin can approve', () => {
    expect(canApproveDonation({ id: 'donor1', role: 'DONOR' }, donation)).toBe(true);
    expect(canApproveDonation({ id: 'other', role: 'DONOR' }, donation)).toBe(false);
    expect(canApproveDonation({ id: 'm1', role: 'ORG_MEMBER', organizationId: 'org1' }, donation)).toBe(false);
    expect(canApproveDonation({ id: 'a', role: 'ADMIN' }, donation)).toBe(true);
  });
  it('only org roles can request; only owner can edit listing', () => {
    expect(canRequestDonation({ id: 'x', role: 'DONOR' })).toBe(false);
    expect(canRequestDonation({ id: 'x', role: 'ORG_ADMIN', organizationId: 'org1' })).toBe(true);
    expect(canEditListing({ id: 'donor1', role: 'DONOR' }, { donorId: 'donor1' })).toBe(true);
    expect(canEditListing({ id: 'nope', role: 'DONOR' }, { donorId: 'donor1' })).toBe(false);
  });
  it('cancel permissions are scoped', () => {
    expect(canCancelDonation({ id: 'm', role: 'ORG_MEMBER', organizationId: 'org2' }, donation)).toBe(false);
    expect(canCancelDonation({ id: 'm', role: 'ORG_MEMBER', organizationId: 'org1' }, donation)).toBe(true);
  });
});

describe('idempotency / duplicate submission', () => {
  it('second submit with same key returns original result', () => {
    const store = new IdempotencyStore();
    const key = makeIdempotencyKey(['donor1', 'listing1', 'org1']);
    expect(store.checkAndRecord(key, 'donation-1')).toBeNull();
    expect(store.checkAndRecord(key, 'donation-2')).toBe('donation-1');
  });
  it('concurrent duplicates: only first wins', async () => {
    const store = new IdempotencyStore();
    const key = makeIdempotencyKey(['a', 'b']);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve(store.checkAndRecord(key, `id-${i}`))));
    expect(results.filter(r => r === null)).toHaveLength(1);
    expect(results.filter(r => r !== null).every(r => r === results.find(x => x !== null))).toBe(true);
  });
  it('different keys are independent', () => {
    const store = new IdempotencyStore();
    expect(store.checkAndRecord(makeIdempotencyKey(['1']), 'a')).toBeNull();
    expect(store.checkAndRecord(makeIdempotencyKey(['2']), 'b')).toBeNull();
  });
});

function mkListing(i: number, over: Partial<Listing> = {}): Listing {
  return { id: `l${i}`, donorId: 'd1', title: `Comic ${i}`, genre: i % 2 ? 'Manga' : 'Superhero', language: 'English', condition: 'GOOD', ageSuitability: 'ALL_AGES', quantity: 1, availableQuantity: 1, isAvailable: true, createdAt: new Date(2024, 0, i + 1), ...over };
}

describe('search / pagination', () => {
  const listings = Array.from({ length: 25 }, (_, i) => mkListing(i));
  it('paginates correctly', () => {
    const p1 = searchListings(listings, { page: 1, pageSize: 10 });
    expect(p1.items).toHaveLength(10); expect(p1.total).toBe(25); expect(p1.totalPages).toBe(3);
    expect(searchListings(listings, { page: 3, pageSize: 10 }).items).toHaveLength(5);
  });
  it('filters by genre and query', () => {
    expect(searchListings(listings, { genre: 'Manga' }).total).toBe(12);
    expect(searchListings(listings, { query: 'Comic 3' }).total).toBeGreaterThanOrEqual(1);
  });
  it('onlyAvailable excludes unavailable', () => {
    const mixed = [mkListing(1), mkListing(2, { isAvailable: false })];
    expect(searchListings(mixed, { onlyAvailable: true }).total).toBe(1);
  });
});

describe('outbox dispatcher', () => {
  const noSleep = async () => {};
  it('retries then succeeds', async () => {
    const d = new OutboxDispatcher({ maxAttempts: 3, sleeper: noSleep });
    d.enqueue(createOutboxEvent({ id: 'e1', type: 'donation.status_changed', aggregateId: 'd1', payload: {} }));
    let calls = 0;
    const res = await d.dispatchAll(async () => { calls++; if (calls < 3) throw new Error('flaky'); });
    expect(res).toEqual({ delivered: 1, failed: 0 });
    expect(d.getEvents()[0].status).toBe('DELIVERED');
    expect(calls).toBe(3);
  });
  it('exhausts retries and marks FAILED with error', async () => {
    const delays: number[] = [];
    const d = new OutboxDispatcher({ maxAttempts: 3, baseDelayMs: 100, sleeper: async (ms) => { delays.push(ms); } });
    d.enqueue(createOutboxEvent({ id: 'e2', type: 'notification.requested', aggregateId: 'd1', payload: {} }));
    const res = await d.dispatchAll(async () => { throw new Error('down'); });
    expect(res).toEqual({ delivered: 0, failed: 1 });
    const ev = d.getEvents()[0];
    expect(ev.status).toBe('FAILED'); expect(ev.attempts).toBe(3); expect(ev.lastError).toBe('down');
    expect(delays).toEqual([100, 200]); // exponential backoff
  });
  it('delivers healthy events without retries', async () => {
    const d = new OutboxDispatcher({ sleeper: noSleep });
    d.enqueue(createOutboxEvent({ id: 'e3', type: 'donation.created', aggregateId: 'd9', payload: { x: 1 } }));
    expect((await d.dispatchAll(async () => {})).delivered).toBe(1);
  });
});
