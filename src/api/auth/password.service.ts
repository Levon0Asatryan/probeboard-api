import { Inject, Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../../core/config/config.module.js';
import type { AppConfig } from '../../core/config/schema.js';
import { describeError } from '../../core/errors/describe.js';

/**
 * Password hashing (NFR-10).
 *
 * @node-rs/argon2 rather than node-argon2: the latter publishes prebuilt
 * binaries for glibc only, so the Alpine image would need a build toolchain
 * and the Dockerfile's `--ignore-scripts` would stop working.
 *
 * Costs come from configuration so they can be raised to match the deployment
 * target without a code change, and so the figure reported in the evaluation
 * chapter is the measured one.
 */
@Injectable()
export class PasswordService {
  /**
   * A hash of a value nobody knows, verified against when no user was found.
   *
   * Without it, an unknown address returns as fast as the database lookup while
   * a wrong password costs a full Argon2 verification, and the difference tells
   * an attacker which addresses are registered (A-2). Computed once, lazily, so
   * startup is not delayed by a hash nobody may need.
   */
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectPinoLogger(PasswordService.name) private readonly logger: PinoLogger,
  ) {}

  private get options() {
    return {
      algorithm: Algorithm.Argon2id,
      memoryCost: this.cfg.ARGON2_MEMORY_KIB,
      timeCost: this.cfg.ARGON2_TIME_COST,
      parallelism: this.cfg.ARGON2_PARALLELISM,
    };
  }

  hash(password: string): Promise<string> {
    return hash(password, this.options);
  }

  /**
   * Verifies a password.
   *
   * A stored hash that cannot be read — corrupted, truncated, or written by a
   * different algorithm — fails the login rather than the request. But the
   * cause is logged: without it, authentication could fail permanently for one
   * user, or for everyone under memory pressure, while operators saw nothing
   * but wrong-password responses.
   *
   * The failure is not propagated, deliberately. Every rejected login must look
   * the same from outside (A-2), and a 500 on some accounts and a 401 on others
   * is exactly the signal that requirement exists to remove. The log is where
   * an operator learns something is wrong.
   */
  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch (err) {
      this.logger.error({ cause: describeError(err) }, 'password verification failed unexpectedly');
      return false;
    }
  }

  /**
   * Spends the same work as a real verification, then fails.
   *
   * Call this on the no-such-user path so both paths cost one Argon2
   * verification.
   */
  async verifyDummy(password: string): Promise<false> {
    this.dummyHash ??= hash(
      // Not a real password, and never compared against user input by value.
      `dummy:${Date.now().toString()}:${Math.random().toString()}`,
      this.options,
    );

    await this.verify(await this.dummyHash, password);
    return false;
  }
}
