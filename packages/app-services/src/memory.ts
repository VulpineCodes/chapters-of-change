/**
 * In-memory `Store` adapter. Used by the integration tests and usable for
 * local demos without Postgres. Records are deep-cloned on the way in and
 * out (via `structuredClone`) so callers can never mutate stored state by
 * holding a reference — the same isolation a real database round-trip gives.
 */
import type { Donation, Listing, OutboxEvent } from '@chapters/domain';
import type {
  CredentialRecord,
  NotificationRecord,
  OrganizationRecord,
  Store,
  UserRecord,
} from './repositories.js';

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryStore implements Store {
  private usersById = new Map<string, UserRecord>();
  private credentialsByEmail = new Map<string, CredentialRecord>();
  private orgsById = new Map<string, OrganizationRecord>();
  private listingsById = new Map<string, Listing>();
  private donationsById = new Map<string, Donation>();
  private outboxEvents: OutboxEvent[] = [];
  private notificationRecords: NotificationRecord[] = [];

  users = {
    create: async (user: UserRecord) => {
      this.usersById.set(user.id, clone(user));
      return clone(user);
    },
    getById: async (id: string) => {
      const u = this.usersById.get(id);
      return u ? clone(u) : null;
    },
    getByEmail: async (email: string) => {
      const u = [...this.usersById.values()].find((x) => x.email === email);
      return u ? clone(u) : null;
    },
    listByOrganization: async (organizationId: string) =>
      [...this.usersById.values()].filter((x) => x.organizationId === organizationId).map(clone),
  };

  credentials = {
    create: async (credential: CredentialRecord) => {
      this.credentialsByEmail.set(credential.email.toLowerCase(), clone(credential));
      return clone(credential);
    },
    getByEmail: async (email: string) => {
      const c = this.credentialsByEmail.get(email.toLowerCase());
      return c ? clone(c) : null;
    },
    getByUserId: async (userId: string) => {
      const c = [...this.credentialsByEmail.values()].find((x) => x.userId === userId);
      return c ? clone(c) : null;
    },
  };

  organizations = {
    create: async (org: OrganizationRecord) => {
      this.orgsById.set(org.id, clone(org));
      return clone(org);
    },
    getById: async (id: string) => {
      const o = this.orgsById.get(id);
      return o ? clone(o) : null;
    },
  };

  listings = {
    create: async (listing: Listing) => {
      this.listingsById.set(listing.id, clone(listing));
      return clone(listing);
    },
    getById: async (id: string) => {
      const l = this.listingsById.get(id);
      return l ? clone(l) : null;
    },
    listAll: async () => [...this.listingsById.values()].map(clone),
    save: async (listing: Listing) => {
      if (!this.listingsById.has(listing.id)) throw new Error(`Listing ${listing.id} does not exist`);
      this.listingsById.set(listing.id, clone(listing));
      return clone(listing);
    },
  };

  donations = {
    create: async (donation: Donation) => {
      this.donationsById.set(donation.id, clone(donation));
      return clone(donation);
    },
    getById: async (id: string) => {
      const d = this.donationsById.get(id);
      return d ? clone(d) : null;
    },
    getByIdempotencyKey: async (key: string) => {
      const d = [...this.donationsById.values()].find((x) => x.idempotencyKey === key);
      return d ? clone(d) : null;
    },
    listAll: async () => [...this.donationsById.values()].map(clone),
    save: async (donation: Donation) => {
      if (!this.donationsById.has(donation.id)) throw new Error(`Donation ${donation.id} does not exist`);
      this.donationsById.set(donation.id, clone(donation));
      return clone(donation);
    },
  };

  outbox = {
    append: async (event: OutboxEvent) => {
      this.outboxEvents.push(clone(event));
      return clone(event);
    },
    listPending: async () => this.outboxEvents.filter((e) => e.status === 'PENDING').map(clone),
    listAll: async () => this.outboxEvents.map(clone),
    save: async (event: OutboxEvent) => {
      const idx = this.outboxEvents.findIndex((e) => e.id === event.id);
      if (idx === -1) throw new Error(`Outbox event ${event.id} does not exist`);
      this.outboxEvents[idx] = clone(event);
      return clone(event);
    },
  };

  notifications = {
    create: async (notification: NotificationRecord) => {
      this.notificationRecords.push(clone(notification));
      return clone(notification);
    },
    listByUser: async (userId: string) =>
      this.notificationRecords.filter((n) => n.userId === userId).map(clone),
    listAll: async () => this.notificationRecords.map(clone),
  };

  /**
   * Single-process store: the callback runs against this same store. True
   * multi-statement atomicity comes from the database in production; the one
   * check-then-create race that matters here (idempotent donation creation)
   * is serialized by the service-level keyed mutex.
   */
  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
