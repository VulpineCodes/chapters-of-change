// SYNTHETIC seed data — all organizations, users, and listings below are fictional
// examples for local development and demos. No real partnerships or donations.
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const org1 = await prisma.organization.create({ data: { name: '[SYNTHETIC] Riverside Community Library', type: 'LIBRARY', city: 'Nashville', country: 'US', description: 'Synthetic example library for demos.' } });
  const org2 = await prisma.organization.create({ data: { name: '[SYNTHETIC] Sunrise Primary School', type: 'SCHOOL', city: 'Lagos', country: 'NG', description: 'Synthetic example school for demos.' } });
  const donor = await prisma.user.create({ data: { email: 'donor@example.com', passwordHash: 'REPLACE_WITH_HASHED_PASSWORD_IN_REAL_SEED', role: 'DONOR', profile: { create: { displayName: 'Synthetic Donor', city: 'Nashville' } } } });
  await prisma.user.create({ data: { email: 'admin@riverside.example.com', passwordHash: 'REPLACE_WITH_HASHED_PASSWORD_IN_REAL_SEED', role: 'ORG_ADMIN', organizationId: org1.id, profile: { create: { displayName: 'Synthetic Org Admin' } } } });
  await prisma.listing.createMany({ data: [
    { donorId: donor.id, title: 'Naruto Vol. 1–5 bundle', genre: 'Manga', language: 'English', condition: 'GOOD', ageSuitability: 'TEEN', quantity: 5, availableQuantity: 5 },
    { donorId: donor.id, title: 'Spider-Man: Into the Spider-Verse comics', genre: 'Superhero', language: 'English', condition: 'LIKE_NEW', ageSuitability: 'ALL_AGES', quantity: 3, availableQuantity: 3 },
    { donorId: donor.id, title: 'One Piece Vol. 1 (French)', genre: 'Manga', language: 'French', condition: 'GOOD', ageSuitability: 'TEEN', quantity: 2, availableQuantity: 2 },
  ]});
  console.log(`Seeded synthetic orgs ${org1.id}, ${org2.id} and donor ${donor.id}`);
}
main().finally(() => prisma.$disconnect());
