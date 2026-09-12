import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../core/config/index.js';
import { PasswordService } from './password.service.js';

// The smallest parameters the schema allows, so the suite stays fast. Cost is
// configuration precisely so it can differ between a test run and production.
const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  ARGON2_MEMORY_KIB: '8192',
  ARGON2_TIME_COST: '1',
});

const logger = { error: vi.fn() };
const service = new PasswordService(cfg, logger as never);

describe('PasswordService', () => {
  it('produces an argon2id hash, as NFR-10 requires', async () => {
    const stored = await service.hash('correct horse battery staple');
    expect(stored.startsWith('$argon2id$')).toBe(true);
  });

  it('never stores the password itself', async () => {
    const password = 'correct horse battery staple';
    expect(await service.hash(password)).not.toContain(password);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([service.hash('same'), service.hash('same')]);
    expect(a).not.toBe(b);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const stored = await service.hash('correct');
    expect(await service.verify(stored, 'correct')).toBe(true);
    expect(await service.verify(stored, 'wrong')).toBe(false);
  });

  it('is case and whitespace sensitive', async () => {
    const stored = await service.hash('Secret Password');
    expect(await service.verify(stored, 'secret password')).toBe(false);
    expect(await service.verify(stored, 'Secret Password ')).toBe(false);
  });

  it('accepts a password that is not ASCII', async () => {
    const stored = await service.hash('գաղտնաբառ-🔐');
    expect(await service.verify(stored, 'գաղտնաբառ-🔐')).toBe(true);
  });

  it('records its parameters in the hash, so costs can be raised later', async () => {
    // The encoded string carries m, t and p, so raising them does not
    // invalidate hashes already stored.
    const stored = await service.hash('x');
    expect(stored).toMatch(/\$m=8192,t=1,p=1\$/);

    const stronger = new PasswordService({ ...cfg, ARGON2_TIME_COST: 2 }, logger as never);
    // A hash made with the old cost still verifies under the new setting.
    expect(await stronger.verify(stored, 'x')).toBe(true);
  });

  it('returns false rather than throwing on a corrupted stored hash', async () => {
    // A damaged row must fail the login, not the request.
    for (const bad of ['', 'not-a-hash', '$argon2id$garbage', '$2b$10$bcryptstyle']) {
      expect(await service.verify(bad, 'anything')).toBe(false);
    }
  });

  it('logs why a verification failed instead of swallowing it', async () => {
    // Otherwise authentication can fail permanently -- for one corrupted row,
    // or for everyone under memory pressure -- while operators see nothing but
    // wrong-password responses.
    logger.error.mockClear();

    expect(await service.verify('$argon2id$garbage', 'anything')).toBe(false);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]?.[1]).toBe('password verification failed unexpectedly');
    expect(logger.error.mock.calls[0]?.[0].cause).toBeTruthy();
  });

  it('verifyDummy always fails but still spends the work', async () => {
    // Without it the no-such-user path returns far faster than a wrong
    // password, which tells an attacker which addresses are registered (A-2).
    const started = Date.now();
    expect(await service.verifyDummy('anything')).toBe(false);
    const dummyMs = Date.now() - started;

    const stored = await service.hash('real');
    const t = Date.now();
    await service.verify(stored, 'wrong');
    const realMs = Date.now() - t;

    // Same order of magnitude, rather than one being effectively free.
    expect(dummyMs).toBeGreaterThan(realMs / 10);
  });
});
