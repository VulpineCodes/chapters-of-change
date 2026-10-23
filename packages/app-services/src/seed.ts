/**
 * Synthetic seed data for the application layer — mirrors `prisma/seed.ts`.
 * Every record is fictional and labeled as such; there are no real users,
 * organizations, partnerships, or donations behind this data.
 */
import type { Store, UserRecord } from './repositories.js';

export const SEED_IDS = {
  donor: 'user-donor-1',
  orgAdmin: 'user-org-admin-1',
  orgMember: 'user-org-member-1',
  otherOrgAdmin: 'user-org-admin-2',
  riversideOrg: 'org-riverside',
  sunriseOrg: 'org-sunrise',
} as const;

export async function seedSyntheticData(store: Store): Promise<{ donor: UserRecord }> {
  await store.organizations.create({
    id: SEED_IDS.riversideOrg,
    name: '[SYNTHETIC] Riverside Community Library',
    type: 'LIBRARY',
    city: 'Nashville',
    country: 'US',
    verified: false,
  });
  await store.organizations.create({
    id: SEED_IDS.sunriseOrg,
    name: '[SYNTHETIC] Sunrise Primary School',
    type: 'SCHOOL',
    city: 'Lagos',
    country: 'NG',
    verified: false,
  });

  const donor = await store.users.create({
    id: SEED_IDS.donor,
    email: 'donor@example.com',
    role: 'DONOR',
    displayName: 'Synthetic Donor',
  });
  await store.users.create({
    id: SEED_IDS.orgAdmin,
    email: 'admin@riverside.example.com',
    role: 'ORG_ADMIN',
    organizationId: SEED_IDS.riversideOrg,
    displayName: 'Synthetic Org Admin',
  });
  await store.users.create({
    id: SEED_IDS.orgMember,
    email: 'member@riverside.example.com',
    role: 'ORG_MEMBER',
    organizationId: SEED_IDS.riversideOrg,
    displayName: 'Synthetic Org Member',
  });
  await store.users.create({
    id: SEED_IDS.otherOrgAdmin,
    email: 'admin@sunrise.example.com',
    role: 'ORG_ADMIN',
    organizationId: SEED_IDS.sunriseOrg,
    displayName: 'Synthetic Other-Org Admin',
  });
  return { donor };
}
