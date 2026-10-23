/**
 * CredentialAuthService — email + password registration and login.
 *
 * Passwords are hashed with bcrypt (`bcryptjs`, the pure-JS implementation
 * — no native build step) at cost factor 10 and verified with bcrypt's
 * constant-time comparison. Plaintext passwords are never stored, never
 * logged, and never included in any return value or error.
 *
 * Login failures are deliberately indistinguishable: an unknown email and a
 * wrong password both throw `InvalidCredentialsError` (the API maps it to a
 * generic 401), and the unknown-email path still runs a bcrypt comparison
 * against a dummy hash so response timing does not leak which case occurred.
 *
 * Successful logins issue the existing HS256 JWT (the API app's canonical
 * JWT module) with claims taken from the stored user record.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { signJwt } from '../../../apps/api/src/auth/jwt.js';
import type { Role } from '@chapters/domain';
import type { Store, UserRecord } from './repositories.js';
import { SEED_IDS } from './seed.js';
import { ValidationError } from './workflow.service.js';

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Password hashing seam — the real implementation is bcrypt (below). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export const BCRYPT_COST = 10;

export const bcryptHasher: PasswordHasher = {
  hash: (password) => bcrypt.hash(password, BCRYPT_COST),
  verify: (password, hash) => bcrypt.compare(password, hash),
};

/**
 * A real bcrypt hash of a throwaway string, used only to spend equivalent
 * comparison time when a login email does not exist. It is not a credential
 * for any account.
 */
const DUMMY_HASH = '$2b$10$3s54PYMbIkPl.v6IlocS7e1Jtf0JEmaOFIjGquDm7OEY3/B2.7uR.';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 8;

export interface RegisterInput {
  email: string;
  password: string;
  role: Exclude<Role, 'ADMIN'>;
  displayName: string;
  organizationId?: string;
}

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  user: UserRecord;
}

export class CredentialAuthService {
  constructor(
    private readonly store: Store,
    private readonly secret: string,
    private readonly hasher: PasswordHasher = bcryptHasher,
    private readonly idGen: () => string = () => randomUUID(),
  ) {}

  /**
   * Registers a new user with a bcrypt-hashed password. `ADMIN` cannot be
   * self-registered. Returns the user record (never the hash).
   */
  async register(input: RegisterInput): Promise<UserRecord> {
    const email = input.email?.trim().toLowerCase();
    if (!email || !EMAIL_PATTERN.test(email)) {
      throw new ValidationError('A valid email address is required');
    }
    if (typeof input.password !== 'string' || input.password.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (!input.displayName?.trim()) {
      throw new ValidationError('Display name is required');
    }
    if (input.role === ('ADMIN' as Role)) {
      throw new ValidationError('Admin accounts cannot be self-registered');
    }
    if ((input.role === 'ORG_ADMIN' || input.role === 'ORG_MEMBER') && !input.organizationId) {
      throw new ValidationError('Organization accounts must specify an organizationId');
    }
    if (input.organizationId) {
      const org = await this.store.organizations.getById(input.organizationId);
      if (!org) throw new ValidationError(`Organization ${input.organizationId} does not exist`);
    }
    if (await this.store.users.getByEmail(email)) {
      throw new ConflictError('An account with this email already exists');
    }
    const passwordHash = await this.hasher.hash(input.password);
    const user = await this.store.users.create({
      id: this.idGen(),
      email,
      role: input.role,
      organizationId: input.organizationId,
      displayName: input.displayName.trim(),
    });
    await this.store.credentials.create({ userId: user.id, email, passwordHash });
    return user;
  }

  /**
   * Verifies email + password and issues a JWT. Unknown email and wrong
   * password produce the identical error (and near-identical timing).
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const credential = normalized ? await this.store.credentials.getByEmail(normalized) : null;
    if (!credential) {
      // Spend a real bcrypt comparison so timing does not reveal that the
      // account does not exist; the result is discarded.
      await this.hasher.verify(typeof password === 'string' ? password : '', DUMMY_HASH);
      throw new InvalidCredentialsError();
    }
    const ok = typeof password === 'string' && (await this.hasher.verify(password, credential.passwordHash));
    if (!ok) throw new InvalidCredentialsError();
    const user = await this.store.users.getById(credential.userId);
    if (!user) throw new InvalidCredentialsError();
    const accessToken = signJwt(
      { sub: user.id, role: user.role, email: user.email, organizationId: user.organizationId },
      this.secret,
      { expiresInSeconds: 3600 },
    );
    return { accessToken, tokenType: 'Bearer', user };
  }
}

/**
 * SYNTHETIC / DEV-ONLY passwords for the seeded demo users (see seed.ts).
 * These exist so the demo login flow can be exercised locally; they are
 * published in the README on purpose and must never be used anywhere real.
 */
export const SYNTHETIC_DEV_CREDENTIALS: ReadonlyArray<{
  userId: string;
  email: string;
  password: string;
}> = [
  { userId: SEED_IDS.donor, email: 'donor@example.com', password: 'synthetic-donor-pass' },
  { userId: SEED_IDS.orgAdmin, email: 'admin@riverside.example.com', password: 'synthetic-org-pass' },
  { userId: SEED_IDS.orgMember, email: 'member@riverside.example.com', password: 'synthetic-org-pass' },
  { userId: SEED_IDS.otherOrgAdmin, email: 'admin@sunrise.example.com', password: 'synthetic-org-pass' },
];

/**
 * Gives every seeded synthetic user a bcrypt-hashed dev credential (see
 * SYNTHETIC_DEV_CREDENTIALS). Idempotent: existing credentials are left
 * untouched. Call after `seedSyntheticData`.
 */
export async function seedSyntheticCredentials(
  store: Store,
  hasher: PasswordHasher = bcryptHasher,
): Promise<void> {
  for (const entry of SYNTHETIC_DEV_CREDENTIALS) {
    if (await store.credentials.getByEmail(entry.email)) continue;
    const passwordHash = await hasher.hash(entry.password);
    await store.credentials.create({ userId: entry.userId, email: entry.email, passwordHash });
  }
}
