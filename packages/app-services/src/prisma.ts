/**
 * Prisma-backed `Store` adapter — the production persistence implementation,
 * written against `prisma/schema.prisma`.
 *
 * VERIFICATION STATUS: this adapter is typechecked and reviewed against the
 * schema, but it has NOT been executed against a live PostgreSQL database in
 * the build environment (no Postgres/Docker was available). The in-memory
 * adapter is the verified one; this adapter is the production wiring to run
 * once a database exists. See STATUS.md.
 *
 * The client is typed structurally (the subset of the Prisma client API this
 * adapter uses) so the package compiles without a generated `@prisma/client`.
 * A real generated `PrismaClient` satisfies `PrismaLike` directly.
 *
 * Known schema limitation: `Donation.history` (the domain audit trail) has
 * no column in the current schema — transitions are recoverable from the
 * OutboxEvent stream, but a follow-up migration should add a
 * `DonationHistory` table (or a `history Json` column) so this adapter can
 * round-trip the audit trail. Reads therefore return `history: []`.
 */
import type { Donation, Listing, OutboxEvent } from '@chapters/domain';
import type {
  CredentialRecord,
  NotificationRecord,
  OrganizationRecord,
  Store,
  UserRecord,
} from './repositories.js';

// ── Structural Prisma client surface (subset used below) ───────────────────

interface Delegate<TCreate, TRow> {
  create(args: { data: TCreate }): Promise<TRow>;
  findUnique(args: { where: Record<string, unknown> }): Promise<TRow | null>;
  findMany(args?: { where?: Record<string, unknown> }): Promise<TRow[]>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<TRow>;
}

export interface PrismaLike {
  user: Delegate<Record<string, unknown>, UserRow>;
  organization: Delegate<Record<string, unknown>, OrganizationRow>;
  listing: Delegate<Record<string, unknown>, ListingRow>;
  donation: Delegate<Record<string, unknown>, DonationRow>;
  outboxEvent: Delegate<Record<string, unknown>, OutboxRow>;
  notification: Delegate<Record<string, unknown>, NotificationRow>;
  $transaction<T>(fn: (tx: PrismaLike) => Promise<T>): Promise<T>;
}

interface UserRow {
  id: string; email: string; role: UserRecord['role']; organizationId: string | null;
  passwordHash: string;
}
interface OrganizationRow {
  id: string; name: string; type: string; city: string | null; country: string | null; verified: boolean;
}
type ListingRow = Omit<Listing, 'description'> & { description: string | null };
interface DonationRow {
  id: string; listingId: string; donorId: string; organizationId: string;
  status: Donation['status']; quantity: number; idempotencyKey: string | null;
  createdAt: Date; updatedAt: Date;
}
interface OutboxRow {
  id: string; type: string; aggregateId: string; payload: unknown;
  status: OutboxEvent['status']; attempts: number; lastError: string | null; createdAt: Date;
}
// The schema's Notification model has no donationId column (the link lives in
// the outbox payload), so rows map back with an empty donationId.
interface NotificationRow extends Omit<NotificationRecord, 'createdAt' | 'donationId'> { createdAt: Date }
const toNotification = (r: NotificationRow): NotificationRecord => ({ ...r, donationId: '' });

// ── Row ↔ domain mapping ────────────────────────────────────────────────────

const toUser = (r: UserRow): UserRecord => ({
  id: r.id,
  email: r.email,
  role: r.role,
  organizationId: r.organizationId ?? undefined,
  displayName: r.email, // Profile.displayName lives on the Profile relation; joined in queries that need it.
});
const toOrg = (r: OrganizationRow): OrganizationRecord => ({
  id: r.id,
  name: r.name,
  type: r.type as OrganizationRecord['type'],
  city: r.city ?? undefined,
  country: r.country ?? undefined,
  verified: r.verified,
});
const toListing = (r: ListingRow): Listing => ({ ...r, description: r.description ?? undefined });
const toDonation = (r: DonationRow): Donation => ({
  id: r.id,
  listingId: r.listingId,
  donorId: r.donorId,
  organizationId: r.organizationId,
  status: r.status,
  quantity: r.quantity,
  idempotencyKey: r.idempotencyKey ?? undefined,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  history: [], // See schema limitation note in the file header.
});
const toOutbox = (r: OutboxRow): OutboxEvent => ({
  id: r.id,
  type: r.type as OutboxEvent['type'],
  aggregateId: r.aggregateId,
  payload: (r.payload ?? {}) as Record<string, unknown>,
  createdAt: r.createdAt,
  attempts: r.attempts,
  status: r.status,
  lastError: r.lastError ?? undefined,
});

// ── Adapter ─────────────────────────────────────────────────────────────────

export class PrismaStore implements Store {
  constructor(private readonly prisma: PrismaLike) {}

  users = {
    create: async (user: UserRecord): Promise<UserRecord> =>
      toUser(
        await this.prisma.user.create({
          data: { id: user.id, email: user.email, role: user.role, organizationId: user.organizationId ?? null, passwordHash: 'EXTERNALLY_MANAGED' },
        }),
      ),
    getById: async (id: string): Promise<UserRecord | null> => {
      const row = await this.prisma.user.findUnique({ where: { id } });
      return row ? toUser(row) : null;
    },
    getByEmail: async (email: string): Promise<UserRecord | null> => {
      const row = await this.prisma.user.findUnique({ where: { email } });
      return row ? toUser(row) : null;
    },
    listByOrganization: async (organizationId: string): Promise<UserRecord[]> =>
      (await this.prisma.user.findMany({ where: { organizationId } })).map(toUser),
  };

  // Credentials live on the User row itself (`User.passwordHash` in the
  // schema). Creating a credential therefore updates the existing user row;
  // registration creates the user row through this same delegate first.
  credentials = {
    create: async (credential: CredentialRecord): Promise<CredentialRecord> => {
      const row = await this.prisma.user.update({
        where: { id: credential.userId },
        data: { passwordHash: credential.passwordHash },
      });
      return { userId: row.id, email: row.email, passwordHash: row.passwordHash };
    },
    getByEmail: async (email: string): Promise<CredentialRecord | null> => {
      const row = await this.prisma.user.findUnique({ where: { email } });
      return row ? { userId: row.id, email: row.email, passwordHash: row.passwordHash } : null;
    },
    getByUserId: async (userId: string): Promise<CredentialRecord | null> => {
      const row = await this.prisma.user.findUnique({ where: { id: userId } });
      return row ? { userId: row.id, email: row.email, passwordHash: row.passwordHash } : null;
    },
  };

  organizations = {
    create: async (org: OrganizationRecord): Promise<OrganizationRecord> =>
      toOrg(
        await this.prisma.organization.create({
          data: { id: org.id, name: org.name, type: org.type, city: org.city ?? null, country: org.country ?? null, verified: org.verified },
        }),
      ),
    getById: async (id: string): Promise<OrganizationRecord | null> => {
      const row = await this.prisma.organization.findUnique({ where: { id } });
      return row ? toOrg(row) : null;
    },
  };

  listings = {
    create: async (listing: Listing): Promise<Listing> =>
      toListing(
        await this.prisma.listing.create({
          data: {
            id: listing.id, donorId: listing.donorId, title: listing.title,
            description: listing.description ?? null, genre: listing.genre,
            language: listing.language, condition: listing.condition,
            ageSuitability: listing.ageSuitability, quantity: listing.quantity,
            availableQuantity: listing.availableQuantity, isAvailable: listing.isAvailable,
            createdAt: listing.createdAt,
          },
        }),
      ),
    getById: async (id: string): Promise<Listing | null> => {
      const row = await this.prisma.listing.findUnique({ where: { id } });
      return row ? toListing(row) : null;
    },
    listAll: async (): Promise<Listing[]> => (await this.prisma.listing.findMany()).map(toListing),
    save: async (listing: Listing): Promise<Listing> =>
      toListing(
        await this.prisma.listing.update({
          where: { id: listing.id },
          data: { availableQuantity: listing.availableQuantity, isAvailable: listing.isAvailable, quantity: listing.quantity, title: listing.title },
        }),
      ),
  };

  donations = {
    create: async (donation: Donation): Promise<Donation> =>
      toDonation(
        await this.prisma.donation.create({
          data: {
            id: donation.id, listingId: donation.listingId, donorId: donation.donorId,
            organizationId: donation.organizationId, status: donation.status,
            quantity: donation.quantity, idempotencyKey: donation.idempotencyKey ?? null,
            createdAt: donation.createdAt, updatedAt: donation.updatedAt,
          },
        }),
      ),
    getById: async (id: string): Promise<Donation | null> => {
      const row = await this.prisma.donation.findUnique({ where: { id } });
      return row ? toDonation(row) : null;
    },
    getByIdempotencyKey: async (key: string): Promise<Donation | null> => {
      // `idempotencyKey` is @unique in the schema — this lookup is the
      // database-level guarantee behind idempotent donation creation.
      const row = await this.prisma.donation.findUnique({ where: { idempotencyKey: key } });
      return row ? toDonation(row) : null;
    },
    listAll: async (): Promise<Donation[]> => (await this.prisma.donation.findMany()).map(toDonation),
    save: async (donation: Donation): Promise<Donation> =>
      toDonation(
        await this.prisma.donation.update({
          where: { id: donation.id },
          data: { status: donation.status, updatedAt: donation.updatedAt },
        }),
      ),
  };

  outbox = {
    append: async (event: OutboxEvent): Promise<OutboxEvent> =>
      toOutbox(
        await this.prisma.outboxEvent.create({
          data: {
            id: event.id, type: event.type, aggregateId: event.aggregateId,
            payload: event.payload, status: event.status, attempts: event.attempts,
            lastError: event.lastError ?? null, createdAt: event.createdAt,
          },
        }),
      ),
    listPending: async (): Promise<OutboxEvent[]> =>
      (await this.prisma.outboxEvent.findMany({ where: { status: 'PENDING' } })).map(toOutbox),
    listAll: async (): Promise<OutboxEvent[]> => (await this.prisma.outboxEvent.findMany()).map(toOutbox),
    save: async (event: OutboxEvent): Promise<OutboxEvent> =>
      toOutbox(
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { status: event.status, attempts: event.attempts, lastError: event.lastError ?? null },
        }),
      ),
  };

  notifications = {
    create: async (n: NotificationRecord): Promise<NotificationRecord> =>
      toNotification(
        await this.prisma.notification.create({
          data: { id: n.id, userId: n.userId, type: n.type, title: n.title, body: n.body, status: n.status, attempts: n.attempts, createdAt: n.createdAt },
        }),
      ),
    listByUser: async (userId: string): Promise<NotificationRecord[]> =>
      (await this.prisma.notification.findMany({ where: { userId } })).map(toNotification),
    listAll: async (): Promise<NotificationRecord[]> =>
      (await this.prisma.notification.findMany()).map(toNotification),
  };

  /** Delegates to Prisma's interactive transaction — the production atomicity boundary for outbox writes. */
  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => fn(new PrismaStore(tx)));
  }
}
