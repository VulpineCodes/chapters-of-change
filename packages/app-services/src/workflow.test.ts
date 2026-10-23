import { describe, it, expect, beforeEach } from 'vitest';
import { IllegalTransitionError, type Actor } from '@chapters/domain';
import { InMemoryStore } from './memory.js';
import {
  AuthorizationError,
  ValidationError,
  WorkflowService,
} from './workflow.service.js';
import { SEED_IDS, seedSyntheticData } from './seed.js';

const noSleep = async () => {};

let store: InMemoryStore;
let svc: WorkflowService;

const donor: Actor = { id: SEED_IDS.donor, role: 'DONOR' };
const orgAdmin: Actor = { id: SEED_IDS.orgAdmin, role: 'ORG_ADMIN', organizationId: SEED_IDS.riversideOrg };
const orgMember: Actor = { id: SEED_IDS.orgMember, role: 'ORG_MEMBER', organizationId: SEED_IDS.riversideOrg };
const otherOrgAdmin: Actor = { id: SEED_IDS.otherOrgAdmin, role: 'ORG_ADMIN', organizationId: SEED_IDS.sunriseOrg };

async function makeListing(quantity = 5) {
  return svc.createListing(donor, {
    title: 'Naruto Vol. 1–5 bundle',
    genre: 'Manga',
    language: 'English',
    condition: 'GOOD',
    ageSuitability: 'TEEN',
    quantity,
  });
}

/** Runs a donation all the way to COMPLETED and returns its id. */
async function completeWorkflow(): Promise<string> {
  const listing = await makeListing(3);
  const { donation } = await svc.requestDonation(orgAdmin, { listingId: listing.id, quantity: 2 });
  await svc.approveDonation(donor, donation.id);
  await svc.markInTransit(donor, donation.id);
  await svc.markDelivered(donor, donation.id);
  await svc.confirmCompleted(orgMember, donation.id);
  return donation.id;
}

beforeEach(async () => {
  store = new InMemoryStore();
  await seedSyntheticData(store);
  let n = 0;
  svc = new WorkflowService(store, { idGen: () => `id-${++n}` });
});

describe('workflow: full donor→recipient lifecycle', () => {
  it('walks create listing → request → approve → in-transit → delivered → completed', async () => {
    const listing = await makeListing(3);
    const { donation, deduplicated } = await svc.requestDonation(orgAdmin, {
      listingId: listing.id,
      quantity: 2,
      idempotencyKey: 'req-key-happy-1',
    });
    expect(deduplicated).toBe(false);
    expect(donation.status).toBe('PENDING_APPROVAL');
    expect(donation.donorId).toBe(SEED_IDS.donor);
    expect(donation.organizationId).toBe(SEED_IDS.riversideOrg);

    const approved = await svc.approveDonation(donor, donation.id);
    expect(approved.status).toBe('APPROVED');

    // Approval reserved inventory.
    const afterApproval = (await store.listings.getById(listing.id))!;
    expect(afterApproval.availableQuantity).toBe(1);
    expect(afterApproval.isAvailable).toBe(true);

    expect((await svc.markInTransit(donor, donation.id)).status).toBe('IN_TRANSIT');
    expect((await svc.markDelivered(donor, donation.id)).status).toBe('DELIVERED');
    const completed = await svc.confirmCompleted(orgMember, donation.id);
    expect(completed.status).toBe('COMPLETED');
    // Full audit trail: submit, approve, ship, deliver, complete.
    expect(completed.history.map((h) => h.to)).toEqual([
      'PENDING_APPROVAL',
      'APPROVED',
      'IN_TRANSIT',
      'DELIVERED',
      'COMPLETED',
    ]);
    // One outbox event per state change, all still pending dispatch.
    expect(await store.outbox.listPending()).toHaveLength(5);
  });

  it('dispatches notifications for every lifecycle event to the right recipients', async () => {
    await completeWorkflow();
    const result = await svc.dispatchNotifications(svc.notificationHandler, { sleeper: noSleep });
    expect(result).toEqual({ delivered: 5, failed: 0 });
    expect(await store.outbox.listPending()).toHaveLength(0);
    expect((await store.outbox.listAll()).every((e) => e.status === 'DELIVERED')).toBe(true);

    // Donor was notified about the request and about completion.
    const donorNotes = await svc.listNotificationsForUser(SEED_IDS.donor);
    expect(donorNotes.map((n) => n.type)).toEqual(['donation.created', 'donation.delivered']);
    // Both org members were notified about approval, transit, delivery.
    const adminNotes = await svc.listNotificationsForUser(SEED_IDS.orgAdmin);
    expect(adminNotes.map((n) => n.type)).toEqual([
      'donation.approved',
      'donation.status_changed',
      'donation.status_changed',
    ]);
    expect((await svc.listNotificationsForUser(SEED_IDS.orgMember)).length).toBe(3);
    expect((await store.notifications.listAll()).every((n) => n.status === 'SENT')).toBe(true);
  });

  it('supports the rejection branch and notifies the organization', async () => {
    const listing = await makeListing();
    const { donation } = await svc.requestDonation(orgMember, { listingId: listing.id, quantity: 1 });
    const rejected = await svc.rejectDonation(donor, donation.id, 'Condition not as described');
    expect(rejected.status).toBe('REJECTED');
    // Terminal: a rejected donation cannot be approved afterwards.
    await expect(svc.approveDonation(donor, donation.id)).rejects.toBeInstanceOf(IllegalTransitionError);
    const result = await svc.dispatchNotifications(svc.notificationHandler, { sleeper: noSleep });
    expect(result.delivered).toBe(2);
    const notes = await svc.listNotificationsForUser(SEED_IDS.orgAdmin);
    expect(notes.some((n) => n.type === 'donation.rejected')).toBe(true);
  });
});

describe('workflow: idempotent donation requests', () => {
  it('duplicate submission with the same key returns the original donation', async () => {
    const listing = await makeListing();
    const first = await svc.requestDonation(orgAdmin, {
      listingId: listing.id,
      quantity: 2,
      idempotencyKey: 'req-key-dup-1',
    });
    const second = await svc.requestDonation(orgAdmin, {
      listingId: listing.id,
      quantity: 2,
      idempotencyKey: 'req-key-dup-1',
    });
    expect(second.deduplicated).toBe(true);
    expect(second.donation.id).toBe(first.donation.id);
    expect(await store.donations.listAll()).toHaveLength(1);
    // No duplicate outbox event / notification for the retry.
    expect(await store.outbox.listAll()).toHaveLength(1);
  });

  it('concurrent duplicate submissions create exactly one donation', async () => {
    const listing = await makeListing();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        svc.requestDonation(orgAdmin, { listingId: listing.id, quantity: 1, idempotencyKey: 'req-key-race-1' }),
      ),
    );
    expect(new Set(results.map((r) => r.donation.id)).size).toBe(1);
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
    expect(await store.donations.listAll()).toHaveLength(1);
  });

  it('different keys create independent donations', async () => {
    const listing = await makeListing();
    const a = await svc.requestDonation(orgAdmin, { listingId: listing.id, quantity: 1, idempotencyKey: 'req-key-a-1' });
    const b = await svc.requestDonation(orgAdmin, { listingId: listing.id, quantity: 1, idempotencyKey: 'req-key-b-1' });
    expect(a.donation.id).not.toBe(b.donation.id);
    expect(await store.donations.listAll()).toHaveLength(2);
  });
});

describe('workflow: authorization failures', () => {
  it('an organization cannot approve — approval belongs to the donor', async () => {
    const listing = await makeListing();
    const { donation } = await svc.requestDonation(orgAdmin, { listingId: listing.id, quantity: 1 });
    // The requesting org itself cannot approve its own request…
    await expect(svc.approveDonation(orgAdmin, donation.id)).rejects.toBeInstanceOf(AuthorizationError);
    // …and neither can an admin of a *different* organization.
    await expect(svc.approveDonation(otherOrgAdmin, donation.id)).rejects.toBeInstanceOf(AuthorizationError);
    // Donation is untouched.
    expect((await svc.getDonation(donor, donation.id)).status).toBe('PENDING_APPROVAL');
  });

  it('a non-owner donor cannot approve, ship, or reject', async () => {
    const listing = await makeListing();
    const { donation } = await svc.requestDonation(orgAdmin, { listingId: listing.id, quantity: 1 });
    const stranger: Actor = { id: 'user-stranger', role: 'DONOR' };
    await expect(svc.approveDonation(stranger, donation.id)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(svc.rejectDonation(stranger, donation.id)).rejects.toBeInstanceOf(AuthorizationError);
    await svc.approveDonation(donor, donation.id);
    await expect(svc.markInTransit(stranger, donation.id)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('donors cannot request donations and org members cannot create listings', async () => {
    const listing = await makeListing();
    await expect(svc.requestDonation(donor, { listingId: listing.id, quantity: 1 })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      svc.createListing(orgAdmin, {
        title: 'X', genre: 'Manga', language: 'English', condition: 'GOOD', ageSuitability: 'TEEN', quantity: 1,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('cross-organization access is denied for viewing, cancelling, and completing', async () => {
    const listing = await makeListing();
    const { donation } = await svc.requestDonation(orgAdmin, { listingId: listing.id, quantity: 1 });
    await expect(svc.getDonation(otherOrgAdmin, donation.id)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(svc.cancelDonation(otherOrgAdmin, donation.id)).rejects.toBeInstanceOf(AuthorizationError);
    await svc.approveDonation(donor, donation.id);
    await svc.markInTransit(donor, donation.id);
    await svc.markDelivered(donor, donation.id);
    await expect(svc.confirmCompleted(otherOrgAdmin, donation.id)).rejects.toBeInstanceOf(AuthorizationError);
    // The owning org can complete it.
    expect((await svc.confirmCompleted(orgAdmin, donation.id)).status).toBe('COMPLETED');
  });
});

describe('workflow: state machine and inventory guards', () => {
  it('rejects illegal transitions (ship before approval, complete before delivery)', async () => {
    const listing = await makeListing();
    const { donation } = await svc.requestDonation(orgAdmin, { listingId: listing.id, quantity: 1 });
    await expect(svc.markInTransit(donor, donation.id)).rejects.toBeInstanceOf(IllegalTransitionError);
    await svc.approveDonation(donor, donation.id);
    await expect(svc.confirmCompleted(orgAdmin, donation.id)).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('rejects requests exceeding available quantity at request and approval time', async () => {
    const listing = await makeListing(2);
    await expect(
      svc.requestDonation(orgAdmin, { listingId: listing.id, quantity: 3 }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Two orgs each request the full stock; only the first approval can reserve it.
    const first = await svc.requestDonation(orgAdmin, { listingId: listing.id, quantity: 2 });
    const second = await svc.requestDonation(otherOrgAdmin, { listingId: listing.id, quantity: 2 });
    await svc.approveDonation(donor, first.donation.id);
    await expect(svc.approveDonation(donor, second.donation.id)).rejects.toBeInstanceOf(ValidationError);
    expect((await svc.getDonation(donor, second.donation.id)).status).toBe('PENDING_APPROVAL');
    const after = (await store.listings.getById(listing.id))!;
    expect(after.availableQuantity).toBe(0);
    expect(after.isAvailable).toBe(false);
  });

  it('cancelling an approved donation releases its reserved inventory', async () => {
    const listing = await makeListing(2);
    const { donation } = await svc.requestDonation(orgAdmin, { listingId: listing.id, quantity: 2 });
    await svc.approveDonation(donor, donation.id);
    expect((await store.listings.getById(listing.id))!.availableQuantity).toBe(0);
    const cancelled = await svc.cancelDonation(orgMember, donation.id);
    expect(cancelled.status).toBe('CANCELLED');
    const after = (await store.listings.getById(listing.id))!;
    expect(after.availableQuantity).toBe(2);
    expect(after.isAvailable).toBe(true);
  });

  it('search delegates to the domain filter/pagination rules', async () => {
    await makeListing();
    await svc.createListing(donor, {
      title: 'Spider-Man: Into the Spider-Verse comics',
      genre: 'Superhero', language: 'English', condition: 'LIKE_NEW', ageSuitability: 'ALL_AGES', quantity: 3,
    });
    expect((await svc.searchListings({ genre: 'Manga' })).total).toBe(1);
    expect((await svc.searchListings({})).total).toBe(2);
    expect((await svc.searchListings({ query: 'Spider' })).total).toBe(1);
  });
});

describe('workflow: outbox retry and failure visibility', () => {
  it('a handler failing twice then succeeding still completes delivery via outbox retry', async () => {
    await completeWorkflow();
    const attemptsByEvent = new Map<string, number>();
    const flakyHandler = async (event: { id: string }) => {
      const attempts = (attemptsByEvent.get(event.id) ?? 0) + 1;
      attemptsByEvent.set(event.id, attempts);
      if (attempts < 3) throw new Error('notification provider temporarily down');
      await svc.notificationHandler(event as never);
    };
    const result = await svc.dispatchNotifications(flakyHandler, { maxAttempts: 3, sleeper: noSleep });
    expect(result).toEqual({ delivered: 5, failed: 0 });
    // Every event needed exactly 3 attempts and ended DELIVERED.
    expect([...attemptsByEvent.values()]).toEqual([3, 3, 3, 3, 3]);
    expect((await store.outbox.listAll()).every((e) => e.status === 'DELIVERED' && e.attempts === 2)).toBe(true);
    // Notifications were recorded exactly once per successful delivery.
    expect(await store.notifications.listAll()).toHaveLength(5 + 3); // donor×2 events→2, org×3 events→2 members each = 8
    // And the workflow itself was never blocked by the flaky provider.
    const donations = await store.donations.listAll();
    expect(donations[0]!.status).toBe('COMPLETED');
  });

  it('a permanently failing handler marks events FAILED with the error preserved', async () => {
    const listing = await makeListing();
    await svc.requestDonation(orgAdmin, { listingId: listing.id, quantity: 1 });
    const delays: number[] = [];
    const result = await svc.dispatchNotifications(
      async () => {
        throw new Error('provider down');
      },
      { maxAttempts: 3, baseDelayMs: 100, sleeper: async (ms) => { delays.push(ms); } },
    );
    expect(result).toEqual({ delivered: 0, failed: 1 });
    const [event] = await store.outbox.listAll();
    expect(event!.status).toBe('FAILED');
    expect(event!.attempts).toBe(3);
    expect(event!.lastError).toBe('provider down');
    expect(delays).toEqual([100, 200]);
    // Failure is in notifications only — donation state is intact.
    expect((await store.donations.listAll())[0]!.status).toBe('PENDING_APPROVAL');
  });
});
