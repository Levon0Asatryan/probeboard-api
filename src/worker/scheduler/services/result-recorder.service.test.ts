import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../core/config/index.js';
import { ResultRecorderService } from './result-recorder.service.js';

const cfg = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
  HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
  RESULT_WRITE_ATTEMPTS: '3',
  RESULT_WRITE_BACKOFF_MS: '1',
});

const fence = { endpointId: 'e1', workerId: 'w1', slot: 't' };
const row = { attempt_id: 'a1' } as never;

function makeRecorder(execute: () => Promise<unknown>) {
  const transaction = vi.fn(() => ({ execute }));
  const db = { kysely: { transaction } };
  return {
    transaction,
    recorder: new ResultRecorderService(db as never, {} as never, {} as never, cfg),
  };
}

describe('ResultRecorderService.recordAndRelease', () => {
  it('retries a failed write and returns the first success', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValue({ inserted: 1, released: 1 });
    const { recorder } = makeRecorder(execute);
    await expect(
      recorder.recordAndRelease(row, fence, () => ({ timeoutMs: 1000, expired: false })),
    ).resolves.toEqual({
      inserted: 1,
      released: 1,
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('stops at RESULT_WRITE_ATTEMPTS and rethrows the last failure', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'));
    const { recorder } = makeRecorder(execute);
    await expect(
      recorder.recordAndRelease(row, fence, () => ({ timeoutMs: 1000, expired: false })),
    ).rejects.toThrow('third');
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('does not retry a success', async () => {
    const execute = vi.fn().mockResolvedValue({ inserted: 1, released: 0 });
    const { recorder } = makeRecorder(execute);
    await recorder.recordAndRelease(row, fence, () => ({ timeoutMs: 1000, expired: false }));
    expect(execute).toHaveBeenCalledOnce();
  });

  it('never starts a retry once the shutdown budget has expired', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('db down'));
    const { recorder } = makeRecorder(execute);
    let expired = false;
    execute.mockImplementationOnce(() => {
      expired = true; // the grace passes while the first attempt is failing
      return Promise.reject(new Error('first'));
    });
    await expect(
      recorder.recordAndRelease(row, fence, () => ({ timeoutMs: 1000, expired })),
    ).rejects.toThrow('first');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('caps a backoff at the time remaining instead of sleeping the configured delay', async () => {
    const slow = new ResultRecorderService(
      {
        kysely: { transaction: () => ({ execute: () => Promise.reject(new Error('x')) }) },
      } as never,
      {} as never,
      {} as never,
      loadConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/probeboard',
        HEADER_ENCRYPTION_KEY: 'ttvqsQVo42QM/ZZbz/sxCf+l7AeczpZBUdpNINtKNPI=',
        RESULT_WRITE_ATTEMPTS: '3',
        RESULT_WRITE_BACKOFF_MS: '10000',
      }),
    );
    const started = Date.now();
    await expect(
      slow.recordAndRelease(row, fence, () => ({ timeoutMs: 5, expired: false })),
    ).rejects.toThrow('x');
    // Uncapped this would sleep 10 s + 20 s.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
