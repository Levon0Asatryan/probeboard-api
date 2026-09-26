import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, truncateAll, type TestDb } from '../../../testing/database.js';
import { movedForward, withProcessClockBehind } from '../../../testing/skewed-clock.js';
import type { DbService } from '../../db/db.service.js';
import { UserRepository } from './user.repository.js';

/**
 * Against a real PostgreSQL. `ON CONFLICT`, the unique index and concurrent
 * inserts are the behaviour under test; a mock would only assert that we called
 * the mock.
 */

let ctx: TestDb;
let repo: UserRepository;

beforeAll(() => {
  ctx = connectTestDb();
  repo = new UserRepository({ kysely: ctx.db } as DbService);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.pool);
});

describe('create', () => {
  it('stores a user and returns the row', async () => {
    const user = await repo.create('alice@example.com', '$argon2id$hash');

    expect(user).toBeDefined();
    expect(user?.email).toBe('alice@example.com');
    expect(user?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user?.created_at).toBeInstanceOf(Date);
    expect(user?.email_verified_at).toBeNull();
  });

  it('normalises the address on the way in', async () => {
    const user = await repo.create('  Alice@EXAMPLE.com ', 'h');
    expect(user?.email).toBe('alice@example.com');
  });

  it('returns undefined for an address already taken', async () => {
    await repo.create('alice@example.com', 'first');
    expect(await repo.create('alice@example.com', 'second')).toBeUndefined();
  });

  it('treats a differently-cased address as taken', async () => {
    // Otherwise one address becomes two accounts and the unique index never
    // sees it.
    await repo.create('alice@example.com', 'first');
    expect(await repo.create('ALICE@example.com', 'second')).toBeUndefined();
  });

  it('does not overwrite the existing password on a conflict', async () => {
    await repo.create('alice@example.com', 'original');
    await repo.create('alice@example.com', 'attacker');

    expect((await repo.findByEmail('alice@example.com'))?.password_hash).toBe('original');
  });

  it('lets exactly one of two concurrent registrations win', async () => {
    // A read-then-write would let both pass the read; the unique index is what
    // actually decides, and ON CONFLICT is what keeps it from throwing.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => repo.create('race@example.com', `hash-${i}`)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('findByEmail', () => {
  it('finds a user regardless of the casing used to look up', async () => {
    await repo.create('alice@example.com', 'h');

    expect(await repo.findByEmail('ALICE@Example.com')).toBeDefined();
    expect(await repo.findByEmail('  alice@example.com  ')).toBeDefined();
  });

  it('returns undefined for an unknown address', async () => {
    expect(await repo.findByEmail('nobody@example.com')).toBeUndefined();
  });
});

describe('findById', () => {
  it('round-trips the created row', async () => {
    const created = await repo.create('alice@example.com', 'h');
    expect((await repo.findById(created!.id))?.email).toBe('alice@example.com');
  });

  it('returns undefined for an id that does not exist', async () => {
    expect(await repo.findById('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });
});

describe('updatePasswordHash', () => {
  it('replaces the hash and moves updated_at', async () => {
    // #71's flake had two causes, and this reasons around both. The insert's
    // DEFAULT now() and the update's now() are one clock, two transactions
    // apart, so no sleep orders them; and they are compared by PostgreSQL at
    // microsecond precision, not as the millisecond Dates the driver returns.
    const created = await repo.create('alice@example.com', 'old');

    const updated = await repo.updatePasswordHash(created!.id, 'new');

    expect(updated?.password_hash).toBe('new');
    expect(await movedForward(ctx.pool, 'users', created!.id)).toBe(true);
  });

  it('stamps updated_at from the database clock, whatever this process thinks the time is', async () => {
    // The other cause, made deterministic: with the process clock behind the
    // database's, a process-stamped updated_at moved backwards.
    const created = await repo.create('alice@example.com', 'old');

    await withProcessClockBehind(() => repo.updatePasswordHash(created!.id, 'new'));

    expect(await movedForward(ctx.pool, 'users', created!.id)).toBe(true);
  });

  it('leaves the address alone', async () => {
    const created = await repo.create('alice@example.com', 'old');
    expect((await repo.updatePasswordHash(created!.id, 'new'))?.email).toBe('alice@example.com');
  });

  it('returns undefined for an unknown user', async () => {
    expect(
      await repo.updatePasswordHash('00000000-0000-0000-0000-000000000000', 'x'),
    ).toBeUndefined();
  });
});
