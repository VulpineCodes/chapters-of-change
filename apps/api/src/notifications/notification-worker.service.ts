import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { NotificationWorkerCore, Store } from '@chapters/app-services';
import { NOTIFICATION_WORKER_CORE, STORE } from '../runtime/runtime.module';
import { BullMqNotificationAdapter } from './bullmq.adapter';

export interface NotificationWorkerStatus {
  state: 'disabled' | 'enabled' | 'error';
  detail: string;
}

/**
 * Owns the notification worker lifecycle. The API must boot with or without
 * Redis: when REDIS_URL is absent the worker stays disabled (with a clear
 * log line) and outbox events remain PENDING in the store for the tested
 * `NotificationWorkerCore.processPending` path; when REDIS_URL is present
 * the BullMQ adapter starts, and a connection failure is reported in the
 * health endpoint instead of crashing the API.
 */
@Injectable()
export class NotificationWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationWorkerService.name);
  private adapter?: BullMqNotificationAdapter;
  status: NotificationWorkerStatus = { state: 'disabled', detail: 'not started' };

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(NOTIFICATION_WORKER_CORE) private readonly core: NotificationWorkerCore,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      this.status = {
        state: 'disabled',
        detail: 'REDIS_URL not set — BullMQ worker inactive; outbox events remain PENDING in the store',
      };
      this.logger.log(
        'Notification worker disabled: REDIS_URL is not set. Outbox events will remain PENDING; ' +
          'set REDIS_URL to enable the BullMQ worker (adapter unverified without a live Redis).',
      );
      return;
    }
    try {
      this.adapter = new BullMqNotificationAdapter(this.store, this.core, redisUrl);
      await this.adapter.start();
      this.status = { state: 'enabled', detail: 'BullMQ worker running against REDIS_URL' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = { state: 'error', detail: `BullMQ worker failed to start: ${message}` };
      this.logger.error(
        `Notification worker failed to start (${message}). The API stays up; outbox events remain PENDING.`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.adapter?.stop().catch(() => undefined);
  }
}
