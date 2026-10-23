import { describe, it, expect, beforeEach } from 'vitest';
import { verifyJwt } from '@api-auth-jwt';
import { AuthService } from './auth.service.js';
import { InMemoryStore } from './memory.js';
import { NotFoundError } from './workflow.service.js';
import { SEED_IDS, seedSyntheticData } from './seed.js';

const SECRET = 'auth-service-test-secret';

let store: InMemoryStore;
let auth: AuthService;

beforeEach(async () => {
  store = new InMemoryStore();
  await seedSyntheticData(store);
  auth = new AuthService(store, SECRET);
});

describe('AuthService token issuance', () => {
  it('issues a token whose claims come from the stored user record', async () => {
    const token = await auth.issueForUser(SEED_IDS.orgAdmin);
    const claims = verifyJwt(token, SECRET);
    expect(claims.sub).toBe(SEED_IDS.orgAdmin);
    expect(claims.role).toBe('ORG_ADMIN');
    expect(claims.organizationId).toBe(SEED_IDS.riversideOrg);
    expect(claims.email).toBe('admin@riverside.example.com');
  });

  it('issues a seeded-user token carrying the seeded donor record id', async () => {
    const token = await auth.issueForSeededUser();
    const claims = verifyJwt(token, SECRET);
    expect(claims.sub).toBe(SEED_IDS.donor);
    expect(claims.role).toBe('DONOR');
    expect(claims.email).toBe('donor@example.com');
  });

  it('refuses to issue tokens for unknown users', async () => {
    await expect(auth.issueForUser('user-does-not-exist')).rejects.toBeInstanceOf(NotFoundError);
  });
});
