export type Role = 'DONOR' | 'ORG_ADMIN' | 'ORG_MEMBER' | 'ADMIN';
export type Condition = 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR' | 'POOR';
export type AgeSuitability = 'ALL_AGES' | 'CHILDREN' | 'TEEN' | 'YOUNG_ADULT' | 'ADULT';

export interface Listing {
  id: string;
  donorId: string;
  title: string;
  description?: string;
  genre: string;
  language: string;
  condition: Condition;
  ageSuitability: AgeSuitability;
  quantity: number;
  availableQuantity: number;
  isAvailable: boolean;
  createdAt: Date;
}

export interface ListingSearchParams {
  query?: string;
  genre?: string;
  language?: string;
  condition?: Condition;
  ageSuitability?: AgeSuitability;
  onlyAvailable?: boolean;
  page?: number;
  pageSize?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function searchListings(listings: Listing[], params: ListingSearchParams = {}): PaginatedResult<Listing> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
  let filtered = [...listings];
  if (params.onlyAvailable) filtered = filtered.filter(l => l.isAvailable && l.availableQuantity > 0);
  if (params.genre) filtered = filtered.filter(l => l.genre.toLowerCase() === params.genre!.toLowerCase());
  if (params.language) filtered = filtered.filter(l => l.language.toLowerCase() === params.language!.toLowerCase());
  if (params.condition) filtered = filtered.filter(l => l.condition === params.condition);
  if (params.ageSuitability) filtered = filtered.filter(l => l.ageSuitability === params.ageSuitability);
  if (params.query) {
    const q = params.query.toLowerCase();
    filtered = filtered.filter(l => l.title.toLowerCase().includes(q) || (l.description ?? '').toLowerCase().includes(q) || l.genre.toLowerCase().includes(q));
  }
  filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const total = filtered.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const items = filtered.slice((page - 1) * pageSize, page * pageSize);
  return { items, total, page, pageSize, totalPages };
}
