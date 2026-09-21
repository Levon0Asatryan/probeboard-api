import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loadConfig } from '../core/config/index.js';
import { describeError } from '../core/errors/describe.js';
import { untilShutdown } from './lifecycle/shutdown.js';
import { SchedulerService } from './scheduler/scheduler.service.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();

  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  logger.log({ workerId: cfg.WORKER_ID, env: cfg.NODE_ENV, msg: 'worker started' });

  const signal = await untilShutdown();
  logger.log({ signal, msg: 'worker stopping' });

  // Stopped explicitly, and awaited, before app.close() destroys the
  // database pool (DbService.onModuleDestroy) -- §3.9's ordering. Nest's own
  // destroy hooks run during app.close() itself, in an order this cannot
  // rely on to finish the scheduler's release writes first.
  await app.get(SchedulerService).stop();

  // Closes the module tree, which releases the database pool (DbService).
  await app.close();
  logger.log({ msg: 'worker stopped' });
}

bootstrap().catch((err: unknown) => {
  console.error(`worker failed to start: ${describeError(err)}`);
  process.exit(1);
});
