import type { Role } from './listing.js';

export interface Actor { id: string; role: Role; organizationId?: string; }
export interface ListingResource { donorId: string; }
export interface DonationResource { donorId: string; organizationId: string; }

export function canCreateListing(actor: Actor): boolean {
  return actor.role === 'DONOR' || actor.role === 'ADMIN';
}
export function canEditListing(actor: Actor, listing: ListingResource): boolean {
  if (actor.role === 'ADMIN') return true;
  return actor.role === 'DONOR' && actor.id === listing.donorId;
}
export function canDeleteListing(actor: Actor, listing: ListingResource): boolean {
  return canEditListing(actor, listing);
}
export function canRequestDonation(actor: Actor): boolean {
  return actor.role === 'ORG_ADMIN' || actor.role === 'ORG_MEMBER' || actor.role === 'ADMIN';
}
export function canApproveDonation(actor: Actor, donation: DonationResource): boolean {
  if (actor.role === 'ADMIN') return true;
  if (actor.role === 'DONOR') return actor.id === donation.donorId;
  return false;
}
export function canRejectDonation(actor: Actor, donation: DonationResource): boolean {
  return canApproveDonation(actor, donation);
}
export function canCancelDonation(actor: Actor, donation: DonationResource): boolean {
  if (actor.role === 'ADMIN') return true;
  if (actor.role === 'DONOR') return actor.id === donation.donorId;
  if ((actor.role === 'ORG_ADMIN' || actor.role === 'ORG_MEMBER') && actor.organizationId) return actor.organizationId === donation.organizationId;
  return false;
}
export function canViewDonation(actor: Actor, donation: DonationResource): boolean {
  if (actor.role === 'ADMIN') return true;
  if (actor.id === donation.donorId) return true;
  if (actor.organizationId && actor.organizationId === donation.organizationId) return true;
  return false;
}
export function canManageOrganization(actor: Actor, organizationId: string): boolean {
  if (actor.role === 'ADMIN') return true;
  return actor.role === 'ORG_ADMIN' && actor.organizationId === organizationId;
}

// Back-compat aliases used in API layer naming
export const canRequest = canRequestDonation;
export const canApprove = canApproveDonation;
