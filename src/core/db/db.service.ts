import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/schema.js';
import { createDb, type Db } from './utils/kysely.js';
import { createPool } from './utils/pool.js';

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly kysely: Db;
  private readonly pool: Pool;

  constructor(
    @Inject(APP_CONFIG) cfg: AppConfig,
    @InjectPinoLogger(DbService.name) private readonly logger: PinoLogger,
  ) {
    this.pool = createPool(cfg, (msg, fields) => this.logger.error(fields, msg));
    this.kysely = createDb(this.pool);
  }

  async onModuleDestroy(): Promise<void> {
    await this.kysely.destroy();
  }
}
