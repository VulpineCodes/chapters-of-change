/**
 * WorkflowService — the donor→recipient donation workflow.
 *
 * Orchestrates the pure domain rules (`packages/domain`) over the repository
 * boundary (`repositories.ts`):
 *
 *   donor creates listing
 *     → organization requests the donation (idempotency-keyed)
 *     → donor approves (inventory reserved) / rejects
 *     → donor marks in-transit → donor marks delivered
 *     → organization confirms receipt → COMPLETED
 *
 * (Per the domain RBAC policy, organizations *request* and donors *approve*:
 * `canRequestDonation` is org-only, `canApproveDonation` is owning-donor/admin.)
 *
 * Every state change and its notification outbox event are written in the
 * same store transaction — the transactional-outbox pattern described in
 * ARCHITECTURE.md. Notifications are materialized later by
 * `dispatchNotifications`, which runs pending outbox events through the
 * domain `OutboxDispatcher` (exponential backoff, FAILED visibility) and
 * persists the outcome of every attempt.
 */
import { randomUUID } from 'node:crypto';
import {
  OutboxDispatcher,
  canApproveDonation,
  canCancelDonation,
  canCreateListing,
  canRejectDonation,
  canRequestDonation,
  canViewDonation,
  createDonation,
  createOutboxEvent,
  isValidIdempotencyKey,
  makeIdempotencyKey,
  searchListings,
  transitionDonation,
  type Actor,
  type Donation,
  type DonationStatus,
  type Listing,
  type ListingSearchParams,
  type OutboxEvent,
  type PaginatedResult,
} from '@chapters/domain';
import type { NotificationRecord, Store } from './repositories.js';

export class AuthorizationError extends Error {
  constructor(message = 'Actor is not authorized for this operation') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Serializes async critical sections per key (models a DB unique constraint). */
class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.tails.set(key, previous.then(() => gate));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export interface CreateListingInput {
  title: string;
  description?: string;
  genre: string;
  language: string;
  condition: Listing['condition'];
  ageSuitability: Listing['ageSuitability'];
  quantity: number;
}

export interface RequestDonationInput {
  listingId: string;
  quantity: number;
  /** Client-supplied idempotency key; derived from the request when omitted. */
  idempotencyKey?: string;
  message?: string;
}

export interface RequestDonationResult {
  donation: Donation;
  /** True when an earlier submission with the same key was returned as-is. */
  deduplicated: boolean;
}

export type NotificationHandler = (event: OutboxEvent) => Promise<void>;

export interface WorkflowServiceOptions {
  idGen?: () => string;
  now?: () => Date;
}

interface NotificationPayload {
  title: string;
  body: string;
  recipientUserId?: string;
  recipientOrganizationId?: string;
}

export class WorkflowService {
  private readonly idGen: () => string;
  private readonly now: () => Date;
  private readonly requestMutex = new KeyedMutex();

  constructor(
    private readonly store: Store,
    opts: WorkflowServiceOptions = {},
  ) {
    this.idGen = opts.idGen ?? (() => randomUUID());
    this.now = opts.now ?? (() => new Date());
  }

  // ── Listings ──────────────────────────────────────────────────────────────

  async createListing(actor: Actor, input: CreateListingInput): Promise<Listing> {
    if (!canCreateListing(actor)) {
      throw new AuthorizationError('Only donors (or admins) can create listings');
    }
    if (!input.title?.trim()) throw new ValidationError('Listing title is required');
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw new ValidationError('Listing quantity must be a positive integer');
    }
    const listing: Listing = {
      id: this.idGen(),
      donorId: actor.id,
      title: input.title.trim(),
      description: input.description,
      genre: input.genre,
      language: input.language,
      condition: input.condition,
      ageSuitability: input.ageSuitability,
      quantity: input.quantity,
      availableQuantity: input.quantity,
      isAvailable: true,
      createdAt: this.now(),
    };
    return this.store.listings.create(listing);
  }

  async searchListings(params: ListingSearchParams = {}): Promise<PaginatedResult<Listing>> {
    return searchListings(await this.store.listings.listAll(), params);
  }

  // ── Donation requests (idempotent creation) ──────────────────────────────

  async requestDonation(actor: Actor, input: RequestDonationInput): Promise<RequestDonationResult> {
    if (!canRequestDonation(actor)) {
      throw new AuthorizationError('Only organization members can request donations');
    }
    if (!actor.organizationId) {
      throw new ValidationError('Requesting actor must belong to an organization');
    }
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw new ValidationError('Requested quantity must be a positive integer');
    }
    const idempotencyKey =
      input.idempotencyKey ??
      makeIdempotencyKey([actor.organizationId, input.listingId, String(input.quantity)]);
    if (input.idempotencyKey !== undefined && !isValidIdempotencyKey(input.idempotencyKey)) {
      throw new ValidationError('Idempotency key has an invalid format');
    }

    // Check-then-create must be atomic per key. In production the unique
    // constraint on Donation.idempotencyKey enforces this; here a keyed
    // mutex serializes the critical section and the in-transaction re-check
    // models the constraint lookup.
    return this.requestMutex.run(idempotencyKey, async () => {
      const existing = await this.store.donations.getByIdempotencyKey(idempotencyKey);
      if (existing) return { donation: existing, deduplicated: true };

      const listing = await this.store.listings.getById(input.listingId);
      if (!listing) throw new NotFoundError(`Listing ${input.listingId}`);
      if (!listing.isAvailable || listing.availableQuantity < 1) {
        throw new ValidationError('Listing is not available');
      }
      if (input.quantity > listing.availableQuantity) {
        throw new ValidationError(
          `Requested quantity ${input.quantity} exceeds available quantity ${listing.availableQuantity}`,
        );
      }
      const organization = await this.store.organizations.getById(actor.organizationId!);
      if (!organization) throw new NotFoundError(`Organization ${actor.organizationId}`);

      let deduplicated = false;
      const donation = await this.store.transaction(async (tx) => {
        const raced = await tx.donations.getByIdempotencyKey(idempotencyKey);
        if (raced) {
          deduplicated = true;
          return raced;
        }
        const draft = createDonation({
          id: this.idGen(),
          listingId: listing.id,
          donorId: listing.donorId,
          organizationId: actor.organizationId!,
          quantity: input.quantity,
          idempotencyKey,
          createdAt: this.now(),
          updatedAt: this.now(),
        });
        // A request is born DRAFT and immediately submitted — both steps are
        // in the audit history, so the lifecycle is never ambiguous.
        const submitted = transitionDonation(draft, 'PENDING_APPROVAL', actor.id, input.message);
        await tx.donations.create(submitted);
        await tx.outbox.append(
          this.notificationEvent('donation.created', submitted, {
            title: 'New donation request',
            body: `${organization.name} requested ${input.quantity} × "${listing.title}".`,
            recipientUserId: listing.donorId,
          }),
        );
        return submitted;
      });
      return { donation, deduplicated };
    });
  }

  // ── Lifecycle transitions ─────────────────────────────────────────────────

  async approveDonation(actor: Actor, donationId: string): Promise<Donation> {
    return this.store.transaction(async (tx) => {
      const donation = await this.mustGetDonation(tx, donationId);
      if (!canApproveDonation(actor, donation)) {
        throw new AuthorizationError('Only the owning donor (or an admin) can approve this donation');
      }
      const listing = await tx.listings.getById(donation.listingId);
      if (!listing) throw new NotFoundError(`Listing ${donation.listingId}`);
      if (listing.availableQuantity < donation.quantity) {
        throw new ValidationError(
          `Insufficient available quantity: need ${donation.quantity}, have ${listing.availableQuantity}`,
        );
      }
      const approved = transitionDonation(donation, 'APPROVED', actor.id);
      // Reserve inventory as part of the same transaction as the approval.
      const remaining = listing.availableQuantity - donation.quantity;
      await tx.listings.save({ ...listing, availableQuantity: remaining, isAvailable: remaining > 0 });
      await tx.donations.save(approved);
      await tx.outbox.append(
        this.notificationEvent('donation.approved', approved, {
          title: 'Donation request approved',
          body: `Your request for ${donation.quantity} × "${listing.title}" was approved.`,
          recipientOrganizationId: donation.organizationId,
        }),
      );
      return approved;
    });
  }

  async rejectDonation(actor: Actor, donationId: string, reason?: string): Promise<Donation> {
    return this.store.transaction(async (tx) => {
      const donation = await this.mustGetDonation(tx, donationId);
      if (!canRejectDonation(actor, donation)) {
        throw new AuthorizationError('Only the owning donor (or an admin) can reject this donation');
      }
      const rejected = transitionDonation(donation, 'REJECTED', actor.id, reason);
      await tx.donations.save(rejected);
      await tx.outbox.append(
        this.notificationEvent('donation.rejected', rejected, {
          title: 'Donation request rejected',
          body: reason ? `Your donation request was rejected: ${reason}` : 'Your donation request was rejected.',
          recipientOrganizationId: donation.organizationId,
        }),
      );
      return rejected;
    });
  }

  async cancelDonation(actor: Actor, donationId: string, reason?: string): Promise<Donation> {
    return this.store.transaction(async (tx) => {
      const donation = await this.mustGetDonation(tx, donationId);
      if (!canCancelDonation(actor, donation)) {
        throw new AuthorizationError('Actor cannot cancel this donation');
      }
      const wasApproved = donation.status === 'APPROVED';
      const cancelled = transitionDonation(donation, 'CANCELLED', actor.id, reason);
      if (wasApproved) {
        // Release the reservation made at approval time.
        const listing = await tx.listings.getById(donation.listingId);
        if (listing) {
          const availableQuantity = listing.availableQuantity + donation.quantity;
          await tx.listings.save({ ...listing, availableQuantity, isAvailable: availableQuantity > 0 });
        }
      }
      await tx.donations.save(cancelled);
      await tx.outbox.append(
        this.notificationEvent('donation.status_changed', cancelled, {
          title: 'Donation cancelled',
          body: 'A donation was cancelled.',
          recipientUserId: donation.donorId,
          recipientOrganizationId: donation.organizationId,
        }),
      );
      return cancelled;
    });
  }

  /** Donor ships the books: APPROVED → IN_TRANSIT. */
  async markInTransit(actor: Actor, donationId: string): Promise<Donation> {
    return this.shipTransition(actor, donationId, 'IN_TRANSIT', 'Donation on its way', 'The donor marked your donation as in transit.');
  }

  /** Donor confirms handoff: IN_TRANSIT → DELIVERED. */
  async markDelivered(actor: Actor, donationId: string): Promise<Donation> {
    return this.shipTransition(actor, donationId, 'DELIVERED', 'Donation delivered', 'Your donation was marked as delivered. Please confirm receipt to complete it.');
  }

  /** Organization confirms receipt: DELIVERED → COMPLETED. */
  async confirmCompleted(actor: Actor, donationId: string): Promise<Donation> {
    return this.store.transaction(async (tx) => {
      const donation = await this.mustGetDonation(tx, donationId);
      const isOwningOrgMember =
        (actor.role === 'ORG_ADMIN' || actor.role === 'ORG_MEMBER') &&
        actor.organizationId === donation.organizationId;
      if (!isOwningOrgMember && actor.role !== 'ADMIN') {
        throw new AuthorizationError('Only a member of the receiving organization can confirm completion');
      }
      const completed = transitionDonation(donation, 'COMPLETED', actor.id);
      await tx.donations.save(completed);
      await tx.outbox.append(
        this.notificationEvent('donation.delivered', completed, {
          title: 'Donation completed',
          body: 'The receiving organization confirmed receipt. This donation is complete.',
          recipientUserId: donation.donorId,
        }),
      );
      return completed;
    });
  }

  async getDonation(actor: Actor, donationId: string): Promise<Donation> {
    const donation = await this.mustGetDonation(this.store, donationId);
    if (!canViewDonation(actor, donation)) {
      throw new AuthorizationError('Actor cannot view this donation');
    }
    return donation;
  }

  // ── Outbox dispatch → notifications ─────────────────────────────────────────

  /**
   * The default notification handler: materializes `Notification` records
   * from an outbox event's payload. Organization recipients expand to all
   * member users; a donor who is also the sole recipient is not duplicated.
   */
  readonly notificationHandler: NotificationHandler = async (event) => {
    const payload = event.payload as unknown as NotificationPayload & { donationId?: string };
    const recipientIds = new Set<string>();
    if (payload.recipientUserId) recipientIds.add(payload.recipientUserId);
    if (payload.recipientOrganizationId) {
      for (const member of await this.store.users.listByOrganization(payload.recipientOrganizationId)) {
        recipientIds.add(member.id);
      }
    }
    for (const userId of recipientIds) {
      await this.store.notifications.create({
        id: this.idGen(),
        userId,
        donationId: event.aggregateId,
        type: event.type,
        title: payload.title,
        body: payload.body,
        status: 'SENT',
        attempts: event.attempts + 1,
        createdAt: this.now(),
      } satisfies NotificationRecord);
    }
  };

  /**
   * Dispatches all pending outbox events through the domain dispatcher
   * (retry with exponential backoff; exhausted events are marked FAILED with
   * the last error preserved) and persists every event's final state.
   * A failing handler never rolls back donation state — that is the point of
   * the outbox — it only affects notification delivery, visibly.
   */
  async dispatchNotifications(
    handler: NotificationHandler = this.notificationHandler,
    dispatcherOptions: { maxAttempts?: number; baseDelayMs?: number; sleeper?: (ms: number) => Promise<void> } = {},
  ): Promise<{ delivered: number; failed: number }> {
    const pending = await this.store.outbox.listPending();
    if (pending.length === 0) return { delivered: 0, failed: 0 };
    const dispatcher = new OutboxDispatcher(dispatcherOptions);
    for (const event of pending) dispatcher.enqueue(event);
    const result = await dispatcher.dispatchAll(handler);
    for (const event of dispatcher.getEvents()) {
      await this.store.outbox.save(event);
    }
    return result;
  }

  async listNotificationsForUser(userId: string): Promise<NotificationRecord[]> {
    return this.store.notifications.listByUser(userId);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async shipTransition(
    actor: Actor,
    donationId: string,
    to: Extract<DonationStatus, 'IN_TRANSIT' | 'DELIVERED'>,
    title: string,
    body: string,
  ): Promise<Donation> {
    return this.store.transaction(async (tx) => {
      const donation = await this.mustGetDonation(tx, donationId);
      // Shipping is the donor's side of the lifecycle: the same ownership
      // policy as approval (owning donor or admin) applies.
      if (!canApproveDonation(actor, donation)) {
        throw new AuthorizationError('Only the owning donor (or an admin) can update shipment status');
      }
      const next = transitionDonation(donation, to, actor.id);
      await tx.donations.save(next);
      await tx.outbox.append(
        this.notificationEvent('donation.status_changed', next, {
          title,
          body,
          recipientOrganizationId: donation.organizationId,
        }),
      );
      return next;
    });
  }

  private async mustGetDonation(store: Store, donationId: string): Promise<Donation> {
    const donation = await store.donations.getById(donationId);
    if (!donation) throw new NotFoundError(`Donation ${donationId}`);
    return donation;
  }

  private notificationEvent(type: OutboxEvent['type'], donation: Donation, payload: NotificationPayload): OutboxEvent {
    return createOutboxEvent({
      id: this.idGen(),
      type,
      aggregateId: donation.id,
      payload: { ...payload, donationId: donation.id, status: donation.status },
      createdAt: this.now(),
    });
  }
}
