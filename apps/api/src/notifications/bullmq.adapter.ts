import { Logger } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import type { NotificationWorkerCore, Store } from '@chapters/app-services';

/**
 * BullMQ adapter for outbox notification delivery.
 *
 * VERIFICATION STATUS: UNVERIFIED against a live Redis — this repo's build
 * environment has no Redis server, so this file is typechecked and reviewed
 * but has never run. The delivery semantics it relies on (retry with
 * exponential backoff, FAILED state with the error preserved) live in the
 * queue-agnostic `NotificationWorkerCore` (packages/app-services), which IS
 * unit-tested; this adapter only moves jobs between Redis and that core.
 *
 * Design:
 *  - One queue, `chapters-notifications`. A repeatable `poll` job (every
 *    30s) scans the store's outbox for PENDING events and enqueues one
 *    `deliver` job per event, with the BullMQ jobId set to the outbox
 *    event id so re-polling never enqueues a duplicate in-flight job.
 *  - A `deliver` job loads the event from the store, runs it through the
 *    worker core, and persists the event's final state (DELIVERED, or
 *    FAILED with attempts + lastError). BullMQ's own retry is left at 1
 *    attempt: retry/backoff policy belongs to the core, so behavior is
 *    identical with or without Redis.
 *  - The worker only starts when REDIS_URL is set (see
 *    NotificationWorkerService); without it the API boots with the worker
 *    disabled and outbox events simply remain PENDING in the store.
 */
export const NOTIFICATIONS_QUEUE = 'chapters-notifications';

export class BullMqNotificationAdapter {
  private readonly logger = new Logger(BullMqNotificationAdapter.name);
  private connection?: IORedis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly store: Store,
    private readonly core: NotificationWorkerCore,
    private readonly redisUrl: string,
  ) {}

  async start(): Promise<void> {
    this.connection = new IORedis(this.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(NOTIFICATIONS_QUEUE, { connection: this.connection });
    this.worker = new Worker(NOTIFICATIONS_QUEUE, (job) => this.handleJob(job), {
      connection: this.connection,
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(`Notification job ${job?.id} failed at the queue level: ${err.message}`);
    });
    // Repeatable poll that turns pending outbox rows into deliver jobs.
    await this.queue.add('poll', {}, { repeat: { every: 30_000 }, jobId: 'outbox-poll' });
    await this.enqueuePending();
    this.logger.log('BullMQ notification worker started (queue: chapters-notifications)');
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit();
  }

  /** Enqueues one deliver job per PENDING outbox event (deduped by jobId). */
  async enqueuePending(): Promise<number> {
    if (!this.queue) return 0;
    const pending = await this.store.outbox.listPending();
    for (const event of pending) {
      await this.queue.add('deliver', { eventId: event.id }, { jobId: `deliver-${event.id}` });
    }
    return pending.length;
  }

  private async handleJob(job: Job): Promise<void> {
    if (job.name === 'poll') {
      await this.enqueuePending();
      return;
    }
    if (job.name === 'deliver') {
      const eventId = (job.data as { eventId?: string }).eventId;
      if (!eventId) return;
      const event = (await this.store.outbox.listAll()).find((e) => e.id === eventId);
      if (!event || event.status !== 'PENDING') return; // already handled
      const { event: processed } = await this.core.process(event);
      await this.store.outbox.save(processed);
    }
  }
}
