import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { ListingsController } from './listings/listings.controller';
import { ListingsService } from './listings/listings.service';
import { DonationsController } from './donations/donations.controller';
import { DonationsService } from './donations/donations.service';
import { AuthController } from './auth/auth.controller';
import { JwtService } from './auth/jwt.service';
import { RuntimeModule } from './runtime/runtime.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [RuntimeModule, NotificationsModule],
  controllers: [HealthController, ListingsController, DonationsController, AuthController],
  providers: [ListingsService, DonationsService, JwtService],
})
export class AppModule {}
