import { createHash } from 'node:crypto';

export function makeIdempotencyKey(parts: string[]): string {
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

export function isValidIdempotencyKey(key: string): boolean {
  return /^[a-f0-9]{64}$/.test(key) || (key.length >= 8 && key.length <= 128 && /^[a-zA-Z0-9\-_]+$/.test(key));
}

/** In-memory idempotency store — in production backed by a unique DB constraint + Redis. */
export class IdempotencyStore {
  private map = new Map<string, string>();
  /** Returns existing result id if key seen, otherwise records and returns null. */
  checkAndRecord(key: string, resultId: string): string | null {
    const existing = this.map.get(key);
    if (existing) return existing;
    this.map.set(key, resultId);
    return null;
  }
  has(key: string): boolean { return this.map.has(key); }
  get(key: string): string | undefined { return this.map.get(key); }
  clear(): void { this.map.clear(); }
}
