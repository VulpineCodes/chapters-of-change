export type DonationStatus =
  | 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED'
  | 'IN_TRANSIT' | 'DELIVERED' | 'COMPLETED' | 'CANCELLED';

export const TRANSITIONS: Record<DonationStatus, DonationStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['IN_TRANSIT', 'CANCELLED'],
  REJECTED: [],
  IN_TRANSIT: ['DELIVERED', 'CANCELLED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export class IllegalTransitionError extends Error {
  constructor(public from: DonationStatus, public to: DonationStatus) {
    super(`Illegal donation transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: DonationStatus, to: DonationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: DonationStatus, to: DonationStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export interface Donation {
  id: string;
  listingId: string;
  donorId: string;
  organizationId: string;
  status: DonationStatus;
  quantity: number;
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
  history: { from: DonationStatus; to: DonationStatus; at: Date; actorId: string; reason?: string }[];
}

export function createDonation(input: Omit<Donation, 'status' | 'history'> & { status?: DonationStatus }): Donation {
  return { ...input, status: input.status ?? 'DRAFT', history: [] };
}

export function transitionDonation(d: Donation, to: DonationStatus, actorId: string, reason?: string): Donation {
  assertTransition(d.status, to);
  const next: Donation = {
    ...d,
    status: to,
    updatedAt: new Date(),
    history: [...d.history, { from: d.status, to, at: new Date(), actorId, reason }],
  };
  return next;
}

export function isTerminal(status: DonationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
