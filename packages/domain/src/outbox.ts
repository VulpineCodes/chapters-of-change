export type OutboxEventType =
  | 'donation.created' | 'donation.status_changed' | 'donation.approved'
  | 'donation.rejected' | 'donation.delivered' | 'notification.requested';

export interface OutboxEvent {
  id: string;
  type: OutboxEventType;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  attempts: number;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  lastError?: string;
  nextAttemptAt?: Date;
}

export function createOutboxEvent(input: Omit<OutboxEvent, 'attempts' | 'status' | 'createdAt'> & { createdAt?: Date }): OutboxEvent {
  return { ...input, createdAt: input.createdAt ?? new Date(), attempts: 0, status: 'PENDING' };
}

export type Sleeper = (ms: number) => Promise<void>;
const defaultSleeper: Sleeper = (ms) => new Promise(r => setTimeout(r, ms));

export interface DispatcherOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleeper?: Sleeper;
}

export class OutboxDispatcher {
  private events: OutboxEvent[] = [];
  constructor(private opts: DispatcherOptions = {}) {}
  enqueue(e: OutboxEvent): void { this.events.push(e); }
  getEvents(): OutboxEvent[] { return [...this.events]; }
  pending(): OutboxEvent[] { return this.events.filter(e => e.status === 'PENDING'); }

  async dispatchAll(handler: (e: OutboxEvent) => Promise<void>): Promise<{ delivered: number; failed: number }> {
    const maxAttempts = this.opts.maxAttempts ?? 3;
    const baseDelay = this.opts.baseDelayMs ?? 100;
    const sleep = this.opts.sleeper ?? defaultSleeper;
    let delivered = 0, failed = 0;
    for (const ev of this.events.filter(e => e.status === 'PENDING')) {
      let ok = false;
      while (ev.attempts < maxAttempts) {
        try {
          await handler(ev);
          ev.status = 'DELIVERED'; ok = true; delivered++;
          break;
        } catch (err) {
          ev.attempts++;
          ev.lastError = err instanceof Error ? err.message : String(err);
          if (ev.attempts < maxAttempts) {
            await sleep(baseDelay * Math.pow(2, ev.attempts - 1));
          }
        }
      }
      if (!ok) { ev.status = 'FAILED'; failed++; }
    }
    return { delivered, failed };
  }
}
