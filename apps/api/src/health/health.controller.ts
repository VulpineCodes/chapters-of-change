import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { NotificationWorkerService } from '../notifications/notification-worker.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly notifications: NotificationWorkerService) {}

  @Get()
  check() {
    return {
      status: 'ok',
      service: 'chapters-api',
      timestamp: new Date().toISOString(),
      storeAdapter: (process.env.STORE_ADAPTER ?? 'memory').toLowerCase(),
      notificationWorker: this.notifications.status,
    };
  }

  @Get('ready')
  ready() {
    return {
      status: 'ready',
      checks: {
        store:
          (process.env.STORE_ADAPTER ?? 'memory').toLowerCase() === 'prisma'
            ? 'PrismaStore selected (unverified against a live database — see STATUS.md)'
            : 'InMemoryStore (verified adapter; state resets on restart)',
        notificationWorker: this.notifications.status,
      },
    };
  }
}
