import { Module } from '@nestjs/common';
import { NotificationWorkerService } from './notification-worker.service';

@Module({
  providers: [NotificationWorkerService],
  exports: [NotificationWorkerService],
})
export class NotificationsModule {}
