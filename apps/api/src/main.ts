import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('bootstrap');
  // Request correlation: attach/propagate x-request-id for structured logs
  app.use((req: any, res: any, next: any) => { req.requestId = req.headers['x-request-id'] ?? randomUUID(); res.setHeader('x-request-id', req.requestId); next(); });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors();
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Chapters of Change API').setVersion('0.1.0').addBearerAuth().build());
  SwaggerModule.setup('docs', app, doc);
  await app.listen(process.env.PORT ?? 4000);
  logger.log(`API listening on ${process.env.PORT ?? 4000}, docs at /docs`);
}
bootstrap();
