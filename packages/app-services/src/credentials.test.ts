import { describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { verifyJwt } from '../../../apps/api/src/auth/jwt.js';
import { InMemoryStore } from './memory.js';
import {
  ConflictError,
  CredentialAuthService,
  InvalidCredentialsError,
  seedSyntheticCredentials,
} from './credentials.js';
import { ValidationError } from './workflow.service.js';
import { SEED_IDS, seedSyntheticData } from './seed.js';

const SECRET = 'credentials-test-secret';

let store: InMemoryStore;
let auth: CredentialAuthService;
let seq = 0;

beforeEach(async () => {
  store = new InMemoryStore();
  await seedSyntheticData(store);
  auth = new CredentialAuthService(store, SECRET, undefined, () => `user-new-${++seq}`);
});

describe('CredentialAuthService: register → login', () => {
  it('registers a user and logs them in, issuing a JWT with the stored claims', async () => {
    const user = await auth.register({
      email: 'NewDonor@Example.com',
      password: 'correct horse battery',
      role: 'DONOR',
      displayName: 'New Donor',
    });
    // Email is normalized; the returned record never carries a hash.
    expect(user.email).toBe('newdonor@example.com');
    expect(user).not.toHaveProperty('passwordHash');

    const { accessToken, tokenType, user: loggedIn } = await auth.login(
      'newdonor@example.com',
      'correct horse battery',
    );
    expect(tokenType).toBe('Bearer');
    expect(loggedIn.id).toBe(user.id);
    const claims = verifyJwt(accessToken, SECRET);
    expect(claims.sub).toBe(user.id);
    expect(claims.role).toBe('DONOR');
    expect(claims.email).toBe('newdonor@example.com');
  });

  it('stores a bcrypt hash that is not the password and verifies correctly', async () => {
    const user = await auth.register({
      email: 'hash-check@example.com',
      password: 'my-secret-password',
      role: 'DONOR',
      displayName: 'Hash Check',
    });
    const credential = await store.credentials.getByUserId(user.id);
    expect(credential).not.toBeNull();
    expect(credential!.passwordHash).not.toBe('my-secret-password');
    expect(credential!.passwordHash).not.toContain('my-secret-password');
    expect(credential!.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt marker
    expect(await bcrypt.compare('my-secret-password', credential!.passwordHash)).toBe(true);
    expect(await bcrypt.compare('not-the-password', credential!.passwordHash)).toBe(false);
  });

  it('rejects a wrong password with InvalidCredentialsError', async () => {
    await auth.register({
      email: 'wrong-pass@example.com',
      password: 'the-real-password',
      role: 'DONOR',
      displayName: 'Wrong Pass',
    });
    await expect(auth.login('wrong-pass@example.com', 'the-wrong-password')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('rejects an unknown email with the same error as a wrong password (no existence leak)', async () => {
    const unknownErr = await auth.login('nobody@example.com', 'whatever-password').catch((e) => e);
    expect(unknownErr).toBeInstanceOf(InvalidCredentialsError);

    await auth.register({
      email: 'known@example.com',
      password: 'the-real-password',
      role: 'DONOR',
      displayName: 'Known',
    });
    const wrongPassErr = await auth
      .login('known@example.com', 'the-wrong-password')
      .catch((e) => e);
    expect(wrongPassErr).toBeInstanceOf(InvalidCredentialsError);
    expect(wrongPassErr.message).toBe(unknownErr.message);
  });

  it('rejects duplicate registration and invalid input', async () => {
    const input = {
      email: 'dup@example.com',
      password: 'a-valid-password',
      role: 'DONOR' as const,
      displayName: 'Dup',
    };
    await auth.register(input);
    await expect(auth.register(input)).rejects.toBeInstanceOf(ConflictError);
    await expect(
      auth.register({ ...input, email: 'short@example.com', password: 'short' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      auth.register({ ...input, email: 'not-an-email' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      auth.register({
        email: 'org-no-org@example.com',
        password: 'a-valid-password',
        role: 'ORG_ADMIN',
        displayName: 'No Org',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('logs in an organization user with organization claims', async () => {
    await auth.register({
      email: 'librarian@riverside.example.com',
      password: 'library-password-1',
      role: 'ORG_ADMIN',
      displayName: 'Librarian',
      organizationId: SEED_IDS.riversideOrg,
    });
    const { accessToken } = await auth.login('librarian@riverside.example.com', 'library-password-1');
    const claims = verifyJwt(accessToken, SECRET);
    expect(claims.role).toBe('ORG_ADMIN');
    expect(claims.organizationId).toBe(SEED_IDS.riversideOrg);
  });
});

describe('seeded synthetic credentials (SYNTHETIC / DEV ONLY)', () => {
  it('seeded users can log in with the documented dev passwords', async () => {
    await seedSyntheticCredentials(store);
    const donorLogin = await auth.login('donor@example.com', 'synthetic-donor-pass');
    expect(verifyJwt(donorLogin.accessToken, SECRET).sub).toBe(SEED_IDS.donor);
    const orgLogin = await auth.login('admin@riverside.example.com', 'synthetic-org-pass');
    const claims = verifyJwt(orgLogin.accessToken, SECRET);
    expect(claims.sub).toBe(SEED_IDS.orgAdmin);
    expect(claims.organizationId).toBe(SEED_IDS.riversideOrg);
    await expect(auth.login('donor@example.com', 'synthetic-org-pass')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });
});
