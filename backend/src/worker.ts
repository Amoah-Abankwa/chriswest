import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClockModule } from './common/clock';
import { getEnv } from './config/env';
import { MailModule } from './mail/mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OutboxModule } from './outbox/outbox.module';
import { OutboxProcessor } from './outbox/outbox.processor';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/file-storage';

// Background worker: emails, notifications, PDF exports and housekeeping, all from the outbox.
@Module({ imports: [PrismaModule, ClockModule, MailModule, StorageModule, NotificationsModule, OutboxModule] })
class WorkerModule {}

const POLL_MS = 15_000;
const CLEANUP_MS = 60 * 60_000; // housekeeping, hourly

async function bootstrap() {
  getEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const logger = new Logger('Worker');
  const processor = app.get(OutboxProcessor);

  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let lastCleanup = 0;

  const tick = async () => {
    try {
      await processor.heartbeat();
      // Keep going while there's a backlog, then wait.
      while (!stopping && (await processor.runOnce()) > 0);
      if (Date.now() - lastCleanup > CLEANUP_MS) {
        lastCleanup = Date.now();
        logger.log({ msg: 'Housekeeping done', ...(await processor.cleanup()) });
      }
    } catch (err) {
      logger.error({ msg: 'Worker tick failed', err });
    }
    if (!stopping) timer = setTimeout(() => (running = tick()), POLL_MS);
  };
  running = tick();

  const stop = async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    await running; // finish the event in hand
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  logger.log('Worker started');
}

void bootstrap();
