/**
 * Repository interfaces — the persistence boundary for the application layer.
 *
 * The workflow service depends ONLY on these interfaces. Two adapters exist:
 *  - `InMemoryStore` (memory.ts) — used by tests and local demos; no infra.
 *  - `PrismaStore` (prisma.ts) — production adapter written against
 *    `prisma/schema.prisma`.
 *
 * Every method is async so the in-memory adapter honestly models the I/O
 * shape of the database adapter (no sync shortcuts that would hide race
 * conditions the real system must handle).
 */
import type { Donation, Listing, OutboxEvent, Role } from '@chapters/domain';

export interface UserRecord {
  id: string;
  email: string;
  role: Role;
  organizationId?: string;
  displayName: string;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  type: 'SCHOOL' | 'LIBRARY' | 'COMMUNITY' | 'OTHER';
  city?: string;
  country?: string;
  verified: boolean;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  donationId: string;
  type: string;
  title: string;
  body: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempts: number;
  createdAt: Date;
}

export interface UserRepository {
  create(user: UserRecord): Promise<UserRecord>;
  getById(id: string): Promise<UserRecord | null>;
  getByEmail(email: string): Promise<UserRecord | null>;
  listByOrganization(organizationId: string): Promise<UserRecord[]>;
}

/**
 * A stored login credential. `passwordHash` is a bcrypt hash — the plaintext
 * password is never stored, logged, or returned by any layer above this one.
 * Kept separate from `UserRecord` so hashes can never leak into profile /
 * workflow responses by accident.
 */
export interface CredentialRecord {
  userId: string;
  email: string;
  passwordHash: string;
}

export interface CredentialRepository {
  create(credential: CredentialRecord): Promise<CredentialRecord>;
  getByEmail(email: string): Promise<CredentialRecord | null>;
  getByUserId(userId: string): Promise<CredentialRecord | null>;
}

export interface OrganizationRepository {
  create(org: OrganizationRecord): Promise<OrganizationRecord>;
  getById(id: string): Promise<OrganizationRecord | null>;
}

export interface ListingRepository {
  create(listing: Listing): Promise<Listing>;
  getById(id: string): Promise<Listing | null>;
  listAll(): Promise<Listing[]>;
  save(listing: Listing): Promise<Listing>;
}

export interface DonationRepository {
  create(donation: Donation): Promise<Donation>;
  getById(id: string): Promise<Donation | null>;
  getByIdempotencyKey(key: string): Promise<Donation | null>;
  listAll(): Promise<Donation[]>;
  save(donation: Donation): Promise<Donation>;
}

export interface OutboxRepository {
  append(event: OutboxEvent): Promise<OutboxEvent>;
  listPending(): Promise<OutboxEvent[]>;
  listAll(): Promise<OutboxEvent[]>;
  save(event: OutboxEvent): Promise<OutboxEvent>;
}

export interface NotificationRepository {
  create(notification: NotificationRecord): Promise<NotificationRecord>;
  listByUser(userId: string): Promise<NotificationRecord[]>;
  listAll(): Promise<NotificationRecord[]>;
}

/**
 * A unit of persistence. `transaction` must run `fn` such that the writes it
 * performs commit or roll back together: the Prisma adapter delegates to
 * `prisma.$transaction`; the in-memory adapter executes `fn` directly
 * (single-process, and the service serializes the one check-then-create
 * path — donation creation — with a keyed mutex; see workflow.service.ts).
 */
export interface Store {
  users: UserRepository;
  credentials: CredentialRepository;
  organizations: OrganizationRepository;
  listings: ListingRepository;
  donations: DonationRepository;
  outbox: OutboxRepository;
  notifications: NotificationRepository;
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
}
