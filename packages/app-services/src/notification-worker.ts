/**
 * NotificationWorkerCore — the queue-agnostic job-processing core behind
 * outbox-driven notification delivery.
 *
 * One job = one outbox event. The core delivers it through an injected
 * `deliver` function (in production: `WorkflowService.notificationHandler`,
 * which materializes Notification records), retrying with exponential
 * backoff. After `maxAttempts` failures the event is moved to the FAILED
 * state with the last error preserved — failures stay inspectable, never
 * silently dropped, and a failed notification never rolls back the donation
 * state that produced the event (that separation is the point of the
 * transactional outbox).
 *
 * This module has no queue dependency, so it is fully unit-tested offline.
 * The BullMQ adapter (`apps/api/src/notifications/bullmq.adapter.ts`) wires
 * this exact core to a real Queue/Worker when Redis is available.
 */
import type { OutboxEvent } from '@chapters/domain';
import type { Store } from './repositories.js';

export type NotificationDeliverFn = (event: OutboxEvent) => Promise<void>;
export type Sleeper = (ms: number) => Promise<void>;

export interface NotificationWorkerOptions {
  /** Total delivery attempts per event before it is marked FAILED. */
  maxAttempts?: number;
  /** First retry delay; doubles on each subsequent failure. */
  baseDelayMs?: number;
  /** Injectable so tests can record delays without real waiting. */
  sleeper?: Sleeper;
}

export interface ProcessedEvent {
  event: OutboxEvent;
  outcome: 'DELIVERED' | 'FAILED';
}

const defaultSleeper: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class NotificationWorkerCore {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleeper: Sleeper;

  constructor(
    private readonly deliver: NotificationDeliverFn,
    opts: NotificationWorkerOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 100;
    this.sleeper = opts.sleeper ?? defaultSleeper;
  }

  /**
   * Processes a single outbox event (one queue job). Returns a copy of the
   * event in its final state: DELIVERED on success, or FAILED with
   * `attempts` and `lastError` recording the failure history.
   */
  async process(input: OutboxEvent): Promise<ProcessedEvent> {
    const event: OutboxEvent = { ...input };
    if (event.status !== 'PENDING') {
      return { event, outcome: event.status === 'DELIVERED' ? 'DELIVERED' : 'FAILED' };
    }
    while (event.attempts < this.maxAttempts) {
      try {
        await this.deliver(event);
        event.status = 'DELIVERED';
        event.lastError = undefined;
        return { event, outcome: 'DELIVERED' };
      } catch (err) {
        event.attempts += 1;
        event.lastError = err instanceof Error ? err.message : String(err);
        if (event.attempts < this.maxAttempts) {
          await this.sleeper(this.baseDelayMs * 2 ** (event.attempts - 1));
        }
      }
    }
    event.status = 'FAILED';
    return { event, outcome: 'FAILED' };
  }

  /**
   * Drains every pending outbox event in the store through `process`,
   * persisting each event's final state. Used by the polling fallback and
   * by tests; the BullMQ adapter processes events one job at a time instead.
   */
  async processPending(store: Store): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    for (const pendingEvent of await store.outbox.listPending()) {
      const { event, outcome } = await this.process(pendingEvent);
      await store.outbox.save(event);
      if (outcome === 'DELIVERED') delivered += 1;
      else failed += 1;
    }
    return { delivered, failed };
  }
}
